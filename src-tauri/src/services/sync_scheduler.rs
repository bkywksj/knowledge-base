//! 自动同步调度器
//!
//! 后台 tokio 任务，按 `sync.auto_interval_min` 周期性触发 WebDAV push。
//! 用户在设置中切换"启用自动同步"或修改间隔时，通过 `AppState.sync_scheduler_notify`
//! 唤醒调度器重新读配置（无需重启应用）。

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::models::SyncScope;
use crate::services::sync::SyncService;
use crate::state::AppState;

/// 调度器主循环
///
/// - enabled=false 时：阻塞等待 notify 被唤醒
/// - enabled=true 时：sleep(interval)，超时触发 push，或被 notify 打断重新读配置
pub async fn run_scheduler(app: AppHandle) {
    log::info!("[sync-scheduler] 启动");

    loop {
        let (enabled, interval_min) = read_schedule_config(&app);

        if !enabled {
            log::debug!("[sync-scheduler] 未启用，等待配置变更…");
            wait_reload(&app).await;
            continue;
        }

        let interval = Duration::from_secs(interval_min.max(5) * 60);
        log::info!(
            "[sync-scheduler] 已启用，间隔 {} 分钟，下次触发倒计时中",
            interval_min
        );

        let notify = {
            let state = app.state::<AppState>();
            state.sync_scheduler_notify.clone()
        };

        tokio::select! {
            _ = tokio::time::sleep(interval) => {
                // 到点触发一次自动 push
                push_once(&app, "scheduler").await;
            }
            _ = notify.notified() => {
                // 配置变更，重新读
                log::info!("[sync-scheduler] 收到重载信号");
                continue;
            }
        }
    }
}

/// 从 DB 读取调度配置
fn read_schedule_config(app: &AppHandle) -> (bool, u64) {
    let state = app.state::<AppState>();
    let db = &state.db;
    let enabled = db
        .get_config("sync.auto_enabled")
        .ok()
        .flatten()
        .map(|v| v == "true")
        .unwrap_or(false);
    let interval = db
        .get_config("sync.auto_interval_min")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(30);
    (enabled, interval)
}

/// 等待 notify 信号（用于未启用自动同步时阻塞）
async fn wait_reload(app: &AppHandle) {
    let notify = {
        let state = app.state::<AppState>();
        state.sync_scheduler_notify.clone()
    };
    notify.notified().await;
}

/// 执行一次 WebDAV push（复用给定时调度器 & 托盘手动触发）
///
/// 根据 `origin` 决定完成后 emit 的事件名：
/// - `"scheduler"` → `sync:auto-triggered`（设置页 SyncSection 监听）
/// - `"tray"`      → `sync:manual-push-result`（AppLayout 全局监听，弹 toast）
pub async fn push_once(app: &AppHandle, origin: &str) {
    let event_name = if origin == "tray" {
        "sync:manual-push-result"
    } else {
        "sync:auto-triggered"
    };

    let state = app.state::<AppState>();
    let db = &state.db;

    // 读 WebDAV 配置
    let url = db
        .get_config("sync.webdav_url")
        .ok()
        .flatten()
        .unwrap_or_default();
    let username = db
        .get_config("sync.webdav_username")
        .ok()
        .flatten()
        .unwrap_or_default();

    if url.is_empty() || username.is_empty() {
        let err = "WebDAV URL 或用户名未配置";
        log::warn!("[sync-scheduler/{}] {}, 跳过", origin, err);
        let _ = app.emit(
            event_name,
            serde_json::json!({ "success": false, "error": err }),
        );
        return;
    }

    let password = match SyncService::get_webdav_password(&state.db, &username) {
        Ok(Some(p)) => p,
        Ok(None) => {
            let err = "未保存 WebDAV 密码";
            log::warn!("[sync-scheduler/{}] {}, 跳过", origin, err);
            let _ = app.emit(
                event_name,
                serde_json::json!({ "success": false, "error": err }),
            );
            return;
        }
        Err(e) => {
            log::error!("[sync-scheduler/{}] 读取密码失败: {}", origin, e);
            let _ = app.emit(
                event_name,
                serde_json::json!({ "success": false, "error": e.to_string() }),
            );
            return;
        }
    };

    let scope = SyncScope::default();
    let version = app.package_info().version.to_string();

    let history_id = db.sync_history_begin("push").ok();

    let result = SyncService::webdav_push(
        &state.data_dir,
        db,
        &scope,
        &version,
        &url,
        &username,
        &password,
    )
    .await;

    match &result {
        Ok(r) => {
            log::info!(
                "[sync-scheduler/{}] 推送成功 (notes={}, assets_size={})",
                origin,
                r.stats.notes_count,
                r.stats.assets_size
            );
            let stats_json = serde_json::to_string(&r.stats).unwrap_or_else(|_| "{}".into());
            if let Some(id) = history_id {
                let _ = db.sync_history_finish(id, true, None, &stats_json);
            }
            let _ = app.emit(
                event_name,
                serde_json::json!({ "success": true, "stats": &r.stats }),
            );
        }
        Err(e) => {
            log::error!("[sync-scheduler/{}] 推送失败: {}", origin, e);
            if let Some(id) = history_id {
                let _ = db.sync_history_finish(id, false, Some(&e.to_string()), "{}");
            }
            let _ = app.emit(
                event_name,
                serde_json::json!({ "success": false, "error": e.to_string() }),
            );
        }
    }
}
