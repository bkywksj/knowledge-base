use chrono::{Datelike, Duration, Months, NaiveDate, NaiveDateTime};

use crate::database::Database;
use crate::error::AppError;
use crate::models::{
    CreateTaskCategoryInput, CreateTaskInput, Task, TaskCategory, TaskLinkInput, TaskQuery,
    TaskSearchHit, TaskStats, UpdateTaskCategoryInput, UpdateTaskInput,
};

pub struct TaskService;

impl TaskService {
    pub fn list(db: &Database, query: TaskQuery) -> Result<Vec<Task>, AppError> {
        db.list_tasks(query)
    }

    pub fn get(db: &Database, id: i64) -> Result<Option<Task>, AppError> {
        db.get_task(id)
    }

    pub fn create(db: &Database, input: CreateTaskInput) -> Result<i64, AppError> {
        let title = input.title.trim();
        if title.is_empty() {
            return Err(AppError::InvalidInput("任务标题不能为空".into()));
        }
        if let Some(p) = input.priority {
            if !(0..=2).contains(&p) {
                return Err(AppError::InvalidInput(format!("非法的 priority: {}", p)));
            }
        }
        validate_repeat(
            input.repeat_kind.as_deref(),
            input.repeat_interval,
            input.repeat_weekdays.as_deref(),
            input.repeat_count,
        )?;
        db.create_task(input)
    }

    pub fn update(db: &Database, id: i64, input: UpdateTaskInput) -> Result<bool, AppError> {
        if let Some(t) = input.title.as_ref() {
            if t.trim().is_empty() {
                return Err(AppError::InvalidInput("任务标题不能为空".into()));
            }
        }
        if let Some(p) = input.priority {
            if !(0..=2).contains(&p) {
                return Err(AppError::InvalidInput(format!("非法的 priority: {}", p)));
            }
        }
        validate_repeat(
            input.repeat_kind.as_deref(),
            input.repeat_interval,
            input.repeat_weekdays.as_deref(),
            input.repeat_count,
        )?;
        db.update_task(id, input)
    }

    pub fn toggle_status(db: &Database, id: i64) -> Result<i32, AppError> {
        db.toggle_task_status(id)
    }

    pub fn delete(db: &Database, id: i64) -> Result<bool, AppError> {
        db.delete_task(id)
    }

    pub fn add_link(db: &Database, task_id: i64, input: TaskLinkInput) -> Result<i64, AppError> {
        db.add_task_link(task_id, input)
    }

    pub fn remove_link(db: &Database, link_id: i64) -> Result<bool, AppError> {
        db.remove_task_link(link_id)
    }

    pub fn stats(db: &Database) -> Result<TaskStats, AppError> {
        db.get_task_stats()
    }

    /// 顶栏全局搜索：keyword 空时返回空数组；limit 默认 20，封顶 50
    pub fn search(
        db: &Database,
        keyword: &str,
        limit: Option<usize>,
    ) -> Result<Vec<TaskSearchHit>, AppError> {
        let n = limit.unwrap_or(20).min(50);
        db.search_tasks(keyword, n)
    }

    /// 稍后提醒：把截止时间向后推 N 分钟 + 清提醒已触发标记
    pub fn snooze(db: &Database, id: i64, minutes: i32) -> Result<bool, AppError> {
        db.snooze_task(id, minutes)
    }

    // ─── 分类 CRUD ────────────────────────────────

    pub fn list_categories(db: &Database) -> Result<Vec<TaskCategory>, AppError> {
        db.list_task_categories()
    }

    pub fn create_category(
        db: &Database,
        mut input: CreateTaskCategoryInput,
    ) -> Result<i64, AppError> {
        input.name = input.name.trim().to_string();
        if input.name.is_empty() {
            return Err(AppError::InvalidInput("分类名称不能为空".into()));
        }
        if input.name.chars().count() > 30 {
            return Err(AppError::InvalidInput("分类名称不能超过 30 字".into()));
        }
        db.create_task_category(input)
    }

