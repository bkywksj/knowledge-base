//! Manifest 计算 + diff
//!
//! `compute_local_manifest`：扫一遍 notes 表 + sync_remote_state，得到当前本地视角的 manifest
//! `diff_manifests`：比对本地 vs 远端 manifest，得出 push / pull / conflict 集合

use std::collections::HashMap;

use sha2::{Digest, Sha256};

use crate::database::Database;
use crate::error::AppError;
use crate::models::{ManifestEntry, SyncManifestV1};
use crate::services::hash::sha256_hex;

/// 计算 manifest entry 的 content_hash（v2 算法，SHA-256 hex 小写）
///
/// 公式：`SHA-256(title + "\n" + content_hash_hex)`
///
/// `content_hash_hex` 必须是 v22 起 `notes.content_hash` 列的值（即 `sha256(content)` 的 hex）。
/// 这样 manifest 计算只需读 hash 列，无需读笔记 content；title 改动也会传递到结果（因为参与拼接）。
pub fn content_hash(title: &str, content_hash_hex: &str) -> String {
    let mut h = Sha256::new();
    h.update(title.as_bytes());
    h.update(b"\n");
    h.update(content_hash_hex.as_bytes());
    format!("{:x}", h.finalize())
}

/// 远端文件路径约定：`notes/<stable_id>.md`
///
/// stable_id 现在 = `notes.stable_uuid`（v36 起，UUID v4），保证多端共用同一文件路径。
/// 早期版本曾用本地 i64 笔记 id，会导致多端撞车 → T-S011 已切换为 UUID。
pub fn remote_path_for(stable_id: &str) -> String {
    format!("notes/{}.md", stable_id)
}

/// tombstone 在 manifest 中保留的天数。超过此天数后被排除（GC，防止无限增长）。
/// 30 天对"多端拉取频率"是宽松值：常用设备 30 天内一定会同步一次，看到 tombstone 就软删本地。
pub const TOMBSTONE_RETENTION_DAYS: i64 = 30;

