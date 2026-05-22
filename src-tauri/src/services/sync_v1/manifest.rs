//! Manifest 计算 + diff
//!
//! `compute_local_manifest`：扫一遍 notes 表 + sync_remote_state，得到当前本地视角的 manifest
//! `diff_manifests`：比对本地 vs 远端 manifest，得出 push / pull / conflict 集合

use std::collections::HashMap;

use sha2::{Digest, Sha256};

use crate::database::Database;
use crate::error::AppError;
use crate::models::{
    ManifestEntry, ProjectManifestEntry, SyncManifestV1, TaskCategoryManifestEntry,
    TaskManifestEntry,
};
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

/// 项目 entry 的 content_hash —— 字段全拼接（参与同步的所有字段都纳入）。
/// 任一字段变动会让 hash 变化，触发跨端 push。
pub fn project_content_hash(p: &ProjectManifestEntry) -> String {
    let mut h = Sha256::new();
    h.update(p.name.as_bytes());
    h.update(b"\n");
    h.update(p.description.as_deref().unwrap_or("").as_bytes());
    h.update(b"\n");
    h.update(p.color.as_bytes());
    h.update(b"\n");
    h.update(p.start_date.as_deref().unwrap_or("").as_bytes());
    h.update(b"\n");
    h.update(p.end_date.as_deref().unwrap_or("").as_bytes());
    h.update(b"\n");
    h.update(if p.archived { b"1" } else { b"0" });
    h.update(b"\n");
    h.update(p.sort_order.to_string().as_bytes());
    h.update(b"\n");
    h.update(if p.tombstone { b"1" } else { b"0" });
    format!("{:x}", h.finalize())
}

/// 任务 entry 的 content_hash —— 字段全拼接（参与同步的所有字段都纳入）。
/// 不含 reminded_at / repeat_done_count / remind_before_minutes / source_batch_id
/// 这些"本地推进 / 本地偏好"字段（避免双端互相 advance 状态）。
pub fn task_content_hash(t: &TaskManifestEntry) -> String {
    let mut h = Sha256::new();
    h.update(t.title.as_bytes());
    h.update(b"\n");
    h.update(t.description.as_deref().unwrap_or("").as_bytes());
    h.update(b"\n");
    h.update(t.priority.to_string().as_bytes());
    h.update(b"\n");
    h.update(if t.important { b"1" } else { b"0" });
    h.update(b"\n");
    h.update(t.status.to_string().as_bytes());
    h.update(b"\n");
    h.update(t.due_date.as_deref().unwrap_or("").as_bytes());
    h.update(b"\n");
    h.update(t.start_date.as_deref().unwrap_or("").as_bytes());
    h.update(b"\n");
    h.update(t.completed_at.as_deref().unwrap_or("").as_bytes());
    h.update(b"\n");
    h.update(t.kanban_stage.as_bytes());
    h.update(b"\n");
    h.update(t.parent_task_uuid.as_deref().unwrap_or("").as_bytes());
    h.update(b"\n");
    h.update(t.project_uuid.as_deref().unwrap_or("").as_bytes());
    h.update(b"\n");
    h.update(t.category_uuid.as_deref().unwrap_or("").as_bytes());
    h.update(b"\n");
    h.update(t.repeat_kind.as_bytes());
    h.update(b"\n");
    h.update(t.repeat_interval.to_string().as_bytes());
    h.update(b"\n");
    h.update(t.repeat_weekdays.as_deref().unwrap_or("").as_bytes());
    h.update(b"\n");
    h.update(t.repeat_until.as_deref().unwrap_or("").as_bytes());
    h.update(b"\n");
    h.update(
        t.repeat_count
            .map(|n| n.to_string())
            .unwrap_or_default()
            .as_bytes(),
    );
    h.update(b"\n");
    h.update(if t.tombstone { b"1" } else { b"0" });
    format!("{:x}", h.finalize())
}

/// 任务分类 entry 的 content_hash
pub fn task_category_content_hash(c: &TaskCategoryManifestEntry) -> String {
    let mut h = Sha256::new();
    h.update(c.name.as_bytes());
    h.update(b"\n");
    h.update(c.color.as_bytes());
    h.update(b"\n");
    h.update(c.icon.as_deref().unwrap_or("").as_bytes());
    h.update(b"\n");
    h.update(c.sort_order.to_string().as_bytes());
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
        "SELECT id, stable_uuid, title, content_hash, updated_at, folder_id, is_deleted, deleted_at,
                is_encrypted, encrypted_blob, is_daily, daily_date, is_hidden
         FROM notes
         WHERE stable_uuid IS NOT NULL
           AND (is_deleted = 0 OR (is_deleted = 1 AND deleted_at IS NOT NULL AND deleted_at >= ?1))",
    )?;
    #[allow(clippy::type_complexity)]
    let rows: Vec<(
        i64,            // id（Bug 12a 给 tags 关联用）
        String,
        String,
        String,
        String,
        Option<i64>,
        i64,
        Option<String>,
        i64,
        Option<Vec<u8>>,
        i64,            // is_daily
        Option<String>, // daily_date
        i64,            // is_hidden
    )> = stmt
        .query_map(rusqlite::params![tombstone_cutoff], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                // content_hash 列在 v22 之后由 DAO 维护，但 ALTER TABLE 没加 NOT NULL，
                // 理论上极老的存量行可能仍为 NULL → 兜底空串（实践中 v22 迁移已回填）。
                row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                row.get::<_, String>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, Option<Vec<u8>>>(9)?,
                row.get::<_, i64>(10)?,
                row.get::<_, Option<String>>(11)?,
                row.get::<_, i64>(12)?,
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

    // Bug 12a：一次性拿全库 (note_id → tag names) 映射，避免 entries 循环里挨个查 DB
    let tags_by_note_id = db.list_all_note_tag_names().unwrap_or_default();

    let mut entries = Vec::with_capacity(rows.len());
    for (
        note_id,
        stable_uuid,
        title,
        content_hash_col,
        updated_at,
        folder_id,
        is_deleted,
        deleted_at,
        is_encrypted_int,
        encrypted_blob,
        is_daily_int,
        daily_date,
        is_hidden_int,
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
        let is_daily = is_daily_int != 0;
        // Bug 12a：tombstone / 加密笔记不带 tags（None；前者已删，后者用户可能不希望标签明文同步）
        // 普通笔记 → Some(...)：该笔记当前的标签列表（可能是空 vec[] 表示"无标签"，要让对端也清空）
        let tags = if tombstone || encrypted {
            None
        } else {
            Some(tags_by_note_id.get(&note_id).cloned().unwrap_or_default())
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
            is_daily,
            // 防御：非日记不带 daily_date（避免脏数据传播到其他端）
            daily_date: if is_daily { daily_date } else { None },
            is_hidden: is_hidden_int != 0,
            tags,
        });
    }

    // 稳定排序（按 stable_id），方便 manifest 文本 diff 友好
    entries.sort_by(|a, b| a.stable_id.cmp(&b.stable_id));

    // T-S014：附带本机 vault meta（如已设置），让其他端首次同步时能拉到 salt+verifier
    let vault_meta = crate::services::vault::VaultService::read_meta(db).unwrap_or(None);

    // T-S022：附件清单（unique hashes from note_attachments）+ Bug 9：每个 hash 携带所有原相对路径
    // 失败仅 warn 不阻塞 manifest 生成；附件同步会在后续步骤识别"远端没有这些 hash"。
    // paths 让 pull 端能把 sync_in/<hash>.<ext> 还原到笔记里 kb-asset:// 引用的原始位置。
    let attachments: Vec<crate::models::AttachmentEntry> = match db.list_all_unique_attachments() {
        Ok(rows) => rows
            .into_iter()
            .map(|row| {
                let ext = std::path::Path::new(&row.local_rel_path)
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|s| s.to_ascii_lowercase());
                // 这一 hash 在本机被引用的所有路径（同 hash 多笔记引用时返回多条）；查不到 fallback 用
                // list_all_unique_attachments 给的那一条 path，至少保证有一个还原目标。
                let paths = db
                    .list_attachment_paths_by_hash(&row.sha256_hex)
                    .unwrap_or_else(|_| vec![row.local_rel_path.clone()]);
                crate::models::AttachmentEntry {
                    hash: row.sha256_hex,
                    size: row.size,
                    mime: row.mime,
                    ext,
                    paths,
                }
            })
            .collect(),
        Err(e) => {
            log::warn!("[manifest] 读取 note_attachments 失败 ({}), attachments 留空", e);
            Vec::new()
        }
    };

    // Bug 12b：projects / tasks / task_categories 跨端同步条目
    let projects = build_project_entries(db).unwrap_or_else(|e| {
        log::warn!("[manifest] 读取 projects 失败 ({}), 留空", e);
        Vec::new()
    });
    let task_categories = build_task_category_entries(db).unwrap_or_else(|e| {
        log::warn!("[manifest] 读取 task_categories 失败 ({}), 留空", e);
        Vec::new()
    });
    let tasks = build_task_entries(db).unwrap_or_else(|e| {
        log::warn!("[manifest] 读取 tasks 失败 ({}), 留空", e);
        Vec::new()
    });

    Ok(SyncManifestV1 {
        manifest_version: SyncManifestV1::VERSION,
        app_version: app_version.to_string(),
        device: device.to_string(),
        generated_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        entries,
        hash_algo: Some(SyncManifestV1::HASH_ALGO_V2.into()),
        vault: vault_meta,
        attachments,
        projects,
        tasks,
        task_categories,
    })
}

