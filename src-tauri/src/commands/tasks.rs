use tauri::State;

use crate::models::{
    CreateTaskCategoryInput, CreateTaskInput, Task, TaskCategory, TaskLinkInput, TaskQuery,
    TaskSearchHit, TaskStats, UpdateTaskCategoryInput, UpdateTaskInput,
};
use crate::services::tasks::TaskService;
use crate::state::AppState;

/// 任何会改变"提醒触发点"的写操作完成后必须调一次，让调度器重算下次唤醒时间
fn notify_reminder(state: &State<'_, AppState>) {
    state.reminder_notify.notify_one();
}

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
    let id = TaskService::create(&state.db, input).map_err(|e| e.to_string())?;
    notify_reminder(&state);
    Ok(id)
}

#[tauri::command]
pub fn update_task(
    state: State<'_, AppState>,
    id: i64,
    input: UpdateTaskInput,
) -> Result<bool, String> {
    let ok = TaskService::update(&state.db, id, input).map_err(|e| e.to_string())?;
    notify_reminder(&state);
    Ok(ok)
}

#[tauri::command]
pub fn toggle_task_status(state: State<'_, AppState>, id: i64) -> Result<i32, String> {
    let v = TaskService::toggle_status(&state.db, id).map_err(|e| e.to_string())?;
    notify_reminder(&state);
    Ok(v)
}

#[tauri::command]
pub fn delete_task(state: State<'_, AppState>, id: i64) -> Result<bool, String> {
    let ok = TaskService::delete(&state.db, id).map_err(|e| e.to_string())?;
    notify_reminder(&state);
    Ok(ok)
}

/// 批量删除任务（任务页多选模式用）。返回实际删除的条数。
#[tauri::command]
pub fn delete_tasks_batch(
    state: State<'_, AppState>,
    ids: Vec<i64>,
) -> Result<usize, String> {
    let n = state
        .db
        .delete_tasks_by_ids(&ids)
        .map_err(|e| e.to_string())?;
    notify_reminder(&state);
    Ok(n)
}

/// 批量标记任务为已完成（任务页多选模式用）。返回实际更新条数。
#[tauri::command]
pub fn complete_tasks_batch(
    state: State<'_, AppState>,
    ids: Vec<i64>,
) -> Result<usize, String> {
    let n = state
        .db
        .complete_tasks_by_ids(&ids)
        .map_err(|e| e.to_string())?;
    notify_reminder(&state);
    Ok(n)
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
    let ok = TaskService::snooze(&state.db, id, minutes).map_err(|e| e.to_string())?;
    notify_reminder(&state);
    Ok(ok)
}

/// 顶栏 Ctrl+K 全局搜索：按关键词查待办（title / description LIKE）
#[tauri::command]
pub fn search_tasks(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<TaskSearchHit>, String> {
    TaskService::search(&state.db, &query, limit).map_err(|e| e.to_string())
}

// ─── 分类 CRUD ────────────────────────────────

#[tauri::command]
pub fn list_task_categories(
    state: State<'_, AppState>,
) -> Result<Vec<TaskCategory>, String> {
    TaskService::list_categories(&state.db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_task_category(
    state: State<'_, AppState>,
    input: CreateTaskCategoryInput,
) -> Result<i64, String> {
    TaskService::create_category(&state.db, input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_task_category(
    state: State<'_, AppState>,
    id: i64,
    input: UpdateTaskCategoryInput,
) -> Result<bool, String> {
    TaskService::update_category(&state.db, id, input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_task_category(
    state: State<'_, AppState>,
    id: i64,
) -> Result<bool, String> {
    TaskService::delete_category(&state.db, id).map_err(|e| e.to_string())
}

/// 完成本次（循环任务）：推进到下一次；非循环任务等同于 toggle 到完成。
/// 达到 repeat_count / repeat_until 上限时自动结束整条循环。
#[tauri::command]
pub fn complete_task_occurrence(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    // 从 app_config 读取全天任务提醒基准时刻，兼容 "HH:MM" / "HH:MM:SS"
    let base = state
        .db
        .get_config("all_day_reminder_time")
        .ok()
        .flatten()
        .map(|s| if s.len() == 5 { format!("{}:00", s) } else { s })
        .unwrap_or_else(|| "09:00:00".to_string());
    TaskService::complete_occurrence(&state.db, id, &base).map_err(|e| e.to_string())?;
    notify_reminder(&state);
    Ok(())
}
