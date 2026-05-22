//! V1 拉取：远端 → 本地
//!
//! 流程：
//! 1. 读远端 manifest（首次 → 当无操作返回）
//! 2. 计算本地 manifest
//! 3. diff
//! 4. 对 to_pull：从 backend.get_note 拉 .md 文本 → 解析 title + body → upsert 到本地
//! 5. 对 to_delete_local：软删本地笔记（v1 不实际删，仅 set is_deleted=1）
//! 6. 冲突 (conflicts)：默认 last-write-wins（按 updated_at 较新者赢）。两种情况会把远端版本
//!    落到 `<app_data>/sync_conflicts/backend_<id>/<sid>_<ts>.md`，本地保持原样、等用户在设置页合并：
//!      a) 双方 updated_at 完全相同但内容 hash 不同（manifest diff 的 `conflicts` 集合，极小概率）
//!      b) T-S051：本地有未推送改动 + 远端也改了（to_pull 里 `is_divergence` 检测命中）

use std::path::Path;

use tauri::{Emitter, Runtime};

use crate::database::Database;
use crate::error::AppError;
use crate::models::{NoteInput, SyncManifestV1, SyncPullResult};

use super::backend::SyncBackendImpl;
use super::manifest;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    backend_id: i64,
    phase: String, // "compute" | "diff" | "download" | "apply" | "done"
    current: usize,
    total: usize,
    message: String,
}

