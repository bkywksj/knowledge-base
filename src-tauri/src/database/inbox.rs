//! 收件箱数据访问层（P1-5，schema v61）。
//!
//! 表结构与"为什么这么设计"见 `schema::migrate_v60_to_v61`。

use crate::error::AppError;
use crate::models::{InboxItem, InboxItemInput};

use super::Database;

/// 单次查询返回的上限。
///
/// 收件箱正常只有几条到几十条；真堆到几百条说明用户有一批文件系统性失败，
/// 那时列表本身也没法逐条看，该先解决共性原因。给个上限免得 UI 一次渲染爆炸。
const MAX_ITEMS: i64 = 500;

fn row_to_item(row: &rusqlite::Row) -> rusqlite::Result<InboxItem> {
    Ok(InboxItem {
        id: row.get(0)?,
        kind: row.get(1)?,
        source: row.get(2)?,
        title: row.get(3)?,
        reason: row.get(4)?,
        detail_json: row.get(5)?,
        retry_count: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

const ITEM_COLS: &str =
    "id, kind, source, title, reason, detail_json, retry_count, created_at, updated_at";

impl Database {
    /// 记一条失败项（同源已存在则刷新原因并累加重试次数）。
    ///
    /// upsert 而非 insert：用户反复导入同一个坏文件不该在列表里刷出一堆重复项。
    /// `retry_count` 借此变成"这个文件失败过几次"的天然计数。
    pub fn add_inbox_item(&self, input: &InboxItemInput) -> Result<InboxItem, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "INSERT INTO inbox_items (kind, source, title, reason, detail_json)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(kind, source) DO UPDATE SET
               title       = excluded.title,
               reason      = excluded.reason,
               detail_json = excluded.detail_json,
               retry_count = inbox_items.retry_count + 1,
               updated_at  = datetime('now', 'localtime')",
            rusqlite::params![
                input.kind,
                input.source,
                input.title,
                input.reason,
                input.detail_json,
            ],
        )?;
        let sql = format!(
            "SELECT {} FROM inbox_items WHERE kind = ?1 AND source = ?2",
            ITEM_COLS
        );
        let item = conn.query_row(&sql, rusqlite::params![input.kind, input.source], row_to_item)?;
        Ok(item)
    }

    /// 列出待处理项（最新的在前）。`kind = None` 表示不限类型。
    pub fn list_inbox_items(&self, kind: Option<&str>) -> Result<Vec<InboxItem>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        // 两个分支各自 prepare：sql / stmt 在块内就 drop，rows 已 collect 成 Vec
        let items = match kind {
            Some(k) => {
                let sql = format!(
                    "SELECT {} FROM inbox_items WHERE kind = ?1
                     ORDER BY updated_at DESC, id DESC LIMIT ?2",
                    ITEM_COLS
                );
                let mut stmt = conn.prepare(&sql)?;
                // 必须先绑定再返回：直接把 collect 作尾表达式会让借用检查器
                // 认为迭代器活得比 stmt 久
                let rows = stmt
                    .query_map(rusqlite::params![k, MAX_ITEMS], row_to_item)?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            }
            None => {
                let sql = format!(
                    "SELECT {} FROM inbox_items ORDER BY updated_at DESC, id DESC LIMIT ?1",
                    ITEM_COLS
                );
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt
                    .query_map(rusqlite::params![MAX_ITEMS], row_to_item)?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            }
        };
        Ok(items)
    }

    /// 按类型统计待处理数量（给侧栏红点 / 分组筛选用）
    pub fn inbox_counts(&self) -> Result<Vec<(String, i64)>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT kind, COUNT(*) FROM inbox_items GROUP BY kind ORDER BY COUNT(*) DESC",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 删除一条（重试成功 / 用户忽略）。返回是否真的删掉了。
    pub fn remove_inbox_item(&self, id: i64) -> Result<bool, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let n = conn.execute("DELETE FROM inbox_items WHERE id = ?1", [id])?;
        Ok(n > 0)
    }

    /// 清空（可按类型）。返回删除条数。
    pub fn clear_inbox(&self, kind: Option<&str>) -> Result<usize, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let n = match kind {
            Some(k) => conn.execute("DELETE FROM inbox_items WHERE kind = ?1", [k])?,
            None => conn.execute("DELETE FROM inbox_items", [])?,
        };
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Database {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("kb_inbox_{}_{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        Database::init(dir.join("t.db").to_str().unwrap()).expect("init db")
    }

    fn input(kind: &str, source: &str, reason: &str) -> InboxItemInput {
        InboxItemInput {
            kind: kind.into(),
            source: source.into(),
            title: Some(source.rsplit('/').next().unwrap_or(source).to_string()),
            reason: reason.into(),
            detail_json: Some(r#"{"folderId":null}"#.into()),
        }
    }

    #[test]
    fn adds_and_lists_items() {
        let db = temp_db();
        db.add_inbox_item(&input("import_pdf", "/a/x.pdf", "扫描件无文字层"))
            .unwrap();
        db.add_inbox_item(&input("clip", "https://e.com/a", "网页返回 403"))
            .unwrap();

        let all = db.list_inbox_items(None).unwrap();
        assert_eq!(all.len(), 2);

        let pdfs = db.list_inbox_items(Some("import_pdf")).unwrap();
        assert_eq!(pdfs.len(), 1);
        assert_eq!(pdfs[0].reason, "扫描件无文字层");
        assert_eq!(pdfs[0].title.as_deref(), Some("x.pdf"));
    }

    /// 同一个文件反复失败只留一条，且 retry_count 累加 ——
    /// 否则用户多试几次列表里就全是同一个文件
    #[test]
    fn same_source_upserts_instead_of_duplicating() {
        let db = temp_db();
        let first = db
            .add_inbox_item(&input("import_pdf", "/a/x.pdf", "第一次失败"))
            .unwrap();
        assert_eq!(first.retry_count, 0);

        let second = db
            .add_inbox_item(&input("import_pdf", "/a/x.pdf", "第二次失败（原因变了）"))
            .unwrap();
        assert_eq!(second.id, first.id, "应更新同一条而不是新建");
        assert_eq!(second.retry_count, 1, "重试次数应累加");
        assert_eq!(second.reason, "第二次失败（原因变了）", "原因应刷新");

        assert_eq!(db.list_inbox_items(None).unwrap().len(), 1);
    }

    /// kind 不同即使 source 相同也是两条（同一个文件可能既导入失败又 OCR 失败）
    #[test]
    fn different_kind_same_source_are_separate() {
        let db = temp_db();
        db.add_inbox_item(&input("import_pdf", "/a/x.pdf", "导入失败"))
            .unwrap();
        db.add_inbox_item(&input("ocr", "/a/x.pdf", "OCR 失败"))
            .unwrap();
        assert_eq!(db.list_inbox_items(None).unwrap().len(), 2);
    }

    #[test]
    fn counts_group_by_kind() {
        let db = temp_db();
        db.add_inbox_item(&input("import_pdf", "/a/1.pdf", "e"))
            .unwrap();
        db.add_inbox_item(&input("import_pdf", "/a/2.pdf", "e"))
            .unwrap();
        db.add_inbox_item(&input("clip", "https://e.com", "e"))
            .unwrap();

        let counts = db.inbox_counts().unwrap();
        assert_eq!(counts.len(), 2);
        // 按数量倒序，pdf 应在前
        assert_eq!(counts[0], ("import_pdf".to_string(), 2));
        assert_eq!(counts[1], ("clip".to_string(), 1));
    }

    #[test]
    fn removes_single_item() {
        let db = temp_db();
        let it = db
            .add_inbox_item(&input("import_pdf", "/a/x.pdf", "e"))
            .unwrap();
        assert!(db.remove_inbox_item(it.id).unwrap());
        assert!(db.list_inbox_items(None).unwrap().is_empty());
        // 再删同一条应返回 false 而不是报错
        assert!(!db.remove_inbox_item(it.id).unwrap());
    }

    #[test]
    fn clears_all_or_by_kind() {
        let db = temp_db();
        db.add_inbox_item(&input("import_pdf", "/a/1.pdf", "e"))
            .unwrap();
        db.add_inbox_item(&input("import_pdf", "/a/2.pdf", "e"))
            .unwrap();
        db.add_inbox_item(&input("clip", "https://e.com", "e"))
            .unwrap();

        assert_eq!(db.clear_inbox(Some("import_pdf")).unwrap(), 2);
        assert_eq!(db.list_inbox_items(None).unwrap().len(), 1);

        assert_eq!(db.clear_inbox(None).unwrap(), 1);
        assert!(db.list_inbox_items(None).unwrap().is_empty());
    }

    /// 重试要靠 detail_json 还原上下文（导到哪个文件夹、是否走 OCR），
    /// 必须原样往返 —— 列表里就带着它，前端不用再单独查一次
    #[test]
    fn detail_json_roundtrips_through_list() {
        let db = temp_db();
        let mut inp = input("import_pdf", "/a/x.pdf", "e");
        inp.detail_json = Some(r#"{"folderId":7,"useOcr":true}"#.into());
        db.add_inbox_item(&inp).unwrap();

        let listed = db.list_inbox_items(None).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(listed[0].detail_json.as_deref().unwrap()).unwrap();
        assert_eq!(v["folderId"], 7);
        assert_eq!(v["useOcr"], true);
    }
}