/// 把 DB 的 projects 行转 ProjectManifestEntry（含墓碑）
fn build_project_entries(db: &Database) -> Result<Vec<ProjectManifestEntry>, AppError> {
    let rows = db.list_projects_for_sync()?;
    let mut entries: Vec<ProjectManifestEntry> = Vec::with_capacity(rows.len());
    for p in rows {
        // 没 stable_uuid 的行（理论上 v42 backfill 后不会有）跳过
        let stable_id = match p.stable_uuid {
            Some(u) => u,
            None => continue,
        };
        let mut entry = ProjectManifestEntry {
            stable_id,
            name: p.name,
            content_hash: String::new(),
            updated_at: p.updated_at,
            description: p.description,
            color: p.color,
            start_date: p.start_date,
            end_date: p.end_date,
            archived: p.archived,
            sort_order: p.sort_order,
            tombstone: p.is_deleted,
        };
        entry.content_hash = project_content_hash(&entry);
        entries.push(entry);
    }
    entries.sort_by(|a, b| a.stable_id.cmp(&b.stable_id));
    Ok(entries)
}

/// 把 DB 的 task_categories 行转 TaskCategoryManifestEntry。分类不带 tombstone，
/// 删除时本端任务 category_id 落 NULL，跨端只关心当前存在的分类。
fn build_task_category_entries(db: &Database) -> Result<Vec<TaskCategoryManifestEntry>, AppError> {
    let rows = db.list_task_categories()?;
    let mut entries: Vec<TaskCategoryManifestEntry> = Vec::with_capacity(rows.len());
    for c in rows {
        let stable_id = match c.stable_uuid {
            Some(u) => u,
            None => continue,
        };
        let mut entry = TaskCategoryManifestEntry {
            stable_id,
            name: c.name,
            content_hash: String::new(),
            color: c.color,
            icon: c.icon,
            sort_order: c.sort_order,
        };
        entry.content_hash = task_category_content_hash(&entry);
        entries.push(entry);
    }
    entries.sort_by(|a, b| a.stable_id.cmp(&b.stable_id));
    Ok(entries)
}

/// 把 DB 的 tasks 行（含主任务 + 子任务）转 TaskManifestEntry。
/// 子任务通过 parent_task_uuid 引用父任务（拉端先按主任务建好 id 映射，再处理子任务）。
fn build_task_entries(db: &Database) -> Result<Vec<TaskManifestEntry>, AppError> {
    let rows = db.list_tasks_for_sync()?;
    // 建 (local_id → stable_uuid) 映射，给 parent_task_uuid / project_uuid / category_uuid 查值
    let task_uuid_by_id: HashMap<i64, String> = rows
        .iter()
        .filter_map(|t| t.stable_uuid.clone().map(|u| (t.id, u)))
        .collect();
    let project_uuid_by_id: HashMap<i64, String> = db
        .list_projects_for_sync()?
        .into_iter()
        .filter_map(|p| p.stable_uuid.map(|u| (p.id, u)))
        .collect();
    let category_uuid_by_id: HashMap<i64, String> = db
        .list_task_categories()?
        .into_iter()
        .filter_map(|c| c.stable_uuid.map(|u| (c.id, u)))
        .collect();

    let mut entries: Vec<TaskManifestEntry> = Vec::with_capacity(rows.len());
    for t in rows {
        let stable_id = match t.stable_uuid.clone() {
            Some(u) => u,
            None => continue,
        };
        let parent_task_uuid = t
            .parent_task_id
            .and_then(|pid| task_uuid_by_id.get(&pid).cloned());
        let project_uuid = t
            .project_id
            .and_then(|pid| project_uuid_by_id.get(&pid).cloned());
        let category_uuid = t
            .category_id
            .and_then(|cid| category_uuid_by_id.get(&cid).cloned());
        let mut entry = TaskManifestEntry {
            stable_id,
            title: t.title,
            content_hash: String::new(),
            updated_at: t.updated_at,
            description: t.description,
            priority: t.priority,
            important: t.important,
            status: t.status,
            due_date: t.due_date,
            start_date: t.start_date,
            completed_at: t.completed_at,
            kanban_stage: t.kanban_stage,
            parent_task_uuid,
            project_uuid,
            category_uuid,
            repeat_kind: t.repeat_kind,
            repeat_interval: t.repeat_interval,
            repeat_weekdays: t.repeat_weekdays,
            repeat_until: t.repeat_until,
            repeat_count: t.repeat_count,
            tombstone: t.is_deleted,
        };
        entry.content_hash = task_content_hash(&entry);
        entries.push(entry);
    }
    entries.sort_by(|a, b| a.stable_id.cmp(&b.stable_id));
    Ok(entries)
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
    // ─── Bug 12b：projects/tasks/task_categories 跨端同步 ───
    /// 本地较新（或本地独有）的项目 → push 写远端 manifest
    pub projects_to_push: Vec<ProjectManifestEntry>,
    /// 远端较新（或远端独有）的项目 → pull 写本地
    pub projects_to_pull: Vec<ProjectManifestEntry>,
    /// 本地较新（或本地独有）的任务 → push
    pub tasks_to_push: Vec<TaskManifestEntry>,
    /// 远端较新（或远端独有）的任务 → pull
    pub tasks_to_pull: Vec<TaskManifestEntry>,
    /// 任务分类（无 tombstone；按 content_hash 不同判别）
    pub task_categories_to_push: Vec<TaskCategoryManifestEntry>,
    pub task_categories_to_pull: Vec<TaskCategoryManifestEntry>,
}