/// 从本地 notes 表 + folders 树构建 manifest
///
/// 包含：
/// - 所有未删除的笔记（tombstone=false）
/// - 最近 [`TOMBSTONE_RETENTION_DAYS`] 天内 soft delete 的笔记（tombstone=true）
///   —— 让其他端拉到后跟着删；超期 tombstone 被 GC 排除以防 manifest 无限膨胀
/// - 加密笔记仅保留 placeholder 内容上传 — 当前上传流程会传 note.content（即 placeholder），
///   不暴露密文；T-007 加密笔记应被同步排除还是带 placeholder，留给 T-S014 决策
pub fn compute_local_manifest(
    db: &Database,
    app_version: &str,
    device: &str,
) -> Result<SyncManifestV1, AppError> {
    let conn = db.conn_lock()?;

    // T-S012：tombstone GC 阈值（本机时间，30 天前）。超过此时间的软删除笔记不再入 manifest。
    // 用本地时间字符串与 deleted_at 比较：deleted_at 也是 datetime('now', 'localtime') 生成的。
    let tombstone_cutoff = (chrono::Local::now() - chrono::Duration::days(TOMBSTONE_RETENTION_DAYS))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();

    // v2 优化：不再读 content 字段；改读 v22 起的 notes.content_hash 列
    // （DAO 在 create/update/update_content/get_or_create_daily 时同步维护）。
    // 大库内存与 IO 显著下降：n 条笔记从 O(总内容字节) 降到 O(64 字节 hex × n)。
    //
    // T-S011：stable_id 改用 v36 引入的 notes.stable_uuid 列。
    // T-S012：把"最近 30 天内软删"的笔记一起拉进来，以 tombstone=1 标志推到其他端。
    // T-S014：读 is_encrypted + encrypted_blob 列，加密笔记的 content_hash 改用 blob 的 hex 算 hash。
    //
    // `WHERE stable_uuid IS NOT NULL` 是防御性约束（v36 backfill 已覆盖全部存量，
    // 但 ALTER TABLE 没加 NOT NULL 约束）—— 极端异常路径下 NULL 行会被排除 manifest，
    // 不会被同步出去（自动隔离损坏数据）。
    let mut stmt = conn.prepare(
        "SELECT stable_uuid, title, content_hash, updated_at, folder_id, is_deleted, deleted_at,
                is_encrypted, encrypted_blob
         FROM notes
         WHERE stable_uuid IS NOT NULL
           AND (is_deleted = 0 OR (is_deleted = 1 AND deleted_at IS NOT NULL AND deleted_at >= ?1))",
    )?;
    #[allow(clippy::type_complexity)]
    let rows: Vec<(
        String,
        String,
        String,
        String,
        Option<i64>,
        i64,
        Option<String>,
        i64,
        Option<Vec<u8>>,
    )> = stmt
        .query_map(rusqlite::params![tombstone_cutoff], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                // content_hash 列在 v22 之后由 DAO 维护，但 ALTER TABLE 没加 NOT NULL，
                // 理论上极老的存量行可能仍为 NULL → 兜底空串（实践中 v22 迁移已回填）。
                row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                row.get::<_, String>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, Option<Vec<u8>>>(8)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);

    // 拿 folders 全树（id → (parent_id, name)）— 用来反查文件夹路径
    let mut stmt2 = conn.prepare("SELECT id, parent_id, name FROM folders")?;
    let folder_rows: Vec<(i64, Option<i64>, String)> = stmt2
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt2);
    drop(conn);

    let folders_by_id: HashMap<i64, (Option<i64>, String)> = folder_rows
        .into_iter()
        .map(|(id, p, name)| (id, (p, name)))
        .collect();

    let mut entries = Vec::with_capacity(rows.len());
    for (
        stable_uuid,
        title,
        content_hash_col,
        updated_at,
        folder_id,
        is_deleted,
        deleted_at,
        is_encrypted_int,
        encrypted_blob,
    ) in rows
    {
        let path = folder_path_for(&folders_by_id, folder_id);
        let tombstone = is_deleted != 0;
        let encrypted = is_encrypted_int != 0;
        // tombstone entry 的"变更时间"用 deleted_at（删除时刻）而非原 updated_at，
        // 这样 diff 比较时"软删除时间"才是判定"哪一边更新"的依据
        let ts = if tombstone {
            deleted_at.unwrap_or(updated_at)
        } else {
            updated_at
        };
        // T-S014：加密笔记的 content_hash 改用 encrypted_blob 的 hex 算 hash
        // - notes.content_hash 列对加密笔记存的是占位字符串 ("🔒 已加密") 的 hash，
        //   多端会被认为内容相同 → 无法触发同步。改用 blob hex 后真正反映密文变更
        // - blob 为 None（异常路径）→ 用空串 hex 兜底
        let body_hash = if encrypted {
            let blob_hex: String = encrypted_blob
                .as_deref()
                .map(|b| b.iter().map(|x| format!("{:02x}", x)).collect())
                .unwrap_or_default();
            sha256_hex(&blob_hex)
        } else {
            content_hash_col
        };
        entries.push(ManifestEntry {
            stable_id: stable_uuid.clone(),
            title: title.clone(),
            content_hash: content_hash(&title, &body_hash),
            updated_at: ts,
            remote_path: remote_path_for(&stable_uuid),
            tombstone,
            folder_path: path,
            encrypted,
        });
    }

    // 稳定排序（按 stable_id），方便 manifest 文本 diff 友好
    entries.sort_by(|a, b| a.stable_id.cmp(&b.stable_id));

    // T-S014：附带本机 vault meta（如已设置），让其他端首次同步时能拉到 salt+verifier
    let vault_meta = crate::services::vault::VaultService::read_meta(db).unwrap_or(None);

    // T-S022：附件清单（unique hashes from note_attachments）
    // 失败仅 warn 不阻塞 manifest 生成；附件同步会在后续步骤识别"远端没有这些 hash"
    let attachments: Vec<crate::models::AttachmentEntry> = match db.list_all_unique_attachments() {
        Ok(rows) => rows
            .into_iter()
            .map(|row| {
                let ext = std::path::Path::new(&row.local_rel_path)
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|s| s.to_ascii_lowercase());
                crate::models::AttachmentEntry {
                    hash: row.sha256_hex,
                    size: row.size,
                    mime: row.mime,
                    ext,
                }
            })
            .collect(),
        Err(e) => {
            log::warn!("[manifest] 读取 note_attachments 失败 ({}), attachments 留空", e);
            Vec::new()
        }
    };

    Ok(SyncManifestV1 {
        manifest_version: SyncManifestV1::VERSION,
        app_version: app_version.to_string(),
        device: device.to_string(),
        generated_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        entries,
        hash_algo: Some(SyncManifestV1::HASH_ALGO_V2.into()),
        vault: vault_meta,
        attachments,
    })
}

/// 反查某 folder_id 的祖先链 → "工作/周报" 风格路径；根层为空串
fn folder_path_for(
    folders_by_id: &HashMap<i64, (Option<i64>, String)>,
    folder_id: Option<i64>,
) -> String {
    let mut chain: Vec<String> = Vec::new();
    let mut cur = folder_id;
    let mut guard = 0;
    while let Some(fid) = cur {
        guard += 1;
        if guard > 32 {
            break; // 防御性：避免脏数据导致死循环
        }
        match folders_by_id.get(&fid) {
            Some((parent, name)) => {
                chain.push(name.clone());
                cur = *parent;
            }
            None => break,
        }
    }
    chain.reverse();
    chain.join("/")
}

