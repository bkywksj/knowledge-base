use rusqlite::{params, params_from_iter, Connection};

use crate::error::AppError;
use crate::models::{
    CreateTaskInput, Task, TaskLink, TaskLinkInput, TaskQuery, TaskStats, UpdateTaskInput,
};

impl super::Database {
    // ─── 查询 ─────────────────────────────────────

    /// 列表（按 priority ASC → due_date NULL LAST → updated_at DESC 排序，附带 links）
    pub fn list_tasks(&self, query: TaskQuery) -> Result<Vec<Task>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let mut where_clauses: Vec<String> = Vec::new();
        let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(s) = query.status {
            where_clauses.push("status = ?".into());
            binds.push(Box::new(s));
        }
        if let Some(p) = query.priority {
            where_clauses.push("priority = ?".into());
            binds.push(Box::new(p));
        }
        if let Some(k) = query.keyword.as_ref().and_then(|s| {
            let t = s.trim();
            (!t.is_empty()).then(|| format!("%{}%", t))
        }) {
            where_clauses.push("(title LIKE ? OR IFNULL(description, '') LIKE ?)".into());
            binds.push(Box::new(k.clone()));
            binds.push(Box::new(k));
        }
        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_clauses.join(" AND "))
        };

        let sql = format!(
            "SELECT id, title, description, priority, important, status, due_date,
                    completed_at, created_at, updated_at
             FROM tasks
             {}
             ORDER BY status ASC,
                      priority ASC,
                      (due_date IS NULL) ASC,
                      due_date ASC,
                      updated_at DESC",
            where_sql,
        );

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(binds.iter().map(|b| b.as_ref())), |row| {
                Ok(Task {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    description: row.get(2)?,
                    priority: row.get(3)?,
                    important: row.get::<_, i32>(4)? != 0,
                    status: row.get(5)?,
                    due_date: row.get(6)?,
                    completed_at: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                    links: Vec::new(),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        // 批量拉 links，避免 N+1
        let mut tasks = rows;
        if !tasks.is_empty() {
            let ids: Vec<String> = tasks.iter().map(|t| t.id.to_string()).collect();
            let placeholders = vec!["?"; ids.len()].join(",");
            let sql = format!(
                "SELECT id, task_id, kind, target, label
                 FROM task_links WHERE task_id IN ({}) ORDER BY id",
                placeholders,
            );
            let mut stmt = conn.prepare(&sql)?;
            let link_iter = stmt.query_map(params_from_iter(&ids), |row| {
                Ok(TaskLink {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    kind: row.get(2)?,
                    target: row.get(3)?,
                    label: row.get(4)?,
                })
            })?;
            for link in link_iter {
                let link = link?;
                if let Some(t) = tasks.iter_mut().find(|t| t.id == link.task_id) {
                    t.links.push(link);
                }
            }
        }

        Ok(tasks)
    }

    pub fn get_task(&self, id: i64) -> Result<Option<Task>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let task: Option<Task> = conn
            .query_row(
                "SELECT id, title, description, priority, important, status, due_date,
                        completed_at, created_at, updated_at
                 FROM tasks WHERE id = ?1",
                params![id],
                |row| {
                    Ok(Task {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        description: row.get(2)?,
                        priority: row.get(3)?,
                        important: row.get::<_, i32>(4)? != 0,
                        status: row.get(5)?,
                        due_date: row.get(6)?,
                        completed_at: row.get(7)?,
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
                        links: Vec::new(),
                    })
                },
            )
            .ok();

        let Some(mut task) = task else { return Ok(None) };

        let mut stmt = conn.prepare(
            "SELECT id, task_id, kind, target, label
             FROM task_links WHERE task_id = ?1 ORDER BY id",
        )?;
        task.links = stmt
            .query_map(params![id], |row| {
                Ok(TaskLink {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    kind: row.get(2)?,
                    target: row.get(3)?,
                    label: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(Some(task))
    }

    // ─── 写操作 ────────────────────────────────

    /// 创建任务（含关联）
    pub fn create_task(&self, input: CreateTaskInput) -> Result<i64, AppError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO tasks (title, description, priority, important, due_date)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                input.title,
                input.description,
                input.priority.unwrap_or(1),
                if input.important.unwrap_or(false) { 1 } else { 0 },
                input.due_date,
            ],
        )?;
        let task_id = tx.last_insert_rowid();

        if let Some(links) = input.links {
            for l in links {
                insert_link(&tx, task_id, &l)?;
            }
        }
        tx.commit()?;
        Ok(task_id)
    }

    pub fn update_task(&self, id: i64, input: UpdateTaskInput) -> Result<bool, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let mut sets: Vec<&'static str> = Vec::new();
        let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        if let Some(t) = input.title {
            sets.push("title = ?");
            binds.push(Box::new(t));
        }
        if let Some(d) = input.description {
            sets.push("description = ?");
            binds.push(Box::new(d));
        }
        if let Some(p) = input.priority {
            sets.push("priority = ?");
            binds.push(Box::new(p));
        }
        if let Some(imp) = input.important {
            sets.push("important = ?");
            binds.push(Box::new(if imp { 1 } else { 0 }));
        }
        if input.clear_due_date.unwrap_or(false) {
            sets.push("due_date = NULL");
        } else if let Some(dd) = input.due_date {
            sets.push("due_date = ?");
            binds.push(Box::new(dd));
        }
        if sets.is_empty() {
            return Ok(false);
        }
        sets.push("updated_at = datetime('now','localtime')");
        let sql = format!("UPDATE tasks SET {} WHERE id = ?", sets.join(", "));
        binds.push(Box::new(id));

        let affected = conn.execute(
            &sql,
            params_from_iter(binds.iter().map(|b| b.as_ref())),
        )?;
        Ok(affected > 0)
    }

    /// 切换完成状态：返回新状态（0/1）
    pub fn toggle_task_status(&self, id: i64) -> Result<i32, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let current: i32 = conn.query_row(
            "SELECT status FROM tasks WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )?;
        let next = if current == 0 { 1 } else { 0 };
        if next == 1 {
            conn.execute(
                "UPDATE tasks SET status = 1, completed_at = datetime('now','localtime'),
                                    updated_at = datetime('now','localtime') WHERE id = ?1",
                params![id],
            )?;
        } else {
            conn.execute(
                "UPDATE tasks SET status = 0, completed_at = NULL,
                                    updated_at = datetime('now','localtime') WHERE id = ?1",
                params![id],
            )?;
        }
        Ok(next)
    }

    pub fn delete_task(&self, id: i64) -> Result<bool, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }

    // ─── 关联（task_links）────────────────────

    pub fn add_task_link(&self, task_id: i64, input: TaskLinkInput) -> Result<i64, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        insert_link(&conn, task_id, &input)?;
        Ok(conn.last_insert_rowid())
    }

    pub fn remove_task_link(&self, link_id: i64) -> Result<bool, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute("DELETE FROM task_links WHERE id = ?1", params![link_id])?;
        Ok(affected > 0)
    }

    // ─── 统计 ─────────────────────────────────

    pub fn get_task_stats(&self) -> Result<TaskStats, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let total_todo: usize = conn.query_row(
            "SELECT COUNT(*) FROM tasks WHERE status = 0",
            [],
            |row| row.get(0),
        )?;
        let total_done: usize = conn.query_row(
            "SELECT COUNT(*) FROM tasks WHERE status = 1",
            [],
            |row| row.get(0),
        )?;
        let urgent_todo: usize = conn.query_row(
            "SELECT COUNT(*) FROM tasks WHERE status = 0 AND priority = 0",
            [],
            |row| row.get(0),
        )?;
        let overdue: usize = conn.query_row(
            "SELECT COUNT(*) FROM tasks WHERE status = 0 AND due_date IS NOT NULL
                AND due_date < DATE('now','localtime')",
            [],
            |row| row.get(0),
        )?;
        let due_today: usize = conn.query_row(
            "SELECT COUNT(*) FROM tasks WHERE status = 0
                AND due_date = DATE('now','localtime')",
            [],
            |row| row.get(0),
        )?;
        Ok(TaskStats {
            total_todo,
            total_done,
            urgent_todo,
            overdue,
            due_today,
        })
    }
}

fn insert_link(conn: &Connection, task_id: i64, input: &TaskLinkInput) -> Result<(), AppError> {
    if !["note", "path", "url"].contains(&input.kind.as_str()) {
        return Err(AppError::InvalidInput(format!(
            "非法的关联类型: {}",
            input.kind
        )));
    }
    if input.target.trim().is_empty() {
        return Err(AppError::InvalidInput("关联目标不能为空".into()));
    }
    conn.execute(
        "INSERT INTO task_links (task_id, kind, target, label) VALUES (?1, ?2, ?3, ?4)",
        params![task_id, input.kind, input.target, input.label],
    )?;
    Ok(())
}
