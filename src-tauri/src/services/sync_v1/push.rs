//! V1 推送：本地 → 远端
//!
//! 流程：
//! 1. 计算本地 manifest
//! 2. 读取远端 manifest（首次同步可能为 None）
//! 3. diff
//! 4. 对 to_push 中每条：put_note + 更新 sync_remote_state
//! 5. 写入新的远端 manifest（合并：本地全量 + 远端独有的；冲突保留较新的）
//!
//! v1 阶段简化：不支持本地软删除推送（tombstone），等 T-024 后续阶段补。

use tauri::{Emitter, Runtime};

use crate::database::Database;
use crate::error::AppError;
use crate::models::{SyncManifestV1, SyncPushResult};

use super::backend::SyncBackendImpl;
use super::manifest;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    backend_id: i64,
    phase: String, // "compute" | "diff" | "upload" | "manifest" | "done"
    current: usize,
    total: usize,
    message: String,
}

pub fn push<R: Runtime, E: Emitter<R>>(
    db: &Database,
    backend_id: i64,
    backend: &dyn SyncBackendImpl,
    app_version: &str,
    device: &str,
    data_dir: &std::path::Path,
    emitter: &E,
) -> Result<SyncPushResult, AppError> {
    let mut result = SyncPushResult::default();
    let event_name = "sync_v1:progress";

    let _ = emitter.emit(
        event_name,
        ProgressEvent {
            backend_id,
            phase: "compute".into(),
            current: 0,
            total: 0,
            message: "刷新附件索引…".into(),
        },
    );
    // 同步前先刷新附件索引：note_attachments 表只在这里（和手动「重建附件索引」）维护，
    // 不刷新的话新加的图片/视频不会进 manifest.attachments → 不会上传到远端。失败仅 warn 不阻塞。
    match super::attachment_scan::scan_all_active_notes(db, data_dir) {
        Ok(n) => log::info!("[sync_v1] push 前刷新附件索引：{} 条引用", n),
        Err(e) => log::warn!(
            "[sync_v1] push 前刷新附件索引失败（继续，本次可能漏传新附件）: {}",
            e
        ),
    }

    let _ = emitter.emit(
        event_name,
        ProgressEvent {
            backend_id,
            phase: "compute".into(),
            current: 0,
            total: 0,
            message: "计算本地 manifest…".into(),
        },
    );
    let local = manifest::compute_local_manifest(db, app_version, device)?;

    let _ = emitter.emit(
        event_name,
        ProgressEvent {
            backend_id,
            phase: "diff".into(),
            current: 0,
            total: 0,
            message: "对比远端 manifest…".into(),
        },
    );
    let mut remote_opt = backend.read_manifest()?;

    // hash 算法兼容性检查（v1 → v2 升级）：
    // 远端 manifest 是旧客户端写的（无 hash_algo 字段），diff 会把所有笔记误判为变更。
    // 处理：清空本机 sync_remote_state，把远端视为"空 manifest" → 走全量首次推送路径，
    // 写出 v2 格式新 manifest 后下次 pull/push 即恢复增量。
    if let Some(ref m) = remote_opt {
        if !m.entries.is_empty()
            && m.hash_algo.as_deref() != Some(SyncManifestV1::HASH_ALGO_V2)
        {
            log::warn!(
                "[sync_v1] backend {} push: 远端 manifest 用旧 hash 算法 ({:?})，清空本地 sync_remote_state 并按首次推送处理（本次将全量重传升级到 v2）",
                backend_id,
                m.hash_algo
            );
            let cleared = db.clear_remote_state_for_backend(backend_id)?;
            log::info!("[sync_v1] 已清空 {} 条 sync_remote_state（backend {}）", cleared, backend_id);
            remote_opt = None;
        }
    }

    let remote = remote_opt.unwrap_or_else(|| SyncManifestV1 {
        manifest_version: SyncManifestV1::VERSION,
        app_version: app_version.into(),
        device: device.into(),
        generated_at: String::new(),
        entries: vec![],
        hash_algo: Some(SyncManifestV1::HASH_ALGO_V2.into()),
        vault: None,
        attachments: vec![],
    });

    let diff = manifest::diff_manifests(&local, &remote);

    // 拿当前同步状态（hash → 用于跳过已同步的）
    let state_map = db.list_remote_state(backend_id)?;

    // 按需读取 to_push 的笔记内容（不再全库读 content）
    //
    // 历史：v1 早期版本一次性 `SELECT id, title, content, updated_at FROM notes`
    // 把整库塞进 HashMap，10000 条 × 平均 50KB content ≈ 500MB 内存峰值，大库爆内存。
    //
    // T-S011 起：entry.stable_id 是 UUID（v36 起 notes.stable_uuid 列），
    // 按 stable_uuid IN (...) 分块查询。HashMap key = uuid，值含本地 note_id（state_map 用）+ 内容。
    // - SQLite 默认 SQLITE_MAX_VARIABLE_NUMBER=999，取 900 留余量
    // - T-S012：tombstone entry 跳过 content 读取（删除推送不需要正文），走另一条分支
    let to_push_uuids: Vec<String> = diff
        .to_push
        .iter()
        .filter(|e| !e.tombstone)
        .map(|e| e.stable_id.clone())
        .collect();
    let local_notes: std::collections::HashMap<String, (i64, String, String, String)> = {
        let mut map = std::collections::HashMap::with_capacity(to_push_uuids.len());
        if !to_push_uuids.is_empty() {
            let conn = db.conn_lock()?;
            for chunk in to_push_uuids.chunks(900) {
                let placeholders =
                    std::iter::repeat("?").take(chunk.len()).collect::<Vec<_>>().join(",");
                let sql = format!(
                    "SELECT id, stable_uuid, title, content, updated_at FROM notes
                     WHERE stable_uuid IN ({}) AND is_deleted = 0",
                    placeholders
                );
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt
                    .query_map(rusqlite::params_from_iter(chunk.iter()), |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                for (id, uuid, t, c, u) in rows {
                    map.insert(uuid, (id, t, c, u));
                }
            }
        }
        map
    };

    // T-S012：tombstone 删除走原串行（数量少 + delete_note 不在 batch trait 中）
    // T-S030/T-S031：非 tombstone 笔记收集后用 batch_put_notes 一次性并发上传
    struct PendingUpload {
        note_id: i64,
        remote_path: String,
        body: String,
        content_hash: String,
        updated_at: String,
        title: String,
    }
    let mut pending: Vec<PendingUpload> = Vec::new();

    let total_to_push = diff.to_push.len();
    for (idx, entry) in diff.to_push.iter().enumerate() {
        // T-S012：tombstone entry 走删除分支
        if entry.tombstone {
            let _ = emitter.emit(
                event_name,
                ProgressEvent {
                    backend_id,
                    phase: "upload".into(),
                    current: idx + 1,
                    total: total_to_push,
                    message: format!("删除远端 {}", entry.title),
                },
            );

            let local_id = match db.get_note_id_by_stable_uuid(&entry.stable_id)? {
                Some(id) => id,
                None => {
                    result.errors.push(format!(
                        "tombstone {} 在 manifest 里但本地找不到 stable_uuid",
                        entry.stable_id
                    ));
                    continue;
                }
            };
            if let Some(state) = state_map.get(&local_id) {
                if state.tombstone {
                    result.skipped += 1;
                    continue;
                }
            }
            match backend.delete_note(&entry.remote_path) {
                Ok(_) => {}
                Err(e) => log::warn!(
                    "[sync_v1] 远端 delete_note {} 失败（视为已删继续）: {}",
                    entry.remote_path,
                    e
                ),
            }
            if let Err(e) = db.upsert_remote_state(
                backend_id,
                local_id,
                &entry.remote_path,
                &entry.content_hash,
                &entry.updated_at,
                true,
            ) {
                result.errors.push(format!(
                    "tombstone upsert sync_remote_state 失败 (note {}): {}",
                    local_id, e
                ));
            }
            result.deleted_remote += 1;
            continue;
        }

        // 非 tombstone：收集到 pending 队列，后面统一 batch 上传
        let (note_id, title, content, updated_at) = match local_notes.get(&entry.stable_id) {
            Some(v) => v.clone(),
            None => {
                result.errors.push(format!(
                    "笔记 stable_uuid={} 在 manifest 里但 DB 里找不到",
                    entry.stable_id
                ));
                continue;
            }
        };

        // 跳过：sync_remote_state 已记录同 hash（幂等）
        if let Some(state) = state_map.get(&note_id) {
            if state.last_synced_hash == entry.content_hash && !state.tombstone {
                result.skipped += 1;
                continue;
            }
        }

        // T-S014：加密笔记走密文上传分支
        let body_to_upload: String = if entry.encrypted {
            match db.get_note_crypto_state_by_uuid(&entry.stable_id) {
                Ok(Some((true, Some(blob)))) => {
                    use base64::Engine as _;
                    base64::engine::general_purpose::STANDARD.encode(&blob)
                }
                Ok(_) => {
                    result.errors.push(format!(
                        "加密笔记 {} 缺 encrypted_blob，跳过上传",
                        entry.title
                    ));
                    continue;
                }
                Err(e) => {
                    result
                        .errors
                        .push(format!("读取 encrypted_blob 失败 {}: {}", entry.title, e));
                    continue;
                }
            }
        } else {
            super::note_md::format_note_md(&title, &content)
        };

        pending.push(PendingUpload {
            note_id,
            remote_path: entry.remote_path.clone(),
            body: body_to_upload,
            content_hash: entry.content_hash.clone(),
            updated_at,
            title: entry.title.clone(),
        });
    }

    // T-S031 + 进度/限流加固：**分小批**上传 —— 每批传完就报一次进度（进度条一格一格走，
    // 不再"全传完才一口气报"卡在 0%），并按上一批的表现**自适应调并发**（撞 5xx → 下批减半；干净 → 下批 +2；范围 [1,8]）。
    if !pending.is_empty() {
        let total = pending.len();
        let _ = emitter.emit(
            event_name,
            ProgressEvent {
                backend_id,
                phase: "upload-batch".into(),
                current: 0,
                total,
                message: format!("批量上传 {} 条笔记…", total),
            },
        );

        const CHUNK: usize = 10; // 每批条数：进度更新粒度（95 篇 → ~10 次更新）
        let mut max_conc: usize = 4; // 初始并发；按 5xx 自适应
        let mut done: usize = 0;
        let mut start = 0usize;
        'chunks: while start < pending.len() {
            let end = (start + CHUNK).min(pending.len());
            let chunk = &pending[start..end];
            let chunk_items: Vec<(String, String)> = chunk
                .iter()
                .map(|p| (p.remote_path.clone(), p.body.clone()))
                .collect();
            let chunk_results = backend.batch_put_notes(&chunk_items, max_conc);

            // backend 在"整批致命错误"（如远端目录创建失败）时会返回比入参更短的 Vec → 视为已中止：
            // 记一条错误，停掉后续 chunk（再试也是一样的错）。
            if chunk_results.len() < chunk.len() {
                let abort_msg = chunk_results
                    .into_iter()
                    .next()
                    .and_then(|r| r.err())
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "远端不可用".into());
                result
                    .errors
                    .push(format!("批量上传已中止（剩余 {} 条未上传）：{}", total - done, abort_msg));
                break 'chunks;
            }

            let mut chunk_had_5xx = false;
            for (p, r) in chunk.iter().zip(chunk_results.into_iter()) {
                done += 1;
                let _ = emitter.emit(
                    event_name,
                    ProgressEvent {
                        backend_id,
                        phase: "upload".into(),
                        current: done,
                        total,
                        message: format!("已传 {}", p.title),
                    },
                );
                match r {
                    Ok(_) => {
                        if let Err(e) = db.upsert_remote_state(
                            backend_id,
                            p.note_id,
                            &p.remote_path,
                            &p.content_hash,
                            &p.updated_at,
                            false,
                        ) {
                            result.errors.push(format!(
                                "upsert sync_remote_state 失败 (note {}): {}",
                                p.note_id, e
                            ));
                        }
                        result.uploaded += 1;
                    }
                    Err(e) => {
                        let msg = e.to_string();
                        if super::backend_webdav::is_transient_server_err(&msg) {
                            chunk_had_5xx = true;
                        }
                        result.errors.push(format!("上传失败 {}: {}", p.title, msg));
                    }
                }
            }

            // 自适应并发：这一批撞过 5xx → 减半（最少 1）；干净 → +2（最多 8）
            max_conc = if chunk_had_5xx {
                (max_conc / 2).max(1)
            } else {
                (max_conc + 2).min(8)
            };
            start = end;
        }
    }

    // T-S024：附件上传（CAS 去重）
    //
    // 本机所有 unique sha256 → has_attachment 远端 → 缺失的 put_attachment 上传。
    // 顺序在 manifest 写入之前：保证 manifest 公布的 hash 都已经在远端，
    // 避免拉端拿到 manifest 后 get_attachment 失败。
    let local_attachments = db.list_all_unique_attachments().unwrap_or_default();
    let total_attach = local_attachments.len();
    for (idx, att) in local_attachments.iter().enumerate() {
        let _ = emitter.emit(
            event_name,
            ProgressEvent {
                backend_id,
                phase: "attachments".into(),
                current: idx + 1,
                total: total_attach,
                message: format!("附件 {} ({} bytes)", short_hash(&att.sha256_hex), att.size),
            },
        );

        // has 判定：远端已有 → 跳过；失败 → 记错继续
        match backend.has_attachment(&att.sha256_hex) {
            Ok(true) => {
                result.attachments_skipped += 1;
                continue;
            }
            Ok(false) => {}
            Err(e) => {
                result.errors.push(format!(
                    "has_attachment 检查失败 {}: {}",
                    short_hash(&att.sha256_hex),
                    e
                ));
                continue;
            }
        }

        // 读本地文件
        let abs = data_dir.join(&att.local_rel_path);
        let bytes = match std::fs::read(&abs) {
            Ok(b) => b,
            Err(e) => {
                result.errors.push(format!(
                    "读取本地附件 {} 失败: {}",
                    att.local_rel_path, e
                ));
                continue;
            }
        };

        // 上传
        match backend.put_attachment(&att.sha256_hex, &bytes) {
            Ok(_) => result.attachments_uploaded += 1,
            Err(e) => result.errors.push(format!(
                "上传附件 {} 失败: {}",
                short_hash(&att.sha256_hex),
                e
            )),
        }
    }

    // 写新的远端 manifest = merge(local, remote_独有) —— 防 lost-update。
    //
    // T-S013（已修）：直接 `write_manifest(&local)` 会**吞掉远端独有项**——比如本机推送时另一台设备
    // 刚好 push 了笔记 X，X 的 .md 已存在但本机 local 不含 X，写入时会把 X 从远端 manifest 抹掉。
    // 解决：写前重新读远端 manifest 合并。
    //
    // **Bug 7（本次加固）**：上面的"读 → merge → 写"也有 race 窗口 —— 两台设备同时跑到这一步：
    // A 读到 rev N → 合并 → 写出 rev N+1A；B 同时读到 rev N → 合并 → 写出 rev N+1B（覆盖 A）。
    // 一旦 A 那次新写的笔记 entry 是 local 独有的，rev N+1B 就会**丢掉 A 那条 entry** → 第三台设备
    // pull 不到。
    //
    // 务实方案（不做完整 If-Match CAS，因为坚果云等 WebDAV server 的 ETag 实现不可靠）：
    // 写完后**重读校验**——如果远端的 hash 不等于刚写的 merged 的 hash，说明被别人覆盖了，
    // 重新合并（包含别人那次新增）+ 重写一次。最多重试 3 次（首次写 + 2 次重试），仍冲突就报错。
    let _ = emitter.emit(
        event_name,
        ProgressEvent {
            backend_id,
            phase: "manifest".into(),
            current: 0,
            total: 0,
            message: "合并并更新远端 manifest…".into(),
        },
    );

    let empty_manifest = || SyncManifestV1 {
        manifest_version: SyncManifestV1::VERSION,
        app_version: app_version.into(),
        device: device.into(),
        generated_at: String::new(),
        entries: vec![],
        hash_algo: Some(SyncManifestV1::HASH_ALGO_V2.into()),
        vault: None,
        attachments: vec![],
    };

    const MANIFEST_WRITE_MAX_ATTEMPTS: u32 = 3;
    let mut last_err: Option<String> = None;
    for attempt in 1..=MANIFEST_WRITE_MAX_ATTEMPTS {
        // 1) 重新读远端（含别人这一窗口期里写入的更新）
        let remote_now = match backend.read_manifest() {
            Ok(Some(m)) => m,
            Ok(None) => empty_manifest(),
            Err(e) => {
                last_err = Some(format!("合并前重读远端 manifest 失败: {}", e));
                break;
            }
        };
        // 2) merge + write
        let merged = manifest::merge_manifests(&local, &remote_now);
        if let Err(e) = backend.write_manifest(&merged) {
            last_err = Some(format!("写远端 manifest 失败: {}", e));
            break;
        }
        // 3) 写后重读校验：远端 hash != 我刚写的 hash → 别人在 1) 之后又写过了（race） → 重试
        // 用 entries 排序后的简单 fingerprint（content_hash 串拼接），对脏数据耐受；不做严格 JSON 等值比对
        let want_fp = manifest_entries_fingerprint(&merged);
        let after = match backend.read_manifest() {
            Ok(Some(m)) => m,
            Ok(None) => {
                // 刚写完远端没了 —— 可能是 race 期间别人删掉、或写入 backend 异常返回 Ok 但实际没成
                last_err = Some("写完 manifest 后重读发现远端为空，疑似 race / 写入未生效".into());
                if attempt < MANIFEST_WRITE_MAX_ATTEMPTS {
                    continue;
                }
                break;
            }
            Err(e) => {
                last_err = Some(format!("写后校验读远端 manifest 失败: {}", e));
                break;
            }
        };
        let got_fp = manifest_entries_fingerprint(&after);
        if got_fp == want_fp {
            // 我们写的就是当前远端 → 成功，退出
            last_err = None;
            break;
        }
        log::warn!(
            "[sync_v1] manifest 写后校验：第 {} 次远端 hash 跟我写的不一致（被并发覆盖），重试 (剩 {} 次)",
            attempt,
            MANIFEST_WRITE_MAX_ATTEMPTS - attempt
        );
        last_err = Some(format!(
            "manifest 写后校验：第 {} 次仍被并发覆盖",
            attempt
        ));
        // 重试前轻微退避（只在还有重试机会时）
        if attempt < MANIFEST_WRITE_MAX_ATTEMPTS {
            std::thread::sleep(std::time::Duration::from_millis(300 * attempt as u64));
        }
    }
    if let Some(e) = last_err {
        result.errors.push(e);
    }

    db.touch_sync_backend_push(backend_id)?;

    let _ = emitter.emit(
        event_name,
        ProgressEvent {
            backend_id,
            phase: "done".into(),
            current: 0,
            total: 0,
            message: format!(
                "推送完成: 上传 {} / 跳过 {} / 错误 {}",
                result.uploaded,
                result.skipped,
                result.errors.len()
            ),
        },
    );

    let _ = (diff, &result); // 防止 lint：diff 当前仅用于循环
    Ok(result)
}

