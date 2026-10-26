//! 待办任务定时提醒调度器
//!
//! 事件驱动 + 兜底唤醒的混合策略（同 Quartz / Sidekiq / BullMQ 思路）：
//!
//! 1. 主循环每次开始先查 DB 最早 effective_remind_at → `tokio::time::sleep_until` 精确睡到那一刻
//! 2. 用户增 / 改 / 删 / snooze 任务时，命令层调 `state.reminder_notify.notify_one()`
//!    → `select!` 中断 sleep → 重算下一次唤醒
//! 3. 没任务时 sleep 5 分钟兜底（防御 OS 休眠 / 时钟跳变 / 漏 emit notify 等极端情况）
//! 4. 醒来后扫一次 due，按 priority 派发：
//!    - priority == 0：开全屏接管窗口（前端循环铃声 + 抢焦点）
//!    - 其它：闪烁主窗任务栏 + emit `task:reminder` 让主窗弹 antd Modal
//! 5. 循环任务提醒只标记已提醒、不推进（推进只在「完成本次」）；用户一直没处理时，
//!    下一次到点由 `roll_missed_recurrences` 滚到新的一次再提醒
//!
//! 精度：~毫秒级。空闲零 DB 查询。

use std::time::Duration;

use chrono::NaiveDateTime;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::error::AppError;
use crate::state::AppState;

/// 没有待提醒任务时的兜底唤醒间隔：避免长时间不动后被 OS 休眠 / 时钟跳变拖错时间
const IDLE_SAFETY_INTERVAL: Duration = Duration::from_secs(300);
/// 单次 sleep 上限：即使下一次提醒还很远（比如几天后），也每隔这么久醒一次自检
const MAX_SLEEP: Duration = Duration::from_secs(300);

/// 启动调度循环。进程存活期间常驻。
pub async fn run_reminder_loop(app: AppHandle) {
    log::info!("[reminder] 调度器已启动（事件驱动模式）");

    // 启动时立刻扫一次：捕获"应用关闭期间已逾期"的任务
    if let Err(e) = tick_once(&app) {
        log::warn!("[reminder] 启动 tick 失败: {}", e);
    }

    loop {
        let notify = {
            let state = app.state::<AppState>();
            state.reminder_notify.clone()
        };
        let sleep_dur = compute_sleep_duration(&app);

        // 关键顺序：先建 notified() future，再 sleep；这样在我们计算 sleep 期间
        // 来的 notify_one 也不会丢——Notify 内部会保留一次"待消费的 permit"
        let notified_fut = notify.notified();
        tokio::pin!(notified_fut);

        tokio::select! {
            _ = tokio::time::sleep(sleep_dur) => {
                log::debug!("[reminder] sleep 唤醒（{:?}）", sleep_dur);
            }
            _ = &mut notified_fut => {
                log::debug!("[reminder] notify 唤醒（任务变更）");
            }
        }

        if let Err(e) = tick_once(&app) {
            log::warn!("[reminder] tick 失败: {}", e);
        }
    }
}

/// 计算下次该 sleep 多久：
/// - 有最早 effective_remind_at = T：sleep `T - now`，但封顶 MAX_SLEEP（防 OS 时钟乱跳）
/// - T 已过：sleep 0（立刻进 tick_once）
/// - 没待提醒任务：sleep IDLE_SAFETY_INTERVAL
fn compute_sleep_duration(app: &AppHandle) -> Duration {
    let state = app.state::<AppState>();
    let base_time = read_base_time(&state);

    let next = match state.db.peek_next_due_at(&base_time) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[reminder] peek_next_due_at 失败: {}, 退化为 5min 轮询", e);
            return IDLE_SAFETY_INTERVAL;
        }
    };

    let next_due = match next {
        Some(s) => match NaiveDateTime::parse_from_str(&s, "%Y-%m-%d %H:%M:%S") {
            Ok(dt) => Some(dt),
            Err(_) => {
                log::warn!("[reminder] 无法解析下次提醒时刻: {}, 退化为 5min 轮询", s);
                return IDLE_SAFETY_INTERVAL;
            }
        },
        None => None,
    };
    // 已提醒但没人处理的循环任务，下一次到点也要醒（届时滚到新的一次再提醒）
    let rollover = earliest_rollover_at(&state, &base_time);
    let Some(next_dt) = [next_due, rollover].into_iter().flatten().min() else {
        return IDLE_SAFETY_INTERVAL;
    };
    let next_str = next_dt.format("%Y-%m-%d %H:%M:%S").to_string();

    let now = chrono::Local::now().naive_local();
    let delta = next_dt.signed_duration_since(now);
    if delta.num_milliseconds() <= 0 {
        return Duration::ZERO;
    }
    let std_dur = delta
        .to_std()
        .unwrap_or(IDLE_SAFETY_INTERVAL)
        .min(MAX_SLEEP);
    log::debug!("[reminder] 下次提醒 {} (in {:?})", next_str, std_dur);
    std_dur
}

fn read_base_time(state: &AppState) -> String {
    state
        .db
        .get_config("all_day_reminder_time")
        .ok()
        .flatten()
        .map(|s| if s.len() == 5 { format!("{}:00", s) } else { s })
        .unwrap_or_else(|| "09:00:00".to_string())
}

