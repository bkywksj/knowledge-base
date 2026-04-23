use rusqlite::params;

use crate::error::AppError;
use crate::models::{Note, Tag};

use super::Database;

impl Database {
    // ─── 标签 DAO ─────────────────────────────────

    /// 创建标签
    pub fn create_tag(&self, name: &str, color: Option<&str>) -> Result<Tag, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        conn.execute(
            "INSERT INTO tags (name, color) VALUES (?1, ?2)",
            params![name, color],
        )?;

        let id = conn.last_insert_rowid();

        Ok(Tag {
            id,
            name: name.to_string(),
            color: color.map(|c| c.to_string()),
            note_count: 0,
        })
    }

    /// 获取所有标签（带笔记计数，按笔记数降序）
    pub fn list_tags(&self) -> Result<Vec<Tag>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        let mut stmt = conn.prepare(
            "SELECT t.id, t.name, t.color, COUNT(nt.note_id) as note_count
             FROM tags t
             LEFT JOIN note_tags nt ON t.id = nt.tag_id
             LEFT JOIN notes n ON nt.note_id = n.id AND n.is_deleted = 0
             GROUP BY t.id
             ORDER BY note_count DESC, t.name",
        )?;

        let tags = stmt
            .query_map([], |row| {
                Ok(Tag {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    note_count: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(tags)
    }

    /// 修改标签颜色（传 None 清空颜色走默认样式）
    pub fn set_tag_color(&self, id: i64, color: Option<&str>) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        let affected = conn.execute(
            "UPDATE tags SET color = ?1 WHERE id = ?2",
            params![color, id],
        )?;

        if affected == 0 {
            return Err(AppError::NotFound(format!("标签 {} 不存在", id)));
        }

        Ok(())
    }

    /// 重命名标签
    pub fn rename_tag(&self, id: i64, name: &str) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        let affected = conn.execute(
            "UPDATE tags SET name = ?1 WHERE id = ?2",
            params![name, id],
        )?;

        if affected == 0 {
            return Err(AppError::NotFound(format!("标签 {} 不存在", id)));
        }

        Ok(())
    }

    /// 删除标签（同时删除关联）
    pub fn delete_tag(&self, id: i64) -> Result<bool, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        // 先删除关联关系
        conn.execute("DELETE FROM note_tags WHERE tag_id = ?1", params![id])?;

        // 再删除标签本身
        let affected = conn.execute("DELETE FROM tags WHERE id = ?1", params![id])?;

        Ok(affected > 0)
    }

    /// 给笔记添加标签
    pub fn add_tag_to_note(&self, note_id: i64, tag_id: i64) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        conn.execute(
            "INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?1, ?2)",
            params![note_id, tag_id],
        )?;

        Ok(())
    }

    /// 移除笔记的标签
    pub fn remove_tag_from_note(&self, note_id: i64, tag_id: i64) -> Result<bool, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        let affected = conn.execute(
            "DELETE FROM note_tags WHERE note_id = ?1 AND tag_id = ?2",
            params![note_id, tag_id],
        )?;

        Ok(affected > 0)
    }

    /// 获取笔记的所有标签
    pub fn get_note_tags(&self, note_id: i64) -> Result<Vec<Tag>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        let mut stmt = conn.prepare(
            "SELECT t.id, t.name, t.color, COUNT(nt2.note_id) as note_count
             FROM tags t
             INNER JOIN note_tags nt ON t.id = nt.tag_id AND nt.note_id = ?1
             LEFT JOIN note_tags nt2 ON t.id = nt2.tag_id
             LEFT JOIN notes n ON nt2.note_id = n.id AND n.is_deleted = 0
             GROUP BY t.id
             ORDER BY t.name",
        )?;

        let tags = stmt
            .query_map(params![note_id], |row| {
                Ok(Tag {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    note_count: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(tags)
    }

    /// 获取标签下的笔记列表（分页）
    pub fn list_notes_by_tag(
        &self,
        tag_id: i64,
        page: usize,
        page_size: usize,
    ) -> Result<(Vec<Note>, usize), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        // 查询总数
        let total: usize = conn.query_row(
            "SELECT COUNT(*) FROM note_tags nt
             INNER JOIN notes n ON nt.note_id = n.id AND n.is_deleted = 0
             WHERE nt.tag_id = ?1",
            params![tag_id],
            |row| row.get(0),
        )?;

        // 查询分页数据
        let offset = (page.saturating_sub(1)) * page_size;

        let mut stmt = conn.prepare(
            "SELECT n.id, n.title, n.content, n.folder_id, n.is_daily, n.daily_date,
                    n.is_pinned, n.word_count, n.created_at, n.updated_at, n.source_file_path, n.source_file_type
             FROM notes n
             INNER JOIN note_tags nt ON n.id = nt.note_id
             WHERE nt.tag_id = ?1 AND n.is_deleted = 0
             ORDER BY n.updated_at DESC
             LIMIT ?2 OFFSET ?3",
        )?;

        let notes = stmt
            .query_map(params![tag_id, page_size as i64, offset as i64], |row| {
                Ok(Note {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    content: row.get(2)?,
                    folder_id: row.get(3)?,
                    is_daily: row.get::<_, i32>(4)? != 0,
                    daily_date: row.get(5)?,
                    is_pinned: row.get::<_, i32>(6)? != 0,
                    word_count: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                    source_file_path: row.get(10)?,
                    source_file_type: row.get(11)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok((notes, total))
    }
}
