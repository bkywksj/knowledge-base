//! T-S020 sidecar CAS 附件同步索引表 DAO
//!
//! `note_attachments` (v37) 记录每条笔记引用的本地资产文件 + 内容 hash。
//! 用于：
//! - 同步 push 阶段：算出本机所有 unique sha256，与远端 has_attachment 算差集
//! - 同步 pull 阶段：远端 manifest.attachments 与本地 unique hashes 算差集，下载缺失的
//! - 本地引用查询：按 hash 反查本地 path（笔记内嵌引用 fallback 时用）

use rusqlite::{params, OptionalExtension};

use crate::error::AppError;

use super::Database;

/// 一条 note_attachments 行
#[derive(Debug, Clone)]
pub struct NoteAttachmentRow {
    /// note_id 当前主要给 list_attachments_for_note 返回 + CASCADE 测试用；
    /// list_all_unique_attachments 调 GROUP BY 后 note_id 只是任取一条的代表值
    #[allow(dead_code)]
    pub note_id: i64,
    pub local_rel_path: String,
    pub sha256_hex: String,
    pub size: i64,
    pub mime: Option<String>,
}

impl Database {
    /// upsert 单条笔记 → 资产的引用记录（同 note_id+rel_path 覆盖）。
    ///
    /// 薄包装，委托给 [`upsert_attachment_refs_batch`]，避免两份 SQL 各自演化。
    /// **热路径（附件扫描）不要用它**：逐条调会产生大量锁抖动，直接用批量版。
    /// 目前主要供测试与零星单点写入使用。
    pub fn upsert_attachment_ref(
        &self,
        note_id: i64,
        local_rel_path: &str,
        sha256_hex: &str,
        size: i64,
        mime: Option<&str>,
    ) -> Result<(), AppError> {
        self.upsert_attachment_refs_batch(
            note_id,
            &[(
                local_rel_path.to_string(),
                sha256_hex.to_string(),
                size,
                mime.map(|s| s.to_string()),
            )],
        )?;
        Ok(())
    }

