use crate::models::{Note, PageResult, RestoreBatchResult};
use crate::services::trash::TrashService;
use crate::state::AppState;

/// 软删除笔记（移入回收站）
#[tauri::command(async)]
pub fn soft_delete_note(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    TrashService::soft_delete(&state.db, id).map_err(|e| e.to_string())
}

/// 恢复笔记（从回收站恢复）
///
/// 返回 true = 回到原文件夹；false = 原文件夹已不存在，落到根目录
#[tauri::command(async)]
pub fn restore_note(state: tauri::State<'_, AppState>, id: i64) -> Result<bool, String> {
    TrashService::restore(&state.db, id).map_err(|e| e.to_string())
}

/// 永久删除笔记（连带清理图片 + 源文件）
#[tauri::command(async)]
pub fn permanent_delete_note(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    TrashService::permanent_delete(&state.db, &state.data_dir, id).map_err(|e| e.to_string())
}

/// 查询回收站笔记列表（分页）
#[tauri::command(async)]
pub fn list_trash(
    state: tauri::State<'_, AppState>,
    page: Option<usize>,
    page_size: Option<usize>,
) -> Result<PageResult<Note>, String> {
    TrashService::list(&state.db, page, page_size).map_err(|e| e.to_string())
}

/// 清空回收站（连带清理所有图片 + 源文件）
#[tauri::command(async)]
pub fn empty_trash(state: tauri::State<'_, AppState>) -> Result<usize, String> {
    TrashService::empty(&state.db, &state.data_dir).map_err(|e| e.to_string())
}

/// 批量恢复笔记
///
/// 返回 RestoreBatchResult{restored, to_root}：实际恢复条数 + 其中落到根目录的条数
#[tauri::command(async)]
pub fn restore_notes_batch(
    state: tauri::State<'_, AppState>,
    ids: Vec<i64>,
) -> Result<RestoreBatchResult, String> {
    TrashService::restore_batch(&state.db, &ids).map_err(|e| e.to_string())
}

/// 批量永久删除笔记；返回实际删除条数
#[tauri::command(async)]
pub fn permanent_delete_notes_batch(
    state: tauri::State<'_, AppState>,
    ids: Vec<i64>,
) -> Result<usize, String> {
    TrashService::permanent_delete_batch(&state.db, &state.data_dir, &ids)
        .map_err(|e| e.to_string())
}
