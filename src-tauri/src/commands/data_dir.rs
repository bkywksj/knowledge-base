//! T-013 自定义数据目录 — Tauri Commands
//!
//! 暴露给前端：
//! - `get_data_dir_info` 读当前/默认/指针/来源（设置页 UI 显示用）
//! - `set_pending_data_dir` 写指针文件（重启生效）
//! - `clear_pending_data_dir` 清指针文件（恢复默认；重启生效）
//!
//! 所有 Command 都通过 `crate::framework_app_data_dir` 获取 framework 根目录，
//! 保证 dev 模式走 `-dev` 隔离目录、不污染 prod 的指针/迁移 marker。

use crate::services::data_dir::{DataDirResolver, MigrationMarker, ResolvedDataDir};
use crate::state::AppState;

#[tauri::command]
pub fn get_data_dir_info(app: tauri::AppHandle) -> Result<ResolvedDataDir, String> {
    let app_data_dir = crate::framework_app_data_dir(&app).map_err(|e| e.to_string())?;
    DataDirResolver::resolve(&app_data_dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_pending_data_dir(
    app: tauri::AppHandle,
    new_path: String,
) -> Result<(), String> {
    let app_data_dir = crate::framework_app_data_dir(&app).map_err(|e| e.to_string())?;
    DataDirResolver::set_pending(&app_data_dir, &new_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_pending_data_dir(app: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = crate::framework_app_data_dir(&app).map_err(|e| e.to_string())?;
    DataDirResolver::clear_pending(&app_data_dir).map_err(|e| e.to_string())
}

/// T-013 完整版：写指针 + 写迁移 marker，让重启时自动迁移
///
/// `from_dir` 是当前使用的数据目录（即 AppState.data_dir），由前端从 get_data_dir_info 得到。
/// **不在 from_dir 默认实例情况下使用 AppState.data_dir 作为 from**：因为多开实例的
/// data_dir 是 instance-N 子目录，迁移整库还是要从父目录复制。所以前端传 framework
/// 默认 app_data_dir 还是用户当前自定义路径作为 from——保持简单，由前端控制。
#[tauri::command]
pub fn set_pending_data_dir_with_migration(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    new_path: String,
) -> Result<(), String> {
    let app_data_dir = crate::framework_app_data_dir(&app).map_err(|e| e.to_string())?;
    // from = 当前实际数据根（多开实例情况下也是当前实例所在）
    let from_dir = state.data_dir.clone();
    DataDirResolver::set_pending_with_migration(&app_data_dir, &from_dir, &new_path)
        .map_err(|e| e.to_string())
}

/// 取消未执行的迁移（用户在重启前后悔了；删指针 + 删 marker）
#[tauri::command]
pub fn cancel_pending_migration(app: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = crate::framework_app_data_dir(&app).map_err(|e| e.to_string())?;
    DataDirResolver::cancel_migration(&app_data_dir).map_err(|e| e.to_string())
}

/// 读迁移 marker（splash 窗口启动时查初始状态用）
#[tauri::command]
pub fn get_migration_marker(
    app: tauri::AppHandle,
) -> Result<Option<MigrationMarker>, String> {
    let app_data_dir = crate::framework_app_data_dir(&app).map_err(|e| e.to_string())?;
    DataDirResolver::read_migration_marker(&app_data_dir).map_err(|e| e.to_string())
}
