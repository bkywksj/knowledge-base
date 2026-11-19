//! v73：文件夹树的 manifest 构建、合并、对比与拉取落库
//!
//! 以前文件夹只靠笔记条目带的路径（`folder_path`）在对端补建：空文件夹传不过去，
//! 改名 / 删除 / 排序也传不过去。现在整棵树单独进 manifest，规则同提示词：
//! 按 stable_id outer-join，`updated_at` 新者赢，删除靠 tombstone 传播。
//!
//! 存量文件夹是各端各自建的，stable_uuid 对不上：升级后第一次同步先按「同一父级 + 同名」
//! 配对（[`adopt_remote_folder_ids`]），否则每个文件夹都会在对端多出一份。

use std::collections::{HashMap, HashSet};

use sha2::{Digest, Sha256};

use super::content_sync::{diff_lww, merge_lww, tombstone_cutoff, LwwEntry};
use crate::database::sync_content::{FolderSyncRow, TOMBSTONE_KIND_FOLDER};
use crate::database::Database;
use crate::error::AppError;
use crate::models::{FolderManifestEntry, SyncPullResult};

pub fn folder_content_hash(f: &FolderManifestEntry) -> String {
    let mut h = Sha256::new();
    for part in [
        f.name.as_str(),
        f.parent_stable_id.as_deref().unwrap_or(""),
        &f.sort_order.to_string(),
        f.color.as_deref().unwrap_or(""),
        if f.tombstone { "1" } else { "0" },
    ] {
        h.update(part.as_bytes());
        h.update(b"\n");
    }
    format!("{:x}", h.finalize())
}

pub fn build_folder_entries(db: &Database) -> Result<Vec<FolderManifestEntry>, AppError> {
    let mut out = db.list_folders_for_sync()?;
    let live: HashSet<String> = out.iter().map(|f| f.stable_id.clone()).collect();
    for (uuid, deleted_at) in db.list_sync_tombstones(TOMBSTONE_KIND_FOLDER, &tombstone_cutoff())? {
        if live.contains(&uuid) {
            continue; // 删了又从远端拉回来过，以现存行为准
        }
        out.push(FolderManifestEntry {
            stable_id: uuid,
            content_hash: String::new(),
            updated_at: deleted_at,
            name: String::new(),
            parent_stable_id: None,
            sort_order: 0,
            color: None,
            tombstone: true,
        });
    }
    for f in &mut out {
        f.content_hash = folder_content_hash(f);
    }
    out.sort_by(|a, b| a.stable_id.cmp(&b.stable_id));
    Ok(out)
}

impl LwwEntry for FolderManifestEntry {
    fn id(&self) -> &str {
        &self.stable_id
    }
    fn updated(&self) -> &str {
        &self.updated_at
    }
    fn hash(&self) -> &str {
        &self.content_hash
    }
    fn is_tombstone(&self) -> bool {
        self.tombstone
    }
}

pub fn merge_folders(
    local: &[FolderManifestEntry],
    remote: &[FolderManifestEntry],
) -> Vec<FolderManifestEntry> {
    merge_lww(local, remote)
}

pub fn diff_folders(
    local: &[FolderManifestEntry],
    remote: &[FolderManifestEntry],
) -> Vec<FolderManifestEntry> {
    diff_lww(local, remote)
}

/// 父级排在子级前面（按条目内的父子链算深度；父级不在这批里的算根层）。
/// 链上有环时截断，不会死循环
fn parents_first(entries: &[FolderManifestEntry]) -> Vec<&FolderManifestEntry> {
    let by_id: HashMap<&str, &FolderManifestEntry> =
        entries.iter().map(|e| (e.stable_id.as_str(), e)).collect();
    let depth = |e: &FolderManifestEntry| {
        let mut d = 0usize;
        let mut cur = e.parent_stable_id.as_deref();
        while let Some(p) = cur {
            match by_id.get(p) {
                Some(pe) if d < entries.len() => {
                    d += 1;
                    cur = pe.parent_stable_id.as_deref();
                }
                _ => break,
            }
        }
        d
    };
    let mut out: Vec<(usize, &FolderManifestEntry)> = entries.iter().map(|e| (depth(e), e)).collect();
    out.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.stable_id.cmp(&b.1.stable_id)));
    out.into_iter().map(|(_, e)| e).collect()
}

