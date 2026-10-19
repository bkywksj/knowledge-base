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

    /// 列出某主任务的子任务
    pub fn list_subtasks(db: &Database, parent_id: i64) -> Result<Vec<Task>, AppError> {
        db.list_subtasks(parent_id)
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

    /// 放弃任务：留在库里可查可恢复，但不再进待办列表 / 不提醒 / 不计入完成率
    pub fn abandon(db: &Database, id: i64) -> Result<(), AppError> {
        db.abandon_task(id)
    }

    /// 恢复已放弃的任务（回到未完成）
    pub fn restore_abandoned(db: &Database, id: i64) -> Result<(), AppError> {
        db.restore_abandoned_task(id)
    }

    /// 设置任务的看板列归属（'todo' / 'doing' / 'done'）。
    /// 校验 stage 合法性后委托给 DAO 层做实际 SQL（DAO 会同步 status / completed_at）。
    pub fn set_kanban_stage(
        db: &Database,
        id: i64,
        stage: &str,
    ) -> Result<(), AppError> {
        match stage {
            "todo" | "doing" | "done" => db.set_task_kanban_stage(id, stage),
            other => Err(AppError::InvalidInput(format!(
                "非法的看板阶段：{}（仅支持 todo/doing/done）",
                other
            ))),
        }
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

    /// 稍后提醒：N 分钟后再提醒一次（只写 snooze_until，不改截止时间）
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
        if let Some(pid) = input.parent_id {
            validate_category_parent(&db.list_task_categories()?, None, pid)?;
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
        if !input.clear_parent.unwrap_or(false) {
            if let Some(pid) = input.parent_id {
                validate_category_parent(&db.list_task_categories()?, Some(id), pid)?;
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

// ─── 分类父级校验 ─────────────────────────────────

/// 父分类必须存在，且不能是自己或自己的后代（否则成环，树永远遍历不完）。
/// `self_id` 为 None 表示新建（新分类还没有后代，只需校验存在）。
fn validate_category_parent(
    all: &[TaskCategory],
    self_id: Option<i64>,
    parent_id: i64,
) -> Result<(), AppError> {
    if !all.iter().any(|c| c.id == parent_id) {
        return Err(AppError::InvalidInput("父分类不存在".into()));
    }
    let Some(me) = self_id else {
        return Ok(());
    };
    // 从候选父级一路往上走：走到自己说明候选父级是自己的后代
    let mut cur = Some(parent_id);
    let mut guard = 0;
    while let Some(id) = cur {
        if id == me {
            return Err(AppError::InvalidInput("不能把分类移到它自己或它的子分类下".into()));
        }
        cur = all.iter().find(|c| c.id == id).and_then(|c| c.parent_id);
        guard += 1;
        if guard > 1000 {
            break; // 库里已有脏环时别死循环
        }
    }
    Ok(())
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

/// 循环任务在 `date` 这一次之后的下一次（遵守 repeat_until / repeat_count）。
///
/// `done` 是「走到 `date` 这一次时已消耗的次数」；跳到下一次会再消耗一次，
/// 达到 repeat_count 上限就没有下一次了 —— 口径与 `advance_recurrence` 一致。
fn next_occurrence_within_limits(task: &Task, date: NaiveDate, done: i32) -> Option<NaiveDate> {
    if let Some(max) = task.repeat_count {
        if done.saturating_add(1) >= max {
            return None;
        }
    }
    let next = next_due_date(
        date,
        &task.repeat_kind,
        task.repeat_interval,
        task.repeat_weekdays.as_deref(),
    )?;
    let until = task
        .repeat_until
        .as_deref()
        .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok());
    match until {
        Some(u) if next > u => None,
        _ => Some(next),
    }
}

/// 循环任务「下一次」的提醒时刻；没有下一次（已到上限 / 无截止 / 未设提醒）返回 None。
/// 调度器据此决定睡多久，保证用户没理会的循环任务在下一次到点时准时醒来。
pub fn next_occurrence_remind_at(task: &Task, all_day_base: &str) -> Option<NaiveDateTime> {
    if task.repeat_kind == "none" {
        return None;
    }
    let remind = task.remind_before_minutes?;
    let (date, time_part) = split_due(task.due_date.as_deref()?)?;
    let next = next_occurrence_within_limits(task, date, task.repeat_done_count)?;
    compute_remind_trigger(next, time_part.as_deref(), all_day_base, remind)
}

/// 用户一直没处理的循环任务：下一次（或更后面几次）的提醒时刻已经到了，
/// 就把任务滚到「最近一次已到点」的那一次，让它重新提醒一回。
///
/// - 提醒触发本身**不推进**循环（推进只发生在「完成本次」），所以没人理会时任务会停在
///   已提醒的那一次；不滚的话之后的每一次都不会再提醒
/// - 中间漏掉的几次合并，只提醒最新那次；漏掉的照样计入 repeat_done_count（占用次数上限）
/// - 撞到 repeat_until / repeat_count 就停在最后一次，**不自动标完成** —— 用户没做完的事
///   不能替他勾掉
///
/// 返回 None = 下一次还没到，不用动。
pub fn roll_missed_recurrence(
    task: &Task,
    all_day_base: &str,
    now_dt: NaiveDateTime,
) -> Option<AdvanceResult> {
    if task.repeat_kind == "none" {
        return None;
    }
    let remind = task.remind_before_minutes?;
    let (mut date, time_part) = split_due(task.due_date.as_deref()?)?;
    let mut done = task.repeat_done_count;
    let mut rolled = false;

    while let Some(next) = next_occurrence_within_limits(task, date, done) {
        let trigger = compute_remind_trigger(next, time_part.as_deref(), all_day_base, remind)?;
        if trigger > now_dt {
            break;
        }
        date = next;
        done = done.saturating_add(1);
        rolled = true;
    }

    rolled.then(|| AdvanceResult {
        next_due: Some(compose_due(date, time_part.as_deref())),
        new_done_count: done,
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap()
    }

    /// 每天 09:00、提前 10 分钟提醒的循环任务（经 DB 建出来，字段与线上一致）
    fn daily_task(db: &Database, due: &str) -> Task {
        let id = db
            .create_task(CreateTaskInput {
                title: "每日站会".into(),
                description: None,
                priority: Some(1),
                important: None,
                due_date: Some(due.into()),
                remind_before_minutes: Some(10),
                links: None,
                repeat_kind: Some("daily".into()),
                repeat_interval: Some(1),
                repeat_weekdays: None,
                repeat_until: None,
                repeat_count: None,
                source_batch_id: None,
                category_id: None,
                parent_task_id: None,
                project_id: None,
                start_date: None,
            })
            .unwrap();
        db.get_task(id).unwrap().unwrap()
    }

    fn fresh() -> Database {
        Database::init(":memory:").unwrap()
    }

    /// 下一次还没到点：不滚，任务停在已提醒的这一次等用户处理
    #[test]
    fn roll_waits_until_next_occurrence_is_due() {
        let db = fresh();
        let t = daily_task(&db, "2026-10-19 09:00:00");
        assert!(roll_missed_recurrence(&t, "09:00:00", dt("2026-10-19 12:00:00")).is_none());
        // 下一次提醒时刻 = 10-20 08:50，差一分钟也不滚
        assert!(roll_missed_recurrence(&t, "09:00:00", dt("2026-10-20 08:49:00")).is_none());
        assert_eq!(
            next_occurrence_remind_at(&t, "09:00:00"),
            Some(dt("2026-10-20 08:50:00"))
        );
    }

    /// 用户一直没理会：下一次到点就滚过去（再提醒一次），中间漏掉的合并、计入次数
    #[test]
    fn roll_jumps_to_latest_due_occurrence() {
        let db = fresh();
        let t = daily_task(&db, "2026-10-19 09:00:00");

        let r = roll_missed_recurrence(&t, "09:00:00", dt("2026-10-20 08:50:00")).unwrap();
        assert_eq!(r.next_due.as_deref(), Some("2026-10-20 09:00:00"));
        assert_eq!(r.new_done_count, 1);

        // 关机三天后打开：只滚到最新已到点的那一次（10-23），不是 10-24
        let r = roll_missed_recurrence(&t, "09:00:00", dt("2026-10-23 10:00:00")).unwrap();
        assert_eq!(r.next_due.as_deref(), Some("2026-10-23 09:00:00"));
        assert_eq!(r.new_done_count, 4);
    }

    /// 撞到次数上限：停在最后一次，不替用户把没做的事勾成完成
    #[test]
    fn roll_stops_at_last_occurrence_without_completing() {
        let db = fresh();
        let mut t = daily_task(&db, "2026-10-19 09:00:00");
        t.repeat_count = Some(3); // 共 3 次：19 / 20 / 21

        let r = roll_missed_recurrence(&t, "09:00:00", dt("2026-10-30 10:00:00")).unwrap();
        assert_eq!(r.next_due.as_deref(), Some("2026-10-21 09:00:00"));
        assert_eq!(r.new_done_count, 2);

        // 已经在最后一次：没有下一次可滚，也不再安排唤醒
        t.due_date = r.next_due;
        t.repeat_done_count = r.new_done_count;
        assert!(roll_missed_recurrence(&t, "09:00:00", dt("2026-10-30 10:00:00")).is_none());
        assert_eq!(next_occurrence_remind_at(&t, "09:00:00"), None);
    }

    /// repeat_until 同理：最后一次在截止日当天
    #[test]
    fn roll_respects_repeat_until() {
        let db = fresh();
        let mut t = daily_task(&db, "2026-10-19 09:00:00");
        t.repeat_until = Some("2026-10-20".into());
        let r = roll_missed_recurrence(&t, "09:00:00", dt("2026-10-25 10:00:00")).unwrap();
        assert_eq!(r.next_due.as_deref(), Some("2026-10-20 09:00:00"));
    }

    /// 回归：提醒触发后点「完成本次」只推进一期。
    /// 以前提醒触发时已推进一次、点完成再推进一次 → 跳过一期、次数多算 1。
    #[test]
    fn reminder_then_complete_advances_exactly_once() {
        let db = fresh();
        let now = chrono::Local::now().naive_local();
        let due = (now - Duration::hours(1)).format("%Y-%m-%d %H:%M:%S").to_string();
        let t = daily_task(&db, &due);

        // 调度器：命中 → 只标记已提醒
        let hits = db.list_due_reminders("09:00:00").unwrap();
        assert_eq!(hits.len(), 1);
        db.mark_task_reminded(t.id).unwrap();
        let after_remind = db.get_task(t.id).unwrap().unwrap();
        assert_eq!(after_remind.due_date.as_deref(), Some(due.as_str()), "提醒不该推进截止");
        assert_eq!(after_remind.repeat_done_count, 0);
        assert!(db.list_due_reminders("09:00:00").unwrap().is_empty(), "同一次不重复提醒");

        // 用户点「完成本次」
        TaskService::complete_occurrence(&db, t.id, "09:00:00").unwrap();
        let done = db.get_task(t.id).unwrap().unwrap();
        let expected = (now - Duration::hours(1) + Duration::days(1))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        assert_eq!(done.due_date.as_deref(), Some(expected.as_str()));
        assert_eq!(done.repeat_done_count, 1);
        assert_eq!(done.status, 0, "循环未结束，仍是未完成");
        assert!(done.reminded_at.is_none(), "推进后下一次要能再提醒");
    }
}
