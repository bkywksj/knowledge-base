use crate::models::ShortcutBinding;
use crate::services::shortcut::ShortcutService;
use crate::state::AppState;

/// 列出所有全局快捷键的当前绑定（默认值 vs 用户自定义）
#[tauri::command]
pub fn list_shortcut_bindings(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ShortcutBinding>, String> {
    ShortcutService::list_bindings(&state.db).map_err(|e| e.to_string())
}

/// 改键。失败原因可能是：accel 格式不合法 / 与其他热键冲突 / 系统已被占用
#[tauri::command]
pub fn set_shortcut_binding(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    accel: String,
) -> Result<(), String> {
    ShortcutService::set_accel(&app, &state.db, &id, &accel).map_err(|e| e.to_string())
}

/// 重置某条快捷键到默认值
#[tauri::command]
pub fn reset_shortcut_binding(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    ShortcutService::reset_accel(&app, &state.db, &id).map_err(|e| e.to_string())
}

/// 禁用某条快捷键（写入空 accel，不再注册任何键位）
#[tauri::command]
pub fn disable_shortcut_binding(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    ShortcutService::disable_accel(&app, &state.db, &id).map_err(|e| e.to_string())
}