    pub fn update_category(
        db: &Database,
        id: i64,
        mut input: UpdateTaskCategoryInput,
    ) -> Result<bool, AppError> {
        if let Some(n) = input.name.as_mut() {
            *n = n.trim().to_string();
            if n.is_empty() {
                return Err(AppError::InvalidInput("分类名称不能为空".into()));
            }
            if n.chars().count() > 30 {
                return Err(AppError::InvalidInput("分类名称不能超过 30 字".into()));
            }
        }
        db.update_task_category(id, input)
    }

    pub fn delete_category(db: &Database, id: i64) -> Result<bool, AppError> {
        db.delete_task_category(id)
    }

    /// 完成本次（循环任务）：推进 due 到下一次；若循环已到终止条件则自动结束整条。
    /// 非循环任务走普通完成（切换 status）。
    pub fn complete_occurrence(
        db: &Database,
        id: i64,
        all_day_base_time: &str,
    ) -> Result<(), AppError> {
        let task = db
            .get_task(id)?
            .ok_or_else(|| AppError::Custom(format!("任务 {} 不存在", id)))?;
        if task.repeat_kind == "none" {
            db.toggle_task_status(id)?;
            return Ok(());
        }
        let now = chrono::Local::now().naive_local();
        let result = advance_recurrence(&task, all_day_base_time, now);
        db.advance_task_recurrence(id, result.next_due, result.new_done_count)?;
        Ok(())
    }
}

// ─── 循环规则校验 ─────────────────────────────────

fn validate_repeat(
    kind: Option<&str>,
    interval: Option<i32>,
    weekdays: Option<&str>,
    count: Option<i32>,
) -> Result<(), AppError> {
    if let Some(k) = kind {
        if !["none", "daily", "weekly", "monthly"].contains(&k) {
            return Err(AppError::InvalidInput(format!("非法的 repeat_kind: {}", k)));
        }
    }
    if let Some(iv) = interval {
        if iv < 1 {
            return Err(AppError::InvalidInput("repeat_interval 必须 >= 1".into()));
        }
    }
    if let Some(w) = weekdays {
        if !w.trim().is_empty() {
            for part in w.split(',') {
                let n: i32 = part
                    .trim()
                    .parse()
                    .map_err(|_| AppError::InvalidInput(format!("非法的星期值: {}", part)))?;
                if !(1..=7).contains(&n) {
                    return Err(AppError::InvalidInput(format!(
                        "星期值需在 1..=7 范围内: {}",
                        n
                    )));
                }
            }
        }
    }
    if let Some(c) = count {
        if c < 1 {
            return Err(AppError::InvalidInput("repeat_count 必须 >= 1".into()));
        }
    }
    Ok(())
}

// ─── 推进逻辑 ─────────────────────────────────────

pub struct AdvanceResult {
    /// None = 循环结束（task 将被标记完成）
    pub next_due: Option<String>,
    /// 推进后的 repeat_done_count（包含本次触发）
    pub new_done_count: i32,
}

