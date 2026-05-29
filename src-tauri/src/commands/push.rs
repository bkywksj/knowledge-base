//! 定时推送 Command（IPC 入口，薄包装）
//!
//! 三层调用：Command → Database（CRUD）+ PushService（算 next_run / 执行）。
//! 任何会改变"触发点"的写操作（建/改/删/启停）完成后调 `notify_push`，让调度器重算唤醒。

use tauri::{AppHandle, State};

use crate::models::{
    CreatePushJobInput, PushJob, PushPopupData, PushRunLog, UpdatePushJobInput,
};
use crate::services::push::PushService;
use crate::state::AppState;

/// 写操作后唤醒调度器，让它重算下次唤醒时刻
fn notify_push(state: &State<'_, AppState>) {
    state.push_notify.notify_one();
}

#[tauri::command]
pub fn list_push_jobs(state: State<'_, AppState>) -> Result<Vec<PushJob>, String> {
    state.db.list_push_jobs().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_push_job(state: State<'_, AppState>, id: i64) -> Result<PushJob, String> {
    state.db.get_push_job(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_push_job(
    state: State<'_, AppState>,
    input: CreatePushJobInput,
) -> Result<i64, String> {
    // 启用时算首个 next_run_at；禁用时留空（调度器不可见）
    let enabled = input.enabled.unwrap_or(true);
    let next_run = if enabled {
        PushService::next_run_from_now(
            &input.schedule_time,
            input.repeat_kind.as_deref().unwrap_or("daily"),
            input.repeat_weekdays.as_deref(),
        )
    } else {
        None
    };
    let id = state
        .db
        .create_push_job(&input, next_run.as_deref())
        .map_err(|e| e.to_string())?;
    notify_push(&state);
    Ok(id)
}

#[tauri::command]
pub fn update_push_job(
    state: State<'_, AppState>,
    id: i64,
    input: UpdatePushJobInput,
) -> Result<bool, String> {
    let enabled = input.enabled.unwrap_or(true);
    let next_run = if enabled {
        PushService::next_run_from_now(
            &input.schedule_time,
            input.repeat_kind.as_deref().unwrap_or("daily"),
            input.repeat_weekdays.as_deref(),
        )
    } else {
        None
    };
    let ok = state
        .db
        .update_push_job(id, &input, next_run.as_deref())
        .map_err(|e| e.to_string())?;
    notify_push(&state);
    Ok(ok)
}

#[tauri::command]
pub fn delete_push_job(state: State<'_, AppState>, id: i64) -> Result<bool, String> {
    let ok = state.db.delete_push_job(id).map_err(|e| e.to_string())?;
    notify_push(&state);
    Ok(ok)
}

#[tauri::command]
pub fn set_push_job_enabled(
    state: State<'_, AppState>,
    id: i64,
    enabled: bool,
) -> Result<bool, String> {
    // 启用时按当前配置算 next_run；禁用时清空
    let next_run = if enabled {
        let job = state.db.get_push_job(id).map_err(|e| e.to_string())?;
        PushService::next_run_from_now(
            &job.schedule_time,
            &job.repeat_kind,
            job.repeat_weekdays.as_deref(),
        )
    } else {
        None
    };
    let ok = state
        .db
        .set_push_job_enabled(id, enabled, next_run.as_deref())
        .map_err(|e| e.to_string())?;
    notify_push(&state);
    Ok(ok)
}

/// 立即运行一次（调试/即时查看用）。不改调度字段，只跑一次提示词并投递。
#[tauri::command]
pub async fn run_push_job_now(app: AppHandle, id: i64) -> Result<(), String> {
    use tauri::Manager;
    let state = app.state::<AppState>();
    let job = state.db.get_push_job(id).map_err(|e| e.to_string())?;
    PushService::run_job(&app, &state.db, &job).await;
    Ok(())
}

/// 居中弹窗页按 run_log id 拉展示数据（推送名 + 内容）
#[tauri::command]
pub fn get_push_popup_data(
    state: State<'_, AppState>,
    log_id: i64,
) -> Result<PushPopupData, String> {
    state.db.get_push_popup_data(log_id).map_err(|e| e.to_string())
}

/// 查看某条推送的最近运行历史
#[tauri::command]
pub fn list_push_run_logs(
    state: State<'_, AppState>,
    job_id: i64,
    limit: Option<i64>,
) -> Result<Vec<PushRunLog>, String> {
    state
        .db
        .list_push_run_logs(job_id, limit.unwrap_or(20))
        .map_err(|e| e.to_string())
}
