use tauri::AppHandle;

use crate::models::{ImportResult, OpenMarkdownResult, ScannedFile};
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

/// 打开单个 Markdown 文件：读取 → 创建新笔记 → 返回 note id
///
/// 用于"打开 md 文件"按钮和文件关联双击，前端拿到 id 后跳转到 /notes/:id
#[tauri::command]
pub fn open_markdown_file(
    state: tauri::State<'_, AppState>,
    file_path: String,
) -> Result<OpenMarkdownResult, String> {
    services::import::ImportService::import_single_markdown(&state.db, &file_path)
        .map_err(|e| e.to_string())
}

/// 取出首次启动时由命令行带入的 .md 文件路径（幂等，取一次就清空）
///
/// 前端 App 初始化完成后调用：若返回 Some，则自动打开这个 md 文件。
#[tauri::command]
pub fn take_pending_open_md_path(
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    let mut guard = state
        .pending_open_md_path
        .lock()
        .map_err(|e| e.to_string())?;
    Ok(guard.take())
}
