use tauri::AppHandle;

use crate::models::ImportResult;
use crate::services;
use crate::state::AppState;

/// 从文件夹导入 Markdown 文件为笔记
#[tauri::command]
pub fn import_markdown_folder(
    state: tauri::State<'_, AppState>,
    app: AppHandle,
    path: String,
    folder_id: Option<i64>,
) -> Result<ImportResult, String> {
    services::import::ImportService::import_markdown_folder(&state.db, &path, folder_id, &app)
        .map_err(|e| e.to_string())
}
