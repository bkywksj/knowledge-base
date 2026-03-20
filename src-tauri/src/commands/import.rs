use tauri::AppHandle;

use crate::models::{ImportResult, ScannedFile};
use crate::services;
use crate::state::AppState;

/// 扫描文件夹中的 Markdown 文件（不导入，仅返回文件列表）
#[tauri::command]
pub fn scan_markdown_folder(path: String) -> Result<Vec<ScannedFile>, String> {
    services::import::ImportService::scan_markdown_folder(&path).map_err(|e| e.to_string())
}

/// 按选定的文件路径列表导入 Markdown 文件
#[tauri::command]
pub fn import_selected_files(
    state: tauri::State<'_, AppState>,
    app: AppHandle,
    file_paths: Vec<String>,
    folder_id: Option<i64>,
) -> Result<ImportResult, String> {
    services::import::ImportService::import_selected_files(
        &state.db,
        &file_paths,
        folder_id,
        &app,
    )
    .map_err(|e| e.to_string())
}
