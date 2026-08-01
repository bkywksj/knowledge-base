use tauri::State;

use crate::models::{GraphData, NoteLink, NoteLinkSummary, WikiLinkSuggestItem};
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
pub fn get_backlinks(state: State<'_, AppState>, note_id: i64) -> Result<Vec<NoteLink>, String> {
    LinkService::get_backlinks(&state.db, note_id).map_err(|e| e.to_string())
}

/// 当前笔记的链接全貌：出链（我引用了谁）+ 入链（谁引用了我）+ 断链。
///
/// 编辑器底部状态条一次取齐三类，不为一条状态条打三次 IPC。
#[tauri::command]
pub fn get_note_link_summary(
    state: State<'_, AppState>,
    note_id: i64,
) -> Result<NoteLinkSummary, String> {
    LinkService::get_link_summary(&state.db, note_id).map_err(|e| e.to_string())
}

/// 从正文重新解析 `[[wiki]]` 并同步出链。
///
/// 日记页保存后调用 —— 日记此前从不同步出链，写进去的 [[X]] 不进 note_links。
/// 笔记编辑器仍走它自己那套（前端解析 + syncLinks），两边判定口径一致。
#[tauri::command]
pub fn rebuild_note_links(
    state: State<'_, AppState>,
    note_id: i64,
    content: String,
) -> Result<(), String> {
    LinkService::rebuild_links(&state.db, note_id, &content).map_err(|e| e.to_string())
}

/// 搜索笔记标题（用于 [[ 自动补全）
#[tauri::command]
pub fn search_link_targets(
    state: State<'_, AppState>,
    keyword: String,
    limit: Option<usize>,
) -> Result<Vec<WikiLinkSuggestItem>, String> {
    LinkService::search_link_targets(&state.db, &keyword, limit.unwrap_or(10))
        .map_err(|e| e.to_string())
}

/// 按"规范化精确匹配"查找笔记 ID（用于 wiki 链接保存时解析 `[[标题]]`）
#[tauri::command]
pub fn find_note_id_by_title_loose(
    state: State<'_, AppState>,
    title: String,
) -> Result<Option<i64>, String> {
    LinkService::find_note_id_by_title_loose(&state.db, &title).map_err(|e| e.to_string())
}

/// 获取知识图谱数据
#[tauri::command]
pub fn get_graph_data(state: State<'_, AppState>) -> Result<GraphData, String> {
    LinkService::get_graph_data(&state.db).map_err(|e| e.to_string())
}