/// 把「用户没理会、而下一次已经到点」的循环任务滚到最近一次已到点的那一次，
/// 并清掉已提醒标记 —— 紧接着的 list_due_reminders 就会把它当作新的一次提醒出来。
///
/// 必须在 list_due_reminders 之前跑：应用关了好几天再打开时，先滚到最新一期，
/// 只提醒一次；反过来会先提醒过期的那一期、下一轮再提醒一次新的。
fn roll_missed_recurrences(state: &AppState, base_time: &str) -> Result<(), AppError> {
    let now = chrono::Local::now().naive_local();
    for task in state.db.list_recurring_reminder_tasks()? {
        let Some(r) = crate::services::tasks::roll_missed_recurrence(&task, base_time, now) else {
            continue;
        };
        log::info!(
            "[reminder] 循环任务 {} 未处理，滚到 {:?}",
            task.id,
            r.next_due
        );
        if let Err(e) = state
            .db
            .advance_task_recurrence(task.id, r.next_due, r.new_done_count)
        {
            log::warn!("[reminder] 滚动循环任务 {} 失败: {}", task.id, e);
        }
    }
    Ok(())
}

/// 已提醒、等待用户处理的循环任务里，最早的「下一次」提醒时刻。
fn earliest_rollover_at(state: &AppState, base_time: &str) -> Option<NaiveDateTime> {
    let tasks = match state.db.list_recurring_reminder_tasks() {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[reminder] list_recurring_reminder_tasks 失败: {}", e);
            return None;
        }
    };
    tasks
        .iter()
        // 还没提醒过的那一次由 peek_next_due_at 负责，这里只看已提醒的
        .filter(|t| t.reminded_at.is_some())
        .filter_map(|t| crate::services::tasks::next_occurrence_remind_at(t, base_time))
        .min()
}

fn tick_once(app: &AppHandle) -> Result<(), AppError> {
    let state = app.state::<AppState>();
    let base_time = read_base_time(&state);
    if let Err(e) = roll_missed_recurrences(&state, &base_time) {
        log::warn!("[reminder] 滚动未处理的循环任务失败: {}", e);
    }
    let due = state.db.list_due_reminders(&base_time)?;
    if due.is_empty() {
        return Ok(());
    }
    log::info!("[reminder] 命中 {} 条待提醒任务", due.len());

    for task in due {
        // 先更新状态，再推送。先更新能防止调度器重入导致重复通知；即便后续推送失败，
        // 用户只是少了一次提醒，不会被打扰到抓狂。
        //
        // 循环任务也只标记「已提醒」，不推进到下一次：推进只在用户点「完成本次」时发生。
        // 以前这里就推进一次、用户点完成再推进一次 → 一下跳过两期、完成次数多算一次。
        // 用户一直不理会的情况由 roll_missed_recurrences 在下一次到点时接手。
        if let Err(e) = state.db.mark_task_reminded(task.id) {
            log::warn!("[reminder] 更新任务 {} 提醒状态失败: {}", task.id, e);
            continue;
        }

        let body = task.description.clone().unwrap_or_else(|| {
            task.due_date
                .clone()
                .map(|d| format!("截止 {}", d))
                .unwrap_or_default()
        });

        if let Err(e) = app
            .notification()
            .builder()
            .title(format!("待办提醒：{}", task.title))
            .body(&body)
            .show()
        {
            log::warn!("[reminder] 系统通知发送失败: {}", e);
        }

        // 分级派发：
        // - priority == 0 紧急：开全屏接管窗口（前端自带循环铃声 + 抢焦点），
        //   主窗 Modal 不再弹同一条，避免双重打扰；窗口创建失败自动 fallback
        //   到主窗 Modal 流程，保证用户不会漏提醒
        // - 其它优先级：闪烁主窗任务栏 + 主窗内 Modal（前端自带短促一声"叮"）
        if task.priority == 0 {
            // 桌面端：开全屏接管窗口；移动端：fallback 到主窗 Modal（无多窗口能力）
            #[cfg(desktop)]
            match crate::services::emergency_window::open_for_task(app, task.id) {
                Ok(_) => {
                    log::info!("[reminder] 紧急任务 {} 已打开全屏窗口", task.id);
                }
                Err(e) => {
                    log::warn!("[reminder] 紧急窗口创建失败，回退主窗 Modal: {}", e);
                    surface_main_window(app);
                    if let Err(e) = app.emit("task:reminder", &task) {
                        log::warn!("[reminder] emit 事件失败: {}", e);
                    }
                }
            }
            #[cfg(mobile)]
            {
                // 移动端无紧急窗口，直接 emit 事件到主窗 Modal
                if let Err(e) = app.emit("task:reminder", &task) {
                    log::warn!("[reminder] emit 事件失败: {}", e);
                }
            }
        } else {
            // 普通/重要级：主窗如果被最小化或隐藏到托盘，必须先把它拉出来
            // 否则 Modal 弹在隐藏的主窗里用户看不见，只剩右下角系统通知 → 没法标记完成
            surface_main_window(app);
            if let Err(e) = app.emit("task:reminder", &task) {
                log::warn!("[reminder] emit 事件失败: {}", e);
            }
        }
    }
    Ok(())
}

/// 把主窗口拉到前台 + 闪烁任务栏抢用户注意。
/// 用于普通/重要级提醒：用户可能把主窗最小化或隐藏到托盘了，必须先 show + unminimize +
/// set_focus，否则 Modal 弹在隐藏窗口里用户看不见，只剩右下角系统通知 → 用户无从操作。
/// 仅桌面端：移动端无最小化/任务栏概念，且 WebviewWindow 不提供这些方法。
#[cfg(desktop)]
fn surface_main_window(app: &AppHandle) {
    // 唤回走统一入口：顺带把窗口纠回用户上次所在的显示器（见 services/main_window_placement.rs）
    crate::services::main_window_placement::show_main(app, "待办提醒");
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.request_user_attention(Some(tauri::UserAttentionType::Critical));
    }
}
/// 移动端 stub：单窗口模型，不需要拉前台
#[cfg(mobile)]
fn surface_main_window(_app: &AppHandle) {}