#[derive(Debug)]
#[allow(dead_code)] // local 字段供 UI 显示冲突详情
pub struct ConflictPair {
    pub local: ManifestEntry,
    pub remote: ManifestEntry,
}

/// T-S013 / P0-2：合并本地 manifest 与远端 manifest（push 末尾写远端前用）
///
/// 算法：以 `stable_id` 为键 outer-join：
/// - 两边都有 → 取 `updated_at` 较新者（相等取本地）
/// - 本地独有 → 保留
/// - 远端独有 → 保留（防止吞掉别的设备已 push 但本机还没 pull 到的项）
///
/// **为什么两边都有时按 updated_at 判胜负**（P0-2 修复）：
/// push 只上传 `diff.to_push`，对 `to_pull`（远端较新）/ `to_delete_local`（远端 tombstone）
/// 的条目，本地 manifest entry 是**陈旧的**。早期实现"两边都有一律取 local" → push 会把
/// 远端较新的笔记在 manifest 里回滚成旧版本、把别端删掉的笔记复活成 alive，导致 manifest
/// 与远端 `.md` 文件不一致（其他端 pull 拿不到新内容 / 报 ".md 丢失"）。
/// 改为 merge 阶段也做 updated_at 胜负判断，与 `diff_manifests` 同款逻辑 → 结果自洽。
///
/// 注意：`updated_at` 是本地 `localtime` 字符串，跨时区 / 时钟偏差时比较仍不可靠（P0-3，
/// 独立问题）；本修复只保证 merge 与 diff 用同一套判据，不引入新的不一致。
///
/// 合并结果元数据：`manifest_version` / `hash_algo` / `device` / `app_version` 用 local，
/// `generated_at` 重置为当前时间，`entries` 按 `stable_id` 稳定排序。
pub fn merge_manifests(local: &SyncManifestV1, remote: &SyncManifestV1) -> SyncManifestV1 {
    let remote_map: HashMap<&str, &ManifestEntry> = remote
        .entries
        .iter()
        .map(|e| (e.stable_id.as_str(), e))
        .collect();
    let local_ids: std::collections::HashSet<&str> = local
        .entries
        .iter()
        .map(|e| e.stable_id.as_str())
        .collect();

    let mut merged: Vec<ManifestEntry> =
        Vec::with_capacity(local.entries.len() + remote.entries.len());
    // 本地每条 entry：与远端同 stable_id 比 updated_at，远端较新则取远端
    // （修 push 回滚远端较新笔记 / 复活远端已删笔记）
    for le in &local.entries {
        match remote_map.get(le.stable_id.as_str()) {
            Some(re) if re.updated_at > le.updated_at => merged.push((*re).clone()),
            _ => merged.push(le.clone()),
        }
    }
    // 远端独有 → 补（别的设备已 push 但本机还没 pull 到）
    for re in &remote.entries {
        if !local_ids.contains(re.stable_id.as_str()) {
            merged.push(re.clone());
        }
    }
    merged.sort_by(|a, b| a.stable_id.cmp(&b.stable_id));

    // T-S022：附件清单合并（与笔记 entry 合并规则同——以 hash 为键 outer-join）+ Bug 9 paths 并集。
    // 本地附件清单全部保留 + 远端独有的 hash 也保留 → 防止两端各上传过一些附件时漏掉对方的 hash。
    // 同 hash 双方都有 → **paths 取并集**：A 端引用同一图在 path P_a、B 端引用在 P_b，本机（C 端）
    // 写出的 manifest 必须同时带上 P_a 和 P_b，否则 D 端 pull 时只能把字节还原到我们 local 这一条
    // path，B 端引用的 P_b 还原不了 → 笔记里 kb-asset:// 显示不出来。
    let mut merged_attachments: Vec<crate::models::AttachmentEntry> = local.attachments.clone();
    let mut local_idx: std::collections::HashMap<String, usize> = merged_attachments
        .iter()
        .enumerate()
        .map(|(i, a)| (a.hash.clone(), i))
        .collect();
    for ra in &remote.attachments {
        if let Some(&i) = local_idx.get(&ra.hash) {
            // 同 hash：合并 paths 并集（保持稳定顺序，去重）
            let existing: std::collections::HashSet<String> =
                merged_attachments[i].paths.iter().cloned().collect();
            for p in &ra.paths {
                if !existing.contains(p) {
                    merged_attachments[i].paths.push(p.clone());
                }
            }
            merged_attachments[i].paths.sort();
        } else {
            local_idx.insert(ra.hash.clone(), merged_attachments.len());
            merged_attachments.push(ra.clone());
        }
    }
    // 稳定排序方便 manifest 文本 diff 友好
    merged_attachments.sort_by(|a, b| a.hash.cmp(&b.hash));

    // Bug 12b：projects / tasks / task_categories 的 merge 策略
    // —— 与 entries 同款：以 stable_id 为键 outer-join 双方，updated_at 新者赢，
    //    本地 tombstone 总是写出（让远端跟着删）。
    let projects = merge_project_entries(&local.projects, &remote.projects);
    let tasks = merge_task_entries(&local.tasks, &remote.tasks);
    let task_categories = merge_task_category_entries(&local.task_categories, &remote.task_categories);

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
        projects,
        tasks,
        task_categories,
    }
}

/// 合并双方 projects：按 stable_id outer-join，updated_at 新者赢。
fn merge_project_entries(
    local: &[ProjectManifestEntry],
    remote: &[ProjectManifestEntry],
) -> Vec<ProjectManifestEntry> {
    let mut map: HashMap<String, ProjectManifestEntry> = HashMap::with_capacity(local.len() + remote.len());
    for e in local {
        map.insert(e.stable_id.clone(), e.clone());
    }
    for re in remote {
        match map.get(&re.stable_id) {
            Some(le) if le.updated_at >= re.updated_at => {}
            _ => {
                map.insert(re.stable_id.clone(), re.clone());
            }
        }
    }
    let mut out: Vec<_> = map.into_values().collect();
    out.sort_by(|a, b| a.stable_id.cmp(&b.stable_id));
    out
}

fn merge_task_entries(
    local: &[TaskManifestEntry],
    remote: &[TaskManifestEntry],
) -> Vec<TaskManifestEntry> {
    let mut map: HashMap<String, TaskManifestEntry> = HashMap::with_capacity(local.len() + remote.len());
    for e in local {
        map.insert(e.stable_id.clone(), e.clone());
    }
    for re in remote {
        match map.get(&re.stable_id) {
            Some(le) if le.updated_at >= re.updated_at => {}
            _ => {
                map.insert(re.stable_id.clone(), re.clone());
            }
        }
    }
    let mut out: Vec<_> = map.into_values().collect();
    out.sort_by(|a, b| a.stable_id.cmp(&b.stable_id));
    out
}

