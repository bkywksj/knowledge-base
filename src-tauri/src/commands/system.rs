use tauri::{Manager, State};

use crate::models::{DailyWritingStat, DashboardStats, SystemInfo};
use crate::services::image::ImageService;
use crate::state::AppState;

/// 获取系统信息
///
/// data_dir / images_dir 都从 state 取，保证多开实例下返回的是当前实例自己的目录
/// （而不是被所有实例共享的 app_data_dir 根）。
#[tauri::command]
pub fn get_system_info(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<SystemInfo, String> {
    let data_dir = state.data_dir.to_string_lossy().into_owned();
    let images_dir = ImageService::images_dir(&state.data_dir)
        .to_string_lossy()
        .into_owned();

    Ok(SystemInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        app_version: app.package_info().version.to_string(),
        data_dir,
        images_dir,
        instance_id: state.instance_id,
        is_dev: cfg!(debug_assertions),
    })
}

/// 获取首页统计数据
#[tauri::command]
pub fn get_dashboard_stats(state: State<'_, AppState>) -> Result<DashboardStats, String> {
    state.db.get_dashboard_stats().map_err(|e| e.to_string())
}

/// 获取写作趋势（最近 N 天）
#[tauri::command]
pub fn get_writing_trend(
    state: State<'_, AppState>,
    days: Option<i32>,
) -> Result<Vec<DailyWritingStat>, String> {
    state.db.get_writing_trend(days.unwrap_or(30)).map_err(|e| e.to_string())
}

/// 简单的 greet 命令（保留为示例）
#[tauri::command]
pub fn greet(name: &str) -> Result<String, String> {
    if name.is_empty() {
        return Err("名称不能为空".into());
    }
    Ok(format!("Hello, {}! 来自 Rust 的问候!", name))
}

/// 查询是否允许多开实例。
/// flag 文件位于 framework_app_data_dir 根（与单实例锁同目录），
/// 在 Tauri Builder 启动前由 lib.rs 读取以决定是否拒绝第二个进程。
#[tauri::command]
pub fn get_multi_instance_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(crate::is_multi_instance_enabled(&dir))
}

/// 切换"允许多开实例"开关。下次启动生效（当前进程的实例锁不会变）。
#[tauri::command]
pub fn set_multi_instance_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::set_multi_instance_enabled(&dir, enabled).map_err(|e| e.to_string())
}