    /// 批量 upsert 一条笔记的全部资产引用（一次加锁 + 一个事务）。
    ///
    /// 相对逐条调 [`upsert_attachment_ref`] 的意义在于**减少锁抖动**：
    /// 附件全库扫描要处理近万条引用，逐条 upsert 就是近万次
    /// `Mutex` 加解锁。同步跑在 `spawn_blocking` 线程上，而 `get_note` 之类的
    /// **同步 Command 跑在主线程**并争抢同一把锁 —— 高频抖动下主线程可能被饿住，
    /// 用户体感就是"扫描期间点笔记一直转圈"。一次锁 + 一个事务同时也让写入更快。
    ///
    /// 入参为空时直接返回（不开事务）。返回成功写入的条数。
    pub fn upsert_attachment_refs_batch(
        &self,
        note_id: i64,
        refs: &[(String, String, i64, Option<String>)],
    ) -> Result<usize, AppError> {
        if refs.is_empty() {
            return Ok(0);
        }
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO note_attachments (note_id, local_rel_path, sha256_hex, size, mime)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(note_id, local_rel_path) DO UPDATE SET
                     sha256_hex = excluded.sha256_hex,
                     size       = excluded.size,
                     mime       = excluded.mime",
            )?;
            for (rel, sha, size, mime) in refs {
                stmt.execute(params![note_id, rel, sha, size, mime.as_deref()])?;
            }
        }
        tx.commit()?;
        Ok(refs.len())
    }

    /// 列出某笔记的所有附件引用
    ///
    /// 预留给 UI 显示"此笔记引用的附件清单"+ note CASCADE 测试用。
    #[allow(dead_code)]
    pub fn list_attachments_for_note(
        &self,
        note_id: i64,
    ) -> Result<Vec<NoteAttachmentRow>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT note_id, local_rel_path, sha256_hex, size, mime
             FROM note_attachments WHERE note_id = ?1
             ORDER BY local_rel_path",
        )?;
        let rows = stmt
            .query_map([note_id], |row| {
                Ok(NoteAttachmentRow {
                    note_id: row.get(0)?,
                    local_rel_path: row.get(1)?,
                    sha256_hex: row.get(2)?,
                    size: row.get(3)?,
                    mime: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 列出全库所有 unique sha256 + 元数据（同步 push manifest 用）
    ///
    /// 重复 hash 取第一条（同一 hash 不同 path 是常见去重场景）。
    pub fn list_all_unique_attachments(&self) -> Result<Vec<NoteAttachmentRow>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        // GROUP BY sha256_hex 取每个 hash 的第一条（MIN(note_id) 保证稳定）
        let mut stmt = conn.prepare(
            "SELECT note_id, local_rel_path, sha256_hex, size, mime
             FROM note_attachments
             GROUP BY sha256_hex
             ORDER BY sha256_hex",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(NoteAttachmentRow {
                    note_id: row.get(0)?,
                    local_rel_path: row.get(1)?,
                    sha256_hex: row.get(2)?,
                    size: row.get(3)?,
                    mime: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 按 sha256 列出**所有**本地路径（一附件可能被多笔记引用）。
    ///
    /// 给 push 端构造 `AttachmentEntry.paths` 用：让 manifest 携带"这个 hash 在写端的所有原路径"，
    /// pull 端按这些路径把字节从 `sync_in/<hash>.<ext>` 拷到原位置，让笔记里的
    /// `kb-asset://kb_assets/images/...` 引用能命中文件。
    pub fn list_attachment_paths_by_hash(
        &self,
        sha256_hex: &str,
    ) -> Result<Vec<String>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT local_rel_path FROM note_attachments
             WHERE sha256_hex = ?1
             ORDER BY local_rel_path",
        )?;
        let paths: Vec<String> = stmt
            .query_map([sha256_hex], |row| row.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(paths)
    }

    /// 按 sha256 反查本地路径（任取一条）
    ///
    /// 同 hash 多 path 时返回第一条 — pull 端写入 `sync_in/<hash>.<ext>` 不依赖此查找；
    /// 此方法主要给"渲染器按 hash 找原路径文件"的 fallback 场景用（后续 UI 集成时启用）。
    #[allow(dead_code)]
    pub fn find_attachment_path_by_hash(
        &self,
        sha256_hex: &str,
    ) -> Result<Option<String>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let path = conn
            .query_row(
                "SELECT local_rel_path FROM note_attachments
                 WHERE sha256_hex = ?1 LIMIT 1",
                [sha256_hex],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(path)
    }

    /// 删除某笔记的全部附件引用（笔记物理删除时用；CASCADE 也会触发，但显式调更安全）
    #[allow(dead_code)]
    pub fn delete_attachment_refs_for_note(&self, note_id: i64) -> Result<usize, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let n = conn.execute(
            "DELETE FROM note_attachments WHERE note_id = ?1",
            [note_id],
        )?;
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::NoteInput;

    fn setup() -> (Database, i64) {
        let db = Database::init(":memory:").expect("init :memory: 应成功");
        let n = db
            .create_note(&NoteInput {
                title: "笔记 A".into(),
                content: "x".into(),
                folder_id: None,
            })
            .unwrap();
        (db, n.id)
    }

    #[test]
    fn schema_creates_note_attachments_table() {
        let db = Database::init(":memory:").unwrap();
        let conn = db.conn_lock().unwrap();
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='note_attachments'",
                [],
                |_| Ok(true),
            )
            .unwrap_or(false);
        assert!(exists, "v37 应创建 note_attachments 表");
    }

    #[test]
    fn upsert_and_list_for_note() {
        let (db, nid) = setup();
        db.upsert_attachment_ref(nid, "kb_assets/images/a.png", "h1", 100, Some("image/png"))
            .unwrap();
        db.upsert_attachment_ref(nid, "pdfs/b.pdf", "h2", 2000, Some("application/pdf"))
            .unwrap();

        let rows = db.list_attachments_for_note(nid).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].local_rel_path, "kb_assets/images/a.png");
        assert_eq!(rows[1].local_rel_path, "pdfs/b.pdf");
    }

    #[test]
    fn upsert_overwrites_same_path() {
        let (db, nid) = setup();
        db.upsert_attachment_ref(nid, "kb_assets/images/a.png", "h1", 100, None)
            .unwrap();
        // 同 path 但 hash 变了 → 应覆盖
        db.upsert_attachment_ref(nid, "kb_assets/images/a.png", "h2", 200, None)
            .unwrap();
        let rows = db.list_attachments_for_note(nid).unwrap();
        assert_eq!(rows.len(), 1, "同 note_id+path 应只有一行");
        assert_eq!(rows[0].sha256_hex, "h2");
        assert_eq!(rows[0].size, 200);
    }

    #[test]
    fn list_all_unique_dedups_by_hash() {
        let (db, n1) = setup();
        let n2 = db
            .create_note(&NoteInput {
                title: "笔记 B".into(),
                content: "y".into(),
                folder_id: None,
            })
            .unwrap()
            .id;

        // 同一 hash 在两个笔记里
        db.upsert_attachment_ref(n1, "kb_assets/images/a.png", "shared_h", 100, None)
            .unwrap();
        db.upsert_attachment_ref(n2, "kb_assets/images/dup.png", "shared_h", 100, None)
            .unwrap();
        // 不同 hash
        db.upsert_attachment_ref(n1, "pdfs/b.pdf", "other_h", 2000, None)
            .unwrap();

        let unique = db.list_all_unique_attachments().unwrap();
        assert_eq!(unique.len(), 2, "GROUP BY sha256_hex 应只剩 2 个唯一 hash");

        let hashes: Vec<&str> = unique.iter().map(|r| r.sha256_hex.as_str()).collect();
        assert!(hashes.contains(&"shared_h"));
        assert!(hashes.contains(&"other_h"));
    }

    #[test]
    fn find_by_hash_works() {
        let (db, nid) = setup();
        db.upsert_attachment_ref(nid, "pdfs/x.pdf", "abc", 1, None)
            .unwrap();
        assert_eq!(
            db.find_attachment_path_by_hash("abc").unwrap(),
            Some("pdfs/x.pdf".into())
        );
        assert_eq!(db.find_attachment_path_by_hash("none").unwrap(), None);
    }

    #[test]
    fn cascade_delete_when_note_deleted() {
        let (db, nid) = setup();
        db.upsert_attachment_ref(nid, "pdfs/x.pdf", "abc", 1, None)
            .unwrap();
        // 物理删除笔记应触发 CASCADE
        {
            let conn = db.conn_lock().unwrap();
            conn.execute("DELETE FROM notes WHERE id = ?1", [nid]).unwrap();
        }
        assert!(db.list_attachments_for_note(nid).unwrap().is_empty());
    }
}

