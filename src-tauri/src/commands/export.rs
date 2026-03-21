use tauri::AppHandle;

use crate::models::ExportResult;
use crate::services;
use crate::state::AppState;

/// 导出笔记为 Markdown 文件
///
/// - `output_dir`: 导出目标目录
/// - `folder_id`: 可选，仅导出指定文件夹；None 导出全部
#[tauri::command]
pub fn export_notes(
    state: tauri::State<'_, AppState>,
    app: AppHandle,
    output_dir: String,
    folder_id: Option<i64>,
) -> Result<ExportResult, String> {
    services::export::ExportService::export_notes(&state.db, &output_dir, folder_id, &app)
        .map_err(|e| e.to_string())
}
