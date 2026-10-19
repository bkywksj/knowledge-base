use crate::models::{Note, NoteInput, NoteTemplate, NoteTemplateInput};
use crate::services::note::NoteService;
use crate::services::template::{self, TemplateService};
use crate::state::AppState;

/// 获取所有模板
#[tauri::command(async)]
pub fn list_templates(state: tauri::State<'_, AppState>) -> Result<Vec<NoteTemplate>, String> {
    TemplateService::list(&state.db).map_err(|e| e.to_string())
}

/// 获取单个模板
#[tauri::command(async)]
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

/// 仅渲染模板内容（不落库），供"每日笔记默认模板"等场景在 UI 侧把渲染后的
/// 文本灌入编辑器使用。
///
/// - title 传入时会替换 `{{title}}`；缺省时用模板名，保持与 create_note_from_template
///   同一份渲染规则
/// - for_date（YYYY-MM-DD）让 `{{date}}/{{weekday}}/...` 锁定到该日期，翻历史日记
///   套模板用；不传则用当下日期。解析失败静默回退到当下日期
#[tauri::command]
pub fn render_template_content(
    state: tauri::State<'_, AppState>,
    template_id: i64,
    title: Option<String>,
    for_date: Option<String>,
) -> Result<String, String> {
    let tpl = TemplateService::get(&state.db, template_id).map_err(|e| e.to_string())?;
    let final_title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| tpl.name.clone());
    let date = for_date.and_then(|s| chrono::NaiveDate::parse_from_str(&s, "%Y-%m-%d").ok());
    Ok(template::render_variables(&tpl.content, &final_title, date))
}

/// 按模板创建笔记：拉模板内容 → 渲染 `{{date}}` 等变量 → 落库。
/// title 不传则默认用模板名（保持与旧 GUI 行为一致）。
#[tauri::command]
pub fn create_note_from_template(
    state: tauri::State<'_, AppState>,
    template_id: i64,
    title: Option<String>,
    folder_id: Option<i64>,
) -> Result<Note, String> {
    let tpl = TemplateService::get(&state.db, template_id).map_err(|e| e.to_string())?;
    let final_title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| tpl.name.clone());
    let rendered = template::render_variables(&tpl.content, &final_title, None);
    let input = NoteInput {
        title: final_title,
        content: rendered,
        folder_id,
    };
    NoteService::create(&state.db, &input).map_err(|e| e.to_string())
}
