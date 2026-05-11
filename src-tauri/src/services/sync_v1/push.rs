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

    let total_to_push = diff.to_push.len();
    for (idx, entry) in diff.to_push.iter().enumerate() {
        let _ = emitter.emit(
            event_name,
            ProgressEvent {
                backend_id,
                phase: "upload".into(),
                current: idx + 1,
                total: total_to_push,
                message: if entry.tombstone {
                    format!("删除远端 {}", entry.title)
                } else {
                    format!("上传 {}", entry.title)
                },
            },
        );

        // T-S012：tombstone entry 走删除分支
        if entry.tombstone {
            // 软删笔记的本地 id：用 get_note_id_by_stable_uuid（含已软删，因为 SQL 没限 is_deleted）
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
            // 远端 state 已知 tombstone → 跳过（幂等）
            if let Some(state) = state_map.get(&local_id) {
                if state.tombstone {
                    result.skipped += 1;
                    continue;
                }
            }
            // 试图删远端 .md；失败仅 warn（可能远端本就没此文件 / 网络抖动）
            // 无论成功失败都更新 sync_remote_state，让 manifest 也带 tombstone:true 后扩散
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

        // 先从 HashMap 拿本地 note_id + content（key 是 stable_uuid）
        // T-S014：加密笔记的 local_notes content 是占位字符串而非真正内容，
        // 实际上传的密文走单独路径（按 stable_uuid 查 encrypted_blob）
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

        // 跳过：sync_remote_state 已记录同 hash（说明本机其它进程刚推过；幂等）
        // state_map 按本地 note_id 索引，所以前面必须先拿到 note_id
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
            format_note_md(&title, &content)
        };

        match backend.put_note(&entry.remote_path, &body_to_upload) {
            Ok(_) => {
                if let Err(e) = db.upsert_remote_state(
                    backend_id,
                    note_id,
                    &entry.remote_path,
                    &entry.content_hash,
                    &updated_at,
                    false,
                ) {
                    result.errors.push(format!(
                        "upsert sync_remote_state 失败 (note {}): {}",
                        note_id, e
                    ));
                }
                result.uploaded += 1;
            }
            Err(e) => {
                result
                    .errors
                    .push(format!("上传失败 {}: {}", entry.title, e));
            }
        }
    }

    // 写新的远端 manifest = merge(local, remote_独有)
    //
    // T-S013：以前的版本直接 `write_manifest(&local)` 会**吞掉远端独有项** ——
    // 比如本机推送时另一台设备刚好 push 了笔记 X，X 的 .md 文件已存在但本机本地 manifest 没有 X，
    // 写入时把 X 从远端 manifest 中抹掉 → 第三台设备 pull 看不到 X。
    //
    // 解决：在写之前重新读远端 manifest（捕获 race 期间别人的更新），
    // 合并 local 全量 + remote 独有，再写回去。
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
    let remote_now = match backend.read_manifest() {
        Ok(Some(m)) => m,
        Ok(None) => SyncManifestV1 {
            manifest_version: SyncManifestV1::VERSION,
            app_version: app_version.into(),
            device: device.into(),
            generated_at: String::new(),
            entries: vec![],
            hash_algo: Some(SyncManifestV1::HASH_ALGO_V2.into()),
            vault: None,
            attachments: vec![],
        },
        Err(e) => {
            result
                .errors
                .push(format!("合并前重读远端 manifest 失败: {}", e));
            // 退化为不合并：用 local。但这种情况"不写"更安全 → 这里仍用 local，因为写远端
            // manifest 失败的后果是"远端处于不一致中间态"，比"完全不写"略好
            local.clone()
        }
    };
    let merged = manifest::merge_manifests(&local, &remote_now);
    if let Err(e) = backend.write_manifest(&merged) {
        result.errors.push(format!("写远端 manifest 失败: {}", e));
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

/// 把笔记渲染成 markdown 文本（只是给 .md 文件用）
fn format_note_md(title: &str, content: &str) -> String {
    // 如果 content 已有 # 标题，避免重复
    let trimmed = content.trim_start();
    if trimmed.starts_with("# ") {
        return content.to_string();
    }
    format!("# {}\n\n{}", title, content)
}

/// 让未引用的常量不报警告（暂留给 pull 用）
#[allow(dead_code)]
const _MARKER: () = ();