pub fn pull<R: Runtime, E: Emitter<R>>(
    db: &Database,
    backend_id: i64,
    backend: &dyn SyncBackendImpl,
    app_version: &str,
    device: &str,
    conflicts_dir: &Path,
    data_dir: &Path,
    emitter: &E,
) -> Result<SyncPullResult, AppError> {
    let mut result = SyncPullResult::default();
    let event_name = "sync_v1:progress";

    let _ = emitter.emit(
        event_name,
        ProgressEvent {
            backend_id,
            phase: "compute".into(),
            current: 0,
            total: 0,
            message: "拉取远端 manifest…".into(),
        },
    );
    let remote = match backend.read_manifest()? {
        Some(m) => m,
        None => {
            // 远端没东西，无操作
            return Ok(result);
        }
    };

    // hash 算法兼容性检查（v1 → v2 升级）：
    // 远端 manifest 不带 hash_algo（旧客户端写的）且有内容 → 当前的 v2 公式与远端不一致，
    // diff 会把所有笔记误判为变更。处理：清空本机 sync_remote_state（防止误判跳过），
    // 本次 pull 直接退出；下次 push 会把本地全部笔记当作首次推送，写出 v2 格式 manifest 完成升级。
    if !remote.entries.is_empty()
        && remote.hash_algo.as_deref() != Some(SyncManifestV1::HASH_ALGO_V2)
    {
        log::warn!(
            "[sync_v1] backend {} 远端 manifest 用旧 hash 算法 ({:?})，跳过本次 pull 并清空本地 sync_remote_state；下次 push 将全量重传升级到 v2",
            backend_id,
            remote.hash_algo
        );
        let cleared = db.clear_remote_state_for_backend(backend_id)?;
        log::info!("[sync_v1] 已清空 {} 条 sync_remote_state（backend {}）", cleared, backend_id);
        // P2-a：之前直接 return 空 result → 前端弹"拉取完成：下载 0 / 冲突 0"像"已是最新"，
        // 用户无从得知"远端还是旧格式、必须 push 一次才能升级"。塞一条 errors 提示，
        // 让前端 modal.warning 弹出来引导用户（push 端遇旧 manifest 会自愈，pull 端不会）。
        result.errors.push(
            "远端 manifest 仍是旧版本格式（hash 算法 v1）。本次拉取已跳过 —— 请点「推送」或「后台同步」一次，会自动把远端升级到新格式，之后拉取即恢复正常。".into(),
        );
        return Ok(result);
    }

    // T-S014：vault meta 跨端同步
    // - 远端有 + 本机无 → 导入（用户用相同密码可解锁）
    // - 远端有 + 本机有 + salt 不同 → 警告（加密笔记会跳过同步，普通笔记照常）
    // - 远端有 + 本机有 + salt 相同 → 一致，加密笔记可互通
    // - 远端无 → 不处理
    let remote_vault_compatible = match remote.vault.as_ref() {
        None => false, // 远端没设置 vault → 加密笔记无法跨端
        Some(meta) => {
            match crate::services::vault::VaultService::import_meta_if_not_set(db, meta) {
                Ok(true) => {
                    log::info!(
                        "[sync_v1] 本机 vault 从远端 manifest 导入 salt+verifier（首次同步加密笔记）"
                    );
                    true
                }
                Ok(false) => {
                    // 本机已有，比对 salt
                    match crate::services::vault::VaultService::meta_matches(db, meta) {
                        Ok(true) => true,
                        Ok(false) => {
                            log::warn!(
                                "[sync_v1] 远端 vault salt 与本机不同，加密笔记不参与本次同步"
                            );
                            false
                        }
                        Err(e) => {
                            log::warn!("[sync_v1] vault meta 比对失败 {}: 加密笔记跳过", e);
                            false
                        }
                    }
                }
                Err(e) => {
                    log::warn!("[sync_v1] 导入远端 vault meta 失败: {}（加密笔记跳过）", e);
                    false
                }
            }
        }
    };

    let local = manifest::compute_local_manifest(db, app_version, device)?;

    let _ = emitter.emit(
        event_name,
        ProgressEvent {
            backend_id,
            phase: "diff".into(),
            current: 0,
            total: 0,
            message: "对比本地…".into(),
        },
    );
    let diff = manifest::diff_manifests(&local, &remote);

    // ── T-S024：附件下载阶段（先于笔记 entry pull，让笔记内容拉下来时附件已就位）
    //
    // 流程：
    //   远端 manifest.attachments - 本地 unique hashes → 差集要下载
    //   下载内容写到 {prefix}kb_assets/sync_in/<hash>.<ext>（dev/prod 目录前缀对齐）
    //
    // 路径还原说明：pull 端的笔记 .md 里可能引用 `kb_assets/images/xxx.png` 等原始路径，
    // 但拉到的实际文件落在 sync_in/ → 编辑器/渲染器需要做 hash 反查 fallback。
    // 这是后续 UI 任务（不在 T-S024 范围），现阶段保证字节到达本地即可。
    let local_hashes: std::collections::HashSet<String> = db
        .list_all_unique_attachments()
        .unwrap_or_default()
        .into_iter()
        .map(|r| r.sha256_hex)
        .collect();
    let to_download: Vec<&crate::models::AttachmentEntry> = remote
        .attachments
        .iter()
        .filter(|a| !local_hashes.contains(&a.hash))
        .collect();
    let total_dl = to_download.len();
    if total_dl > 0 {
        let assets_prefix = if cfg!(debug_assertions) {
            "dev-kb_assets"
        } else {
            "kb_assets"
        };
        let sync_in_dir = data_dir.join(assets_prefix).join("sync_in");
        if let Err(e) = std::fs::create_dir_all(&sync_in_dir) {
            log::warn!("[sync_v1] 创建 sync_in 目录失败 ({}): {}", sync_in_dir.display(), e);
        }

        for (idx, att) in to_download.iter().enumerate() {
            let _ = emitter.emit(
                event_name,
                ProgressEvent {
                    backend_id,
                    phase: "attachments".into(),
                    current: idx + 1,
                    total: total_dl,
                    message: format!(
                        "下载附件 {} ({} bytes)",
                        &att.hash[..att.hash.len().min(8)],
                        att.size
                    ),
                },
            );

            match backend.get_attachment(&att.hash) {
                Ok(Some(bytes)) => {
                    // 1) 总是落一份 sync_in/<hash>.<ext>（CAS 镜像，下次同步前的快取）
                    let ext = att.ext.as_deref().unwrap_or("bin");
                    let mirror = sync_in_dir.join(format!("{}.{}", att.hash, ext));
                    if let Err(e) = std::fs::write(&mirror, &bytes) {
                        result
                            .errors
                            .push(format!("写入附件 {} 失败: {}", mirror.display(), e));
                        continue;
                    }
                    result.attachments_downloaded += 1;

                    // 2) Bug 9：按 manifest 携带的 paths 把字节还原到原相对路径，让笔记里
                    //    kb-asset://kb_assets/images/... 引用能命中。同 hash 多 path 全部还原。
                    //    旧 manifest 不带 paths → 不还原（向后兼容；下次写端 push 后下次 pull 才修上）。
                    for rel in &att.paths {
                        // 防御：拒绝绝对路径 / 路径穿越（manifest 来自其他端，不能完全信任）
                        if rel.is_empty()
                            || rel.starts_with('/')
                            || rel.starts_with('\\')
                            || rel.contains("..")
                            || rel.contains(":\\")
                            || rel.contains(":/")
                        {
                            result.errors.push(format!(
                                "拒绝可疑附件路径 {} (hash {})",
                                rel,
                                &att.hash[..att.hash.len().min(8)]
                            ));
                            continue;
                        }
                        let target = data_dir.join(rel);
                        // 已存在且字节相同 → 跳过（避免覆盖用户本地版本，也减少 IO）
                        if target.exists() {
                            if let Ok(existing) = std::fs::read(&target) {
                                if existing == bytes {
                                    continue;
                                }
                            }
                        }
                        if let Some(parent) = target.parent() {
                            if let Err(e) = std::fs::create_dir_all(parent) {
                                result.errors.push(format!(
                                    "创建附件目录失败 {}: {}",
                                    parent.display(),
                                    e
                                ));
                                continue;
                            }
                        }
                        // 写盘后无须立刻 upsert note_attachments —— 下次 push 前 scan_all_active_notes
                        // 会扫到引用这条 path 的笔记（因为 attachment_scan_at 此时落后于 updated_at），
                        // 自动 upsert 进 note_attachments。这样避免 pull 端额外猜测哪条笔记引用了它。
                        if let Err(e) = std::fs::write(&target, &bytes) {
                            result.errors.push(format!(
                                "还原附件到 {} 失败: {}",
                                target.display(),
                                e
                            ));
                        }
                    }
                }
                Ok(None) => result.errors.push(format!(
                    "远端 manifest 有附件 {} 但 get_attachment 返回空",
                    &att.hash[..att.hash.len().min(8)]
                )),
                Err(e) => result.errors.push(format!(
                    "下载附件 {} 失败: {}",
                    &att.hash[..att.hash.len().min(8)],
                    e
                )),
            }
        }
    }

    // T-S051: 分歧检测准备数据
    //  - local_hash_by_uuid：本地每条笔记的当前内容 hash（用 stable_uuid 索引）
    //  - remote_states：本地与该 backend 的同步状态（含 last_synced_hash = 上次同步时的内容 hash）
    // 若一条笔记在 to_pull 里（远端较新），但本地当前 hash 已偏离 last_synced（说明本地也改过了），
    // 且与远端 hash 也不同 → 双方各改各的 → 不静默覆盖本地，而是把远端版本落冲突文件等用户合并。
    let local_hash_by_uuid: std::collections::HashMap<&str, &str> = local
        .entries
        .iter()
        .map(|e| (e.stable_id.as_str(), e.content_hash.as_str()))
        .collect();
    // 方案 C：本地每条笔记当前的 updated_at（按 stable_uuid 索引）——
    // pull 据此判断要不要用远端标签覆盖本地（本地标签较新时不覆盖，见 should_overwrite_tags）
    let local_updated_at_by_uuid: std::collections::HashMap<&str, &str> = local
        .entries
        .iter()
        .map(|e| (e.stable_id.as_str(), e.updated_at.as_str()))
        .collect();
    let remote_states = db.list_remote_state(backend_id)?;

    // ── 处理 to_pull（远端独有 / 远端较新）
    let total_pull = diff.to_pull.len();
    for (idx, entry) in diff.to_pull.iter().enumerate() {
        let _ = emitter.emit(
            event_name,
            ProgressEvent {
                backend_id,
                phase: "download".into(),
                current: idx + 1,
                total: total_pull,
                message: format!("下载 {}", entry.title),
            },
        );
        let body = match backend.get_note(&entry.remote_path)? {
            Some(s) => s,
            None => {
                result.errors.push(format!(
                    "远端 manifest 有 {} 但 .md 文件丢失",
                    entry.remote_path
                ));
                continue;
            }
        };
        let folder_id = ensure_folder_path(db, &entry.folder_path)?;

        // T-S014：加密笔记走密文 upsert 分支
        if entry.encrypted {
            if !remote_vault_compatible {
                // 计入 encrypted_skipped 让前端给用户弹提示（之前只 warn 日志，用户毫无感知 →
                // 误以为加密笔记也同步了，实则被静默跳过 / 多端 vault salt 不一致永远互不可见）
                result.encrypted_skipped += 1;
                log::warn!(
                    "[sync_v1] 跳过加密笔记 {}（vault meta 不匹配或缺失）",
                    entry.title
                );
                continue;
            }
            // P0-5：加密笔记也做分歧检测 —— 本地有未推送改动且与远端各不相同 →
            // 不静默用远端密文覆盖本地，落冲突文件保留本地。加密笔记冲突在 UI 上
            // 只能"忽略"（密文不可合并），但至少本地这次编辑不会被悄悄冲掉。
            if let Some(local_id) = db.get_note_id_by_stable_uuid(&entry.stable_id)? {
                let diverged = is_divergence(
                    local_hash_by_uuid.get(entry.stable_id.as_str()).copied(),
                    remote_states.get(&local_id).map(|s| s.last_synced_hash.as_str()),
                    &entry.content_hash,
                );
                if diverged {
                    match super::conflicts::write_conflict_file(
                        conflicts_dir,
                        &entry.stable_id,
                        &body,
                    ) {
                        Ok(_) => {
                            result.conflicts += 1;
                            log::warn!(
                                "[sync_v1] 加密笔记 {} 本地/远端各改各的，已落冲突文件，本地保留（密文不可合并，请在设置页处理）",
                                entry.title
                            );
                        }
                        Err(e) => result
                            .errors
                            .push(format!("写加密冲突文件失败 ({}): {}", entry.title, e)),
                    }
                    continue;
                }
            }
            use base64::Engine as _;
            let blob = match base64::engine::general_purpose::STANDARD.decode(body.as_bytes()) {
                Ok(b) => b,
                Err(e) => {
                    result.errors.push(format!(
                        "加密笔记 {} base64 解码失败: {}",
                        entry.title, e
                    ));
                    continue;
                }
            };
            match db.upsert_encrypted_note_with_uuid(
                &entry.stable_id,
                &entry.title,
                &blob,
                folder_id,
            ) {
                Ok(local_id) => {
                    result.downloaded += 1;
                    if let Err(e) = db.upsert_remote_state(
                        backend_id,
                        local_id,
                        &entry.remote_path,
                        &entry.content_hash,
                        &entry.updated_at,
                        false,
                    ) {
                        result
                            .errors
                            .push(format!("upsert sync_remote_state 失败: {}", e));
                    }
                }
                Err(e) => result
                    .errors
                    .push(format!("写入加密笔记失败 {}: {}", entry.title, e)),
            }
            continue;
        }

        // 非加密笔记：原 markdown 路径（解析 front-matter / 兼容旧 # 标题格式）
        let (title, content) = super::note_md::parse_note_md(&body, &entry.title);
        let input = NoteInput {
            title,
            content,
            folder_id,
        };

        // T-S011：entry.stable_id 现在是 UUID（v36）。先按 stable_uuid 查本地 → 决定 update/create
        let local_id_for_state = match db.get_note_id_by_stable_uuid(&entry.stable_id)? {
            Some(local_id) => {
                // T-S051: 分歧检测 —— 本地有未推送改动且与远端各不相同 → 不覆盖，落冲突文件保留本地
                let diverged = is_divergence(
                    local_hash_by_uuid.get(entry.stable_id.as_str()).copied(),
                    remote_states.get(&local_id).map(|s| s.last_synced_hash.as_str()),
                    &entry.content_hash,
                );
                if diverged {
                    match super::conflicts::write_conflict_file(
                        conflicts_dir,
                        &entry.stable_id,
                        &body,
                    ) {
                        Ok(_) => {
                            result.conflicts += 1;
                            log::warn!(
                                "[sync_v1] 笔记 {} 本地/远端各改各的，已把远端版本落冲突文件，本地保留（等用户在设置页解决）",
                                entry.title
                            );
                        }
                        Err(e) => result
                            .errors
                            .push(format!("写冲突文件失败 ({}): {}", entry.title, e)),
                    }
                    continue; // 不 update_note、不 upsert_remote_state → 保留本地，等用户在设置页解决
                }
                // pull 是被动接收 → updated_at 用远端 entry 的值，不冒泡到 now（修同步震荡 / 时间失真）
                match db.update_note_synced(local_id, &input, &entry.updated_at) {
                    Ok(_) => {
                        // 把"每日笔记"标记对齐到远端 manifest entry（远端是日记本地不是 → 恢复；反之则清）
                        if let Err(e) = db.sync_note_daily_state(
                            local_id,
                            entry.is_daily,
                            entry.daily_date.as_deref(),
                        ) {
                            result
                                .errors
                                .push(format!("对齐日记标记失败 {}: {}", entry.title, e));
                        }
                        // 把"隐藏"标记对齐（仅单向：远端隐藏 → 本地也隐藏，避免隐藏笔记在新端变可见）
                        if let Err(e) = db.sync_note_hidden_state(local_id, entry.is_hidden) {
                            result
                                .errors
                                .push(format!("对齐隐藏标记失败 {}: {}", entry.title, e));
                        }
                        // Bug 12a：按 name 替换本地 tag 关联。Option 区分新旧客户端：
                        //   None → 旧 manifest 没此字段 / 加密笔记 / tombstone → 不动
                        //   Some(_) → 替换（含 Some(vec![]) → 清空，让"用户在另一端删空标签"也能跨端传播）
                        // 方案 C：仅当远端 entry 不旧于本地时才覆盖标签（should_overwrite_tags）——
                        // 本地标签较新时保留本地，不被远端旧标签回滚（P0-1）。
                        if let Some(tag_names) = entry.tags.as_ref() {
                            let local_ua = local_updated_at_by_uuid
                                .get(entry.stable_id.as_str())
                                .copied();
                            if should_overwrite_tags(&entry.updated_at, local_ua) {
                                if let Err(e) = db.sync_note_tags(local_id, tag_names) {
                                    result
                                        .errors
                                        .push(format!("对齐标签失败 {}: {}", entry.title, e));
                                }
                            }
                        }
                        Some(local_id)
                    }
                    Err(e) => {
                        result
                            .errors
                            .push(format!("更新本地笔记失败 {}: {}", entry.title, e));
                        None
                    }
                }
            }
            None => {
                // 本地没有 → 用远端 UUID 创建（保持多端 ID 稳定）+ 透传 is_daily/daily_date/is_hidden
                // （否则拉来的日记变普通笔记 → get_or_create_daily 反复新建；隐藏笔记拉到对端变可见）
                match db.create_note_with_uuid(
                    &input,
                    &entry.stable_id,
                    entry.is_daily,
                    entry.daily_date.as_deref(),
                    entry.is_hidden,
                ) {
                    Ok(n) => {
                        // Bug 12a：新建笔记同步标签（旧 manifest tags=None → 跳过）
                        if let Some(tag_names) = entry.tags.as_ref() {
                            if let Err(e) = db.sync_note_tags(n.id, tag_names) {
                                result
                                    .errors
                                    .push(format!("新建笔记设置标签失败 {}: {}", entry.title, e));
                            }
                        }
                        Some(n.id)
                    }
                    Err(e) => {
                        result
                            .errors
                            .push(format!("新建本地笔记失败 {}: {}", entry.title, e));
                        None
                    }
                }
            }
        };

        if let Some(local_id) = local_id_for_state {
            result.downloaded += 1;
            if let Err(e) = db.upsert_remote_state(
                backend_id,
                local_id,
                &entry.remote_path,
                &entry.content_hash,
                &entry.updated_at,
                false,
            ) {
                result
                    .errors
                    .push(format!("upsert sync_remote_state 失败: {}", e));
            }
            // 反链 pull 后重建：原本只有"前端 handleSave"才会触发 sync_note_links，
            // 新端 pull 完笔记不打开就拿不到反向链接。这里立刻按 content 重新解析
            // [[wiki]] 写 note_links 表，让反链面板第一次打开就准确。
            // 失败只记 warn 不影响主流程（反链数据可由用户编辑保存自愈）。
            if let Err(e) = db.rebuild_note_links_from_content(local_id, &input.content) {
                log::warn!("[sync_v1] 重建反链失败 {}: {}", entry.title, e);
            }
        }
    }

    // ── 处理 to_delete_local（远端 tombstone）
    for entry in &diff.to_delete_local {
        // T-S011：按 stable_uuid 找本地 id，没找到说明本地本就没有此笔记，跳过
        let local_id = match db.get_note_id_by_stable_uuid(&entry.stable_id)? {
            Some(id) => id,
            None => continue,
        };
        match db.soft_delete_note(local_id) {
            Ok(true) => {
                result.deleted_local += 1;
                let _ = db.upsert_remote_state(
                    backend_id,
                    local_id,
                    &entry.remote_path,
                    &entry.content_hash,
                    &entry.updated_at,
                    true,
                );
            }
            Ok(false) => {} // 本地已没有
            Err(e) => result
                .errors
                .push(format!("软删本地失败 {}: {}", entry.title, e)),
        }
    }

    // ── 处理 conflicts（updated_at 相同但 hash 不同）
    for pair in &diff.conflicts {
        result.conflicts += 1;
        // 把远端版本落地到 sync_conflicts/，让用户在设置页手动选
        match backend.get_note(&pair.remote.remote_path) {
            Ok(Some(remote_body)) => {
                if let Err(e) = super::conflicts::write_conflict_file(
                    conflicts_dir,
                    &pair.remote.stable_id,
                    &remote_body,
                ) {
                    result.errors.push(format!("写冲突文件失败: {}", e));
                }
            }
            Ok(None) => {}
            Err(e) => result.errors.push(format!("拉远端冲突文件失败: {}", e)),
        }
    }

    db.touch_sync_backend_pull(backend_id)?;

    let _ = emitter.emit(
        event_name,
        ProgressEvent {
            backend_id,
            phase: "done".into(),
            current: 0,
            total: 0,
            message: format!(
                "拉取完成: 下载 {} / 删本地 {} / 冲突 {} / 错误 {}",
                result.downloaded,
                result.deleted_local,
                result.conflicts,
                result.errors.len()
            ),
        },
    );

    Ok(result)
}

