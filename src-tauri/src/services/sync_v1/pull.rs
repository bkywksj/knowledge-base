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

    // ── Bug 12b：projects / task_categories / tasks 三组的 pull
    //
    // 顺序很重要：
    //   1) task_categories  — tasks 可能引用 category_id
    //   2) projects         — tasks 可能引用 project_id
    //   3) tasks            — 引用以上 + 可能引用 parent_task_id（同批，按 uuid 解析两遍）
    //
    // 整体策略：上面 diff_manifests 已经按 last-write-wins 把要 pull 的条目筛进
    // diff.projects_to_pull / tasks_to_pull / task_categories_to_pull。
    // 这里只负责把每条远端 entry 实际落到本地（create or update）。
    apply_pulled_task_categories(db, &diff.task_categories_to_pull, &mut result);
    apply_pulled_projects(db, &diff.projects_to_pull, &mut result);
    apply_pulled_tasks(db, &diff.tasks_to_pull, &mut result);

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

/// pull → 任务分类：远端独有 → create_with_uuid；双方都有 → update_synced（按 name 等字段对齐）。
fn apply_pulled_task_categories(
    db: &Database,
    entries: &[crate::models::TaskCategoryManifestEntry],
    result: &mut SyncPullResult,
) {
    for e in entries {
        let icon_ref = e.icon.as_deref();
        match db.get_task_category_id_by_stable_uuid(&e.stable_id) {
            Ok(Some(local_id)) => {
                if let Err(err) =
                    db.update_task_category_synced(local_id, &e.name, &e.color, icon_ref, e.sort_order)
                {
                    result
                        .errors
                        .push(format!("更新本地任务分类 {} 失败: {}", e.name, err));
                }
            }
            Ok(None) => {
                if let Err(err) = db.create_task_category_with_uuid(
                    &e.stable_id,
                    &e.name,
                    &e.color,
                    icon_ref,
                    e.sort_order,
                ) {
                    result
                        .errors
                        .push(format!("创建本地任务分类 {} 失败: {}", e.name, err));
                }
            }
            Err(err) => result
                .errors
                .push(format!("查任务分类 UUID 失败 {}: {}", e.name, err)),
        }
    }
}

/// pull → 项目：远端独有 → create_with_uuid（含 tombstone：直接以 is_deleted=1 创建占位行，
/// 这样后续 task 拉到本端时 project_uuid → project_id 解析仍然能命中）；
/// 双方都有 → update_project_synced 全字段对齐。
fn apply_pulled_projects(
    db: &Database,
    entries: &[crate::models::ProjectManifestEntry],
    result: &mut SyncPullResult,
) {
    use crate::models::CreateProjectInput;
    for e in entries {
        let input = CreateProjectInput {
            name: e.name.clone(),
            description: e.description.clone(),
            color: Some(e.color.clone()),
            start_date: e.start_date.clone(),
            end_date: e.end_date.clone(),
        };
        match db.get_project_id_by_stable_uuid(&e.stable_id) {
            Ok(Some(local_id)) => {
                if let Err(err) = db.update_project_synced(
                    local_id,
                    &input,
                    e.archived,
                    e.sort_order,
                    e.tombstone,
                    &e.updated_at,
                ) {
                    result
                        .errors
                        .push(format!("更新本地项目 {} 失败: {}", e.name, err));
                }
            }
            Ok(None) => {
                match db.create_project_with_uuid(
                    &input,
                    &e.stable_id,
                    e.archived,
                    e.sort_order,
                    Some(&e.updated_at),
                ) {
                    Ok(new_id) if e.tombstone => {
                        // 远端是 tombstone → 本地创建后立刻软删，保持 UUID 占位但不可见
                        if let Err(err) = db.update_project_synced(
                            new_id,
                            &input,
                            e.archived,
                            e.sort_order,
                            true,
                            &e.updated_at,
                        ) {
                            result.errors.push(format!(
                                "对新建项目 {} 落 tombstone 失败: {}",
                                e.name, err
                            ));
                        }
                    }
                    Ok(_) => {}
                    Err(err) => result
                        .errors
                        .push(format!("创建本地项目 {} 失败: {}", e.name, err)),
                }
            }
            Err(err) => result
                .errors
                .push(format!("查项目 UUID 失败 {}: {}", e.name, err)),
        }
    }
}

