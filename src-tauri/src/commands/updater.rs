//! 软件更新 Commands（仅桌面端）。逻辑见 services::updater_download，这里只做转发。
//! 进度和状态变化通过 `updater://state` 事件推给所有窗口，载荷与这些命令的返回值相同。

use tauri::AppHandle;

use crate::services::updater_download::{self, UpdaterSnapshot};

/// 检查更新。`auto_download` 为真时发现新版本立即在后台下载。
/// 正在下载 / 已暂停 / 已就绪时不重复检查，直接返回当前状态。
#[tauri::command]
pub async fn updater_check(app: AppHandle, auto_download: bool) -> Result<UpdaterSnapshot, String> {
    updater_download::check(&app, auto_download).await
}

/// 当前状态（窗口刚打开、组件重新挂载时用来对齐）。
#[tauri::command]
pub fn updater_state(app: AppHandle) -> UpdaterSnapshot {
    updater_download::snapshot(&app)
}

/// 开始下载；已暂停时从断点继续。
#[tauri::command]
pub async fn updater_start(app: AppHandle) -> Result<UpdaterSnapshot, String> {
    updater_download::start(&app).await
}

/// 暂停下载，保留已下载的部分。
#[tauri::command]
pub async fn updater_pause(app: AppHandle) -> UpdaterSnapshot {
    updater_download::pause(&app).await
}

/// 取消下载并删除已下载的部分。
#[tauri::command]
pub async fn updater_cancel(app: AppHandle) -> UpdaterSnapshot {
    updater_download::cancel(&app).await
}

/// 安装已下载并验签的更新包。Windows 上安装器会结束本进程；其它平台返回后由前端重启应用。
#[tauri::command]
pub async fn updater_install(app: AppHandle) -> Result<(), String> {
    updater_download::install(&app).await
}
