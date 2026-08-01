use crate::models::{DailyEntry, Note};
use crate::services::daily::DailyService;
use crate::services::daily_import::{
    DailyConvertOptions, DailyConvertPlan, DailyConvertResult, DailyImportService,
};
use crate::state::AppState;

/// 查询每日笔记（不创建）
#[tauri::command]
pub fn get_daily(state: tauri::State<'_, AppState>, date: String) -> Result<Option<Note>, String> {
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

/// 找当前日期相邻的"真实存在"的日记日期，返回 (prev, next)。
/// 用于 ← / → 跳转：跳过没写的日子，直接到上一篇/下一篇真实日记。
#[tauri::command]
pub fn get_daily_neighbors(
    state: tauri::State<'_, AppState>,
    date: String,
) -> Result<(Option<String>, Option<String>), String> {
    DailyService::get_neighbors(&state.db, &date).map_err(|e| e.to_string())
}

/// 列出全部日记（前端按年月分组渲染用）。
/// 一次拉回所有日记的轻量元数据，前端 group 后用 Collapse 折叠展示。
#[tauri::command]
pub fn list_all_dailies(state: tauri::State<'_, AppState>) -> Result<Vec<DailyEntry>, String> {
    DailyService::list_all(&state.db).map_err(|e| e.to_string())
}

/// 快速记一笔：追加带时间戳的 callout 块到今天的日记末尾。
/// 返回当天日记的 id（前端可决定是否跳转）。
#[tauri::command]
pub fn append_quick_capture(
    state: tauri::State<'_, AppState>,
    text: String,
) -> Result<i64, String> {
    DailyService::append_quick_capture(&state.db, &text).map_err(|e| e.to_string())
}

/// 扫描库里「文件夹名是日期」的普通笔记，生成历史日记转换计划。
///
/// **只读**，不改任何数据 —— 前端拿它渲染预览（识别到多少天、哪些要合并、
/// 哪些与已有日记冲突、哪些文件夹没认出来），用户确认后再调 `apply_daily_convert`。
#[tauri::command]
pub fn scan_daily_convert(
    state: tauri::State<'_, AppState>,
) -> Result<DailyConvertPlan, String> {
    DailyImportService::scan_library(&state.db).map_err(|e| e.to_string())
}

/// 执行历史日记转换。
///
/// ⚠️ 会改数据：单文件日期只改 is_daily/daily_date（无损）；合并模式会改主笔记正文、
/// 并把被合并的笔记移入**回收站**（可捞回）。前端必须先让用户看过 `scan_daily_convert`
/// 的预览再调这个。
#[tauri::command]
pub fn apply_daily_convert(
    state: tauri::State<'_, AppState>,
    plan: DailyConvertPlan,
    options: DailyConvertOptions,
) -> Result<DailyConvertResult, String> {
    DailyImportService::apply(&state.db, &plan, &options).map_err(|e| e.to_string())
}
