//! 待办提醒「自定义提示音」Command 入口（仅桌面端）。
//!
//! 业务逻辑全在 `services::reminder_sound`，这里只做 AppHandle → app_data_dir 的解析
//! 和错误转字符串。音频文件落在 framework_app_data_dir 下，
//! 前端用 `convertFileSrc(path)` 喂 `<audio>` 播放（assetProtocol scope 已覆盖该目录）。

use crate::services::reminder_sound::{CustomSound, ReminderSoundService};

/// 取 framework app_data_dir（dev 走 -dev 兄弟目录），失败转成人话错误
fn app_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    crate::framework_app_data_dir(app).map_err(|e| format!("无法获取 app_data_dir: {}", e))
}

/// 导入用户在原生对话框里选中的音频文件，复制进提示音目录
#[tauri::command]
pub fn import_reminder_sound(
    app: tauri::AppHandle,
    src_path: String,
) -> Result<CustomSound, String> {
    let dir = app_data_dir(&app)?;
    ReminderSoundService::import(&dir, &src_path).map_err(|e| e.to_string())
}

/// 列出已导入的自定义提示音（设置页下拉 + 管理列表）
#[tauri::command]
pub fn list_reminder_sounds(app: tauri::AppHandle) -> Result<Vec<CustomSound>, String> {
    let dir = app_data_dir(&app)?;
    ReminderSoundService::list(&dir).map_err(|e| e.to_string())
}

/// 把配置里存的文件名解析成绝对路径（前端播放前调一次，拿去 convertFileSrc）。
///
/// 文件被用户在资源管理器里删掉时返回 NotFound，前端据此回退到内置预设音，
/// 而不是静默不响 —— 提醒不响比提醒响错更糟。
#[tauri::command]
pub fn resolve_reminder_sound(app: tauri::AppHandle, file_name: String) -> Result<String, String> {
    let dir = app_data_dir(&app)?;
    ReminderSoundService::resolve(&dir, &file_name).map_err(|e| e.to_string())
}

/// 删除一个自定义提示音（幂等）
#[tauri::command]
pub fn delete_reminder_sound(app: tauri::AppHandle, file_name: String) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    ReminderSoundService::delete(&dir, &file_name).map_err(|e| e.to_string())
}
