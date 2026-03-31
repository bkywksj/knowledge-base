use crate::models::{NoteTemplate, NoteTemplateInput};
use crate::services::template::TemplateService;
use crate::state::AppState;

/// 获取所有模板
#[tauri::command]
pub fn list_templates(state: tauri::State<'_, AppState>) -> Result<Vec<NoteTemplate>, String> {
    TemplateService::list(&state.db).map_err(|e| e.to_string())
}

/// 获取单个模板
#[tauri::command]
pub fn get_template(state: tauri::State<'_, AppState>, id: i64) -> Result<NoteTemplate, String> {
    TemplateService::get(&state.db, id).map_err(|e| e.to_string())
}

/// 创建模板
#[tauri::command]
pub fn create_template(
    state: tauri::State<'_, AppState>,
    input: NoteTemplateInput,
) -> Result<NoteTemplate, String> {
    TemplateService::create(&state.db, &input).map_err(|e| e.to_string())
}

/// 更新模板
#[tauri::command]
pub fn update_template(
    state: tauri::State<'_, AppState>,
    id: i64,
    input: NoteTemplateInput,
) -> Result<NoteTemplate, String> {
    TemplateService::update(&state.db, id, &input).map_err(|e| e.to_string())
}

/// 删除模板
#[tauri::command]
pub fn delete_template(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    TemplateService::delete(&state.db, id).map_err(|e| e.to_string())
}