fn merge_task_category_entries(
    local: &[TaskCategoryManifestEntry],
    remote: &[TaskCategoryManifestEntry],
) -> Vec<TaskCategoryManifestEntry> {
    let mut map: HashMap<String, TaskCategoryManifestEntry> = HashMap::with_capacity(local.len() + remote.len());
    for e in local {
        map.insert(e.stable_id.clone(), e.clone());
    }
    // 分类没有 updated_at —— 取本地版本即可（本端视角权威，name 改名以后下次本地写）
    for re in remote {
        if !map.contains_key(&re.stable_id) {
            map.insert(re.stable_id.clone(), re.clone());
        }
    }
    let mut out: Vec<_> = map.into_values().collect();
    out.sort_by(|a, b| a.stable_id.cmp(&b.stable_id));
    out
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
                    // 远端把这条删成 tombstone。
                    // P0-4：tombstone entry 的 updated_at 是删除时刻（deleted_at）。
                    // 若本地 updated_at 比它还新 → 本地在"对端删除之后"又编辑过这条笔记
                    // → "编辑胜过删除"：不删本地，改为 to_push 把本地编辑版重新推上去
                    // （复活远端），避免本地这次编辑被静默丢进回收站。
                    // 否则（本地未在删除后动过）→ 正常 to_delete_local 跟随删除。
                    if le.updated_at > re.updated_at {
                        diff.to_push.push((*le).clone());
                    } else {
                        diff.to_delete_local.push((*re).clone());
                    }
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
                // 内容一致，但元数据可能需要对齐（拉一次，pull.rs 顺带补标记，正文不变）：
                // - is_daily / is_hidden：单向恢复 —— 远端有标记、本地没有 → 拉一次补上
                //   （修历史"伪日记" / 避免隐藏笔记在新端变可见）。反方向不动。
                // - tags：方案 C —— 加 / 删标签已冒泡 updated_at（database::tags），按
                //   updated_at 做 last-write-wins：仅当远端不旧于本地时才拉（远端标签较新 /
                //   持平）。本地标签较新则不拉 —— 靠 push 的 merge_manifests 把本地标签写进
                //   远端 manifest，再由对端拉走。这样"本地只改标签"不会在 pull 时被远端旧
                //   标签回滚（修 P0-1）。
                let meta_recover =
                    (re.is_daily && !le.is_daily) || (re.is_hidden && !le.is_hidden);
                let tags_differ = match (le.tags.as_ref(), re.tags.as_ref()) {
                    (Some(lt), Some(rt)) => lt != rt,
                    _ => false, // 任一为 None（旧 manifest / 加密 / tombstone）→ 不据此触发
                };
                let pull_for_tags = tags_differ && re.updated_at >= le.updated_at;
                if meta_recover || pull_for_tags {
                    diff.to_pull.push((*re).clone());
                }
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

    // ─── Bug 12b：projects / tasks / task_categories 的 diff（last-write-wins）───
    diff_projects(&local.projects, &remote.projects, &mut diff);
    diff_tasks(&local.tasks, &remote.tasks, &mut diff);
    diff_task_categories(&local.task_categories, &remote.task_categories, &mut diff);

    diff
}

/// 项目 diff：last-write-wins
/// - 仅本地有 → push（含本地 tombstone：让远端跟着删）
/// - 仅远端有 → pull（含远端 tombstone：本地需要软删）
/// - 双方都有：content_hash 不同 → updated_at 新者赢；相等忽略
fn diff_projects(
    local: &[ProjectManifestEntry],
    remote: &[ProjectManifestEntry],
    diff: &mut ManifestDiff,
) {
    let remote_map: HashMap<&str, &ProjectManifestEntry> =
        remote.iter().map(|e| (e.stable_id.as_str(), e)).collect();
    let local_map: HashMap<&str, &ProjectManifestEntry> =
        local.iter().map(|e| (e.stable_id.as_str(), e)).collect();
    // 本地视角
    for le in local {
        match remote_map.get(le.stable_id.as_str()) {
            None => diff.projects_to_push.push(le.clone()),
            Some(re) => {
                if le.content_hash == re.content_hash {
                    continue;
                }
                if le.updated_at >= re.updated_at {
                    diff.projects_to_push.push(le.clone());
                } else {
                    diff.projects_to_pull.push((*re).clone());
                }
            }
        }
    }
    // 远端独有
    for re in remote {
        if !local_map.contains_key(re.stable_id.as_str()) {
            diff.projects_to_pull.push(re.clone());
        }
    }
}

/// 任务 diff（同 projects 套路）
fn diff_tasks(
    local: &[TaskManifestEntry],
    remote: &[TaskManifestEntry],
    diff: &mut ManifestDiff,
) {
    let remote_map: HashMap<&str, &TaskManifestEntry> =
        remote.iter().map(|e| (e.stable_id.as_str(), e)).collect();
    let local_map: HashMap<&str, &TaskManifestEntry> =
        local.iter().map(|e| (e.stable_id.as_str(), e)).collect();
    for le in local {
        match remote_map.get(le.stable_id.as_str()) {
            None => diff.tasks_to_push.push(le.clone()),
            Some(re) => {
                if le.content_hash == re.content_hash {
                    continue;
                }
                if le.updated_at >= re.updated_at {
                    diff.tasks_to_push.push(le.clone());
                } else {
                    diff.tasks_to_pull.push((*re).clone());
                }
            }
        }
    }
    for re in remote {
        if !local_map.contains_key(re.stable_id.as_str()) {
            diff.tasks_to_pull.push(re.clone());
        }
    }
}

