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
            "SELECT id, name, color, icon, sort_order, created_at, stable_uuid, parent_id
             FROM task_categories
             ORDER BY sort_order ASC, id ASC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                // TEXT 列走降级读：本方法在同步 manifest 链路上，
                // 一个坏 cell 不该让整次同步失败。见 database::text_health。
                use crate::database::text_health::{get_opt_text_lossy, get_text_lossy};
                Ok(TaskCategory {
                    id: row.get(0)?,
                    name: get_text_lossy(row, 1, "task_categories.name")?,
                    color: get_text_lossy(row, 2, "task_categories.color")?,
                    icon: get_opt_text_lossy(row, 3, "task_categories.icon")?,
                    sort_order: row.get(4)?,
                    created_at: get_text_lossy(row, 5, "task_categories.created_at")?,
                    stable_uuid: get_opt_text_lossy(row, 6, "task_categories.stable_uuid")?,
                    parent_id: row.get(7)?,
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
            "INSERT INTO task_categories (name, color, icon, sort_order, stable_uuid, parent_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                input.name,
                color,
                input.icon,
                input.sort_order.unwrap_or(0),
                uuid,
                input.parent_id,
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
        if input.clear_parent.unwrap_or(false) {
            sets.push("parent_id = NULL");
        } else if let Some(pid) = input.parent_id {
            sets.push("parent_id = ?");
            binds.push(Box::new(pid));
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

    /// 删除分类。tasks.category_id 因 ON DELETE SET NULL 自动落到未分类；
    /// 子分类上移一级（挂到被删分类的父级下），不连带删除 —— 删一个目录不该让下面的分类跟着消失。
    pub fn delete_task_category(&self, id: i64) -> Result<bool, AppError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let tx = conn.transaction()?;
        let parent: Option<i64> = tx
            .query_row(
                "SELECT parent_id FROM task_categories WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap_or(None);
        tx.execute(
            "UPDATE task_categories SET parent_id = ?1 WHERE parent_id = ?2",
            params![parent, id],
        )?;
        let affected = tx.execute("DELETE FROM task_categories WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(affected > 0)
    }

    /// 只改父级（同步 pull 第二轮用：父分类可能在同一批里才建出来）
    pub fn set_task_category_parent(
        &self,
        id: i64,
        parent_id: Option<i64>,
    ) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE task_categories SET parent_id = ?1 WHERE id = ?2",
            params![parent_id, id],
        )?;
        Ok(())
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

#[cfg(test)]
mod tests {
    use crate::database::Database;
    use crate::models::{
        CreateTaskCategoryInput, CreateTaskInput, TaskQuery, UpdateTaskCategoryInput,
    };
    use crate::services::tasks::TaskService;

    fn cat(db: &Database, name: &str, parent: Option<i64>) -> i64 {
        TaskService::create_category(
            db,
            CreateTaskCategoryInput {
                name: name.into(),
                color: None,
                icon: None,
                sort_order: None,
                parent_id: parent,
            },
        )
        .unwrap()
    }

    fn task_in(db: &Database, title: &str, category: i64) -> i64 {
        let input: CreateTaskInput = serde_json::from_value(serde_json::json!({
            "title": title,
            "category_id": category,
        }))
        .unwrap();
        db.create_task(input).unwrap()
    }

    #[test]
    fn delete_parent_moves_children_up_one_level() {
        let db = Database::init(":memory:").unwrap();
        let root = cat(&db, "工作", None);
        let mid = cat(&db, "项目", Some(root));
        let leaf = cat(&db, "周会", Some(mid));
        db.delete_task_category(mid).unwrap();
        let cats = db.list_task_categories().unwrap();
        assert_eq!(
            cats.iter().find(|c| c.id == leaf).unwrap().parent_id,
            Some(root)
        );
    }

    #[test]
    fn reject_moving_category_under_its_own_descendant() {
        let db = Database::init(":memory:").unwrap();
        let a = cat(&db, "A", None);
        let b = cat(&db, "B", Some(a));
        let move_a_under_b: UpdateTaskCategoryInput =
            serde_json::from_value(serde_json::json!({ "parent_id": b })).unwrap();
        assert!(TaskService::update_category(&db, a, move_a_under_b).is_err());
        let move_a_under_self: UpdateTaskCategoryInput =
            serde_json::from_value(serde_json::json!({ "parent_id": a })).unwrap();
        assert!(TaskService::update_category(&db, a, move_a_under_self).is_err());
        // 移到顶层总是允许
        let to_top: UpdateTaskCategoryInput =
            serde_json::from_value(serde_json::json!({ "clear_parent": true })).unwrap();
        assert!(TaskService::update_category(&db, b, to_top).is_ok());
    }

    #[test]
    fn filter_by_parent_includes_descendant_tasks() {
        let db = Database::init(":memory:").unwrap();
        let root = cat(&db, "工作", None);
        let child = cat(&db, "周会", Some(root));
        let other = cat(&db, "生活", None);
        task_in(&db, "根上的", root);
        task_in(&db, "子分类里的", child);
        task_in(&db, "别的分类", other);
        let q: TaskQuery =
            serde_json::from_value(serde_json::json!({ "category_id": root })).unwrap();
        let mut titles: Vec<String> = db
            .list_tasks(q)
            .unwrap()
            .into_iter()
            .map(|t| t.title)
            .collect();
        titles.sort();
        assert_eq!(titles, vec!["子分类里的".to_string(), "根上的".to_string()]);
    }
}
