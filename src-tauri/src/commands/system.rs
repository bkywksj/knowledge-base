use tauri::{Manager, State};

use crate::models::{DashboardStats, SystemInfo};
use crate::services::image::ImageService;
use crate::state::AppState;

/// 获取系统信息
#[tauri::command]
pub fn get_system_info(app: tauri::AppHandle) -> Result<SystemInfo, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "unknown".into());

    let images_dir = app
        .path()
        .app_data_dir()
        .map(|p| ImageService::images_dir(&p).to_string_lossy().into_owned())
        .unwrap_or_else(|_| "unknown".into());

    Ok(SystemInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        app_version: app.package_info().version.to_string(),
        data_dir,
        images_dir,
    })
}

/// 获取首页统计数据
#[tauri::command]
pub fn get_dashboard_stats(state: State<'_, AppState>) -> Result<DashboardStats, String> {
    state.db.get_dashboard_stats().map_err(|e| e.to_string())
}

/// 简单的 greet 命令（保留为示例）
#[tauri::command]
pub fn greet(name: &str) -> Result<String, String> {
    if name.is_empty() {
        return Err("名称不能为空".into());
    }
    Ok(format!("Hello, {}! 来自 Rust 的问候!", name))
}
