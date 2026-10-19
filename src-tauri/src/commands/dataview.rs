//! Dataview Commands（v0.1 最简）：5 个固定查询 IPC 入口。

use tauri::State;

use crate::models::DataviewRow;
use crate::services::dataview::DataviewService;
use crate::state::AppState;

#[tauri::command(async)]
pub fn dataview_recent_notes(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<DataviewRow>, String> {
    DataviewService::recent_notes(&state.db, limit).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn dataview_notes_by_tag(
    state: State<'_, AppState>,
    tag: String,
    limit: Option<i64>,
) -> Result<Vec<DataviewRow>, String> {
    DataviewService::notes_by_tag(&state.db, &tag, limit).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn dataview_notes_by_folder(
    state: State<'_, AppState>,
    folder_id: i64,
    limit: Option<i64>,
) -> Result<Vec<DataviewRow>, String> {
    DataviewService::notes_by_folder(&state.db, folder_id, limit).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn dataview_pending_tasks(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<DataviewRow>, String> {
    DataviewService::pending_tasks(&state.db, limit).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn dataview_tasks_by_project(
    state: State<'_, AppState>,
    project_id: i64,
    limit: Option<i64>,
) -> Result<Vec<DataviewRow>, String> {
    DataviewService::tasks_by_project(&state.db, project_id, limit).map_err(|e| e.to_string())
}
