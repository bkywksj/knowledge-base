use tauri::State;

use crate::models::{GraphData, NoteLink};
use crate::services::links::LinkService;
use crate::state::AppState;

/// 同步笔记的出链
#[tauri::command]
pub fn sync_note_links(
    state: State<'_, AppState>,
    source_id: i64,
    target_ids: Vec<i64>,
) -> Result<(), String> {
    LinkService::sync_links(&state.db, source_id, target_ids).map_err(|e| e.to_string())
}

/// 获取反向链接
#[tauri::command]
pub fn get_backlinks(
    state: State<'_, AppState>,
    note_id: i64,
) -> Result<Vec<NoteLink>, String> {
    LinkService::get_backlinks(&state.db, note_id).map_err(|e| e.to_string())
}

/// 搜索笔记标题（用于 [[ 自动补全）
#[tauri::command]
pub fn search_link_targets(
    state: State<'_, AppState>,
    keyword: String,
    limit: Option<usize>,
) -> Result<Vec<(i64, String)>, String> {
    LinkService::search_link_targets(&state.db, &keyword, limit.unwrap_or(10))
        .map_err(|e| e.to_string())
}

/// 获取知识图谱数据
#[tauri::command]
pub fn get_graph_data(state: State<'_, AppState>) -> Result<GraphData, String> {
    LinkService::get_graph_data(&state.db).map_err(|e| e.to_string())
}
