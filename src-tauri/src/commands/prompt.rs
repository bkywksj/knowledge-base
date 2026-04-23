//! AI 提示词模板 Commands
//!
//! 薄 IPC 包装：校验参数 → 调 DAO → 把 AppError 转成 String。
//! 业务层无特殊编排（变量渲染发生在 `services::ai::AiService::write_assist` 里），
//! 这里只做 CRUD。

use tauri::State;

use crate::models::{PromptTemplate, PromptTemplateInput};
use crate::state::AppState;

/// 列出所有提示词
///
/// `onlyEnabled`（前端传 `only_enabled`，serde 自动转驼峰）：
/// - true：编辑器菜单只需要启用项
/// - false：管理页需要看到禁用项以便重新启用
#[tauri::command]
pub fn list_prompts(
    state: State<'_, AppState>,
    only_enabled: Option<bool>,
) -> Result<Vec<PromptTemplate>, String> {
    state
        .db
        .list_prompts(only_enabled.unwrap_or(false))
        .map_err(|e| e.to_string())
}

/// 获取单条提示词
#[tauri::command]
pub fn get_prompt(state: State<'_, AppState>, id: i64) -> Result<PromptTemplate, String> {
    state.db.get_prompt(id).map_err(|e| e.to_string())
}

/// 新建提示词（用户自定义）
#[tauri::command]
pub fn create_prompt(
    state: State<'_, AppState>,
    input: PromptTemplateInput,
) -> Result<PromptTemplate, String> {
    state.db.create_prompt(&input).map_err(|e| e.to_string())
}

/// 更新提示词
///
/// 内置模板可以改文案/排序/启用状态，但 `is_builtin` / `builtin_code` 由 DAO 保护不改。
#[tauri::command]
pub fn update_prompt(
    state: State<'_, AppState>,
    id: i64,
    input: PromptTemplateInput,
) -> Result<PromptTemplate, String> {
    state
        .db
        .update_prompt(id, &input)
        .map_err(|e| e.to_string())
}

/// 删除提示词
///
/// 返回 true 表示真的删到了一行；前端据此决定是否刷新列表 / 提示 "不存在"。
#[tauri::command]
pub fn delete_prompt(state: State<'_, AppState>, id: i64) -> Result<bool, String> {
    state.db.delete_prompt(id).map_err(|e| e.to_string())
}

/// 单独切换启用状态（管理页开关）
#[tauri::command]
pub fn set_prompt_enabled(
    state: State<'_, AppState>,
    id: i64,
    enabled: bool,
) -> Result<(), String> {
    state
        .db
        .set_prompt_enabled(id, enabled)
        .map_err(|e| e.to_string())
}