/// 算出本地哪些文件夹要改用远端的 stable_uuid：`(本地 id, 远端 stable_uuid)`。
///
/// 远端每个本地没有的文件夹，在本地找「同一父级 + 同名」、且自己的 uuid 不在远端清单里的那个
/// （在远端清单里说明它已经是另一个同步过的文件夹，只是恰好同名）。父级先配，子级才能按父级找；
/// 同名有多个时取 id 最小的，一个本地文件夹只配一次。
fn plan_folder_adoption(
    local_rows: &[FolderSyncRow],
    remote: &[FolderManifestEntry],
) -> Vec<(i64, String)> {
    let remote_ids: HashSet<&str> = remote.iter().map(|e| e.stable_id.as_str()).collect();
    let local_by_uuid: HashMap<&str, i64> = local_rows
        .iter()
        .filter_map(|(id, uuid, _, _)| uuid.as_deref().map(|u| (u, *id)))
        .collect();
    let mut mapped: HashMap<String, i64> = remote
        .iter()
        .filter_map(|e| local_by_uuid.get(e.stable_id.as_str()).map(|id| (e.stable_id.clone(), *id)))
        .collect();
    let mut claimed: HashSet<i64> = mapped.values().copied().collect();
    let mut plan = Vec::new();

    let alive: Vec<FolderManifestEntry> = remote.iter().filter(|e| !e.tombstone).cloned().collect();
    for re in parents_first(&alive) {
        if mapped.contains_key(&re.stable_id) {
            continue;
        }
        let parent_local: Option<i64> = match re.parent_stable_id.as_deref() {
            None => None,
            Some(pu) => match mapped.get(pu) {
                Some(id) => Some(*id),
                None => continue, // 父级本地没有 → 子级也不可能配上，拉取时整枝新建
            },
        };
        let candidate = local_rows
            .iter()
            .filter(|(id, uuid, parent, name)| {
                *parent == parent_local
                    && *name == re.name
                    && !claimed.contains(id)
                    && !uuid.as_deref().is_some_and(|u| remote_ids.contains(u))
            })
            .map(|(id, _, _, _)| *id)
            .min();
        if let Some(id) = candidate {
            plan.push((id, re.stable_id.clone()));
            mapped.insert(re.stable_id.clone(), id);
            claimed.insert(id);
        }
    }
    plan
}

/// 首次同步配对：把本地与远端「同一父级 + 同名」的文件夹改用远端的 stable_uuid。返回改了几个。
///
/// push / pull 都要在算本地 manifest 之前调：只跑 push 时不配对，会把另一套 uuid 写上远端，
/// 别的设备拉下来就是两份同名文件夹。配对过一次之后 uuid 已一致，再调是空操作。
pub fn adopt_remote_folder_ids(
    db: &Database,
    remote: &[FolderManifestEntry],
) -> Result<usize, AppError> {
    if remote.is_empty() {
        return Ok(0);
    }
    let plan = plan_folder_adoption(&db.list_folder_sync_rows()?, remote);
    for (id, uuid) in &plan {
        db.set_folder_stable_uuid(*id, uuid)?;
    }
    if !plan.is_empty() {
        log::info!("[sync_v1] 首次同步配对：{} 个文件夹改用远端的 stable_uuid", plan.len());
    }
    Ok(plan.len())
}

