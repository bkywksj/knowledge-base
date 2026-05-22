use rusqlite::{params, ErrorCode};

use crate::error::AppError;
use crate::models::{CreateTaskCategoryInput, TaskCategory, UpdateTaskCategoryInput};

/// 把 rusqlite 错误中的 UNIQUE 约束冲突翻译成中文提示，其余原样向上抛
fn translate_name_conflict(err: rusqlite::Error, name: &str) -> AppError {
    if let rusqlite::Error::SqliteFailure(ref ffi, _) = err {
        if ffi.code == ErrorCode::ConstraintViolation {
            return AppError::InvalidInput(format!("分类名称「{}」已存在", name));
        }
    }
    AppError::Database(err)
}

impl super::Database {
    /// 列出所有分类（按 sort_order ASC, id ASC）
    pub fn list_task_categories(&self) -> Result<Vec<TaskCategory>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT id, name, color, icon, sort_order, created_at, stable_uuid
             FROM task_categories
             ORDER BY sort_order ASC, id ASC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(TaskCategory {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    icon: row.get(3)?,
                    sort_order: row.get(4)?,
                    created_at: row.get(5)?,
                    stable_uuid: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 创建分类（name 唯一约束由 DB 保证；冲突时返回错误）
    pub fn create_task_category(&self, input: CreateTaskCategoryInput) -> Result<i64, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let color = input
            .color
            .as_deref()
            .filter(|c| !c.trim().is_empty())
            .unwrap_or("#1677ff")
            .to_string();
        let uuid = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO task_categories (name, color, icon, sort_order, stable_uuid)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                input.name,
                color,
                input.icon,
                input.sort_order.unwrap_or(0),
                uuid,
            ],
        )
        .map_err(|e| translate_name_conflict(e, &input.name))?;
        Ok(conn.last_insert_rowid())
    }

    /// 更新分类（仅传入字段会被改）
    pub fn update_task_category(
        &self,
        id: i64,
        input: UpdateTaskCategoryInput,
    ) -> Result<bool, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let mut sets: Vec<&'static str> = Vec::new();
        let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        // 留个引用方便 UNIQUE 冲突时拼提示
        let new_name = input.name.clone();
        if let Some(n) = input.name {
            sets.push("name = ?");
            binds.push(Box::new(n));
        }
        if let Some(c) = input.color {
            sets.push("color = ?");
            binds.push(Box::new(c));
        }
        if input.clear_icon.unwrap_or(false) {
            sets.push("icon = NULL");
        } else if let Some(i) = input.icon {
            sets.push("icon = ?");
            binds.push(Box::new(i));
        }
        if let Some(s) = input.sort_order {
            sets.push("sort_order = ?");
            binds.push(Box::new(s));
        }
        if sets.is_empty() {
            return Ok(false);
        }
        let sql = format!(
            "UPDATE task_categories SET {} WHERE id = ?",
            sets.join(", ")
        );
        binds.push(Box::new(id));
        let affected = conn
            .execute(
                &sql,
                rusqlite::params_from_iter(binds.iter().map(|b| b.as_ref())),
            )
            .map_err(|e| translate_name_conflict(e, new_name.as_deref().unwrap_or("")))?;
        Ok(affected > 0)
    }

    /// 删除分类。tasks.category_id 因 ON DELETE SET NULL 自动落到未分类。
    pub fn delete_task_category(&self, id: i64) -> Result<bool, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute("DELETE FROM task_categories WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }

    /// 按 stable_uuid 找本地分类 id（sync pull 端用）。
    #[allow(dead_code)]
    pub fn get_task_category_id_by_stable_uuid(
        &self,
        stable_uuid: &str,
    ) -> Result<Option<i64>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let id: Option<i64> = conn
            .query_row(
                "SELECT id FROM task_categories WHERE stable_uuid = ?1",
                params![stable_uuid],
                |row| row.get(0),
            )
            .ok();
        Ok(id)
    }

    /// 同步 pull 端：按已知 UUID 插入分类（用于远端独有）。
    /// 名字冲突走 translate_name_conflict 回中文提示。
    #[allow(dead_code)]
    pub fn create_task_category_with_uuid(
        &self,
        stable_uuid: &str,
        name: &str,
        color: &str,
        icon: Option<&str>,
        sort_order: i32,
    ) -> Result<i64, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "INSERT INTO task_categories (name, color, icon, sort_order, stable_uuid)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![name, color, icon, sort_order, stable_uuid],
        )
        .map_err(|e| translate_name_conflict(e, name))?;
        Ok(conn.last_insert_rowid())
    }

    /// 同步 pull 端：按 local_id 全字段对齐远端分类。
    #[allow(dead_code)]
    pub fn update_task_category_synced(
        &self,
        local_id: i64,
        name: &str,
        color: &str,
        icon: Option<&str>,
        sort_order: i32,
    ) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE task_categories
             SET name = ?1, color = ?2, icon = ?3, sort_order = ?4
             WHERE id = ?5",
            params![name, color, icon, sort_order, local_id],
        )
        .map_err(|e| translate_name_conflict(e, name))?;
        Ok(())
    }
}
