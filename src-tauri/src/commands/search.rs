use crate::models::{SearchFilters, SearchResult};
use crate::services::search::SearchService;
use crate::state::AppState;

/// 全文搜索笔记
///
/// `filters` 可选（P1-2）：不传 = 不筛选，与旧行为一致。
/// 前端只需传用户真正勾选的维度，其余字段省略即可。
#[tauri::command]
pub fn search_notes(
    state: tauri::State<'_, AppState>,
    query: String,
    limit: Option<usize>,
    filters: Option<SearchFilters>,
) -> Result<Vec<SearchResult>, String> {
    SearchService::search_filtered(&state.db, &query, limit, filters).map_err(|e| e.to_string())
}
