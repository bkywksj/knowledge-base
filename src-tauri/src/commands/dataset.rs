//! Excel 二维数据集的 IPC 入口（P1-3b）。
//!
//! 全部仅桌面端：依赖 `excel_parser`（calamine 在 Android target 编译失败）。
//! 移动端不注册这些 command。

#![cfg(desktop)]

use tauri::State;

use crate::models::{Dataset, DatasetSchema};
use crate::services::dataset::DatasetService;
use crate::state::AppState;

/// 把 Excel/CSV 附件解析入库为若干数据集，返回入库个数。
///
/// `rel` 是相对 data_dir 的附件路径（笔记 content 里 `kb-asset://` 后那段）。
/// 重复调用 = 整体替换该文件已有的数据集（源文件改一行都可能让结构全变）。
/// `force` 缺省为 false：文件哈希没变时直接跳过，避免白白重解析 + 重插几千行。
#[tauri::command]
pub fn import_attachment_datasets(
    state: State<'_, AppState>,
    rel: String,
    force: Option<bool>,
) -> Result<usize, String> {
    let abs = crate::services::asset_path::rel_to_abs(&rel, &state.data_dir)
        .map_err(|e| format!("路径解析失败: {}", e))?;
    if !abs.exists() {
        return Err(format!("附件不存在: {}", rel));
    }
    DatasetService::import_file(
        &state.db,
        &rel,
        &abs.to_string_lossy(),
        force.unwrap_or(false),
    )
    .map_err(|e| e.to_string())
}

/// 列出某个附件下已入库的数据集
#[tauri::command]
pub fn list_attachment_datasets(
    state: State<'_, AppState>,
    rel: String,
) -> Result<Vec<Dataset>, String> {
    state
        .db
        .list_datasets_by_source(&rel)
        .map_err(|e| e.to_string())
}

/// 取数据集详情（元信息 + 列画像）
#[tauri::command]
pub fn get_dataset_schema(
    state: State<'_, AppState>,
    dataset_id: i64,
) -> Result<DatasetSchema, String> {
    state
        .db
        .get_dataset_schema(dataset_id)
        .map_err(|e| e.to_string())
}

/// 分页预览数据行。
///
/// 返回的是每行的 `{"列名": "值"}` JSON 字符串数组，前端自行 parse ——
/// 不在 Rust 侧转二维数组，免得列顺序在两侧各维护一份。
#[tauri::command]
pub fn preview_dataset_rows(
    state: State<'_, AppState>,
    dataset_id: i64,
    offset: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<String>, String> {
    state
        .db
        .preview_dataset_rows(dataset_id, offset.unwrap_or(0), limit.unwrap_or(50))
        .map_err(|e| e.to_string())
}
