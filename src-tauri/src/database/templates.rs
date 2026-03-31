use crate::error::AppError;
use crate::models::{NoteTemplate, NoteTemplateInput};

use super::Database;

impl Database {
    /// 获取所有模板
    pub fn list_templates(&self) -> Result<Vec<NoteTemplate>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT id, name, description, content, created_at FROM note_templates ORDER BY id",
        )?;
        let templates = stmt
            .query_map([], |row| {
                Ok(NoteTemplate {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    content: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(templates)
    }

    /// 获取单个模板
    pub fn get_template(&self, id: i64) -> Result<NoteTemplate, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let template = conn.query_row(
            "SELECT id, name, description, content, created_at FROM note_templates WHERE id = ?1",
            [id],
            |row| {
                Ok(NoteTemplate {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    content: row.get(3)?,
                    created_at: row.get(4)?,
                })
            },
        )?;
        Ok(template)
    }

    /// 创建模板
    pub fn create_template(&self, input: &NoteTemplateInput) -> Result<NoteTemplate, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "INSERT INTO note_templates (name, description, content) VALUES (?1, ?2, ?3)",
            rusqlite::params![input.name, input.description, input.content],
        )?;
        let id = conn.last_insert_rowid();
        drop(conn);
        self.get_template(id)
    }

    /// 更新模板
    pub fn update_template(&self, id: i64, input: &NoteTemplateInput) -> Result<NoteTemplate, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE note_templates SET name = ?1, description = ?2, content = ?3 WHERE id = ?4",
            rusqlite::params![input.name, input.description, input.content, id],
        )?;
        if affected == 0 {
            return Err(AppError::NotFound(format!("模板 {} 不存在", id)));
        }
        drop(conn);
        self.get_template(id)
    }

    /// 删除模板
    pub fn delete_template(&self, id: i64) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute("DELETE FROM note_templates WHERE id = ?1", [id])?;
        if affected == 0 {
            return Err(AppError::NotFound(format!("模板 {} 不存在", id)));
        }
        Ok(())
    }
}
