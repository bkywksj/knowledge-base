//! Excel / ODS / CSV 导入为笔记的 IPC 入口。
//!
//! 仅桌面端：依赖 `excel_parser`（calamine 在 Android target 编译失败），移动端不注册。

#![cfg(desktop)]

use tauri::State;

use crate::services::excel_import::{ExcelImportResult, ExcelImportService};
use crate::state::AppState;

/// 批量导入 Excel / ODS / CSV 为笔记（一个文件一篇笔记）。
///
/// - 单个失败不影响其他，错误信息回填到 `error` 字段
/// - 每个工作表正文只放前若干行，被截断的工作表名在 `truncatedSheets` 里返回
/// - 每开始处理一个文件会发一条 `excel:import-progress`，前端右下角悬浮条据此显示 x/N
/// - async command 在 worker 线程执行，大文件解析不冻结 UI
#[tauri::command]
pub async fn import_excel_files(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    folder_id: Option<i64>,
) -> Result<Vec<ExcelImportResult>, String> {
    Ok(ExcelImportService::import_many(
        &state.data_dir,
        &state.db,
        &paths,
        folder_id,
        &app,
    ))
}
