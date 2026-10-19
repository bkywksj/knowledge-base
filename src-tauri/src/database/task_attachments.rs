//! 任务附件（v65 `task_attachments`）DAO。
//!
//! 只管行；文件落盘 / 删除由 `services::task_attachment` 负责。

use rusqlite::{params, OptionalExtension};

use crate::error::AppError;
use crate::models::TaskAttachment;

const SELECT_COLS: &str = "id, task_id, rel_path, file_name, mime, size, sort_order, created_at";

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskAttachment> {
    Ok(TaskAttachment {
        id: row.get(0)?,
        task_id: row.get(1)?,
        rel_path: row.get(2)?,
        file_name: row.get(3)?,
        mime: row.get(4)?,
        size: row.get(5)?,
        sort_order: row.get(6)?,
        created_at: row.get(7)?,
    })
}

impl super::Database {
    /// 某任务的附件，按 sort_order → id 正序
    pub fn list_task_attachments(&self, task_id: i64) -> Result<Vec<TaskAttachment>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(&format!(
            "SELECT {SELECT_COLS} FROM task_attachments
             WHERE task_id = ?1 ORDER BY sort_order ASC, id ASC"
        ))?;
        let rows = stmt
            .query_map(params![task_id], map_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_task_attachment(&self, id: i64) -> Result<Option<TaskAttachment>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let row = conn
            .query_row(
                &format!("SELECT {SELECT_COLS} FROM task_attachments WHERE id = ?1"),
                params![id],
                map_row,
            )
            .optional()?;
        Ok(row)
    }

    /// 追加一条附件，排到该任务现有附件末尾。返回新行。
    pub fn insert_task_attachment(
        &self,
        task_id: i64,
        rel_path: &str,
        file_name: &str,
        mime: &str,
        size: i64,
    ) -> Result<TaskAttachment, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "INSERT INTO task_attachments (task_id, rel_path, file_name, mime, size, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5,
                     (SELECT COALESCE(MAX(sort_order), -1) + 1
                        FROM task_attachments WHERE task_id = ?1))",
            params![task_id, rel_path, file_name, mime, size],
        )?;
        let id = conn.last_insert_rowid();
        let row = conn.query_row(
            &format!("SELECT {SELECT_COLS} FROM task_attachments WHERE id = ?1"),
            params![id],
            map_row,
        )?;
        Ok(row)
    }

    pub fn delete_task_attachment(&self, id: i64) -> Result<bool, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute("DELETE FROM task_attachments WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }

    /// 还有几行引用这个文件。`safe_filename::save_unique` 对同内容同名文件会复用路径，
    /// 所以删行后要看引用数，归零才能删文件。
    pub fn count_task_attachment_refs(&self, rel_path: &str) -> Result<i64, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let n = conn.query_row(
            "SELECT COUNT(*) FROM task_attachments WHERE rel_path = ?1",
            params![rel_path],
            |r| r.get(0),
        )?;
        Ok(n)
    }

    /// 按给定 id 顺序重写 sort_order（只改属于该任务的行，防止前端传错把别的任务的附件挪过来）
    pub fn reorder_task_attachments(&self, task_id: i64, ids: &[i64]) -> Result<(), AppError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "UPDATE task_attachments SET sort_order = ?1 WHERE id = ?2 AND task_id = ?3",
            )?;
            for (idx, id) in ids.iter().enumerate() {
                stmt.execute(params![idx as i64, id, task_id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// 全部任务 id（含软删墓碑）—— 孤儿扫描用，软删任务的附件目录不算孤儿
    pub fn list_all_task_ids_for_orphan_scan(&self) -> Result<Vec<i64>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare("SELECT id FROM tasks")?;
        let rows = stmt
            .query_map([], |r| r.get::<_, i64>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 所有附件的相对路径（孤儿扫描判断「是否被引用」用）
    pub fn list_all_task_attachment_paths(&self) -> Result<Vec<String>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare("SELECT DISTINCT rel_path FROM task_attachments")?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use crate::database::Database;
    use crate::models::CreateTaskInput;

    fn new_task(db: &Database) -> i64 {
        let input: CreateTaskInput =
            serde_json::from_value(serde_json::json!({ "title": "带附件的任务" })).unwrap();
        db.create_task(input).unwrap()
    }

    #[test]
    fn insert_appends_and_reorder_scoped_to_task() {
        let db = Database::init(":memory:").unwrap();
        let t1 = new_task(&db);
        let t2 = new_task(&db);
        let a = db
            .insert_task_attachment(t1, "kb_assets/task_files/1/a.png", "a.png", "image/png", 10)
            .unwrap();
        let b = db
            .insert_task_attachment(t1, "kb_assets/task_files/1/b.png", "b.png", "image/png", 10)
            .unwrap();
        let other = db
            .insert_task_attachment(t2, "kb_assets/task_files/2/c.png", "c.png", "image/png", 10)
            .unwrap();
        assert_eq!((a.sort_order, b.sort_order, other.sort_order), (0, 1, 0));

        // 混进别的任务的 id 不应被挪动
        db.reorder_task_attachments(t1, &[b.id, other.id, a.id])
            .unwrap();
        let list = db.list_task_attachments(t1).unwrap();
        assert_eq!(
            list.iter().map(|x| x.id).collect::<Vec<_>>(),
            vec![b.id, a.id]
        );
        assert_eq!(
            db.get_task_attachment(other.id)
                .unwrap()
                .unwrap()
                .sort_order,
            0
        );
    }

    #[test]
    fn list_tasks_reports_attachment_count() {
        let db = Database::init(":memory:").unwrap();
        let t = new_task(&db);
        db.insert_task_attachment(t, "p1", "a.png", "image/png", 1)
            .unwrap();
        db.insert_task_attachment(t, "p1", "a.png", "image/png", 1)
            .unwrap();
        assert_eq!(db.count_task_attachment_refs("p1").unwrap(), 2);
        let tasks = db.list_tasks(Default::default()).unwrap();
        assert_eq!(
            tasks.iter().find(|x| x.id == t).unwrap().attachment_count,
            2
        );
        assert_eq!(db.get_task(t).unwrap().unwrap().attachment_count, 2);
    }
}