/// 推进循环任务到下一次 > now 的触发时刻。
///
/// - 本次命中算一次 done
/// - 若命中后漏掉多次（如电脑关机跨越了多次周期），一次性合并跳到最新那次，但只通知一次
/// - 遇到 repeat_count / repeat_until 上限则返回 next_due=None（由调用方写 status=1）
pub fn advance_recurrence(task: &Task, all_day_base: &str, now_dt: NaiveDateTime) -> AdvanceResult {
    let mut done = task.repeat_done_count.saturating_add(1);

    // 先判断本次命中后是否已达上限
    if let Some(max) = task.repeat_count {
        if done >= max {
            return AdvanceResult {
                next_due: None,
                new_done_count: done,
            };
        }
    }

    let Some(due_raw) = task.due_date.as_ref() else {
        return AdvanceResult {
            next_due: None,
            new_done_count: done,
        };
    };
    let Some((mut date, time_part)) = split_due(due_raw) else {
        return AdvanceResult {
            next_due: None,
            new_done_count: done,
        };
    };

    let until = task
        .repeat_until
        .as_deref()
        .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok());

    loop {
        let Some(next) = next_due_date(
            date,
            &task.repeat_kind,
            task.repeat_interval,
            task.repeat_weekdays.as_deref(),
        ) else {
            return AdvanceResult {
                next_due: None,
                new_done_count: done,
            };
        };

        // 已过截止日期则终止
        if let Some(u) = until {
            if next > u {
                return AdvanceResult {
                    next_due: None,
                    new_done_count: done,
                };
            }
        }

        // 计算下一次的"提醒触发时刻"，判断是否仍处于过去（漏掉）
        let remind_trigger = compute_remind_trigger(
            next,
            time_part.as_deref(),
            all_day_base,
            task.remind_before_minutes.unwrap_or(0),
        );

        let in_future = remind_trigger.map(|t| t > now_dt).unwrap_or(true);
        if in_future {
            return AdvanceResult {
                next_due: Some(compose_due(next, time_part.as_deref())),
                new_done_count: done,
            };
        }

        // 这一轮也漏了：累计一次但不通知，继续向后推
        done = done.saturating_add(1);
        if let Some(max) = task.repeat_count {
            if done >= max {
                return AdvanceResult {
                    next_due: None,
                    new_done_count: done,
                };
            }
        }
        date = next;
    }
}

/// 计算下一次 due 日期（不检查终止条件）
fn next_due_date(
    current: NaiveDate,
    kind: &str,
    interval: i32,
    weekdays: Option<&str>,
) -> Option<NaiveDate> {
    let iv = interval.max(1) as i64;
    match kind {
        "daily" => current.checked_add_signed(Duration::days(iv)),
        "weekly" => {
            let wds = weekdays.map(parse_weekdays).unwrap_or_default();
            if wds.is_empty() {
                current.checked_add_signed(Duration::days(7 * iv))
            } else {
                // 逐日向后查找下一个匹配的星期（最多 14 天兜底）
                let mut d = current;
                for _ in 0..14 {
                    d = d.checked_add_signed(Duration::days(1))?;
                    let iso = d.weekday().number_from_monday();
                    if wds.contains(&iso) {
                        return Some(d);
                    }
                }
                None
            }
        }
        "monthly" => current.checked_add_months(Months::new(iv as u32)),
        _ => None,
    }
}

fn parse_weekdays(spec: &str) -> Vec<u32> {
    spec.split(',')
        .filter_map(|s| s.trim().parse::<u32>().ok())
        .filter(|n| (1..=7).contains(n))
        .collect()
}

/// 拆分 due_date：返回 (日期, 时间后缀)；时间后缀形如 " HH:MM:SS"（含前导空格），
/// 全天任务则为 None
fn split_due(due: &str) -> Option<(NaiveDate, Option<String>)> {
    let head = due.get(..10)?;
    let date = NaiveDate::parse_from_str(head, "%Y-%m-%d").ok()?;
    if due.len() > 10 {
        Some((date, Some(due[10..].to_string())))
    } else {
        Some((date, None))
    }
}

fn compose_due(date: NaiveDate, time_part: Option<&str>) -> String {
    match time_part {
        Some(t) => format!("{}{}", date.format("%Y-%m-%d"), t),
        None => date.format("%Y-%m-%d").to_string(),
    }
}

/// 计算某一次 due 对应的"提醒触发时刻" = due_datetime - remind_before_minutes
fn compute_remind_trigger(
    date: NaiveDate,
    time_part: Option<&str>,
    all_day_base: &str,
    remind_before_minutes: i32,
) -> Option<NaiveDateTime> {
    let dt_str = match time_part {
        Some(t) => format!("{}{}", date.format("%Y-%m-%d"), t),
        None => format!("{} {}", date.format("%Y-%m-%d"), all_day_base),
    };
    // 兼容 'HH:MM' 和 'HH:MM:SS'
    let parsed = NaiveDateTime::parse_from_str(&dt_str, "%Y-%m-%d %H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(&dt_str, "%Y-%m-%d %H:%M"))
        .ok()?;
    parsed.checked_sub_signed(Duration::minutes(remind_before_minutes as i64))
}