#[cfg(test)]
mod batch_upsert_tests {
    use super::*;
    use crate::models::NoteInput;

    fn mk(db: &Database, title: &str) -> i64 {
        db.create_note(&NoteInput {
            title: title.into(),
            content: "x".into(),
            folder_id: None,
        })
        .unwrap()
        .id
    }

    /// 批量写入的结果必须与逐条写入等价
    #[test]
    fn batch_upsert_writes_all_rows() {
        let db = Database::init(":memory:").unwrap();
        let nid = mk(&db, "n");
        let refs = vec![
            ("kb_assets/images/a.png".to_string(), "h1".to_string(), 100, Some("image/png".to_string())),
            ("pdfs/b.pdf".to_string(), "h2".to_string(), 2000, Some("application/pdf".to_string())),
            ("attachments/3/c.zip".to_string(), "h3".to_string(), 30, None),
        ];
        let n = db.upsert_attachment_refs_batch(nid, &refs).unwrap();
        assert_eq!(n, 3);

        let rows = db.list_attachments_for_note(nid).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].local_rel_path, "attachments/3/c.zip");
        assert_eq!(rows[0].mime, None, "mime 为 None 应原样落 NULL");
    }

    /// 同 (note_id, rel_path) 再写一次 → 覆盖而不是插重复行
    #[test]
    fn batch_upsert_overwrites_same_path() {
        let db = Database::init(":memory:").unwrap();
        let nid = mk(&db, "n");
        db.upsert_attachment_refs_batch(
            nid,
            &[("kb_assets/x.png".into(), "old".into(), 1, None)],
        )
        .unwrap();
        db.upsert_attachment_refs_batch(
            nid,
            &[("kb_assets/x.png".into(), "new".into(), 999, Some("image/png".into()))],
        )
        .unwrap();

        let rows = db.list_attachments_for_note(nid).unwrap();
        assert_eq!(rows.len(), 1, "同路径应覆盖而非新增");
        assert_eq!(rows[0].sha256_hex, "new");
        assert_eq!(rows[0].size, 999);
    }

    /// 空入参不开事务、不报错
    #[test]
    fn batch_upsert_empty_is_noop() {
        let db = Database::init(":memory:").unwrap();
        let nid = mk(&db, "n");
        assert_eq!(db.upsert_attachment_refs_batch(nid, &[]).unwrap(), 0);
        assert!(db.list_attachments_for_note(nid).unwrap().is_empty());
    }

    /// 单条包装方法与批量版行为一致（包装不能改语义）
    #[test]
    fn single_wrapper_matches_batch() {
        let db = Database::init(":memory:").unwrap();
        let nid = mk(&db, "n");
        db.upsert_attachment_ref(nid, "pdfs/z.pdf", "hh", 42, Some("application/pdf"))
            .unwrap();
        let rows = db.list_attachments_for_note(nid).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].sha256_hex, "hh");
        assert_eq!(rows[0].size, 42);
        assert_eq!(rows[0].mime.as_deref(), Some("application/pdf"));
    }
}
