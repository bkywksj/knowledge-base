//! 待办任务定时提醒调度器
//!
//! 后台 tokio 任务，每分钟扫一次 `tasks` 表：命中"到提醒点但尚未提醒过"的
//! 未完成任务后，发系统通知 + 推 `task:reminder` 事件给前端，并把该任务标记
//! 为已提醒（reminded_at），避免重复触发。
//!
//! 触发条件由 SQL 侧计算（见 `Database::list_due_reminders`），这里只负责
//! 周期调度与副作用分发。

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::error::AppError;
use crate::state::AppState;

/// 扫描周期：1 分钟（足够精确，且避免对 DB 造成压力）
const TICK_INTERVAL_SECS: u64 = 60;

/// 启动调度循环。进程存活期间常驻。
pub async fn run_reminder_loop(app: AppHandle) {
    log::info!("[reminder] 调度器已启动");
    let mut interval = tokio::time::interval(Duration::from_secs(TICK_INTERVAL_SECS));
    // 第一次 tick 会立即返回（默认 Immediate），跳过避免启动时就扫一轮
    interval.tick().await;

    loop {
        interval.tick().await;
        if let Err(e) = tick_once(&app) {
            log::warn!("[reminder] tick 失败: {}", e);
        }
    }
}

fn tick_once(app: &AppHandle) -> Result<(), AppError> {
    let state = app.state::<AppState>();
    // 读全天任务提醒基准时刻，默认 09:00；兼容 "HH:MM" 和 "HH:MM:SS"
    let base_time = state
        .db
        .get_config("all_day_reminder_time")
        .ok()
        .flatten()
        .map(|s| if s.len() == 5 { format!("{}:00", s) } else { s })
        .unwrap_or_else(|| "09:00:00".to_string());
    let due = state.db.list_due_reminders(&base_time)?;
    if due.is_empty() {
        return Ok(());
    }
    log::info!("[reminder] 命中 {} 条待提醒任务", due.len());

    for task in due {
        // 先标记，再推送。先标记能防止调度器重入导致重复通知；即便后续推送失败，
        // 用户只是少了一次提醒，不会被打扰到抓狂。
        if let Err(e) = state.db.mark_task_reminded(task.id) {
            log::warn!("[reminder] 标记任务 {} 已提醒失败: {}", task.id, e);
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

        // 推事件给前端。前端若窗口可见则弹应用内 Modal，否则仅托盘角标
        if let Err(e) = app.emit("task:reminder", &task) {
            log::warn!("[reminder] emit 事件失败: {}", e);
        }
    }
    Ok(())
}
