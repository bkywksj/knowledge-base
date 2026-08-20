//! 笔记内容快照 DAO（schema v57 的 `note_snapshots` 表）。
//!
//! 快照解决的是"自动保存把内容覆盖没了"这一类事故 —— 白板尤其突出：
//! 画布是 800ms 防抖自动落库的，用户误删一大片图形**什么都不用做**，改动就已经进库，
//! 而撤销栈只活在内存里，关掉应用就没了。
//!
//! 这一层只管存取，**不含任何"该不该存"的策略**（节流 / 去重 / 配额都在
//! `services::snapshot` 里），保持 DAO 单一职责。

use rusqlite::{params, OptionalExtension};

use crate::error::AppError;
use crate::models::{NoteSnapshot, NoteSnapshotMeta, SnapshotNoteUsage, SnapshotUsage};

use super::Database;

impl Database {
    /// 存一条快照，返回新行 id。调用方负责判断"该不该存"。
    /// `target_path`：None = 笔记正文本身；Some(相对路径) = 笔记里内嵌的那块白板。
    pub fn insert_note_snapshot(
        &self,
        note_id: i64,
        content: &str,
        reason: &str,
        target_path: Option<&str>,
    ) -> Result<i64, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let content_hash = crate::services::hash::sha256_hex(content);
        conn.execute(
            "INSERT INTO note_snapshots (note_id, content, content_hash, byte_size, reason, target_path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                note_id,
                content,
                content_hash,
                content.len() as i64,
                reason,
                target_path
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// 最近一条快照的 `(内容哈希, 距今秒数)`，没有快照则 None。
    ///
    /// 距今秒数在 SQL 里用 `julianday` 算好再回传，免得 Rust 侧解析
    /// `datetime('now','localtime')` 那种不带时区的字符串 —— 那是跨平台踩坑重灾区。
    pub fn latest_snapshot_stamp(
        &self,
        note_id: i64,
        target_path: Option<&str>,
    ) -> Result<Option<(String, f64)>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let row = conn
            .query_row(
                "SELECT content_hash,
                        (julianday('now', 'localtime') - julianday(created_at)) * 86400.0
                 FROM note_snapshots
                 WHERE note_id = ?1 AND target_path IS ?2
                 ORDER BY created_at DESC, id DESC
                 LIMIT 1",
                params![note_id, target_path],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)),
            )
            .optional()?;
        Ok(row)
    }

    /// 列出某条笔记的全部快照（**不含 content**）。
    ///
    /// 列表不带正文是刻意的：一块白板的快照动辄几十 KB，30 条一次性回传给前端
    /// 就是几 MB 的 IPC 负担，而列表界面只需要时间和体积。正文按需用
    /// `get_note_snapshot` 单条取。
    pub fn list_note_snapshots(
        &self,
        note_id: i64,
        target_path: Option<&str>,
    ) -> Result<Vec<NoteSnapshotMeta>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let mut stmt = conn.prepare(
            "SELECT id, note_id, byte_size, reason, created_at
             FROM note_snapshots
             WHERE note_id = ?1 AND target_path IS ?2
             ORDER BY created_at DESC, id DESC",
        )?;
        let rows = stmt
            .query_map(params![note_id, target_path], |r| {
                Ok(NoteSnapshotMeta {
                    id: r.get(0)?,
                    note_id: r.get(1)?,
                    byte_size: r.get(2)?,
                    reason: r.get(3)?,
                    created_at: r.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 取单条快照的完整内容。
    pub fn get_note_snapshot(&self, id: i64) -> Result<Option<NoteSnapshot>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let row = conn
            .query_row(
                "SELECT id, note_id, content, byte_size, reason, created_at
                 FROM note_snapshots WHERE id = ?1",
                params![id],
                |r| {
                    Ok(NoteSnapshot {
                        id: r.get(0)?,
                        note_id: r.get(1)?,
                        content: r.get(2)?,
                        byte_size: r.get(3)?,
                        reason: r.get(4)?,
                        created_at: r.get(5)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    /// 全库快照用量统计（设置页展示用）。
    ///
    /// `top` 控制回传多少条"占用最大的笔记"—— 用户要清理时最想看的就是这几条，
    /// 全量回传没有意义（几百条笔记的明细列表没人会逐条看）。
    pub fn note_snapshot_usage(&self, top: i64) -> Result<SnapshotUsage, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        // COALESCE 兜底：一条快照都没有时 SUM 返回 NULL，不处理会取值失败
        let (total_count, total_bytes) = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(byte_size), 0) FROM note_snapshots",
            [],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )?;

        // JOIN notes 拿标题；已被 purge 的笔记其快照已随 CASCADE 删掉，不会出现在这里
        let mut stmt = conn.prepare(
            "SELECT s.note_id, n.title, n.note_type, COUNT(*), SUM(s.byte_size)
             FROM note_snapshots s
             JOIN notes n ON n.id = s.note_id
             GROUP BY s.note_id
             ORDER BY SUM(s.byte_size) DESC
             LIMIT ?1",
        )?;
        let top_notes = stmt
            .query_map(params![top], |r| {
                Ok(SnapshotNoteUsage {
                    note_id: r.get(0)?,
                    title: r.get(1)?,
                    note_type: r.get(2)?,
                    count: r.get(3)?,
                    byte_size: r.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(SnapshotUsage {
            total_count,
            total_bytes,
            top_notes,
        })
    }

    /// 删除某条笔记的全部快照，返回删除条数。
    pub fn delete_note_snapshots(&self, note_id: i64) -> Result<usize, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        Ok(conn.execute(
            "DELETE FROM note_snapshots WHERE note_id = ?1",
            params![note_id],
        )?)
    }

    /// 删除所有笔记里超过 `days` 天的快照，返回删除条数。
    ///
    /// 刻意**不保底留最后一份**：用户选"只留最近 30 天"就是这个意思，
    /// 替他保留反而让清理结果对不上预期。要留底可以用手动存档。
    pub fn delete_note_snapshots_older_than(&self, days: i64) -> Result<usize, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        // 日期比较交给 SQLite：created_at 是 localtime 字符串，
        // 拿到 Rust 侧解析是跨平台踩坑重灾区（与 latest_snapshot_stamp 同理）
        Ok(conn.execute(
            "DELETE FROM note_snapshots
             WHERE created_at < datetime('now', 'localtime', ?1)",
            params![format!("-{} days", days)],
        )?)
    }

    /// 清空全部快照，返回删除条数。
    pub fn delete_all_note_snapshots(&self) -> Result<usize, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        Ok(conn.execute("DELETE FROM note_snapshots", [])?)
    }

    /// 只保留最近 `keep` 条，其余删除，返回删除条数。
    pub fn prune_note_snapshots(
        &self,
        note_id: i64,
        keep: i64,
        target_path: Option<&str>,
    ) -> Result<usize, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        // created_at 只精确到秒，同一秒内可能有多条，所以排序要带 id 兜底，
        // 否则 LIMIT 取到哪几条是不确定的
        let deleted = conn.execute(
            "DELETE FROM note_snapshots
             WHERE note_id = ?1 AND target_path IS ?3 AND id NOT IN (
                 SELECT id FROM note_snapshots
                 WHERE note_id = ?1 AND target_path IS ?3
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?2
             )",
            params![note_id, keep, target_path],
        )?;
        Ok(deleted)
    }
}

#[cfg(test)]
mod tests {
    use crate::models::NoteInput;

    fn mem_db() -> crate::database::Database {
        crate::database::Database::init(":memory:").unwrap()
    }

    fn new_note(db: &crate::database::Database, content: &str) -> i64 {
        db.create_note(&NoteInput {
            title: "白板".into(),
            content: content.into(),
            folder_id: None,
        })
        .unwrap()
        .id
    }

    #[test]
    fn insert_and_read_back() {
        let db = mem_db();
        let note_id = new_note(&db, "v1");

        let sid = db.insert_note_snapshot(note_id, "画布 A", "auto", None).unwrap();
        let got = db.get_note_snapshot(sid).unwrap().expect("应能读回");
        assert_eq!(got.content, "画布 A");
        assert_eq!(got.note_id, note_id);
        assert_eq!(got.reason, "auto");
        assert_eq!(got.byte_size, "画布 A".len() as i64);

        // 列表不带正文，但条数和元信息要对
        let list = db.list_note_snapshots(note_id, None).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, sid);
    }

    /// 节流与去重都依赖这条：它必须给出最近一份的哈希，且 age 是"刚刚"。
    #[test]
    fn latest_stamp_tracks_newest() {
        let db = mem_db();
        let note_id = new_note(&db, "v1");
        assert!(db.latest_snapshot_stamp(note_id, None).unwrap().is_none());

        db.insert_note_snapshot(note_id, "旧", "auto", None).unwrap();
        db.insert_note_snapshot(note_id, "新", "auto", None).unwrap();

        let (hash, age) = db.latest_snapshot_stamp(note_id, None).unwrap().unwrap();
        assert_eq!(hash, crate::services::hash::sha256_hex("新"));
        // 刚写进去，age 必须接近 0（留足余量避免 CI 慢机器抖动）
        assert!(age < 60.0, "age 应接近 0，实际 {}", age);
    }

    /// 份数上限：超出的从最旧开始删，最新的必须留下。
    #[test]
    fn prune_keeps_newest_only() {
        let db = mem_db();
        let note_id = new_note(&db, "v1");

        let mut ids = Vec::new();
        for i in 0..5 {
            ids.push(
                db.insert_note_snapshot(note_id, &format!("画布 {}", i), "auto", None)
                    .unwrap(),
            );
        }

        let deleted = db.prune_note_snapshots(note_id, 2, None).unwrap();
        assert_eq!(deleted, 3);

        let left = db.list_note_snapshots(note_id, None).unwrap();
        assert_eq!(left.len(), 2);
        // created_at 只精确到秒，5 条大概率同秒 —— 所以排序必须靠 id 兜底，
        // 留下的应是 id 最大的两条
        let left_ids: Vec<i64> = left.iter().map(|s| s.id).collect();
        assert!(left_ids.contains(&ids[4]), "最新一份必须留下");
        assert!(left_ids.contains(&ids[3]));
    }

    /// 笔记永久删除后快照不能变成孤儿数据（靠 FOREIGN KEY ... ON DELETE CASCADE，
    /// 前提是 Database::init 里开了 PRAGMA foreign_keys=ON）。
    #[test]
    fn snapshots_cascade_on_note_delete() {
        let db = mem_db();
        let note_id = new_note(&db, "v1");
        db.insert_note_snapshot(note_id, "画布", "auto", None).unwrap();

        {
            let conn = db.conn.lock().unwrap();
            conn.execute("DELETE FROM notes WHERE id = ?1", [note_id])
                .unwrap();
        }

        assert!(db.list_note_snapshots(note_id, None).unwrap().is_empty());
    }

    // ─── 用量与清理 ──────────────────────────────────────

    /// 统计要能正确汇总总量，并按占用从大到小给出 top 列表。
    #[test]
    fn usage_aggregates_and_ranks() {
        let db = mem_db();
        let small = new_note(&db, "v1");
        let big = new_note(&db, "v1");

        db.insert_note_snapshot(small, "abc", "auto", None).unwrap();
        db.insert_note_snapshot(big, &"x".repeat(500), "auto", None).unwrap();
        db.insert_note_snapshot(big, &"y".repeat(300), "manual", None).unwrap();

        let u = db.note_snapshot_usage(10).unwrap();
        assert_eq!(u.total_count, 3);
        assert_eq!(u.total_bytes, 3 + 500 + 300);
        assert_eq!(u.top_notes.len(), 2);
        // 占用大的排前面
        assert_eq!(u.top_notes[0].note_id, big);
        assert_eq!(u.top_notes[0].count, 2);
        assert_eq!(u.top_notes[0].byte_size, 800);
        assert_eq!(u.top_notes[1].note_id, small);
    }

    /// 一条快照都没有时不能炸（SUM 返回 NULL 的那条路径）。
    #[test]
    fn usage_on_empty_db() {
        let db = mem_db();
        let u = db.note_snapshot_usage(10).unwrap();
        assert_eq!(u.total_count, 0);
        assert_eq!(u.total_bytes, 0);
        assert!(u.top_notes.is_empty());
    }

    /// 清某条笔记只影响它自己。
    #[test]
    fn delete_for_one_note_only() {
        let db = mem_db();
        let a = new_note(&db, "v1");
        let b = new_note(&db, "v1");
        db.insert_note_snapshot(a, "A", "auto", None).unwrap();
        db.insert_note_snapshot(b, "B", "auto", None).unwrap();

        assert_eq!(db.delete_note_snapshots(a).unwrap(), 1);
        assert!(db.list_note_snapshots(a, None).unwrap().is_empty());
        assert_eq!(db.list_note_snapshots(b, None).unwrap().len(), 1, "不该动别的笔记");
    }

    /// 按天数清理：只删超期的，新的留下。
    #[test]
    fn delete_older_than_respects_cutoff() {
        let db = mem_db();
        let id = new_note(&db, "v1");
        let old_id = db.insert_note_snapshot(id, "很久以前", "auto", None).unwrap();
        let new_id = db.insert_note_snapshot(id, "刚刚", "auto", None).unwrap();

        // 把第一条的时间改成 10 天前
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE note_snapshots SET created_at = datetime('now','localtime','-10 days') WHERE id = ?1",
                [old_id],
            )
            .unwrap();
        }

        assert_eq!(db.delete_note_snapshots_older_than(7).unwrap(), 1);
        let left = db.list_note_snapshots(id, None).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, new_id, "只该删掉超期那条");
    }

    // ─── 内嵌白板（target_path）──────────────────────────

    /// 同一条笔记里，正文与各块内嵌白板的历史必须互不干扰 ——
    /// 靠 `target_path IS ?`（不是 `=`，SQLite 里 NULL = NULL 为假）。
    #[test]
    fn target_path_isolates_histories() {
        let db = mem_db();
        let id = new_note(&db, "v1");
        let wb_a = "kb_assets/images/1/wb-aaa.excalidraw";
        let wb_b = "kb_assets/images/1/wb-bbb.excalidraw";

        db.insert_note_snapshot(id, "正文版本", "auto", None).unwrap();
        db.insert_note_snapshot(id, "白板A版本", "auto", Some(wb_a)).unwrap();
        db.insert_note_snapshot(id, "白板B版本", "auto", Some(wb_b)).unwrap();

        // 各查各的，一条不多一条不少
        let body = db.list_note_snapshots(id, None).unwrap();
        assert_eq!(body.len(), 1, "正文历史不该混进白板的");
        let a = db.list_note_snapshots(id, Some(wb_a)).unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(
            db.get_note_snapshot(a[0].id).unwrap().unwrap().content,
            "白板A版本"
        );
        let b = db.list_note_snapshots(id, Some(wb_b)).unwrap();
        assert_eq!(b.len(), 1);
    }

    /// 份数上限按 target 独立算：一条笔记插了几块白板，
    /// 不该让它们互相挤掉对方的历史。
    #[test]
    fn prune_is_scoped_to_target() {
        let db = mem_db();
        let id = new_note(&db, "v1");
        let wb = "kb_assets/images/1/wb-x.excalidraw";

        for i in 0..4 {
            db.insert_note_snapshot(id, &format!("正文{}", i), "auto", None).unwrap();
            db.insert_note_snapshot(id, &format!("白板{}", i), "auto", Some(wb)).unwrap();
        }

        // 只裁白板那一档
        db.prune_note_snapshots(id, 2, Some(wb)).unwrap();
        assert_eq!(db.list_note_snapshots(id, Some(wb)).unwrap().len(), 2);
        assert_eq!(
            db.list_note_snapshots(id, None).unwrap().len(),
            4,
            "裁白板不该动到正文历史"
        );
    }

    /// 节流/去重看的也必须是同一个 target 的最近一份。
    #[test]
    fn latest_stamp_is_scoped_to_target() {
        let db = mem_db();
        let id = new_note(&db, "v1");
        let wb = "kb_assets/images/1/wb-x.excalidraw";

        db.insert_note_snapshot(id, "正文", "auto", None).unwrap();
        // 白板那一档还没有任何快照 → 必须是 None，而不是拿到正文那条
        assert!(db.latest_snapshot_stamp(id, Some(wb)).unwrap().is_none());

        db.insert_note_snapshot(id, "白板", "auto", Some(wb)).unwrap();
        let (hash, _) = db.latest_snapshot_stamp(id, Some(wb)).unwrap().unwrap();
        assert_eq!(hash, crate::services::hash::sha256_hex("白板"));
    }

    #[test]
    fn delete_all_clears_everything() {
        let db = mem_db();
        let a = new_note(&db, "v1");
        let b = new_note(&db, "v1");
        db.insert_note_snapshot(a, "A", "auto", None).unwrap();
        db.insert_note_snapshot(b, "B", "auto", None).unwrap();

        assert_eq!(db.delete_all_note_snapshots().unwrap(), 2);
        assert_eq!(db.note_snapshot_usage(10).unwrap().total_count, 0);
    }
}