/// T-S051: 判定一条 to_pull 笔记是否"本地远端各改各的"
///
/// 条件：本地当前 hash 已知 + 上次同步 hash 已知 + 本地 ≠ 上次同步（本地有未推送改动）
///       + 本地 ≠ 远端（远端确实带来了不同内容）→ 真分歧。
/// 任一信息缺失（如该笔记从未同步过、本地刚 create）→ 不算分歧（按原 last-write-wins 走）。
fn is_divergence(local_hash: Option<&str>, last_synced_hash: Option<&str>, remote_hash: &str) -> bool {
    match (local_hash, last_synced_hash) {
        (Some(lh), Some(ls)) => lh != ls && lh != remote_hash,
        _ => false,
    }
}

/// 方案 C：pull 时是否该用远端标签覆盖本地标签。
///
/// 标签变更已冒泡 `updated_at`（见 `database::tags` 的 `bump_note_updated_at`），故按
/// last-write-wins：远端 entry 的 `updated_at` 不旧于本地 → 覆盖；本地较新 → 保留本地
/// （这条 entry 多半是因 is_daily / is_hidden 恢复被一起拉下来的，标签不该跟着回滚）。
/// 本地 `updated_at` 缺失（理论上不会发生）→ 兜底覆盖。
fn should_overwrite_tags(remote_updated_at: &str, local_updated_at: Option<&str>) -> bool {
    match local_updated_at {
        Some(lua) => remote_updated_at >= lua,
        None => true,
    }
}

