use std::collections::HashMap;

use crate::models::{Note, NoteTagBrief, PageResult, Tag};
use crate::services::tag::TagService;
use crate::state::AppState;

/// 创建标签（可选 parent_id：传 null/undefined 即创建顶层标签）
#[tauri::command]
pub fn create_tag(
    state: tauri::State<'_, AppState>,
    name: String,
    color: Option<String>,
    parent_id: Option<i64>,
) -> Result<Tag, String> {
    TagService::create(&state.db, &name, color.as_deref(), parent_id)
        .map_err(|e| e.to_string())
}

/// 设置标签的父级（None = 提升为顶层）
///
/// 拒绝自引用和循环依赖（具体校验在 DAO 层用 `WITH RECURSIVE` 做）。
#[tauri::command]
pub fn set_tag_parent(
    state: tauri::State<'_, AppState>,
    id: i64,
    parent_id: Option<i64>,
) -> Result<(), String> {
    TagService::set_parent(&state.db, id, parent_id).map_err(|e| e.to_string())
}

/// 批量重排同级标签：`ordered_ids` 是同一 parent（或全顶层）下的完整顺序列表。
/// 间隔 1000 留给未来插队（参考 notes / folders 的同款实现）。
#[tauri::command]
pub fn reorder_tags(
    state: tauri::State<'_, AppState>,
    ordered_ids: Vec<i64>,
) -> Result<(), String> {
    TagService::reorder(&state.db, &ordered_ids).map_err(|e| e.to_string())
}

/// 获取所有标签
#[tauri::command]
pub fn list_tags(state: tauri::State<'_, AppState>) -> Result<Vec<Tag>, String> {
    TagService::list(&state.db).map_err(|e| e.to_string())
}

/// 重命名标签
#[tauri::command]
pub fn rename_tag(state: tauri::State<'_, AppState>, id: i64, name: String) -> Result<(), String> {
    TagService::rename(&state.db, id, &name).map_err(|e| e.to_string())
}

/// 修改标签颜色（color 传 null 表示清除自定义颜色）
#[tauri::command]
pub fn set_tag_color(
    state: tauri::State<'_, AppState>,
    id: i64,
    color: Option<String>,
) -> Result<(), String> {
    TagService::set_color(&state.db, id, color.as_deref()).map_err(|e| e.to_string())
}

/// 删除标签
#[tauri::command]
pub fn delete_tag(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    TagService::delete(&state.db, id).map_err(|e| e.to_string())
}

/// 给笔记添加标签
#[tauri::command]
pub fn add_tag_to_note(
    state: tauri::State<'_, AppState>,
    note_id: i64,
    tag_id: i64,
) -> Result<(), String> {
    TagService::add_to_note(&state.db, note_id, tag_id).map_err(|e| e.to_string())
}

/// 移除笔记的标签
#[tauri::command]
pub fn remove_tag_from_note(
    state: tauri::State<'_, AppState>,
    note_id: i64,
    tag_id: i64,
) -> Result<(), String> {
    TagService::remove_from_note(&state.db, note_id, tag_id).map_err(|e| e.to_string())
}

/// 获取笔记的所有标签
#[tauri::command]
pub fn get_note_tags(state: tauri::State<'_, AppState>, note_id: i64) -> Result<Vec<Tag>, String> {
    TagService::get_note_tags(&state.db, note_id).map_err(|e| e.to_string())
}

/// 批量获取一组笔记各自的标签（笔记列表「标签」列用）
///
/// 返回 `{ 笔记id: [标签...] }`，没有标签的笔记不在表里（JSON 里整数键会变成字符串）。
#[tauri::command]
pub fn get_tags_for_notes(
    state: tauri::State<'_, AppState>,
    note_ids: Vec<i64>,
) -> Result<HashMap<i64, Vec<NoteTagBrief>>, String> {
    TagService::get_tags_for_notes(&state.db, &note_ids).map_err(|e| e.to_string())
}

/// 获取标签下的笔记列表（分页）
#[tauri::command]
pub fn list_notes_by_tag(
    state: tauri::State<'_, AppState>,
    tag_id: i64,
    page: Option<usize>,
    page_size: Option<usize>,
) -> Result<PageResult<Note>, String> {
    TagService::list_notes_by_tag(&state.db, tag_id, page, page_size).map_err(|e| e.to_string())
}
