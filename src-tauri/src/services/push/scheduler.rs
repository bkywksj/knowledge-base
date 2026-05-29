//! 定时推送调度器
//!
//! 骨架照搬 `services/task_reminder.rs`（事件驱动 + 兜底唤醒）：
//!
//! 1. 主循环先查 DB 最近 `next_run_at` → `sleep` 精确睡到那一刻（封顶 5min 防时钟跳变）
//! 2. 用户增/改/删/启停推送时，命令层调 `state.push_notify.notify_one()`
//!    → `select!` 中断 sleep → 重算下一次唤醒
//! 3. 无启用推送时 sleep 5min 兜底（防 OS 休眠 / 时钟跳变）
//! 4. 醒来后扫一次 due：**先推进 next_run_at/last_run_at（防重入），再 spawn 异步执行**
//!    —— AI 网络调用绝不在 loop 里同步跑，否则会冻结整个调度
//!
//! 启动时先 tick 一次：补推"应用关闭期间已错过"的推送（合并漏掉的多次，只补一次）。

use std::time::Duration;

use chrono::{Local, NaiveDateTime};
use tauri::{AppHandle, Manager};

use crate::services::push::{schedule_calc, PushService};
use crate::state::AppState;

/// 无待运行推送时的兜底唤醒间隔
const IDLE_SAFETY_INTERVAL: Duration = Duration::from_secs(300);
/// 单次 sleep 上限：即使下次运行还很远也每隔这么久醒一次自检（防时钟乱跳）
const MAX_SLEEP: Duration = Duration::from_secs(300);

/// 启动调度循环。进程存活期间常驻。
pub async fn run_push_loop(app: AppHandle) {
    log::info!("[push] 调度器已启动（事件驱动模式）");

    // 启动先扫一次：捕获"应用关闭期间已错过"的推送
    tick_once(&app);

    loop {
        let notify = {
            let state = app.state::<AppState>();
            state.push_notify.clone()
        };
        let sleep_dur = compute_sleep_duration(&app);

        // 先建 notified() future 再 sleep：计算 sleep 期间来的 notify_one 不会丢
        let notified_fut = notify.notified();
        tokio::pin!(notified_fut);

        tokio::select! {
            _ = tokio::time::sleep(sleep_dur) => {
                log::debug!("[push] sleep 唤醒（{:?}）", sleep_dur);
            }
            _ = &mut notified_fut => {
                log::debug!("[push] notify 唤醒（推送变更）");
            }
        }

        tick_once(&app);
    }
}

/// 算下次该 sleep 多久：有最近 next_run_at = T → sleep `T - now`（封顶 MAX_SLEEP）；
/// T 已过 → sleep 0；无启用推送 → sleep IDLE_SAFETY_INTERVAL。
fn compute_sleep_duration(app: &AppHandle) -> Duration {
    let state = app.state::<AppState>();
    let next = match state.db.peek_next_push_run_at() {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[push] peek_next_push_run_at 失败: {}, 退化为 5min 轮询", e);
            return IDLE_SAFETY_INTERVAL;
        }
    };
    let Some(next_str) = next else {
        return IDLE_SAFETY_INTERVAL;
    };
    let Ok(next_dt) = NaiveDateTime::parse_from_str(&next_str, "%Y-%m-%d %H:%M:%S") else {
        log::warn!("[push] 无法解析下次运行时刻: {}, 退化为 5min 轮询", next_str);
        return IDLE_SAFETY_INTERVAL;
    };
    let now = Local::now().naive_local();
    let delta = next_dt.signed_duration_since(now);
    if delta.num_milliseconds() <= 0 {
        return Duration::ZERO;
    }
    delta.to_std().unwrap_or(IDLE_SAFETY_INTERVAL).min(MAX_SLEEP)
}

/// 扫一次到点的推送，逐条：先推进调度字段（防重入）→ 再 spawn 异步执行。
fn tick_once(app: &AppHandle) {
    let state = app.state::<AppState>();
    let due = match state.db.list_due_push_jobs() {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[push] list_due_push_jobs 失败: {}", e);
            return;
        }
    };
    if due.is_empty() {
        return;
    }

    // 模块总开关（设置→功能模块）。关掉时：仍推进各任务的下次时刻（避免重新启用时
    // 积压的过期任务一次性全部触发），但不投递任何推送。
    let module_enabled = PushService::is_module_enabled(&state.db);
    if module_enabled {
        log::info!("[push] 命中 {} 条到点推送", due.len());
    } else {
        log::info!("[push] 模块已关闭，静默推进 {} 条（不投递）", due.len());
    }

    let now = Local::now().naive_local();
    let now_str = now.format("%Y-%m-%d %H:%M:%S").to_string();

    for job in due {
        // 先推进 next_run_at / last_run_at：即便后续执行失败，也不会被下一轮重复命中。
        let next = schedule_calc::compute_next_run(
            &job.schedule_time,
            &job.repeat_kind,
            job.repeat_weekdays.as_deref(),
            now,
        );
        if let Err(e) = state.db.update_push_job_run(job.id, &now_str, next.as_deref()) {
            log::warn!("[push] 推进推送 #{} 调度字段失败: {}", job.id, e);
            continue;
        }

        // 模块关闭时只推进时刻、不投递（上面已统一记日志）
        if !module_enabled {
            continue;
        }

        // 实际执行（含 AI 网络调用）放后台 task，绝不阻塞调度 loop。
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            let state = app2.state::<AppState>();
            PushService::run_job(&app2, &state.db, &job).await;
        });
    }
}
