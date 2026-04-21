use tauri::State;

use crate::models::{
    CreateTaskInput, Task, TaskLinkInput, TaskQuery, TaskStats, UpdateTaskInput,
};
use crate::services::tasks::TaskService;
use crate::state::AppState;

#[tauri::command]
pub fn list_tasks(
    state: State<'_, AppState>,
    query: Option<TaskQuery>,
) -> Result<Vec<Task>, String> {
    TaskService::list(&state.db, query.unwrap_or_default()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_task(state: State<'_, AppState>, id: i64) -> Result<Task, String> {
    TaskService::get(&state.db, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("任务 {} 不存在", id))
}

#[tauri::command]
pub fn create_task(state: State<'_, AppState>, input: CreateTaskInput) -> Result<i64, String> {
    TaskService::create(&state.db, input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_task(
    state: State<'_, AppState>,
    id: i64,
    input: UpdateTaskInput,
) -> Result<bool, String> {
    TaskService::update(&state.db, id, input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn toggle_task_status(state: State<'_, AppState>, id: i64) -> Result<i32, String> {
    TaskService::toggle_status(&state.db, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_task(state: State<'_, AppState>, id: i64) -> Result<bool, String> {
    TaskService::delete(&state.db, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_task_link(
    state: State<'_, AppState>,
    task_id: i64,
    input: TaskLinkInput,
) -> Result<i64, String> {
    TaskService::add_link(&state.db, task_id, input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_task_link(state: State<'_, AppState>, link_id: i64) -> Result<bool, String> {
    TaskService::remove_link(&state.db, link_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_task_stats(state: State<'_, AppState>) -> Result<TaskStats, String> {
    TaskService::stats(&state.db).map_err(|e| e.to_string())
}

/// 稍后再提醒：把截止时间向后推 N 分钟并重置"已提醒"标记
#[tauri::command]
pub fn snooze_task_reminder(
    state: State<'_, AppState>,
    id: i64,
    minutes: i32,
) -> Result<bool, String> {
    TaskService::snooze(&state.db, id, minutes).map_err(|e| e.to_string())
}
