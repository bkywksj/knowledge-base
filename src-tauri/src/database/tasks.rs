use rusqlite::{params, params_from_iter, Connection, OptionalExtension};

use crate::error::AppError;
use crate::models::{
    CreateTaskInput, Task, TaskLink, TaskLinkInput, TaskQuery, TaskSearchHit, TaskStats,
    UpdateTaskInput,
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
        // 分类筛选：category_id 优先；否则看 uncategorized
        if let Some(cid) = query.category_id {
            where_clauses.push("category_id = ?".into());
            binds.push(Box::new(cid));
        } else if query.uncategorized.unwrap_or(false) {
            where_clauses.push("category_id IS NULL".into());
        }
        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_clauses.join(" AND "))
        };

        let sql = format!(
            "SELECT id, title, description, priority, important, status, due_date,
                    completed_at, created_at, updated_at, remind_before_minutes, reminded_at,
                    repeat_kind, repeat_interval, repeat_weekdays, repeat_until,
                    repeat_count, repeat_done_count, source_batch_id, category_id
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
                    remind_before_minutes: row.get(10)?,
                    reminded_at: row.get(11)?,
                    repeat_kind: row.get(12)?,
                    repeat_interval: row.get(13)?,
                    repeat_weekdays: row.get(14)?,
                    repeat_until: row.get(15)?,
                    repeat_count: row.get(16)?,
                    repeat_done_count: row.get(17)?,
                    source_batch_id: row.get(18)?,
                    category_id: row.get(19)?,
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

        // SELECT 必须包含 20 列以对齐下方 row.get(0..=19)。
        // 历史教训 1：缺 source_batch_id 时 row.get(18)? 抛 InvalidColumnIndex。
        // 历史教训 2：v30 加 category_id 后这里漏改，导致搜索点中跳详情时永远报"任务不存在"。
        // 改用 .optional()? 而不是 .ok() —— "无行" 仍是 Ok(None)，但 SQL 错误（缺列/类型转换失败）
        // 会被原样向上抛，避免静默吞掉问题、误导前端。
        let task: Option<Task> = conn
            .query_row(
                "SELECT id, title, description, priority, important, status, due_date,
                        completed_at, created_at, updated_at, remind_before_minutes, reminded_at,
                        repeat_kind, repeat_interval, repeat_weekdays, repeat_until,
                        repeat_count, repeat_done_count, source_batch_id, category_id
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
                        remind_before_minutes: row.get(10)?,
                        reminded_at: row.get(11)?,
                        repeat_kind: row.get(12)?,
                        repeat_interval: row.get(13)?,
                        repeat_weekdays: row.get(14)?,
                        repeat_until: row.get(15)?,
                        repeat_count: row.get(16)?,
                        repeat_done_count: row.get(17)?,
                        source_batch_id: row.get(18)?,
                        category_id: row.get(19)?,
                        links: Vec::new(),
                    })
                },
            )
            .optional()?;

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

    /// 顶栏 Ctrl+K 搜索：按 title / description LIKE，未完成优先，高优先级靠前
    ///
    /// 只走简单 LIKE（不接 FTS5），原因：tasks 数据量小（用户级，几百条封顶），
    /// 索引收益不抵复杂度；未来如要全文 + 排名再切。
    pub fn search_tasks(
        &self,
        keyword: &str,
        limit: usize,
    ) -> Result<Vec<TaskSearchHit>, AppError> {
        let kw = keyword.trim();
        if kw.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let pattern = format!("%{}%", kw);
        let mut stmt = conn.prepare(
            "SELECT id, title, IFNULL(description, ''), status, priority, due_date
             FROM tasks
             WHERE title LIKE ?1 OR IFNULL(description, '') LIKE ?1
             ORDER BY status ASC, priority ASC,
                      (due_date IS NULL) ASC, due_date ASC,
                      updated_at DESC
             LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![pattern, limit as i64], |row| {
                let description: String = row.get(2)?;
                Ok(TaskSearchHit {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    snippet: description,
                    status: row.get(3)?,
                    priority: row.get(4)?,
                    due_date: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // ─── 写操作 ────────────────────────────────

    /// 创建任务（含关联）
    pub fn create_task(&self, input: CreateTaskInput) -> Result<i64, AppError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let tx = conn.transaction()?;
        let kind = input
            .repeat_kind
            .as_deref()
            .filter(|k| !k.is_empty())
            .unwrap_or("none")
            .to_string();
        let interval = input.repeat_interval.unwrap_or(1).max(1);
        tx.execute(
            "INSERT INTO tasks (title, description, priority, important, due_date,
                                remind_before_minutes, repeat_kind, repeat_interval,
                                repeat_weekdays, repeat_until, repeat_count,
                                source_batch_id, category_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                input.title,
                input.description,
                input.priority.unwrap_or(1),
                if input.important.unwrap_or(false) { 1 } else { 0 },
                input.due_date,
                input.remind_before_minutes,
                kind,
                interval,
                input.repeat_weekdays,
                input.repeat_until,
                input.repeat_count,
                input.source_batch_id,
                input.category_id,
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
            // 清空截止时间时一并清掉提醒已触发标记，避免复用时卡住
            sets.push("reminded_at = NULL");
        } else if let Some(dd) = input.due_date {
            sets.push("due_date = ?");
            binds.push(Box::new(dd));
            // 截止时间变更也重置提醒触发标记
            sets.push("reminded_at = NULL");
        }
        if input.clear_remind_before_minutes.unwrap_or(false) {
            sets.push("remind_before_minutes = NULL");
        } else if let Some(rm) = input.remind_before_minutes {
            sets.push("remind_before_minutes = ?");
            binds.push(Box::new(rm));
            // 改动提醒时机时重置已触发，使新设置立即生效
            sets.push("reminded_at = NULL");
        }
        // ─── 循环规则 ─────────────────────────────
        if let Some(k) = input.repeat_kind.as_ref() {
            sets.push("repeat_kind = ?");
            binds.push(Box::new(k.clone()));
            // 关闭循环时重置已触发次数
            if k == "none" {
                sets.push("repeat_done_count = 0");
            }
        }
        if let Some(iv) = input.repeat_interval {
            sets.push("repeat_interval = ?");
            binds.push(Box::new(iv.max(1)));
        }
        if input.clear_repeat_weekdays.unwrap_or(false) {
            sets.push("repeat_weekdays = NULL");
        } else if let Some(w) = input.repeat_weekdays.as_ref() {
            sets.push("repeat_weekdays = ?");
            binds.push(Box::new(w.clone()));
        }
        if input.clear_repeat_until.unwrap_or(false) {
            sets.push("repeat_until = NULL");
        } else if let Some(u) = input.repeat_until.as_ref() {
            sets.push("repeat_until = ?");
            binds.push(Box::new(u.clone()));
        }
        if input.clear_repeat_count.unwrap_or(false) {
            sets.push("repeat_count = NULL");
            sets.push("repeat_done_count = 0");
        } else if let Some(c) = input.repeat_count {
            sets.push("repeat_count = ?");
            binds.push(Box::new(c));
        }
        // ─── 分类 ─────────────────────────────────
        if input.clear_category_id.unwrap_or(false) {
            sets.push("category_id = NULL");
        } else if let Some(cid) = input.category_id {
            sets.push("category_id = ?");
            binds.push(Box::new(cid));
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

    /// 推进循环任务到下一次：更新 due_date、清 reminded_at、写 repeat_done_count。
    ///
    /// - `next_due = Some(...)`：保留未完成状态，仅移动截止时间，等下次到点
    /// - `next_due = None`：循环已结束，自动把任务标记完成
    pub fn advance_task_recurrence(
        &self,
        id: i64,
        next_due: Option<String>,
        new_done_count: i32,
    ) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        match next_due {
            Some(due) => {
                conn.execute(
                    "UPDATE tasks
                        SET due_date = ?1,
                            reminded_at = NULL,
                            repeat_done_count = ?2,
                            updated_at = datetime('now','localtime')
                      WHERE id = ?3",
                    params![due, new_done_count, id],
                )?;
            }
            None => {
                // 循环结束：置为已完成，关闭循环，停止再次调度
                conn.execute(
                    "UPDATE tasks
                        SET status = 1,
                            completed_at = datetime('now','localtime'),
                            reminded_at = datetime('now','localtime'),
                            repeat_done_count = ?1,
                            repeat_kind = 'none',
                            updated_at = datetime('now','localtime')
                      WHERE id = ?2",
                    params![new_done_count, id],
                )?;
            }
        }
        Ok(())
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

    /// 批量删除任务（多选场景）。task_links 由 ON DELETE CASCADE 自动清理。
    /// 返回实际删除条数；空 ids 返回 0。
    pub fn delete_tasks_by_ids(&self, ids: &[i64]) -> Result<usize, AppError> {
        if ids.is_empty() {
            return Ok(0);
        }
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!("DELETE FROM tasks WHERE id IN ({})", placeholders);
        let affected = conn.execute(&sql, rusqlite::params_from_iter(ids))?;
        Ok(affected)
    }

    /// 批量标记任务为已完成（多选场景）。循环任务也直接置为完成态，不推进周期。
    /// 返回实际更新条数。
    pub fn complete_tasks_by_ids(&self, ids: &[i64]) -> Result<usize, AppError> {
        if ids.is_empty() {
            return Ok(0);
        }
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!(
            "UPDATE tasks
                SET status = 1,
                    completed_at = datetime('now','localtime'),
                    updated_at = datetime('now','localtime')
              WHERE id IN ({}) AND status = 0",
            placeholders
        );
        let affected = conn.execute(&sql, rusqlite::params_from_iter(ids))?;
        Ok(affected)
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

    // ─── 提醒调度 ─────────────────────────────

    /// 捞出所有"到提醒点了但还没提醒过"的未完成任务。
    ///
    /// 条件：status=0 AND 有 due_date AND 有 remind_before_minutes AND reminded_at IS NULL
    /// 且 now >= (due_datetime - remind_before_minutes 分钟)
    ///
    /// 纯日期 due_date 的提醒基准时刻由 `all_day_base_time` 参数指定，
    /// 格式 'HH:MM:SS'（如 "09:00:00"）。对齐 Apple Reminders / MS To Do 的默认 09:00。
    pub fn list_due_reminders(
        &self,
        all_day_base_time: &str,
    ) -> Result<Vec<Task>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        // SELECT 必须包含 18 个映射用到的列（索引 0..=17），最后一个 source_batch_id
        // 之前缺这列，导致 row.get(18)? 抛 InvalidColumnIndex —— 调度器每次 tick 都失败，
        // 提醒从未触发（看似"调度器静默"）。修复：补全 SELECT 列对齐 row.get 索引。
        let sql = "
            SELECT id, title, description, priority, important, status, due_date,
                   completed_at, created_at, updated_at, remind_before_minutes, reminded_at,
                   repeat_kind, repeat_interval, repeat_weekdays, repeat_until,
                   repeat_count, repeat_done_count, source_batch_id
            FROM tasks
            WHERE status = 0
              AND reminded_at IS NULL
              AND due_date IS NOT NULL
              AND remind_before_minutes IS NOT NULL
              AND datetime(
                    CASE WHEN LENGTH(due_date) <= 10
                         THEN due_date || ' ' || ?1
                         ELSE due_date END,
                    '-' || remind_before_minutes || ' minutes'
                  ) <= datetime('now','localtime')
        ";
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt
            .query_map(params![all_day_base_time], |row| {
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
                    remind_before_minutes: row.get(10)?,
                    reminded_at: row.get(11)?,
                    repeat_kind: row.get(12)?,
                    repeat_interval: row.get(13)?,
                    repeat_weekdays: row.get(14)?,
                    repeat_until: row.get(15)?,
                    repeat_count: row.get(16)?,
                    repeat_done_count: row.get(17)?,
                    source_batch_id: row.get(18)?,
                    category_id: row.get(19)?,
                    links: Vec::new(),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 查最早一条「待提醒」任务的 effective_remind_at（含已逾期的）。
    /// 返回字符串 'YYYY-MM-DD HH:MM:SS'（local），无待提醒任务时返回 None。
    /// 调度器据此 sleep_until 精准触发，避免轮询空跑。
    pub fn peek_next_due_at(
        &self,
        all_day_base_time: &str,
    ) -> Result<Option<String>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let sql = "
            SELECT MIN(datetime(
                CASE WHEN LENGTH(due_date) <= 10
                     THEN due_date || ' ' || ?1
                     ELSE due_date END,
                '-' || remind_before_minutes || ' minutes'
            )) AS next_at
            FROM tasks
            WHERE status = 0
              AND reminded_at IS NULL
              AND due_date IS NOT NULL
              AND remind_before_minutes IS NOT NULL
        ";
        // MIN 在无匹配行时返回一行 NULL，所以走 `Option<String>` 接收避免 InvalidColumnType
        let next: Option<String> = conn.query_row(
            sql,
            params![all_day_base_time],
            |row| row.get::<_, Option<String>>(0),
        )?;
        Ok(next)
    }

    /// 标记任务已触发提醒（写入当前时刻到 reminded_at）
    pub fn mark_task_reminded(&self, id: i64) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE tasks SET reminded_at = datetime('now','localtime') WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// 稍后再提醒：清 reminded_at 并把 due_date 向后推 N 分钟
    ///
    /// 原 due_date 为纯日期时会被补 23:59:59 再推。
    pub fn snooze_task(&self, id: i64, minutes: i32) -> Result<bool, AppError> {
        if minutes <= 0 {
            return Err(AppError::InvalidInput("snooze 分钟数必须大于 0".into()));
        }
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE tasks
               SET due_date = datetime(
                     CASE WHEN LENGTH(IFNULL(due_date,'')) <= 10
                          THEN IFNULL(due_date, DATE('now','localtime')) || ' 23:59:59'
                          ELSE due_date END,
                     '+' || ?1 || ' minutes'),
                   reminded_at = NULL,
                   updated_at = datetime('now','localtime')
             WHERE id = ?2",
            params![minutes, id],
        )?;
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
        // 纯日期('YYYY-MM-DD') 视作当天 23:59:59；带时分的按实际时刻比较
        let overdue: usize = conn.query_row(
            "SELECT COUNT(*) FROM tasks WHERE status = 0 AND due_date IS NOT NULL
                AND datetime(CASE WHEN LENGTH(due_date) <= 10
                                  THEN due_date || ' 23:59:59'
                                  ELSE due_date END)
                    < datetime('now','localtime')",
            [],
            |row| row.get(0),
        )?;
        let due_today: usize = conn.query_row(
            "SELECT COUNT(*) FROM tasks WHERE status = 0 AND due_date IS NOT NULL
                AND DATE(due_date) = DATE('now','localtime')",
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

    // ─── 批次操作（AI 智能规划）─────────────────

    /// 删除某个 source_batch_id 下的所有任务（task_links 因 ON DELETE CASCADE 一并清掉）
    /// 返回删除的任务条数。
    pub fn delete_tasks_by_batch(&self, batch_id: &str) -> Result<usize, AppError> {
        if batch_id.trim().is_empty() {
            return Err(AppError::InvalidInput("batch_id 不能为空".into()));
        }
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "DELETE FROM tasks WHERE source_batch_id = ?1",
            params![batch_id],
        )?;
        Ok(affected)
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
