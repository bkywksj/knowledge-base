use rusqlite::params;

use crate::error::AppError;
use crate::models::{Note, NoteInput};

use super::Database;

impl Database {
    // ─── 笔记 DAO ─────────────────────────────────

    /// 创建笔记
    pub fn create_note(&self, input: &NoteInput) -> Result<Note, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        conn.execute(
            "INSERT INTO notes (title, content, folder_id) VALUES (?1, ?2, ?3)",
            params![input.title, input.content, input.folder_id],
        )?;

        let id = conn.last_insert_rowid();
        self.get_note_inner(&conn, id)
    }

    /// 更新笔记
    pub fn update_note(&self, id: i64, input: &NoteInput) -> Result<Note, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        let affected = conn.execute(
            "UPDATE notes SET title = ?1, content = ?2, folder_id = ?3,
                    updated_at = datetime('now', 'localtime')
             WHERE id = ?4",
            params![input.title, input.content, input.folder_id, id],
        )?;

        if affected == 0 {
            return Err(AppError::NotFound(format!("笔记 {} 不存在", id)));
        }

        self.get_note_inner(&conn, id)
    }

    /// 删除笔记（永久删除，预留给未来使用）
    #[allow(dead_code)]
    pub fn delete_note(&self, id: i64) -> Result<bool, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }

    /// 获取单个笔记
    pub fn get_note(&self, id: i64) -> Result<Option<Note>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        let mut stmt = conn.prepare(
            "SELECT id, title, content, folder_id, is_daily, daily_date, is_pinned, word_count, created_at, updated_at, source_file_path, source_file_type
             FROM notes WHERE id = ?1",
        )?;

        let result = stmt
            .query_row(params![id], |row| {
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
            })
            .ok();

        Ok(result)
    }

    /// 查询笔记列表（分页 + 可选 folder_id 和 keyword 过滤）
    pub fn list_notes(
        &self,
        folder_id: Option<i64>,
        keyword: Option<&str>,
        page: usize,
        page_size: usize,
    ) -> Result<(Vec<Note>, usize), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        // 构建 WHERE 条件（始终过滤已删除笔记）
        let mut conditions = vec!["is_deleted = 0".to_string()];
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(fid) = folder_id {
            conditions.push(format!("folder_id = ?{}", param_values.len() + 1));
            param_values.push(Box::new(fid));
        }

        if let Some(kw) = keyword {
            if !kw.is_empty() {
                conditions.push(format!("title LIKE ?{}", param_values.len() + 1));
                param_values.push(Box::new(format!("%{}%", kw)));
            }
        }

        let where_clause = format!("WHERE {}", conditions.join(" AND "));

        // 查询总数
        let count_sql = format!("SELECT COUNT(*) FROM notes {}", where_clause);
        let params_ref: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();

        let total: usize =
            conn.query_row(&count_sql, params_ref.as_slice(), |row| row.get(0))?;

        // 查询分页数据
        let offset = (page.saturating_sub(1)) * page_size;
        let data_sql = format!(
            "SELECT id, title, content, folder_id, is_daily, daily_date, is_pinned, word_count, created_at, updated_at, source_file_path, source_file_type
             FROM notes {} ORDER BY updated_at DESC LIMIT ?{} OFFSET ?{}",
            where_clause,
            param_values.len() + 1,
            param_values.len() + 2,
        );

        let mut all_params: Vec<Box<dyn rusqlite::types::ToSql>> = param_values;
        all_params.push(Box::new(page_size as i64));
        all_params.push(Box::new(offset as i64));

        let all_params_ref: Vec<&dyn rusqlite::types::ToSql> =
            all_params.iter().map(|p| p.as_ref()).collect();

        let mut stmt = conn.prepare(&data_sql)?;
        let notes = stmt
            .query_map(all_params_ref.as_slice(), |row| {
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

    // ─── 置顶 & 移动 DAO ─────────────────────────

    /// 切换笔记置顶状态
    pub fn toggle_pin(&self, id: i64) -> Result<bool, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        let affected = conn.execute(
            "UPDATE notes SET is_pinned = CASE WHEN is_pinned = 0 THEN 1 ELSE 0 END,
                    updated_at = datetime('now', 'localtime')
             WHERE id = ?1 AND is_deleted = 0",
            params![id],
        )?;

        if affected == 0 {
            return Err(AppError::NotFound(format!("笔记 {} 不存在", id)));
        }

        let is_pinned: bool = conn.query_row(
            "SELECT is_pinned FROM notes WHERE id = ?1",
            params![id],
            |row| row.get::<_, i32>(0).map(|v| v != 0),
        )?;

        Ok(is_pinned)
    }

    /// 移动笔记到文件夹
    pub fn move_note_to_folder(&self, note_id: i64, folder_id: Option<i64>) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        let affected = conn.execute(
            "UPDATE notes SET folder_id = ?1, updated_at = datetime('now', 'localtime')
             WHERE id = ?2 AND is_deleted = 0",
            params![folder_id, note_id],
        )?;

        if affected == 0 {
            return Err(AppError::NotFound(format!("笔记 {} 不存在", note_id)));
        }

        Ok(())
    }

    // ─── 回收站 DAO ──────────────────────────────

    /// 软删除笔记（移入回收站）
    pub fn soft_delete_note(&self, id: i64) -> Result<bool, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE notes SET is_deleted = 1, deleted_at = datetime('now', 'localtime')
             WHERE id = ?1 AND is_deleted = 0",
            params![id],
        )?;
        Ok(affected > 0)
    }

    /// 恢复笔记（从回收站恢复）
    pub fn restore_note(&self, id: i64) -> Result<bool, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE notes SET is_deleted = 0, deleted_at = NULL
             WHERE id = ?1 AND is_deleted = 1",
            params![id],
        )?;
        Ok(affected > 0)
    }

    /// 永久删除笔记
    pub fn permanent_delete_note(&self, id: i64) -> Result<bool, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "DELETE FROM notes WHERE id = ?1 AND is_deleted = 1",
            params![id],
        )?;
        Ok(affected > 0)
    }

    /// 查询回收站笔记列表（分页）
    pub fn list_trash(
        &self,
        page: usize,
        page_size: usize,
    ) -> Result<(Vec<Note>, usize), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        // 查询总数
        let total: usize = conn.query_row(
            "SELECT COUNT(*) FROM notes WHERE is_deleted = 1",
            [],
            |row| row.get(0),
        )?;

        // 查询分页数据
        let offset = (page.saturating_sub(1)) * page_size;
        let mut stmt = conn.prepare(
            "SELECT id, title, content, folder_id, is_daily, daily_date, is_pinned, word_count, created_at, updated_at, source_file_path, source_file_type
             FROM notes WHERE is_deleted = 1
             ORDER BY deleted_at DESC
             LIMIT ?1 OFFSET ?2",
        )?;

        let notes = stmt
            .query_map(params![page_size as i64, offset as i64], |row| {
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

    /// 清空回收站
    pub fn empty_trash(&self) -> Result<usize, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute("DELETE FROM notes WHERE is_deleted = 1", [])?;
        Ok(affected)
    }

    /// 将所有笔记批量移到回收站（软删）
    /// 只影响 is_deleted = 0 的笔记；已在回收站的保持不变。
    pub fn trash_all_notes(&self) -> Result<usize, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE notes
             SET is_deleted = 1,
                 deleted_at = datetime('now', 'localtime')
             WHERE is_deleted = 0",
            [],
        )?;
        Ok(affected)
    }

    // ─── 每日笔记 DAO ────────────────────────────

    /// 查询每日笔记（不创建）
    pub fn get_daily(&self, date: &str) -> Result<Option<Note>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        let mut stmt = conn.prepare(
            "SELECT id, title, content, folder_id, is_daily, daily_date, is_pinned, word_count, created_at, updated_at, source_file_path, source_file_type
             FROM notes WHERE is_daily = 1 AND daily_date = ?1 AND is_deleted = 0",
        )?;

        let existing = stmt
            .query_row(params![date], |row| {
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
            })
            .ok();

        Ok(existing)
    }

    /// 获取或创建每日笔记
    pub fn get_or_create_daily(&self, date: &str) -> Result<Note, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        // 先查询是否已存在
        let mut stmt = conn.prepare(
            "SELECT id, title, content, folder_id, is_daily, daily_date, is_pinned, word_count, created_at, updated_at, source_file_path, source_file_type
             FROM notes WHERE is_daily = 1 AND daily_date = ?1 AND is_deleted = 0",
        )?;

        let existing = stmt
            .query_row(params![date], |row| {
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
            })
            .ok();

        if let Some(note) = existing {
            return Ok(note);
        }

        // 不存在则创建
        let title = format!("{} 的日记", date);
        conn.execute(
            "INSERT INTO notes (title, content, is_daily, daily_date) VALUES (?1, '', 1, ?2)",
            params![title, date],
        )?;

        let id = conn.last_insert_rowid();
        self.get_note_inner(&conn, id)
    }

    /// 获取有日记的日期列表（用于日历标记）
    pub fn list_daily_dates(&self, year: i32, month: i32) -> Result<Vec<String>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;

        let pattern = format!("{}-{:02}-%", year, month);
        let mut stmt = conn.prepare(
            "SELECT daily_date FROM notes
             WHERE is_daily = 1 AND is_deleted = 0 AND daily_date LIKE ?1
             ORDER BY daily_date DESC",
        )?;

        let dates = stmt
            .query_map(params![pattern], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(dates)
    }

    /// 内部方法：通过已有连接获取单个笔记（避免重复锁）
    fn get_note_inner(
        &self,
        conn: &rusqlite::Connection,
        id: i64,
    ) -> Result<Note, AppError> {
        let mut stmt = conn.prepare(
            "SELECT id, title, content, folder_id, is_daily, daily_date, is_pinned, word_count, created_at, updated_at, source_file_path, source_file_type
             FROM notes WHERE id = ?1",
        )?;

        let note = stmt.query_row(params![id], |row| {
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
        })?;

        Ok(note)
    }

    /// 更新笔记的源文件路径与类型
    pub fn set_note_source_file(
        &self,
        id: i64,
        path: Option<&str>,
        file_type: Option<&str>,
    ) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE notes SET source_file_path = ?1, source_file_type = ?2 WHERE id = ?3",
            params![path, file_type, id],
        )?;
        if affected == 0 {
            return Err(AppError::NotFound(format!("笔记 {} 不存在", id)));
        }
        Ok(())
    }
}