/// Manifest diff 结果
#[derive(Debug, Default)]
#[allow(dead_code)] // stats_total_* 字段供 UI 显示，目前命令层未读取
pub struct ManifestDiff {
    /// 本地有 / 远端无（或 hash 较新）→ 需要 push
    pub to_push: Vec<ManifestEntry>,
    /// 远端有 / 本地无（或 hash 较新）→ 需要 pull
    pub to_pull: Vec<ManifestEntry>,
    /// 双方都改了 → 冲突（last-write-wins，按 updated_at 较新者赢）
    pub conflicts: Vec<ConflictPair>,
    /// 远端 tombstone → 本地需删
    pub to_delete_local: Vec<ManifestEntry>,
    /// 本地比远端少（对方有我没有 + 不是 tombstone）→ pull 集已涵盖
    /// 本地有但比远端旧 → pull 集涵盖
    /// 本地有但远端 tombstone 标记删除 → to_delete_local
    pub stats_total_local: usize,
    pub stats_total_remote: usize,
}

#[derive(Debug)]
#[allow(dead_code)] // local 字段供 UI 显示冲突详情
pub struct ConflictPair {
    pub local: ManifestEntry,
    pub remote: ManifestEntry,
}

/// T-S013：合并本地 manifest 与远端 manifest（push 末尾写远端前用）
///
/// 算法：以 `stable_id` 为键 outer-join：
/// - 本地有 → 全部保留（本机视角是权威：刚刚 push 完，知道本地每条都是最新版本）
/// - 远端独有 → 原样保留（防止吞掉别的设备已经 push 但本机还没 pull 到的项）
///
/// **不取 updated_at 较新者**：push 之前已经做过 diff 决策（冲突已分流到 conflict 集合），
/// 本地的每条 entry 都代表"本机认为对的版本"，直接用即可。
///
/// 合并结果：
/// - `manifest_version` / `hash_algo` 用 local 的（新版客户端写出的格式）
/// - `device` / `app_version` 用 local 的（标识最近写者）
/// - `generated_at` 重置为当前时间
/// - `entries` 排序后稳定输出（diff 友好）
pub fn merge_manifests(local: &SyncManifestV1, remote: &SyncManifestV1) -> SyncManifestV1 {
    let local_ids: std::collections::HashSet<&str> = local
        .entries
        .iter()
        .map(|e| e.stable_id.as_str())
        .collect();

    let mut merged: Vec<ManifestEntry> =
        Vec::with_capacity(local.entries.len() + remote.entries.len());
    merged.extend(local.entries.iter().cloned());
    for re in &remote.entries {
        if !local_ids.contains(re.stable_id.as_str()) {
            merged.push(re.clone());
        }
    }
    merged.sort_by(|a, b| a.stable_id.cmp(&b.stable_id));

    // T-S022：附件清单合并（与笔记 entry 合并规则同——以 hash 为键 outer-join）。
    // 本地附件清单全部保留 + 远端独有的 hash 也保留。
    // 防止两端各上传过一些附件时，新写出的 manifest 漏掉对方的 hash → 拉端找不到引用。
    let mut local_attachment_hashes: std::collections::HashSet<&str> =
        local.attachments.iter().map(|a| a.hash.as_str()).collect();
    let mut merged_attachments: Vec<crate::models::AttachmentEntry> =
        local.attachments.clone();
    for ra in &remote.attachments {
        if local_attachment_hashes.insert(ra.hash.as_str()) {
            merged_attachments.push(ra.clone());
        }
    }
    // 稳定排序方便 manifest 文本 diff 友好
    merged_attachments.sort_by(|a, b| a.hash.cmp(&b.hash));

    SyncManifestV1 {
        manifest_version: local.manifest_version,
        app_version: local.app_version.clone(),
        device: local.device.clone(),
        generated_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        entries: merged,
        hash_algo: Some(SyncManifestV1::HASH_ALGO_V2.into()),
        // T-S014：vault meta 用本地的（本机视角是权威；首次同步时远端独有的 meta 已被
        // 上层 pull 流程在 read_manifest 时单独 import 写入本机 app_config）
        vault: local.vault.clone(),
        attachments: merged_attachments,
    }
}

