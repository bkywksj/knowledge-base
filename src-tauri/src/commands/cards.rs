//! 闪卡 Command 层（IPC 入口）
//!
//! 8 个 Command，对应前端 cardApi 的 8 个方法。错误统一转 String 给前端。

use crate::models::{Card, CardReviewLog, CardStats, CreateCardInput, ReviewCardInput};
use crate::services::cards::CardService;
use crate::state::AppState;

#[tauri::command]
pub fn create_card(
    state: tauri::State<'_, AppState>,
    input: CreateCardInput,
) -> Result<Card, String> {
    CardService::create(&state.db, input).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn list_cards(
    state: tauri::State<'_, AppState>,
    deck: Option<String>,
) -> Result<Vec<Card>, String> {
    CardService::list(&state.db, deck).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_card(
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<Option<Card>, String> {
    CardService::get(&state.db, id).map_err(|e| e.to_string())
}

/// 取今天到期 / 已过期 / 新卡 的待复习队列
#[tauri::command(async)]
pub fn list_due_cards(
    state: tauri::State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<Card>, String> {
    CardService::list_due(&state.db, limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_card_content(
    state: tauri::State<'_, AppState>,
    id: i64,
    front: String,
    back: String,
) -> Result<(), String> {
    CardService::update_content(&state.db, id, front, back).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_card(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    CardService::delete(&state.db, id).map_err(|e| e.to_string())
}

/// 提交一次复习：前端用 ts-fsrs 算好新调度状态后调这个
#[tauri::command]
pub fn review_card(
    state: tauri::State<'_, AppState>,
    input: ReviewCardInput,
) -> Result<(), String> {
    CardService::review(&state.db, input).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_card_stats(state: tauri::State<'_, AppState>) -> Result<CardStats, String> {
    CardService::stats(&state.db).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn list_card_review_logs(
    state: tauri::State<'_, AppState>,
    card_id: i64,
    limit: Option<i64>,
) -> Result<Vec<CardReviewLog>, String> {
    CardService::list_logs(&state.db, card_id, limit).map_err(|e| e.to_string())
}