/// 截断 hash 用于日志/事件消息（前 8 位足以辨识）
fn short_hash(hash: &str) -> String {
    if hash.len() >= 8 {
        hash[..8].to_string()
    } else {
        hash.to_string()
    }
}

/// 让未引用的常量不报警告（暂留给 pull 用）
#[allow(dead_code)]
const _MARKER: () = ();

/// manifest 写后校验用的轻量 fingerprint —— 把所有 entry 按 stable_id 排序后串接
/// `<id>=<content_hash>;`，再加 attachments 的 hash 列表。返回结果用 sha256 hex 简化对比。
///
/// 不依赖 manifest 顶层易变字段（generated_at / device / app_version），因此 race 重读时即便
/// 别人这次也写了 manifest（generated_at 不同），只要"内容/附件集合"一致就视为同一份。
fn manifest_entries_fingerprint(m: &SyncManifestV1) -> String {
    use sha2::{Digest, Sha256};
    let mut entries: Vec<&crate::models::ManifestEntry> = m.entries.iter().collect();
    entries.sort_by(|a, b| a.stable_id.cmp(&b.stable_id));
    let mut hasher = Sha256::new();
    for e in &entries {
        hasher.update(e.stable_id.as_bytes());
        hasher.update(b"=");
        hasher.update(e.content_hash.as_bytes());
        hasher.update(b";");
    }
    hasher.update(b"|att|");
    let mut atts: Vec<&str> = m.attachments.iter().map(|a| a.hash.as_str()).collect();
    atts.sort_unstable();
    for h in atts {
        hasher.update(h.as_bytes());
        hasher.update(b",");
    }
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AttachmentEntry, ManifestEntry, SyncManifestV1};

    fn entry(id: &str, hash: &str) -> ManifestEntry {
        ManifestEntry {
            stable_id: id.into(),
            title: "t".into(),
            content_hash: hash.into(),
            updated_at: "2026-05-14".into(),
            remote_path: format!("notes/{}.md", id),
            tombstone: false,
            folder_path: String::new(),
            encrypted: false,
            is_daily: false,
            daily_date: None,
            is_hidden: false,
        }
    }

    fn manifest(entries: Vec<ManifestEntry>, atts: Vec<&str>) -> SyncManifestV1 {
        SyncManifestV1 {
            manifest_version: SyncManifestV1::VERSION,
            app_version: "x".into(),
            device: "x".into(),
            generated_at: String::new(),
            entries,
            hash_algo: Some(SyncManifestV1::HASH_ALGO_V2.into()),
            vault: None,
            attachments: atts
                .into_iter()
                .map(|h| AttachmentEntry {
                    hash: h.into(),
                    size: 0,
                    mime: None,
                    ext: None,
                })
                .collect(),
        }
    }

    #[test]
    fn fingerprint_independent_of_entry_order_and_volatile_fields() {
        let m1 = manifest(vec![entry("a", "h1"), entry("b", "h2")], vec!["x", "y"]);
        let mut m2 = manifest(vec![entry("b", "h2"), entry("a", "h1")], vec!["y", "x"]);
        // 干扰易变字段：fingerprint 应不受影响
        m2.app_version = "different".into();
        m2.device = "different".into();
        m2.generated_at = "2099-01-01".into();
        assert_eq!(manifest_entries_fingerprint(&m1), manifest_entries_fingerprint(&m2));
    }

    #[test]
    fn fingerprint_changes_with_entry_content() {
        let m1 = manifest(vec![entry("a", "h1")], vec![]);
        let m2 = manifest(vec![entry("a", "h2")], vec![]); // hash 变了
        assert_ne!(manifest_entries_fingerprint(&m1), manifest_entries_fingerprint(&m2));
    }

    #[test]
    fn fingerprint_changes_with_added_entry_or_attachment() {
        let base = manifest(vec![entry("a", "h1")], vec!["x"]);
        let plus_entry = manifest(vec![entry("a", "h1"), entry("b", "h2")], vec!["x"]);
        let plus_att = manifest(vec![entry("a", "h1")], vec!["x", "y"]);
        let base_fp = manifest_entries_fingerprint(&base);
        assert_ne!(base_fp, manifest_entries_fingerprint(&plus_entry));
        assert_ne!(base_fp, manifest_entries_fingerprint(&plus_att));
    }
}