/// 比对本地 vs 远端 manifest
///
/// 算法：以 stable_id 为键 outer-join 两边
/// - 仅本地有 → push（含 tombstone：让远端首次知道本地软删过这条）
/// - 仅远端有 → pull（如果远端 tombstone：本地无 → 直接忽略；本地有但应该不会到这分支）
/// - 双方都有：
///     - 远端 tombstone + 本地非 tombstone → to_delete_local（按远端来软删本地）
///     - 本地 tombstone + 远端非 tombstone → to_push（让远端跟着删；T-S012）
///     - 双方都 tombstone → 跳过（已一致）
///     - 双方都非 tombstone + hash 相同 → 跳过
///     - 双方都非 tombstone + hash 不同 → 按 updated_at 较新者赢（push / pull / conflict）
///
/// **本算法不直接判定"本地是否有变更"**：那是 sync_remote_state 的活，由上层 push/pull 决定
/// 是否真正调 backend.put / put_note。这个 diff 只回答"两份 manifest 不一致的项是哪些"。
pub fn diff_manifests(local: &SyncManifestV1, remote: &SyncManifestV1) -> ManifestDiff {
    let local_map: HashMap<&str, &ManifestEntry> = local
        .entries
        .iter()
        .map(|e| (e.stable_id.as_str(), e))
        .collect();
    let remote_map: HashMap<&str, &ManifestEntry> = remote
        .entries
        .iter()
        .map(|e| (e.stable_id.as_str(), e))
        .collect();

    let mut diff = ManifestDiff {
        stats_total_local: local.entries.len(),
        stats_total_remote: remote.entries.len(),
        ..Default::default()
    };

    // 仅本地有 → push
    for (sid, le) in &local_map {
        if !remote_map.contains_key(sid) {
            diff.to_push.push((*le).clone());
        }
    }
    // 仅远端有 → pull / delete_local
    for (sid, re) in &remote_map {
        if !local_map.contains_key(sid) {
            if re.tombstone {
                // 本地本就没有，跳过
                continue;
            }
            diff.to_pull.push((*re).clone());
        }
    }
    // 双方都有
    for (sid, le) in &local_map {
        if let Some(re) = remote_map.get(sid) {
            // T-S012: tombstone 处理优先
            match (le.tombstone, re.tombstone) {
                (false, true) => {
                    // 远端要求删本地
                    diff.to_delete_local.push((*re).clone());
                    continue;
                }
                (true, false) => {
                    // 本地已删 → 推送 tombstone 让远端跟着删
                    diff.to_push.push((*le).clone());
                    continue;
                }
                (true, true) => {
                    // 双方一致都已删，跳过
                    continue;
                }
                (false, false) => {} // 都未删，走 hash 比较
            }

            if le.content_hash == re.content_hash {
                continue;
            }
            // hash 不同 → 比时间
            match le.updated_at.cmp(&re.updated_at) {
                std::cmp::Ordering::Greater => diff.to_push.push((*le).clone()),
                std::cmp::Ordering::Less => diff.to_pull.push((*re).clone()),
                std::cmp::Ordering::Equal => diff.conflicts.push(ConflictPair {
                    local: (*le).clone(),
                    remote: (*re).clone(),
                }),
            }
        }
    }

    diff
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, title: &str, hash: &str, ts: &str, tombstone: bool) -> ManifestEntry {
        ManifestEntry {
            stable_id: id.into(),
            title: title.into(),
            content_hash: hash.into(),
            updated_at: ts.into(),
            remote_path: format!("notes/{}.md", id),
            tombstone,
            folder_path: String::new(),
            encrypted: false,
        }
    }

    fn manifest(entries: Vec<ManifestEntry>) -> SyncManifestV1 {
        SyncManifestV1 {
            manifest_version: 1,
            app_version: "test".into(),
            device: "host".into(),
            generated_at: "2026-04-25 12:00:00".into(),
            entries,
            hash_algo: Some(SyncManifestV1::HASH_ALGO_V2.into()),
            vault: None,
            attachments: vec![],
        }
    }

    #[test]
    fn diff_only_local() {
        let local = manifest(vec![entry("1", "a", "h1", "2026-01-01", false)]);
        let remote = manifest(vec![]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.to_push.len(), 1);
        assert_eq!(d.to_pull.len(), 0);
    }

    #[test]
    fn diff_only_remote() {
        let local = manifest(vec![]);
        let remote = manifest(vec![entry("1", "a", "h1", "2026-01-01", false)]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.to_pull.len(), 1);
        assert_eq!(d.to_push.len(), 0);
    }

    #[test]
    fn diff_remote_newer() {
        let local = manifest(vec![entry("1", "a", "h1", "2026-01-01", false)]);
        let remote = manifest(vec![entry("1", "a", "h2", "2026-02-01", false)]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.to_pull.len(), 1);
        assert_eq!(d.to_push.len(), 0);
    }

    #[test]
    fn diff_local_newer() {
        let local = manifest(vec![entry("1", "a", "h2", "2026-02-01", false)]);
        let remote = manifest(vec![entry("1", "a", "h1", "2026-01-01", false)]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.to_push.len(), 1);
    }

    #[test]
    fn diff_conflict_same_ts() {
        let local = manifest(vec![entry("1", "a", "h1", "2026-01-01", false)]);
        let remote = manifest(vec![entry("1", "a", "h2", "2026-01-01", false)]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.conflicts.len(), 1);
    }

    #[test]
    fn diff_remote_tombstone() {
        let local = manifest(vec![entry("1", "a", "h1", "2026-01-01", false)]);
        let remote = manifest(vec![entry("1", "a", "", "2026-02-01", true)]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.to_delete_local.len(), 1);
    }

    // ───────── T-S013：merge_manifests 测试 ─────────

    /// 远端独有项必须保留（不被吞）
    #[test]
    fn merge_preserves_remote_only_entries() {
        let local = manifest(vec![entry("a", "A", "h1", "2026-01-01", false)]);
        let remote = manifest(vec![
            entry("a", "A_old", "h_old", "2025-12-01", false), // 本地也有，用本地
            entry("b", "B_other_device", "h2", "2025-12-15", false), // 远端独有 → 必须保留
        ]);
        let m = merge_manifests(&local, &remote);
        let ids: Vec<&str> = m.entries.iter().map(|e| e.stable_id.as_str()).collect();
        assert!(ids.contains(&"a"));
        assert!(ids.contains(&"b"), "远端独有项必须保留，不能被吞");

        // 重复 id 时应取 local 版本（hash 不能是 h_old）
        let a = m.entries.iter().find(|e| e.stable_id == "a").unwrap();
        assert_eq!(a.content_hash, "h1");
        assert_eq!(a.title, "A");
    }

    /// 仅 local 有时，合并结果 = local
    #[test]
    fn merge_only_local() {
        let local = manifest(vec![entry("1", "a", "h1", "2026-01-01", false)]);
        let remote = manifest(vec![]);
        let m = merge_manifests(&local, &remote);
        assert_eq!(m.entries.len(), 1);
        assert_eq!(m.entries[0].stable_id, "1");
    }

    /// 仅 remote 有时，合并结果保留远端
    #[test]
    fn merge_only_remote() {
        let local = manifest(vec![]);
        let remote = manifest(vec![entry("1", "a", "h1", "2026-01-01", false)]);
        let m = merge_manifests(&local, &remote);
        assert_eq!(m.entries.len(), 1);
        assert_eq!(m.entries[0].stable_id, "1");
    }

    /// 合并后 hash_algo / 排序 / 时间戳元数据正确
    #[test]
    fn merge_metadata_v2_and_sorted() {
        let local = manifest(vec![entry("b", "b", "h", "2026-01-01", false)]);
        let remote = manifest(vec![entry("a", "a", "h", "2026-01-01", false)]);
        let m = merge_manifests(&local, &remote);
        assert_eq!(m.entries.len(), 2);
        // 排序：a 在前 b 在后
        assert_eq!(m.entries[0].stable_id, "a");
        assert_eq!(m.entries[1].stable_id, "b");
        assert_eq!(m.hash_algo.as_deref(), Some("v2"));
        assert!(!m.generated_at.is_empty(), "应有当前时间戳");
    }

    /// 双方都有 tombstone：本地版本优先（按合并规则 local 优先），不会被远端非 tombstone 覆盖
    #[test]
    fn merge_local_tombstone_overrides_remote_alive() {
        let local = manifest(vec![entry("1", "a", "", "2026-03-01", true)]);
        let remote = manifest(vec![entry("1", "a", "h_alive", "2026-02-01", false)]);
        let m = merge_manifests(&local, &remote);
        assert_eq!(m.entries.len(), 1);
        assert!(m.entries[0].tombstone, "本地 tombstone 必须优先");
    }

    /// T-S012：本地 tombstone + 远端非 tombstone → 推送删除
    #[test]
    fn diff_local_tombstone_pushes() {
        let local = manifest(vec![entry("1", "a", "", "2026-02-01", true)]);
        let remote = manifest(vec![entry("1", "a", "h1", "2026-01-01", false)]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.to_push.len(), 1, "本地 tombstone 应 push 让远端跟着删");
        assert!(d.to_push[0].tombstone);
        assert_eq!(d.to_delete_local.len(), 0);
        assert_eq!(d.to_pull.len(), 0);
    }

    /// T-S012：双方都 tombstone → 无操作
    #[test]
    fn diff_both_tombstones_skip() {
        let local = manifest(vec![entry("1", "a", "", "2026-02-01", true)]);
        let remote = manifest(vec![entry("1", "a", "", "2026-01-15", true)]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.to_push.len(), 0, "双方一致都已删");
        assert_eq!(d.to_pull.len(), 0);
        assert_eq!(d.to_delete_local.len(), 0);
    }

    /// T-S012：仅本地有 + 本地 tombstone → push（首次推送删除标记给远端）
    #[test]
    fn diff_only_local_tombstone_pushes() {
        let local = manifest(vec![entry("1", "a", "", "2026-02-01", true)]);
        let remote = manifest(vec![]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.to_push.len(), 1, "tombstone 也要 push 到首次同步的远端");
        assert!(d.to_push[0].tombstone);
    }

    /// T-S012：compute_local_manifest 包含 30 天内软删的笔记，超过 30 天的被 GC
    #[test]
    fn compute_local_manifest_includes_recent_tombstones_excludes_old() {
        use crate::models::NoteInput;
        let db = Database::init(":memory:").unwrap();

        let n_active = db
            .create_note(&NoteInput {
                title: "活的".into(),
                content: "x".into(),
                folder_id: None,
            })
            .unwrap();
        let n_recent = db
            .create_note(&NoteInput {
                title: "最近删的".into(),
                content: "y".into(),
                folder_id: None,
            })
            .unwrap();
        let n_old = db
            .create_note(&NoteInput {
                title: "很久以前删的".into(),
                content: "z".into(),
                folder_id: None,
            })
            .unwrap();

        // n_recent 软删（用 datetime('now') 自动填 deleted_at）
        db.soft_delete_note(n_recent.id).unwrap();
        // n_old 手动改成 60 天前删（超出 30 天 GC 阈值）
        let cutoff_old = (chrono::Local::now() - chrono::Duration::days(60))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        {
            let conn = db.conn_lock().unwrap();
            conn.execute(
                "UPDATE notes SET is_deleted = 1, deleted_at = ?1 WHERE id = ?2",
                rusqlite::params![cutoff_old, n_old.id],
            )
            .unwrap();
        }

        let m = compute_local_manifest(&db, "test", "host").unwrap();
        let titles: Vec<&str> = m.entries.iter().map(|e| e.title.as_str()).collect();
        assert!(titles.contains(&"活的"), "活笔记必须在");
        assert!(titles.contains(&"最近删的"), "30 天内软删笔记必须以 tombstone 进入");
        assert!(!titles.contains(&"很久以前删的"), "超过 30 天的 tombstone 应被 GC");

        let recent_entry = m.entries.iter().find(|e| e.title == "最近删的").unwrap();
        assert!(recent_entry.tombstone, "软删 entry 必须 tombstone=true");
    }

    #[test]
    fn diff_same_hash_no_op() {
        let local = manifest(vec![entry("1", "a", "h1", "2026-01-01", false)]);
        let remote = manifest(vec![entry("1", "a", "h1", "2026-01-02", false)]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.to_push.len(), 0);
        assert_eq!(d.to_pull.len(), 0);
        assert_eq!(d.conflicts.len(), 0);
    }

    #[test]
    fn content_hash_changes_with_title() {
        // v2 入参语义：第二个参数是 notes.content_hash 列的值（hex 字符串）
        let h1 = content_hash("a", "abcd");
        let h2 = content_hash("b", "abcd");
        assert_ne!(h1, h2);
    }

    #[test]
    fn content_hash_changes_with_content_hash_col() {
        let h1 = content_hash("a", "abcd");
        let h2 = content_hash("a", "xyz9");
        assert_ne!(h1, h2);
    }

    #[test]
    fn content_hash_v2_is_deterministic() {
        // 同样输入两次必须得到相同结果（多端必须一致）
        let h1 = content_hash("title", "deadbeef");
        let h2 = content_hash("title", "deadbeef");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64); // SHA-256 hex
    }

    #[test]
    fn manifest_serializes_with_hash_algo_v2() {
        let m = manifest(vec![entry("1", "a", "h1", "2026-01-01", false)]);
        let json = serde_json::to_string(&m).unwrap();
        assert!(
            json.contains("\"hashAlgo\":\"v2\""),
            "新版 manifest 必须序列化出 hashAlgo 字段; got = {}",
            json
        );
    }

    #[test]
    fn old_manifest_without_hash_algo_deserializes_to_none() {
        // 模拟旧客户端写出的 manifest（没有 hashAlgo 字段）
        let json = r#"{
            "manifestVersion": 1,
            "appVersion": "1.0.0",
            "device": "old-host",
            "generatedAt": "2026-01-01 00:00:00",
            "entries": []
        }"#;
        let m: SyncManifestV1 = serde_json::from_str(json).expect("旧 manifest 必须能反序列化");
        assert_eq!(m.hash_algo, None, "字段缺失应反序列化为 None，pull/push 据此识别旧版本");
    }

    /// T-S011：compute_local_manifest 用 stable_uuid 作为 entry.stable_id 和 remote_path
    #[test]
    fn compute_local_manifest_uses_stable_uuid_as_stable_id() {
        use crate::models::NoteInput;
        let db = Database::init(":memory:").expect("init :memory: 应成功");
        let n = db
            .create_note(&NoteInput {
                title: "测试笔记".into(),
                content: "正文".into(),
                folder_id: None,
            })
            .expect("create_note 应成功");

        // 取 stable_uuid（v36 自动生成）
        let expected_uuid: String = {
            let conn = db.conn_lock().unwrap();
            conn.query_row(
                "SELECT stable_uuid FROM notes WHERE id = ?1",
                rusqlite::params![n.id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(expected_uuid.len(), 36, "UUID v4 文本应 36 字符");

        let manifest = compute_local_manifest(&db, "test-app", "test-host").unwrap();
        assert_eq!(manifest.entries.len(), 1);
        let entry = &manifest.entries[0];
        assert_eq!(
            entry.stable_id, expected_uuid,
            "entry.stable_id 必须是 stable_uuid 不是 i64"
        );
        assert_eq!(
            entry.remote_path,
            format!("notes/{}.md", expected_uuid),
            "远端路径必须用 UUID"
        );
        assert_eq!(entry.title, "测试笔记");
        // hash_algo v2 公式：sha256(title + "\n" + content_hash_hex)
        // content_hash_hex 是 notes.content_hash 列值（sha256("正文") 的 hex）
        let content_sha = crate::services::hash::sha256_hex("正文");
        let expected_hash = content_hash(&entry.title, &content_sha);
        assert_eq!(entry.content_hash, expected_hash);
    }

    /// T-S014：upsert_encrypted_note_with_uuid 端到端：远端 UUID + blob → 本地加密笔记
    #[test]
    fn upsert_encrypted_note_with_uuid_roundtrip() {
        let db = Database::init(":memory:").unwrap();
        let uuid = "12345678-1234-1234-1234-123456789abc";
        let blob: Vec<u8> = vec![0xde, 0xad, 0xbe, 0xef];

        // 首次：本地没有 → 创建
        let id1 = db
            .upsert_encrypted_note_with_uuid(uuid, "我的密笔", &blob, None)
            .expect("首次 upsert 应成功");
        assert!(id1 > 0);

        // 验证落库
        let st = db
            .get_note_crypto_state_by_uuid(uuid)
            .unwrap()
            .expect("应能查到");
        assert!(st.0, "is_encrypted 必须 true");
        assert_eq!(st.1.as_deref(), Some(blob.as_slice()), "blob 字节级一致");

        // 二次：同 UUID 不同 blob → update
        let blob2: Vec<u8> = vec![0xca, 0xfe];
        let id2 = db
            .upsert_encrypted_note_with_uuid(uuid, "我的密笔 v2", &blob2, None)
            .unwrap();
        assert_eq!(id1, id2, "同 UUID 必须更新原行不新建");
        let st2 = db.get_note_crypto_state_by_uuid(uuid).unwrap().unwrap();
        assert_eq!(st2.1.as_deref(), Some(blob2.as_slice()));
    }

    /// T-S014：vault meta 序列化和反序列化（旧客户端无该字段时反序列化为 None）
    #[test]
    fn vault_meta_serde_compatibility() {
        // 不写 vault 字段
        let m_no_vault = manifest(vec![]);
        let json_no = serde_json::to_string(&m_no_vault).unwrap();
        assert!(!json_no.contains("vault"), "vault=None 时不应序列化出字段");

        // 写 vault 字段
        let mut m_with = manifest(vec![]);
        m_with.vault = Some(crate::models::VaultMeta {
            salt: "c2FsdA==".into(),
            verifier: "dmVy".into(),
        });
        let json_with = serde_json::to_string(&m_with).unwrap();
        assert!(json_with.contains("\"vault\""));
        assert!(json_with.contains("\"salt\":\"c2FsdA==\""));

        // 旧 manifest 反序列化
        let old = r#"{
            "manifestVersion": 1, "appVersion": "x", "device": "x",
            "generatedAt": "x", "entries": []
        }"#;
        let m: SyncManifestV1 = serde_json::from_str(old).unwrap();
        assert_eq!(m.vault, None);
    }

    /// T-S014：加密笔记进 manifest，entry.encrypted=true + content_hash 用 blob hex
    #[test]
    fn compute_local_manifest_marks_encrypted_notes() {
        use crate::models::NoteInput;
        let db = Database::init(":memory:").unwrap();

        // 创建一条普通笔记
        let n_normal = db
            .create_note(&NoteInput {
                title: "明文".into(),
                content: "正文".into(),
                folder_id: None,
            })
            .unwrap();

        // 创建一条空笔记，手动改成加密态（模拟 T-007 启用加密路径）
        let n_enc = db
            .create_note(&NoteInput {
                title: "密文".into(),
                content: "原文".into(),
                folder_id: None,
            })
            .unwrap();
        let fake_blob: Vec<u8> = vec![0x01, 0x02, 0x03, 0x04];
        {
            let conn = db.conn_lock().unwrap();
            conn.execute(
                "UPDATE notes SET is_encrypted = 1, encrypted_blob = ?1, content = ?2
                 WHERE id = ?3",
                rusqlite::params![fake_blob, "🔒 已加密", n_enc.id],
            )
            .unwrap();
        }

        let m = compute_local_manifest(&db, "test", "host").unwrap();
        assert_eq!(m.entries.len(), 2);

        // n_normal 的 stable_uuid 单独查（Note 模型没暴露此列，只在 DB 表中）
        let normal_uuid: String = {
            let conn = db.conn_lock().unwrap();
            conn.query_row(
                "SELECT stable_uuid FROM notes WHERE id = ?1",
                rusqlite::params![n_normal.id],
                |r| r.get(0),
            )
            .unwrap()
        };
        let e_normal = m
            .entries
            .iter()
            .find(|e| e.stable_id == normal_uuid)
            .unwrap_or_else(|| panic!("missing normal entry; got = {:?}", m.entries));
        assert!(!e_normal.encrypted);

        let e_enc = m
            .entries
            .iter()
            .find(|e| e.title == "密文")
            .expect("missing encrypted entry");
        assert!(e_enc.encrypted, "is_encrypted=1 笔记 entry.encrypted 必须 true");
        // content_hash 应基于 blob hex 而非占位字符串
        let expected_blob_hex = "01020304";
        let expected_hash = content_hash("密文", &sha256_hex(expected_blob_hex));
        assert_eq!(
            e_enc.content_hash, expected_hash,
            "加密笔记 content_hash 必须用 blob hex 算"
        );
    }

    #[test]
    fn new_manifest_without_hash_algo_when_explicitly_none() {
        // hash_algo = None 时 skip_serializing_if 应让该字段不出现在 JSON 里
        let m = SyncManifestV1 {
            manifest_version: 1,
            app_version: "x".into(),
            device: "x".into(),
            generated_at: "x".into(),
            entries: vec![],
            hash_algo: None,
            vault: None,
            attachments: vec![],
        };
        let json = serde_json::to_string(&m).unwrap();
        assert!(!json.contains("hashAlgo"), "None 时不应输出该字段; got = {}", json);
        assert!(
            !json.contains("attachments"),
            "空 attachments 不应输出字段; got = {}",
            json
        );
    }

    /// T-S022：compute_local_manifest 填充 attachments
    #[test]
    fn compute_local_manifest_fills_attachments_from_note_attachments() {
        use crate::models::NoteInput;
        let db = Database::init(":memory:").unwrap();
        let n = db
            .create_note(&NoteInput {
                title: "笔记".into(),
                content: "x".into(),
                folder_id: None,
            })
            .unwrap();

        // 直接 upsert 几条附件引用（不走 attachment_scan，单元解耦）
        db.upsert_attachment_ref(
            n.id,
            "kb_assets/images/a.png",
            "hash_a",
            100,
            Some("image/png"),
        )
        .unwrap();
        db.upsert_attachment_ref(
            n.id,
            "pdfs/b.pdf",
            "hash_b",
            2000,
            Some("application/pdf"),
        )
        .unwrap();
        // 同 hash 不同 path 应去重
        db.upsert_attachment_ref(
            n.id,
            "kb_assets/images/dup.png",
            "hash_a",
            100,
            Some("image/png"),
        )
        .unwrap();

        let m = compute_local_manifest(&db, "test", "host").unwrap();
        assert_eq!(m.attachments.len(), 2, "去重后应 2 个唯一 hash");

        let hashes: std::collections::HashSet<&str> =
            m.attachments.iter().map(|a| a.hash.as_str()).collect();
        assert!(hashes.contains("hash_a"));
        assert!(hashes.contains("hash_b"));

        // ext 从 path 推断
        let a = m.attachments.iter().find(|a| a.hash == "hash_a").unwrap();
        assert_eq!(a.ext.as_deref(), Some("png"));
        let b = m.attachments.iter().find(|a| a.hash == "hash_b").unwrap();
        assert_eq!(b.ext.as_deref(), Some("pdf"));
        assert_eq!(b.size, 2000);
    }

    /// T-S022：旧客户端无 attachments 字段也能反序列化（默认空 Vec）
    #[test]
    fn old_manifest_without_attachments_deserializes_to_empty() {
        let old = r#"{
            "manifestVersion": 1,
            "appVersion": "1.0",
            "device": "old",
            "generatedAt": "2026-01-01 00:00:00",
            "entries": []
        }"#;
        let m: SyncManifestV1 = serde_json::from_str(old).unwrap();
        assert!(m.attachments.is_empty());
    }

    /// T-S022：merge_manifests 合并 attachments（outer-join 保留双方）
    #[test]
    fn merge_attachments_outer_join() {
        let mut local = manifest(vec![]);
        local.attachments = vec![
            crate::models::AttachmentEntry {
                hash: "common".into(),
                size: 100,
                mime: None,
                ext: None,
            },
            crate::models::AttachmentEntry {
                hash: "local_only".into(),
                size: 200,
                mime: None,
                ext: None,
            },
        ];
        let mut remote = manifest(vec![]);
        remote.attachments = vec![
            crate::models::AttachmentEntry {
                hash: "common".into(),
                size: 100,
                mime: None,
                ext: None,
            },
            crate::models::AttachmentEntry {
                hash: "remote_only".into(),
                size: 300,
                mime: None,
                ext: None,
            },
        ];

        let merged = merge_manifests(&local, &remote);
        assert_eq!(merged.attachments.len(), 3, "common + local_only + remote_only");
        let hashes: std::collections::HashSet<&str> =
            merged.attachments.iter().map(|a| a.hash.as_str()).collect();
        assert!(hashes.contains("common"));
        assert!(hashes.contains("local_only"));
        assert!(hashes.contains("remote_only"));
    }
}