/// 拉取落库。要在笔记之前跑：笔记按 `folder_uuid` 找文件夹，找不到才按路径补建。
/// 先建 / 改（父级在前），再删 —— 子文件夹被挪出去之后再删父级，不会被连带提到根层
pub fn apply_pulled_folders(
    db: &Database,
    entries: &[FolderManifestEntry],
    result: &mut SyncPullResult,
) {
    let (dead, alive): (Vec<_>, Vec<_>) = entries.iter().cloned().partition(|e| e.tombstone);
    for e in parents_first(&alive) {
        let parent_id = match e.parent_stable_id.as_deref() {
            None => None,
            Some(pu) => match db.get_folder_id_by_stable_uuid(pu) {
                Ok(Some(id)) => Some(id),
                Ok(None) => {
                    log::warn!("[sync_v1] 文件夹「{}」的父级本地不存在，先放根层", e.name);
                    None
                }
                Err(err) => {
                    result.errors.push(format!("查文件夹 {} 的父级失败: {}", e.name, err));
                    continue;
                }
            },
        };
        if let Err(err) = db.upsert_folder_synced(e, parent_id) {
            result.errors.push(format!("同步文件夹 {} 失败: {}", e.name, err));
        }
    }
    for e in &dead {
        if let Err(err) = db.delete_folder_synced(&e.stable_id, &e.updated_at) {
            result.errors.push(format!("同步删除文件夹失败: {}", err));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(id: &str, name: &str, parent: Option<&str>, updated: &str) -> FolderManifestEntry {
        let mut f = FolderManifestEntry {
            stable_id: id.into(),
            content_hash: String::new(),
            updated_at: updated.into(),
            name: name.into(),
            parent_stable_id: parent.map(String::from),
            sort_order: 0,
            color: None,
            tombstone: false,
        };
        f.content_hash = folder_content_hash(&f);
        f
    }

    fn tombstone(id: &str, deleted_at: &str) -> FolderManifestEntry {
        let mut f = folder(id, "", None, deleted_at);
        f.tombstone = true;
        f.content_hash = folder_content_hash(&f);
        f
    }

    fn row(id: i64, uuid: &str, parent: Option<i64>, name: &str) -> FolderSyncRow {
        (id, Some(uuid.into()), parent, name.into())
    }

    #[test]
    fn adoption_pairs_same_name_same_parent_top_down() {
        // 本地：工作(1) / 周报(2)；远端同名同结构但 uuid 不同
        let local = vec![row(1, "l-work", None, "工作"), row(2, "l-week", Some(1), "周报")];
        let remote = vec![
            folder("r-week", "周报", Some("r-work"), "2026-11-01 00:00:00"),
            folder("r-work", "工作", None, "2026-11-01 00:00:00"),
        ];
        let plan = plan_folder_adoption(&local, &remote);
        assert_eq!(plan, vec![(1, "r-work".to_string()), (2, "r-week".to_string())]);
    }

    #[test]
    fn adoption_skips_folder_already_synced_under_same_name() {
        // 本地「工作」的 uuid 已在远端（是另一个同步过的文件夹）→ 远端新的同名文件夹不配它
        let local = vec![row(1, "shared", None, "工作")];
        let remote = vec![
            folder("shared", "工作", None, "2026-11-01 00:00:00"),
            folder("r-other", "工作", None, "2026-11-01 00:00:00"),
        ];
        assert!(plan_folder_adoption(&local, &remote).is_empty());
    }

    #[test]
    fn adoption_ignores_different_parent_and_tombstones() {
        let local = vec![row(1, "l-a", None, "A"), row(2, "l-b", None, "B")];
        let remote = vec![
            folder("r-root", "根", None, "2026-11-01 00:00:00"),
            // 远端的 A 在「根」下面，本地 A 在根层 → 不配
            folder("r-a", "A", Some("r-root"), "2026-11-01 00:00:00"),
            // 已删除的不配
            {
                let mut b = tombstone("r-b", "2026-11-01 00:00:00");
                b.name = "B".into();
                b
            },
        ];
        assert!(plan_folder_adoption(&local, &remote).is_empty());
    }

    #[test]
    fn adoption_claims_each_local_folder_once() {
        let local = vec![row(5, "l-1", None, "重名"), row(3, "l-2", None, "重名")];
        let remote = vec![
            folder("r-1", "重名", None, "2026-11-01 00:00:00"),
            folder("r-2", "重名", None, "2026-11-01 00:00:00"),
            folder("r-3", "重名", None, "2026-11-01 00:00:00"),
        ];
        let plan = plan_folder_adoption(&local, &remote);
        assert_eq!(plan, vec![(3, "r-1".to_string()), (5, "r-2".to_string())]);
    }

    #[test]
    fn diff_pulls_newer_rename_and_newer_tombstone_only() {
        let local = vec![
            folder("a", "旧名", None, "2026-11-01 10:00:00"),
            folder("b", "B", None, "2026-11-05 10:00:00"),
            folder("c", "C", None, "2026-11-01 10:00:00"),
        ];
        let remote = vec![
            folder("a", "新名", None, "2026-11-02 10:00:00"),
            // 远端删了 b，但本地之后又改过 → 不删
            tombstone("b", "2026-11-03 10:00:00"),
            tombstone("c", "2026-11-03 10:00:00"),
            folder("d", "空文件夹", None, "2026-11-01 10:00:00"),
            tombstone("e", "2026-11-03 10:00:00"),
        ];
        let mut ids: Vec<String> = diff_folders(&local, &remote)
            .into_iter()
            .map(|f| f.stable_id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["a", "c", "d"]);
    }

    // ─── 落库（真实内存库，含 v73 触发器） ─────────────────────

    fn sql_one(db: &Database, sql: &str, id: i64) -> Option<String> {
        let conn = db.conn_lock().unwrap();
        conn.query_row(sql, rusqlite::params![id], |r| r.get(0)).unwrap()
    }

    fn uuid_of(db: &Database, id: i64) -> String {
        sql_one(db, "SELECT stable_uuid FROM folders WHERE id = ?1", id).unwrap()
    }

    fn updated_of(db: &Database, id: i64) -> String {
        sql_one(db, "SELECT updated_at FROM folders WHERE id = ?1", id).unwrap()
    }

    fn age(db: &Database, id: i64) {
        // 把记录时间拨回过去，才看得出触发器有没有重新记时
        db.conn_lock()
            .unwrap()
            .execute(
                "UPDATE folders SET updated_at = '2000-01-01 00:00:00' WHERE id = ?1",
                rusqlite::params![id],
            )
            .unwrap();
    }

    #[test]
    fn triggers_fill_uuid_touch_on_edit_and_record_delete() {
        let db = Database::init(":memory:").unwrap();
        let f = db.create_folder("工作", None).unwrap();
        assert_eq!(uuid_of(&db, f.id).len(), 36);

        age(&db, f.id);
        db.rename_folder(f.id, "工作2").unwrap();
        assert_ne!(updated_of(&db, f.id), "2000-01-01 00:00:00", "改名要重新记时");

        // 同步落库自带远端时间，触发器不能盖掉
        let mut e = build_folder_entries(&db).unwrap().remove(0);
        e.name = "远端改的名".into();
        e.updated_at = "2001-01-01 00:00:00".into();
        db.upsert_folder_synced(&e, None).unwrap();
        assert_eq!(updated_of(&db, f.id), "2001-01-01 00:00:00");

        let uuid = uuid_of(&db, f.id);
        db.delete_folder(f.id).unwrap();
        let entries = build_folder_entries(&db).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].tombstone && entries[0].stable_id == uuid);
    }

    #[test]
    fn apply_creates_tree_renames_and_deletes_without_losing_notes() {
        let db = Database::init(":memory:").unwrap();
        let mut result = SyncPullResult::default();
        // 子级排在父级前面也要能建对
        apply_pulled_folders(
            &db,
            &[
                folder("r-week", "周报", Some("r-work"), "2026-11-01 00:00:00"),
                folder("r-work", "工作", None, "2026-11-01 00:00:00"),
                folder("r-empty", "空文件夹", None, "2026-11-01 00:00:00"),
            ],
            &mut result,
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        let work = db.get_folder_id_by_stable_uuid("r-work").unwrap().unwrap();
        let week = db.get_folder_id_by_stable_uuid("r-week").unwrap().unwrap();
        assert_eq!(
            sql_one(&db, "SELECT CAST(parent_id AS TEXT) FROM folders WHERE id = ?1", week),
            Some(work.to_string())
        );

        // 改名 + 删除；被删文件夹里的笔记移到未分类，不删
        db.conn_lock()
            .unwrap()
            .execute(
                "INSERT INTO notes (title, content, folder_id) VALUES ('周报一', '', ?1)",
                rusqlite::params![week],
            )
            .unwrap();
        apply_pulled_folders(
            &db,
            &[
                folder("r-work", "工作（改名）", None, "2026-11-02 00:00:00"),
                tombstone("r-week", "2026-11-02 00:00:00"),
            ],
            &mut result,
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            sql_one(&db, "SELECT name FROM folders WHERE id = ?1", work).as_deref(),
            Some("工作（改名）")
        );
        assert!(db.get_folder_id_by_stable_uuid("r-week").unwrap().is_none());
        let (alive, folder_null): (i64, i64) = db
            .conn_lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*), SUM(folder_id IS NULL) FROM notes WHERE title = '周报一' AND is_deleted = 0",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((alive, folder_null), (1, 1));
        // 删除记录用的是远端时间
        assert_eq!(
            db.list_sync_tombstones(TOMBSTONE_KIND_FOLDER, "2000-01-01 00:00:00").unwrap(),
            vec![("r-week".to_string(), "2026-11-02 00:00:00".to_string())]
        );
    }

    #[test]
    fn apply_breaks_cycle_by_moving_to_root() {
        let db = Database::init(":memory:").unwrap();
        let mut result = SyncPullResult::default();
        apply_pulled_folders(
            &db,
            &[
                folder("a", "A", None, "2026-11-01 00:00:00"),
                folder("b", "B", Some("a"), "2026-11-01 00:00:00"),
            ],
            &mut result,
        );
        // 远端说 A 挪进了 B（本地 B 还在 A 下面）→ 不能成环，A 放根层
        apply_pulled_folders(&db, &[folder("a", "A", Some("b"), "2026-11-02 00:00:00")], &mut result);
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        let a = db.get_folder_id_by_stable_uuid("a").unwrap().unwrap();
        assert_eq!(sql_one(&db, "SELECT CAST(parent_id AS TEXT) FROM folders WHERE id = ?1", a), None);
    }

    #[test]
    fn first_sync_pairs_existing_folders_then_only_pulls_new_ones() {
        // 两台设备各自建过同样的「工作/周报」，B 另有一个空文件夹「阅读」
        let a = Database::init(":memory:").unwrap();
        let b = Database::init(":memory:").unwrap();
        for db in [&a, &b] {
            let work = db.create_folder("工作", None).unwrap();
            db.create_folder("周报", Some(work.id)).unwrap();
        }
        b.create_folder("阅读", None).unwrap();
        let remote = build_folder_entries(&b).unwrap();

        assert_eq!(adopt_remote_folder_ids(&a, &remote).unwrap(), 2);
        assert_eq!(adopt_remote_folder_ids(&a, &remote).unwrap(), 0, "配过一次再调是空操作");

        let local = build_folder_entries(&a).unwrap();
        let to_pull = diff_folders(&local, &remote);
        assert_eq!(to_pull.len(), 1);
        assert_eq!(to_pull[0].name, "阅读");

        let mut result = SyncPullResult::default();
        apply_pulled_folders(&a, &to_pull, &mut result);
        let names: Vec<String> = {
            let conn = a.conn_lock().unwrap();
            let mut stmt = conn.prepare("SELECT name FROM folders ORDER BY name").unwrap();
            let rows = stmt.query_map([], |r| r.get(0)).unwrap();
            rows.map(|r| r.unwrap()).collect()
        };
        assert_eq!(names, vec!["周报", "工作", "阅读"]);
    }

    #[test]
    fn parents_first_orders_by_depth_and_survives_cycles() {
        let entries = vec![
            folder("c", "C", Some("b"), "t"),
            folder("b", "B", Some("a"), "t"),
            folder("a", "A", None, "t"),
            folder("x", "X", Some("y"), "t"),
            folder("y", "Y", Some("x"), "t"),
        ];
        let order: Vec<&str> = parents_first(&entries).iter().map(|e| e.stable_id.as_str()).collect();
        let pos = |id: &str| order.iter().position(|o| *o == id).unwrap();
        assert!(pos("a") < pos("b") && pos("b") < pos("c"));
        assert_eq!(order.len(), 5);
    }
}