/// 任务分类 diff：分类无 updated_at，按 content_hash 不同时一律 push（本端视角权威）
/// + 远端独有 → pull。
fn diff_task_categories(
    local: &[TaskCategoryManifestEntry],
    remote: &[TaskCategoryManifestEntry],
    diff: &mut ManifestDiff,
) {
    let remote_map: HashMap<&str, &TaskCategoryManifestEntry> =
        remote.iter().map(|e| (e.stable_id.as_str(), e)).collect();
    let local_map: HashMap<&str, &TaskCategoryManifestEntry> =
        local.iter().map(|e| (e.stable_id.as_str(), e)).collect();
    for le in local {
        match remote_map.get(le.stable_id.as_str()) {
            None => diff.task_categories_to_push.push(le.clone()),
            Some(re) => {
                if le.content_hash != re.content_hash {
                    // 本端权威：分类无 updated_at，所以 push 把本地版本写过去
                    diff.task_categories_to_push.push(le.clone());
                }
            }
        }
    }
    for re in remote {
        if !local_map.contains_key(re.stable_id.as_str()) {
            diff.task_categories_to_pull.push(re.clone());
        }
    }
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
            is_daily: false,
            daily_date: None,
            is_hidden: false,
            tags: None,
        }
    }

    /// 同 `entry` 但带显式 tags（Some(...)）— Bug 12a 标签同步相关测试用
    fn entry_with_tags(
        id: &str,
        title: &str,
        hash: &str,
        ts: &str,
        tags: Vec<&str>,
    ) -> ManifestEntry {
        let mut e = entry(id, title, hash, ts, false);
        e.tags = Some(tags.into_iter().map(|s| s.to_string()).collect());
        e
    }

    /// 同 `entry` 但显式给定每日笔记标记（is_daily 修复相关测试用）
    fn daily_entry(id: &str, title: &str, hash: &str, ts: &str, date: &str) -> ManifestEntry {
        let mut e = entry(id, title, hash, ts, false);
        e.is_daily = true;
        e.daily_date = Some(date.into());
        e
    }

    /// 同 `entry` 但 is_hidden=true（is_hidden 修复相关测试用）
    fn hidden_entry(id: &str, title: &str, hash: &str, ts: &str) -> ManifestEntry {
        let mut e = entry(id, title, hash, ts, false);
        e.is_hidden = true;
        e
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
            projects: vec![],
            tasks: vec![],
            task_categories: vec![],
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

    /// P0-4：本地在远端删除之后又编辑过（本地 updated_at > tombstone 的 deleted_at）
    /// → "编辑胜过删除"，进 to_push 复活，不进 to_delete_local（不丢本地新编辑）
    #[test]
    fn diff_edit_wins_when_local_edited_after_remote_delete() {
        let local = manifest(vec![entry("1", "a", "h_edited", "2026-03-01", false)]);
        // 远端 tombstone 的 updated_at = deleted_at，比本地编辑时刻早
        let remote = manifest(vec![entry("1", "a", "", "2026-02-01", true)]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.to_push.len(), 1, "本地编辑较新 → 复活推送");
        assert!(!d.to_push[0].tombstone, "推上去的是本地 alive 版本");
        assert_eq!(d.to_delete_local.len(), 0, "不能静默删掉本地新编辑");
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

    /// 本地 tombstone 的 deleted_at 比远端 alive 版本新 → merge 取本地 tombstone
    #[test]
    fn merge_local_tombstone_overrides_remote_alive() {
        let local = manifest(vec![entry("1", "a", "", "2026-03-01", true)]);
        let remote = manifest(vec![entry("1", "a", "h_alive", "2026-02-01", false)]);
        let m = merge_manifests(&local, &remote);
        assert_eq!(m.entries.len(), 1);
        assert!(m.entries[0].tombstone, "本地 tombstone 较新 → 取本地");
    }

    /// P0-2：两边都有同一笔记、远端 updated_at 较新 → merge 必须取远端版本。
    /// 早期"两边都有一律取 local"会把远端较新的笔记在 manifest 里回滚成本地旧版本。
    #[test]
    fn merge_takes_remote_when_remote_newer() {
        let local = manifest(vec![entry("1", "旧标题", "h_old", "2026-01-01", false)]);
        let remote = manifest(vec![entry("1", "新标题", "h_new", "2026-02-01", false)]);
        let m = merge_manifests(&local, &remote);
        assert_eq!(m.entries.len(), 1);
        assert_eq!(
            m.entries[0].content_hash, "h_new",
            "远端较新 → 取远端，不能回滚成本地旧 hash"
        );
        assert_eq!(m.entries[0].title, "新标题");
    }

    /// P0-2：远端把笔记删成 tombstone（deleted_at 较新）而本地还 alive
    /// → merge 必须保留远端 tombstone，否则 push 会把已删笔记复活。
    #[test]
    fn merge_keeps_remote_tombstone_when_newer() {
        let local = manifest(vec![entry("1", "a", "h_alive", "2026-01-01", false)]);
        let remote = manifest(vec![entry("1", "a", "", "2026-02-01", true)]);
        let m = merge_manifests(&local, &remote);
        assert_eq!(m.entries.len(), 1);
        assert!(
            m.entries[0].tombstone,
            "远端 tombstone 较新 → 不能复活已删笔记"
        );
    }

    /// P0-2：本地较新（push 刚上传的笔记）→ merge 取本地，不被远端旧版本覆盖。
    #[test]
    fn merge_takes_local_when_local_newer() {
        let local = manifest(vec![entry("1", "本地新", "h_local", "2026-03-01", false)]);
        let remote = manifest(vec![entry("1", "远端旧", "h_remote", "2026-02-01", false)]);
        let m = merge_manifests(&local, &remote);
        assert_eq!(m.entries.len(), 1);
        assert_eq!(m.entries[0].content_hash, "h_local", "本地较新 → 取本地");
    }

    /// P0-2：updated_at 完全相等 → merge 取本地（push 端视角；真冲突由 pull 端处理）。
    #[test]
    fn merge_takes_local_when_ts_equal() {
        let local = manifest(vec![entry("1", "L", "h_local", "2026-01-01", false)]);
        let remote = manifest(vec![entry("1", "R", "h_remote", "2026-01-01", false)]);
        let m = merge_manifests(&local, &remote);
        assert_eq!(m.entries.len(), 1);
        assert_eq!(m.entries[0].content_hash, "h_local");
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

        let _n_active = db
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
            projects: vec![],
            tasks: vec![],
            task_categories: vec![],
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
                paths: vec!["kb_assets/images/1/a.png".into()],
            },
            crate::models::AttachmentEntry {
                hash: "local_only".into(),
                size: 200,
                mime: None,
                ext: None,
                paths: vec![],
            },
        ];
        let mut remote = manifest(vec![]);
        remote.attachments = vec![
            crate::models::AttachmentEntry {
                hash: "common".into(),
                size: 100,
                mime: None,
                ext: None,
                paths: vec!["kb_assets/images/2/b.png".into()],
            },
            crate::models::AttachmentEntry {
                hash: "remote_only".into(),
                size: 300,
                mime: None,
                ext: None,
                paths: vec![],
            },
        ];

        let merged = merge_manifests(&local, &remote);
        assert_eq!(merged.attachments.len(), 3, "common + local_only + remote_only");
        let hashes: std::collections::HashSet<&str> =
            merged.attachments.iter().map(|a| a.hash.as_str()).collect();
        assert!(hashes.contains("common"));
        assert!(hashes.contains("local_only"));
        assert!(hashes.contains("remote_only"));

        // Bug 9: 同 hash 双方都有 → paths 必须并集（local 的 a.png + remote 的 b.png）
        let common = merged.attachments.iter().find(|a| a.hash == "common").unwrap();
        assert!(
            common.paths.contains(&"kb_assets/images/1/a.png".to_string())
                && common.paths.contains(&"kb_assets/images/2/b.png".to_string()),
            "common hash 的 paths 应是双方并集; got = {:?}",
            common.paths
        );
        assert_eq!(common.paths.len(), 2);
    }

    // ───────── 日记重复 bug 修复：is_daily / daily_date 进 manifest ─────────

    /// compute_local_manifest 把笔记的 is_daily / daily_date 填进 entry
    #[test]
    fn compute_local_manifest_carries_daily_flag() {
        use crate::models::NoteInput;
        let db = Database::init(":memory:").unwrap();

        let _plain = db
            .create_note(&NoteInput {
                title: "普通笔记".into(),
                content: "x".into(),
                folder_id: None,
            })
            .unwrap();
        let daily = db.get_or_create_daily("2026-05-12").unwrap();

        let m = compute_local_manifest(&db, "test", "host").unwrap();

        let plain_entry = m.entries.iter().find(|e| e.title == "普通笔记").unwrap();
        assert!(!plain_entry.is_daily, "普通笔记 entry.is_daily 必须 false");
        assert!(plain_entry.daily_date.is_none(), "普通笔记不带 daily_date");

        let daily_uuid: String = {
            let conn = db.conn_lock().unwrap();
            conn.query_row(
                "SELECT stable_uuid FROM notes WHERE id = ?1",
                rusqlite::params![daily.id],
                |r| r.get(0),
            )
            .unwrap()
        };
        let de = m
            .entries
            .iter()
            .find(|e| e.stable_id == daily_uuid)
            .expect("日记 entry 必须在 manifest 里");
        assert!(de.is_daily, "日记 entry.is_daily 必须 true");
        assert_eq!(de.daily_date.as_deref(), Some("2026-05-12"));
    }

    /// diff：内容相同但远端标记为日记、本地不是 → 放进 to_pull 以恢复 is_daily
    #[test]
    fn diff_recovers_daily_flag_when_remote_is_daily() {
        let local = manifest(vec![entry("1", "2026-05-12 的日记", "h1", "2026-05-12", false)]);
        let remote = manifest(vec![daily_entry(
            "1",
            "2026-05-12 的日记",
            "h1",
            "2026-05-12",
            "2026-05-12",
        )]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.to_pull.len(), 1, "应拉一次以恢复 is_daily");
        assert!(d.to_pull[0].is_daily);
        assert_eq!(d.to_pull[0].daily_date.as_deref(), Some("2026-05-12"));
        assert_eq!(d.to_push.len(), 0);
        assert_eq!(d.conflicts.len(), 0);
    }

    /// diff：双方都是日记且内容相同 → 不触发额外 pull
    #[test]
    fn diff_no_recover_when_both_daily() {
        let e = daily_entry("1", "2026-05-12 的日记", "h1", "2026-05-12", "2026-05-12");
        let d = diff_manifests(&manifest(vec![e.clone()]), &manifest(vec![e]));
        assert_eq!(d.to_pull.len(), 0);
        assert_eq!(d.to_push.len(), 0);
    }

    /// diff：本地是日记、远端不是（旧端写的 manifest）→ 不通过 diff 改本地
    #[test]
    fn diff_no_clear_when_local_daily_remote_not() {
        let local = manifest(vec![daily_entry(
            "1",
            "2026-05-12 的日记",
            "h1",
            "2026-05-12",
            "2026-05-12",
        )]);
        let remote = manifest(vec![entry("1", "2026-05-12 的日记", "h1", "2026-05-12", false)]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.to_pull.len(), 0, "不能把本地刚标记的日记又改回普通笔记");
        assert_eq!(d.to_push.len(), 0);
    }

    /// 旧 manifest（无 isDaily/dailyDate 字段）能反序列化为 is_daily=false / daily_date=None
    #[test]
    fn old_manifest_entry_without_daily_fields_deserializes() {
        let json = r#"{
            "manifestVersion": 1,
            "appVersion": "1.0.0",
            "device": "old-host",
            "generatedAt": "2026-01-01 00:00:00",
            "entries": [{
                "stableId": "11111111-1111-1111-1111-111111111111",
                "title": "x",
                "contentHash": "h",
                "updatedAt": "2026-01-01",
                "remotePath": "notes/x.md"
            }]
        }"#;
        let m: SyncManifestV1 = serde_json::from_str(json).expect("旧 manifest 必须能反序列化");
        assert_eq!(m.entries.len(), 1);
        assert!(!m.entries[0].is_daily);
        assert!(m.entries[0].daily_date.is_none());
    }

    /// 新 manifest entry 序列化出 isDaily（daily_date=None 时不输出 dailyDate）
    #[test]
    fn new_manifest_entry_serializes_is_daily() {
        let json = serde_json::to_string(&manifest(vec![daily_entry(
            "1", "x", "h", "t", "2026-05-12",
        )]))
        .unwrap();
        assert!(json.contains("\"isDaily\":true"), "got = {}", json);
        assert!(json.contains("\"dailyDate\":\"2026-05-12\""), "got = {}", json);

        let json2 = serde_json::to_string(&manifest(vec![entry("1", "x", "h", "t", false)])).unwrap();
        assert!(json2.contains("\"isDaily\":false"), "got = {}", json2);
        assert!(!json2.contains("dailyDate"), "非日记不应输出 dailyDate; got = {}", json2);
    }

    // ───────── 修 Bug：隐藏笔记 is_hidden 进同步协议 ─────────

    /// compute_local_manifest 把笔记的 is_hidden 填进 entry
    #[test]
    fn compute_local_manifest_carries_is_hidden() {
        use crate::models::NoteInput;
        let db = Database::init(":memory:").unwrap();

        let visible = db
            .create_note(&NoteInput {
                title: "可见".into(),
                content: "x".into(),
                folder_id: None,
            })
            .unwrap();
        let hidden = db
            .create_note(&NoteInput {
                title: "隐藏".into(),
                content: "y".into(),
                folder_id: None,
            })
            .unwrap();
        {
            let conn = db.conn_lock().unwrap();
            conn.execute(
                "UPDATE notes SET is_hidden = 1 WHERE id = ?1",
                rusqlite::params![hidden.id],
            )
            .unwrap();
        }

        let (uv, uh): (String, String) = {
            let conn = db.conn_lock().unwrap();
            (
                conn.query_row(
                    "SELECT stable_uuid FROM notes WHERE id = ?1",
                    rusqlite::params![visible.id],
                    |r| r.get(0),
                )
                .unwrap(),
                conn.query_row(
                    "SELECT stable_uuid FROM notes WHERE id = ?1",
                    rusqlite::params![hidden.id],
                    |r| r.get(0),
                )
                .unwrap(),
            )
        };

        let m = compute_local_manifest(&db, "test", "host").unwrap();
        assert!(
            !m.entries.iter().find(|e| e.stable_id == uv).unwrap().is_hidden,
            "可见笔记 entry.is_hidden 必须 false"
        );
        assert!(
            m.entries.iter().find(|e| e.stable_id == uh).unwrap().is_hidden,
            "隐藏笔记 entry.is_hidden 必须 true"
        );
    }

    /// diff：内容相同但远端标记隐藏、本地不隐藏 → 放进 to_pull 以恢复 is_hidden
    #[test]
    fn diff_recovers_is_hidden_when_remote_hidden() {
        let local = manifest(vec![entry("1", "a", "h1", "2026-05-12", false)]);
        let remote = manifest(vec![hidden_entry("1", "a", "h1", "2026-05-12")]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.to_pull.len(), 1, "应拉一次以恢复 is_hidden");
        assert!(d.to_pull[0].is_hidden);
        assert_eq!(d.to_push.len(), 0);
        assert_eq!(d.conflicts.len(), 0);
    }

    /// diff：本地隐藏、远端不隐藏（旧端写的 manifest）→ 不通过 diff 取消本地隐藏
    #[test]
    fn diff_no_unhide_when_local_hidden_remote_not() {
        let local = manifest(vec![hidden_entry("1", "a", "h1", "2026-05-12")]);
        let remote = manifest(vec![entry("1", "a", "h1", "2026-05-12", false)]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.to_pull.len(), 0, "不能把本地刚隐藏的笔记又改回可见");
        assert_eq!(d.to_push.len(), 0);
    }

    /// 旧 manifest（无 isHidden 字段）反序列化为 is_hidden=false；新 entry 序列化出 isHidden
    #[test]
    fn is_hidden_serde_compatibility() {
        let old = r#"{"manifestVersion":1,"appVersion":"x","device":"x","generatedAt":"x","entries":[{"stableId":"u","title":"t","contentHash":"h","updatedAt":"u","remotePath":"notes/u.md"}]}"#;
        let m: SyncManifestV1 = serde_json::from_str(old).unwrap();
        assert!(!m.entries[0].is_hidden, "旧 manifest entry 应反序列化为 is_hidden=false");

        let json = serde_json::to_string(&manifest(vec![hidden_entry("1", "x", "h", "t")])).unwrap();
        assert!(json.contains("\"isHidden\":true"), "got = {}", json);
        let json2 = serde_json::to_string(&manifest(vec![entry("1", "x", "h", "t", false)])).unwrap();
        assert!(json2.contains("\"isHidden\":false"), "got = {}", json2);
    }

    // ───────── Bug 12a：标签跨端同步 ─────────

    /// compute_local_manifest 把每条笔记的标签名列表填进 entry.tags
    #[test]
    fn compute_local_manifest_carries_tags() {
        use crate::models::NoteInput;
        let db = Database::init(":memory:").unwrap();

        let n = db
            .create_note(&NoteInput {
                title: "带标签".into(),
                content: "x".into(),
                folder_id: None,
            })
            .unwrap();
        let no_tag = db
            .create_note(&NoteInput {
                title: "无标签".into(),
                content: "y".into(),
                folder_id: None,
            })
            .unwrap();
        let tag1 = db.get_or_create_tag_by_name("工作").unwrap();
        let tag2 = db.get_or_create_tag_by_name("周报").unwrap();
        db.add_tag_to_note(n.id, tag1).unwrap();
        db.add_tag_to_note(n.id, tag2).unwrap();

        let m = compute_local_manifest(&db, "test", "host").unwrap();
        let with_tag = m.entries.iter().find(|e| e.title == "带标签").unwrap();
        assert_eq!(
            with_tag.tags.as_ref().unwrap().iter().cloned().collect::<std::collections::HashSet<_>>(),
            ["工作".to_string(), "周报".to_string()].into_iter().collect::<std::collections::HashSet<_>>()
        );
        let without_tag = m.entries.iter().find(|e| e.title == "无标签").unwrap();
        assert_eq!(
            without_tag.tags.as_ref().map(|v| v.is_empty()),
            Some(true),
            "无标签笔记 tags 应是 Some(vec![])（让 pull 端能把对端清空）"
        );
        let _ = no_tag;
    }

    /// diff：内容相同、tags 不同、updated_at 持平 → 拉一次（让"只改标签"能跨端）
    #[test]
    fn diff_recovers_tags_when_only_tags_differ() {
        let local = manifest(vec![entry_with_tags("1", "a", "h1", "t", vec!["工作"])]);
        let remote = manifest(vec![entry_with_tags("1", "a", "h1", "t", vec!["工作", "周报"])]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.to_pull.len(), 1, "tags 不同应触发拉取（content_hash 没变）");
        assert_eq!(d.to_push.len(), 0);
    }

    /// P0-1 / 方案 C：内容相同、本地标签较新（updated_at 更大）→ 不 to_pull
    /// （否则 pull 会把本地刚改的标签回滚成远端旧标签）
    #[test]
    fn diff_no_pull_when_local_tags_newer() {
        let local = manifest(vec![entry_with_tags(
            "1",
            "a",
            "h1",
            "2026-02-01",
            vec!["工作", "周报"],
        )]);
        let remote = manifest(vec![entry_with_tags("1", "a", "h1", "2026-01-01", vec!["工作"])]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.to_pull.len(), 0, "本地标签较新 → 不拉，避免回滚（P0-1）");
        assert_eq!(d.to_push.len(), 0);
    }

    /// 方案 C：内容相同、远端标签较新（updated_at 更大）→ to_pull（接收远端标签）
    #[test]
    fn diff_pull_when_remote_tags_newer() {
        let local = manifest(vec![entry_with_tags("1", "a", "h1", "2026-01-01", vec!["工作"])]);
        let remote = manifest(vec![entry_with_tags(
            "1",
            "a",
            "h1",
            "2026-02-01",
            vec!["工作", "周报"],
        )]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.to_pull.len(), 1, "远端标签较新 → 拉取");
    }

    /// diff：双方 tags 都为 None（旧客户端 / 加密 / tombstone）→ 不据此触发
    #[test]
    fn diff_no_pull_when_tags_both_none() {
        let local = manifest(vec![entry("1", "a", "h1", "t", false)]);
        let remote = manifest(vec![entry("1", "a", "h1", "t", false)]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.to_pull.len(), 0);
    }

    /// diff：双方 tags 都 Some 且相等 → 不触发
    #[test]
    fn diff_no_pull_when_tags_equal() {
        let e1 = entry_with_tags("1", "a", "h1", "t", vec!["工作", "周报"]);
        let d = diff_manifests(&manifest(vec![e1.clone()]), &manifest(vec![e1]));
        assert_eq!(d.to_pull.len(), 0);
    }

    /// diff：远端 Some(vec![]) 本地 Some(["a"]) → 拉一次（"用户清空标签"也能传播）
    #[test]
    fn diff_recovers_when_remote_clears_tags() {
        let local = manifest(vec![entry_with_tags("1", "a", "h1", "t", vec!["a"])]);
        let remote = manifest(vec![entry_with_tags("1", "a", "h1", "t", vec![])]);
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.to_pull.len(), 1);
    }

    /// 旧 manifest 无 tags 字段 → 反序列化为 None；新 entry 序列化出 tags 字段
    #[test]
    fn tags_serde_compat() {
        let old = r#"{"manifestVersion":1,"appVersion":"x","device":"x","generatedAt":"x","entries":[{"stableId":"u","title":"t","contentHash":"h","updatedAt":"u","remotePath":"notes/u.md"}]}"#;
        let m: SyncManifestV1 = serde_json::from_str(old).unwrap();
        assert!(m.entries[0].tags.is_none());

        let json = serde_json::to_string(&manifest(vec![entry_with_tags("1", "x", "h", "t", vec!["work"])])).unwrap();
        assert!(json.contains("\"tags\":[\"work\"]"), "got = {}", json);

        // None 不应序列化（skip_serializing_if）
        let json2 = serde_json::to_string(&manifest(vec![entry("1", "x", "h", "t", false)])).unwrap();
        assert!(!json2.contains("\"tags\""), "tags=None 时不应序列化; got = {}", json2);
    }

    /// 加密笔记 tags 设 None（不在 manifest 里明文携带标签）
    #[test]
    fn compute_manifest_encrypted_note_has_no_tags() {
        use crate::models::NoteInput;
        let db = Database::init(":memory:").unwrap();
        let n = db
            .create_note(&NoteInput {
                title: "密".into(),
                content: "x".into(),
                folder_id: None,
            })
            .unwrap();
        let tag = db.get_or_create_tag_by_name("私密").unwrap();
        db.add_tag_to_note(n.id, tag).unwrap();
        // 标记加密（绕过完整 vault 流程，直接置位）
        {
            let conn = db.conn_lock().unwrap();
            conn.execute(
                "UPDATE notes SET is_encrypted = 1, encrypted_blob = ?1 WHERE id = ?2",
                rusqlite::params![vec![0u8, 1, 2], n.id],
            )
            .unwrap();
        }

        let m = compute_local_manifest(&db, "t", "h").unwrap();
        let e = m.entries.iter().find(|e| e.title == "密").unwrap();
        assert!(e.encrypted);
        assert!(e.tags.is_none(), "加密笔记 tags 应 None（不明文同步）");
    }

    // ───────── Bug 12b：projects / tasks / task_categories diff 测试 ─────────

    fn proj(id: &str, hash: &str, ts: &str, tombstone: bool) -> ProjectManifestEntry {
        ProjectManifestEntry {
            stable_id: id.into(),
            name: format!("P-{}", id),
            content_hash: hash.into(),
            updated_at: ts.into(),
            description: None,
            color: "#1677ff".into(),
            start_date: None,
            end_date: None,
            archived: false,
            sort_order: 0,
            tombstone,
        }
    }

    fn task(id: &str, hash: &str, ts: &str, tombstone: bool) -> TaskManifestEntry {
        TaskManifestEntry {
            stable_id: id.into(),
            title: format!("T-{}", id),
            content_hash: hash.into(),
            updated_at: ts.into(),
            description: None,
            priority: 1,
            important: false,
            status: 0,
            due_date: None,
            start_date: None,
            completed_at: None,
            kanban_stage: "todo".into(),
            parent_task_uuid: None,
            project_uuid: None,
            category_uuid: None,
            repeat_kind: "none".into(),
            repeat_interval: 1,
            repeat_weekdays: None,
            repeat_until: None,
            repeat_count: None,
            tombstone,
        }
    }

    fn cat(id: &str, hash: &str) -> TaskCategoryManifestEntry {
        TaskCategoryManifestEntry {
            stable_id: id.into(),
            name: format!("C-{}", id),
            content_hash: hash.into(),
            color: "#1677ff".into(),
            icon: None,
            sort_order: 0,
        }
    }

    /// 本地独有项目 → push；远端独有项目 → pull
    #[test]
    fn diff_projects_outer_join() {
        let mut local = manifest(vec![]);
        local.projects = vec![proj("p1", "h1", "2026-01-01", false)];
        let mut remote = manifest(vec![]);
        remote.projects = vec![proj("p2", "h2", "2026-01-01", false)];

        let d = diff_manifests(&local, &remote);
        assert_eq!(d.projects_to_push.len(), 1);
        assert_eq!(d.projects_to_push[0].stable_id, "p1");
        assert_eq!(d.projects_to_pull.len(), 1);
        assert_eq!(d.projects_to_pull[0].stable_id, "p2");
    }

    /// 同 UUID 双方都有，hash 不同：远端 updated_at 较新 → pull；本地较新 → push
    #[test]
    fn diff_projects_last_write_wins() {
        // 远端较新
        {
            let mut local = manifest(vec![]);
            local.projects = vec![proj("p", "h_local", "2026-01-01", false)];
            let mut remote = manifest(vec![]);
            remote.projects = vec![proj("p", "h_remote", "2026-02-01", false)];
            let d = diff_manifests(&local, &remote);
            assert_eq!(d.projects_to_pull.len(), 1);
            assert_eq!(d.projects_to_push.len(), 0);
        }
        // 本地较新
        {
            let mut local = manifest(vec![]);
            local.projects = vec![proj("p", "h_local", "2026-03-01", false)];
            let mut remote = manifest(vec![]);
            remote.projects = vec![proj("p", "h_remote", "2026-02-01", false)];
            let d = diff_manifests(&local, &remote);
            assert_eq!(d.projects_to_push.len(), 1);
            assert_eq!(d.projects_to_pull.len(), 0);
        }
    }

    /// 同 UUID 双方 hash 相同 → 不进 push/pull（等价跳过）
    #[test]
    fn diff_projects_skip_when_hash_equal() {
        let mut local = manifest(vec![]);
        local.projects = vec![proj("p", "h_same", "2026-01-01", false)];
        let mut remote = manifest(vec![]);
        remote.projects = vec![proj("p", "h_same", "2026-02-01", false)];
        let d = diff_manifests(&local, &remote);
        assert!(d.projects_to_push.is_empty());
        assert!(d.projects_to_pull.is_empty());
    }

    /// 本地 tombstone 也要 push（让远端跟着软删）
    #[test]
    fn diff_projects_push_local_tombstone() {
        let mut local = manifest(vec![]);
        local.projects = vec![proj("p", "h_del", "2026-03-01", true)];
        let mut remote = manifest(vec![]);
        remote.projects = vec![proj("p", "h_live", "2026-02-01", false)];
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.projects_to_push.len(), 1);
        assert!(d.projects_to_push[0].tombstone, "本地软删 → 远端跟随");
    }

    /// 任务 diff 同 projects 走 last-write-wins
    #[test]
    fn diff_tasks_last_write_wins() {
        let mut local = manifest(vec![]);
        local.tasks = vec![task("t", "h_l", "2026-01-01", false)];
        let mut remote = manifest(vec![]);
        remote.tasks = vec![task("t", "h_r", "2026-02-01", false)];
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.tasks_to_pull.len(), 1);
        assert_eq!(d.tasks_to_push.len(), 0);
    }

    /// 分类无 updated_at → hash 不等本地权威，push 把本地版本写过去
    #[test]
    fn diff_task_categories_local_wins_on_diff() {
        let mut local = manifest(vec![]);
        local.task_categories = vec![cat("c", "h_local")];
        let mut remote = manifest(vec![]);
        remote.task_categories = vec![cat("c", "h_remote")];
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.task_categories_to_push.len(), 1);
        assert_eq!(d.task_categories_to_push[0].content_hash, "h_local");
        assert!(d.task_categories_to_pull.is_empty());
    }

    /// 分类远端独有 → pull
    #[test]
    fn diff_task_categories_remote_only_pulled() {
        let local = manifest(vec![]);
        let mut remote = manifest(vec![]);
        remote.task_categories = vec![cat("c", "h")];
        let d = diff_manifests(&local, &remote);
        assert_eq!(d.task_categories_to_pull.len(), 1);
    }

    /// merge：projects 取较新 updated_at（last-write-wins）+ 远端独有保留
    #[test]
    fn merge_projects_keeps_newer_and_remote_only() {
        let mut local = manifest(vec![]);
        local.projects = vec![
            proj("p1", "h1_local", "2026-02-01", false),
            proj("p2", "h2_local", "2026-01-01", false),
        ];
        let mut remote = manifest(vec![]);
        remote.projects = vec![
            proj("p1", "h1_remote", "2026-01-01", false), // 本地较新
            proj("p2", "h2_remote", "2026-03-01", false), // 远端较新
            proj("p3", "h3_remote", "2026-01-01", false), // 远端独有
        ];
        let merged = merge_manifests(&local, &remote);
        let by_id: HashMap<&str, &ProjectManifestEntry> = merged
            .projects
            .iter()
            .map(|p| (p.stable_id.as_str(), p))
            .collect();
        assert_eq!(by_id.get("p1").unwrap().content_hash, "h1_local");
        assert_eq!(by_id.get("p2").unwrap().content_hash, "h2_remote");
        assert!(by_id.contains_key("p3"), "远端独有项目必须保留");
    }

    /// manifest JSON 往返：projects / tasks / task_categories 不丢失
    #[test]
    fn manifest_json_roundtrip_includes_new_fields() {
        let mut m = manifest(vec![]);
        m.projects = vec![proj("p1", "h1", "2026-01-01", false)];
        m.tasks = vec![task("t1", "th", "2026-01-01", false)];
        m.task_categories = vec![cat("c1", "ch")];

        let s = serde_json::to_string(&m).unwrap();
        // 序列化后键名应是 camelCase（manifestVersion / taskCategories）
        assert!(s.contains("\"taskCategories\""), "字段名应是 camelCase: {}", s);
        assert!(s.contains("\"stableId\""), "stable_id 序列化为 stableId: {}", s);

        let back: SyncManifestV1 = serde_json::from_str(&s).unwrap();
        assert_eq!(back.projects.len(), 1);
        assert_eq!(back.projects[0].stable_id, "p1");
        assert_eq!(back.tasks.len(), 1);
        assert_eq!(back.tasks[0].stable_id, "t1");
        assert_eq!(back.task_categories.len(), 1);
        assert_eq!(back.task_categories[0].stable_id, "c1");
    }
}
