use crate::models::SearchResult;
use crate::services::search::SearchService;
use crate::state::AppState;

/// 全文搜索笔记
#[tauri::command]
pub fn search_notes(
    state: tauri::State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SearchResult>, String> {
    SearchService::search(&state.db, &query, limit).map_err(|e| e.to_string())
}
