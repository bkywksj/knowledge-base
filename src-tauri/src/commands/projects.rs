//! 项目相关 Command（v41 引入，配合甘特图视图）

use tauri::State;

use crate::models::{CreateProjectInput, Project, UpdateProjectInput};
use crate::services::project::ProjectService;
use crate::state::AppState;

/// 列出项目（含未完成/已完成任务计数）。
///
/// `includeArchived` 默认 false：归档项目从主列表移除，不打扰当前视野。
#[tauri::command(async)]
pub fn list_projects(
    state: State<'_, AppState>,
    include_archived: Option<bool>,
) -> Result<Vec<Project>, String> {
    ProjectService::list(&state.db, include_archived.unwrap_or(false))
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_project(
    state: State<'_, AppState>,
    id: i64,
) -> Result<Option<Project>, String> {
    ProjectService::get(&state.db, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_project(
    state: State<'_, AppState>,
    input: CreateProjectInput,
) -> Result<i64, String> {
    ProjectService::create(&state.db, input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_project(
    state: State<'_, AppState>,
    id: i64,
    input: UpdateProjectInput,
) -> Result<(), String> {
    ProjectService::update(&state.db, id, input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_project(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    ProjectService::delete(&state.db, id).map_err(|e| e.to_string())
}