/// pull → 任务：分两轮处理（解决 parent_task_uuid 同批引用问题）
/// - Pass 1：先创建/更新所有任务（parent_task_id 暂置 None）
/// - Pass 2：再回填 parent_task_id（此时所有 uuid 都已有 local_id）
///
/// project_uuid / category_uuid 在 Pass 1 中按需查找本地表（前置 apply_pulled_projects
/// / apply_pulled_task_categories 已保证此时它们已落库）。
fn apply_pulled_tasks(
    db: &Database,
    entries: &[crate::models::TaskManifestEntry],
    result: &mut SyncPullResult,
) {
    use crate::models::CreateTaskInput;
    if entries.is_empty() {
        return;
    }
    // Pass 1：写入主字段
    for e in entries {
        // project_uuid → project_id
        let project_id = match e.project_uuid.as_deref() {
            Some(u) => match db.get_project_id_by_stable_uuid(u) {
                Ok(id) => id,
                Err(err) => {
                    result.errors.push(format!(
                        "任务 {} 查 project_uuid 失败: {}",
                        e.title, err
                    ));
                    None
                }
            },
            None => None,
        };
        // category_uuid → category_id
        let category_id = match e.category_uuid.as_deref() {
            Some(u) => match db.get_task_category_id_by_stable_uuid(u) {
                Ok(id) => id,
                Err(err) => {
                    result.errors.push(format!(
                        "任务 {} 查 category_uuid 失败: {}",
                        e.title, err
                    ));
                    None
                }
            },
            None => None,
        };

        let input = CreateTaskInput {
            title: e.title.clone(),
            description: e.description.clone(),
            priority: Some(e.priority),
            important: Some(e.important),
            due_date: e.due_date.clone(),
            remind_before_minutes: None,
            links: None,
            repeat_kind: Some(e.repeat_kind.clone()),
            repeat_interval: Some(e.repeat_interval),
            repeat_weekdays: e.repeat_weekdays.clone(),
            repeat_until: e.repeat_until.clone(),
            repeat_count: e.repeat_count,
            source_batch_id: None,
            category_id,
            parent_task_id: None, // Pass 2 回填
            project_id,
            start_date: e.start_date.clone(),
        };

        match db.get_task_id_by_stable_uuid(&e.stable_id) {
            Ok(Some(local_id)) => {
                if let Err(err) = db.update_task_synced(
                    local_id,
                    &e.title,
                    e.description.as_deref(),
                    e.priority,
                    e.important,
                    e.status,
                    e.due_date.as_deref(),
                    e.start_date.as_deref(),
                    e.completed_at.as_deref(),
                    &e.kanban_stage,
                    category_id,
                    project_id,
                    None, // Pass 2 回填
                    &e.repeat_kind,
                    e.repeat_interval,
                    e.repeat_weekdays.as_deref(),
                    e.repeat_until.as_deref(),
                    e.repeat_count,
                    e.tombstone,
                    &e.updated_at,
                ) {
                    result
                        .errors
                        .push(format!("更新本地任务 {} 失败: {}", e.title, err));
                }
            }
            Ok(None) => {
                match db.create_task_with_uuid(
                    &input,
                    &e.stable_id,
                    &e.updated_at,
                    e.status,
                    e.completed_at.as_deref(),
                    &e.kanban_stage,
                ) {
                    Ok(new_id) if e.tombstone => {
                        // 远端 tombstone → 本端创建后立刻软删（保留 UUID 占位）
                        if let Err(err) = db.update_task_synced(
                            new_id,
                            &e.title,
                            e.description.as_deref(),
                            e.priority,
                            e.important,
                            e.status,
                            e.due_date.as_deref(),
                            e.start_date.as_deref(),
                            e.completed_at.as_deref(),
                            &e.kanban_stage,
                            category_id,
                            project_id,
                            None,
                            &e.repeat_kind,
                            e.repeat_interval,
                            e.repeat_weekdays.as_deref(),
                            e.repeat_until.as_deref(),
                            e.repeat_count,
                            true,
                            &e.updated_at,
                        ) {
                            result.errors.push(format!(
                                "对新建任务 {} 落 tombstone 失败: {}",
                                e.title, err
                            ));
                        }
                    }
                    Ok(_) => {}
                    Err(err) => result
                        .errors
                        .push(format!("创建本地任务 {} 失败: {}", e.title, err)),
                }
            }
            Err(err) => result
                .errors
                .push(format!("查任务 UUID 失败 {}: {}", e.title, err)),
        }
    }
    // Pass 2：回填 parent_task_id（拿到所有 task 的 local_id 后再处理）
    for e in entries {
        let parent_uuid = match e.parent_task_uuid.as_deref() {
            Some(u) if !u.is_empty() => u,
            _ => continue,
        };
        let parent_local = match db.get_task_id_by_stable_uuid(parent_uuid) {
            Ok(Some(id)) => id,
            Ok(None) => {
                result.errors.push(format!(
                    "任务 {} 的父任务 UUID {} 本地未找到（同批未拉到？）",
                    e.title, parent_uuid
                ));
                continue;
            }
            Err(err) => {
                result.errors.push(format!(
                    "查父任务 UUID {} 失败: {}",
                    parent_uuid, err
                ));
                continue;
            }
        };
        if let Ok(Some(local_id)) = db.get_task_id_by_stable_uuid(&e.stable_id) {
            // 只回写 parent_task_id 列（避免覆盖 Pass 1 已写的内容 / 触发 updated_at 变动用远端值）
            if let Err(err) = db.set_task_parent_synced(local_id, Some(parent_local), &e.updated_at)
            {
                result.errors.push(format!(
                    "回填任务 {} 的 parent_task_id 失败: {}",
                    e.title, err
                ));
            }
        }
    }
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

    // ───────── Bug 12b：apply_pulled_* 端到端测试 ─────────

    use crate::models::{
        ProjectManifestEntry, TaskCategoryManifestEntry, TaskManifestEntry,
    };

    fn mk_project_entry(uuid: &str, name: &str, ts: &str, tombstone: bool) -> ProjectManifestEntry {
        ProjectManifestEntry {
            stable_id: uuid.into(),
            name: name.into(),
            content_hash: format!("h-{}", uuid),
            updated_at: ts.into(),
            description: None,
            color: "#ff0000".into(),
            start_date: None,
            end_date: None,
            archived: false,
            sort_order: 0,
            tombstone,
        }
    }

    fn mk_task_entry(
        uuid: &str,
        title: &str,
        ts: &str,
        project_uuid: Option<&str>,
        category_uuid: Option<&str>,
        parent_uuid: Option<&str>,
        tombstone: bool,
    ) -> TaskManifestEntry {
        TaskManifestEntry {
            stable_id: uuid.into(),
            title: title.into(),
            content_hash: format!("h-{}", uuid),
            updated_at: ts.into(),
            description: None,
            priority: 1,
            important: false,
            status: 0,
            due_date: None,
            start_date: None,
            completed_at: None,
            kanban_stage: "todo".into(),
            parent_task_uuid: parent_uuid.map(String::from),
            project_uuid: project_uuid.map(String::from),
            category_uuid: category_uuid.map(String::from),
            repeat_kind: "none".into(),
            repeat_interval: 1,
            repeat_weekdays: None,
            repeat_until: None,
            repeat_count: None,
            tombstone,
        }
    }

    fn mk_category_entry(uuid: &str, name: &str) -> TaskCategoryManifestEntry {
        TaskCategoryManifestEntry {
            stable_id: uuid.into(),
            name: name.into(),
            content_hash: format!("h-{}", uuid),
            color: "#1677ff".into(),
            icon: None,
            sort_order: 0,
        }
    }

    /// apply_pulled_task_categories：远端独有 → 本地创建；本地已有 → 改名对齐
    #[test]
    fn apply_pulled_task_categories_creates_then_updates() {
        let db = Database::init(":memory:").unwrap();
        let mut result = SyncPullResult::default();

        // 1) 首次：远端独有 → 本地新建
        apply_pulled_task_categories(
            &db,
            &[mk_category_entry("uuid-c1", "工作")],
            &mut result,
        );
        let cats = db.list_task_categories().unwrap();
        let c1 = cats
            .iter()
            .find(|c| c.stable_uuid.as_deref() == Some("uuid-c1"))
            .expect("uuid-c1 应已创建");
        assert_eq!(c1.name, "工作");

        // 2) 同 uuid 再次拉到（改名）→ 本端更新
        let mut entry = mk_category_entry("uuid-c1", "学习");
        entry.color = "#00ff00".into();
        apply_pulled_task_categories(&db, &[entry], &mut result);
        let cats2 = db.list_task_categories().unwrap();
        let c2 = cats2
            .iter()
            .find(|c| c.stable_uuid.as_deref() == Some("uuid-c1"))
            .unwrap();
        assert_eq!(c2.name, "学习");
        assert_eq!(c2.color, "#00ff00");
        assert!(result.errors.is_empty(), "应无错误: {:?}", result.errors);
    }

    /// apply_pulled_projects：远端独有 → 本地创建，updated_at 用远端值；
    /// 远端 tombstone 项目 → 本地占位但 is_deleted=1
    #[test]
    fn apply_pulled_projects_creates_with_remote_ts_and_handles_tombstone() {
        let db = Database::init(":memory:").unwrap();
        let mut result = SyncPullResult::default();

        apply_pulled_projects(
            &db,
            &[
                mk_project_entry("uuid-p1", "项目A", "2026-03-01 10:00:00", false),
                mk_project_entry("uuid-p2", "项目B", "2026-03-02 10:00:00", true), // 远端已删
            ],
            &mut result,
        );

        // p1 应正常出现在 list_projects 里
        let p1_id = db.get_project_id_by_stable_uuid("uuid-p1").unwrap();
        assert!(p1_id.is_some(), "uuid-p1 应已创建");
        let live = db.list_projects(true).unwrap();
        assert!(
            live.iter().any(|p| p.stable_uuid.as_deref() == Some("uuid-p1")),
            "p1 应在 live list（is_deleted=0）"
        );

        // p2 应在 _for_sync 里（含墓碑）但不在 list_projects（过滤了 is_deleted=1）
        let p2_id = db.get_project_id_by_stable_uuid("uuid-p2").unwrap();
        assert!(p2_id.is_some(), "uuid-p2 应占位创建");
        let live_p2 = live.iter().any(|p| p.stable_uuid.as_deref() == Some("uuid-p2"));
        assert!(!live_p2, "p2 在 live list 中应不可见（tombstone）");
        let all_for_sync = db.list_projects_for_sync().unwrap();
        let p2 = all_for_sync
            .iter()
            .find(|p| p.stable_uuid.as_deref() == Some("uuid-p2"))
            .unwrap();
        assert!(p2.is_deleted, "p2 应为 tombstone（is_deleted=1）");

        // updated_at 应用远端值
        let p1 = all_for_sync
            .iter()
            .find(|p| p.stable_uuid.as_deref() == Some("uuid-p1"))
            .unwrap();
        assert_eq!(p1.updated_at, "2026-03-01 10:00:00");

        assert!(result.errors.is_empty(), "应无错误: {:?}", result.errors);
    }

    /// apply_pulled_tasks：完整链路 — 先拉 categories + projects，再拉 task，
    /// 验证 category_id / project_id / parent_task_id（同批引用） 全部解析正确
    #[test]
    fn apply_pulled_tasks_resolves_uuid_references_and_parent_in_same_batch() {
        let db = Database::init(":memory:").unwrap();
        let mut result = SyncPullResult::default();

        // 1) 先准备好 category + project（pull 顺序保证）
        apply_pulled_task_categories(&db, &[mk_category_entry("c-uuid", "工作")], &mut result);
        apply_pulled_projects(
            &db,
            &[mk_project_entry("p-uuid", "项目A", "2026-03-01 10:00:00", false)],
            &mut result,
        );

        // 2) 同批两条任务：父 + 子
        let parent = mk_task_entry(
            "tk-parent",
            "父任务",
            "2026-03-01 11:00:00",
            Some("p-uuid"),
            Some("c-uuid"),
            None,
            false,
        );
        // 子任务在数组中出现在父任务之前 → 验证 Pass 2 回填能跨顺序工作
        let child = mk_task_entry(
            "tk-child",
            "子任务",
            "2026-03-01 11:00:01",
            Some("p-uuid"),
            None,
            Some("tk-parent"),
            false,
        );
        apply_pulled_tasks(&db, &[child, parent], &mut result);

        assert!(result.errors.is_empty(), "应无错误: {:?}", result.errors);

        // 3) 验证
        let p_local_id = db.get_project_id_by_stable_uuid("p-uuid").unwrap().unwrap();
        let c_local_id = db
            .get_task_category_id_by_stable_uuid("c-uuid")
            .unwrap()
            .unwrap();
        let parent_local = db.get_task_id_by_stable_uuid("tk-parent").unwrap().unwrap();

        let all = db.list_tasks_for_sync().unwrap();
        let parent_t = all
            .iter()
            .find(|t| t.stable_uuid.as_deref() == Some("tk-parent"))
            .unwrap();
        assert_eq!(parent_t.project_id, Some(p_local_id));
        assert_eq!(parent_t.category_id, Some(c_local_id));
        assert_eq!(parent_t.parent_task_id, None);
        assert_eq!(parent_t.updated_at, "2026-03-01 11:00:00");

        let child_t = all
            .iter()
            .find(|t| t.stable_uuid.as_deref() == Some("tk-child"))
            .unwrap();
        assert_eq!(child_t.project_id, Some(p_local_id));
        assert_eq!(
            child_t.parent_task_id,
            Some(parent_local),
            "Pass 2 应已回填 parent_task_id"
        );
    }

    /// 远端 tombstone 任务 → 本地占位 + is_deleted=1
    #[test]
    fn apply_pulled_tasks_handles_remote_tombstone() {
        let db = Database::init(":memory:").unwrap();
        let mut result = SyncPullResult::default();

        let t = mk_task_entry(
            "tk-x",
            "被删的任务",
            "2026-04-01 10:00:00",
            None,
            None,
            None,
            true, // tombstone
        );
        apply_pulled_tasks(&db, &[t], &mut result);

        let all = db.list_tasks_for_sync().unwrap();
        let row = all
            .iter()
            .find(|t| t.stable_uuid.as_deref() == Some("tk-x"))
            .expect("应占位创建");
        assert!(row.is_deleted, "远端 tombstone → 本地软删");
        assert!(result.errors.is_empty(), "应无错误: {:?}", result.errors);
    }
}