/// 把 "工作/周报" 风格的路径递归展平成 folder_id
///
/// 复用 `FolderService::ensure_path`（T-006 阶段已实现）
fn ensure_folder_path(db: &Database, path: &str) -> Result<Option<i64>, AppError> {
    if path.is_empty() {
        return Ok(None);
    }
    crate::services::folder::FolderService::ensure_path(db, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn divergence_only_when_both_changed_and_differ() {
        // 本地改了（≠ 上次同步），远端也带来不同内容（≠ 本地）→ 分歧
        assert!(is_divergence(Some("localH"), Some("syncedH"), "remoteH"));
        // 本地没改（== 上次同步）→ 不是分歧，正常 last-write-wins 拉远端
        assert!(!is_divergence(Some("syncedH"), Some("syncedH"), "remoteH"));
        // 本地改了，但改成的内容恰好和远端一样 → 不算分歧（只需更新时间戳）
        assert!(!is_divergence(Some("sameH"), Some("syncedH"), "sameH"));
        // 该笔记从未同步过 / 信息缺失 → 不算分歧
        assert!(!is_divergence(Some("localH"), None, "remoteH"));
        assert!(!is_divergence(None, Some("syncedH"), "remoteH"));
    }

    #[test]
    fn overwrite_tags_only_when_remote_not_older() {
        // 远端 entry 较新 → 用远端标签覆盖本地
        assert!(should_overwrite_tags("2026-02-01 00:00:00", Some("2026-01-01 00:00:00")));
        // updated_at 持平 → 覆盖（标签冲突极小概率，远端赢，结果确定）
        assert!(should_overwrite_tags("2026-01-01 00:00:00", Some("2026-01-01 00:00:00")));
        // 本地较新 → 保留本地标签，不回滚（P0-1 核心）
        assert!(!should_overwrite_tags("2026-01-01 00:00:00", Some("2026-02-01 00:00:00")));
        // 本地 updated_at 缺失 → 兜底覆盖
        assert!(should_overwrite_tags("2026-01-01 00:00:00", None));
    }
}
