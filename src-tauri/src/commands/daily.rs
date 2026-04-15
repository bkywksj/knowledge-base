use crate::models::Note;
use crate::services::daily::DailyService;
use crate::state::AppState;

/// 查询每日笔记（不创建）
#[tauri::command]
pub fn get_daily(
    state: tauri::State<'_, AppState>,
    date: String,
) -> Result<Option<Note>, String> {
    DailyService::get(&state.db, &date).map_err(|e| e.to_string())
}

/// 获取或创建每日笔记
#[tauri::command]
pub fn get_or_create_daily(
    state: tauri::State<'_, AppState>,
    date: String,
) -> Result<Note, String> {
    DailyService::get_or_create(&state.db, &date).map_err(|e| e.to_string())
}

/// 获取某月有日记的日期列表
#[tauri::command]
pub fn list_daily_dates(
    state: tauri::State<'_, AppState>,
    year: i32,
    month: i32,
) -> Result<Vec<String>, String> {
    DailyService::list_dates(&state.db, year, month).map_err(|e| e.to_string())
}
