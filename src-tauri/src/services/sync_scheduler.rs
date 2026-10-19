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

/// 上次整包推送成功时的笔记数（由 `SyncService::webdav_push` 成功后写入）
pub const LAST_PUSH_NOTES_KEY: &str = "sync.v0_last_push_notes";

/// 少于这么多篇时不做"减半"判断：小库删几篇就过半很正常，不该拦
const SHRINK_GUARD_MIN: usize = 10;

/// 无人值守推送前的保护：本机 0 篇，或比上次推送少了一半以上 → 拒绝。
///
/// 返回的错误文案直接展示给用户，要说明原因和出路（去设置页手动推）。
pub fn check_push_safety(local_notes: usize, last_pushed: Option<usize>) -> Result<(), String> {
    if local_notes == 0 {
        return Err(
            "本机没有任何笔记，为防止覆盖云端备份已跳过推送；确需推送请到「设置 → 同步」手动操作"
                .into(),
        );
    }
    if let Some(last) = last_pushed {
        if last >= SHRINK_GUARD_MIN && local_notes * 2 < last {
            return Err(format!(
                "本机笔记数（{}）比上次推送（{}）少了一半以上，为防止覆盖云端备份已跳过推送；\
                 确认无误请到「设置 → 同步」手动推送",
                local_notes, last
            ));
        }
    }
    Ok(())
}

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

    // 无人值守的推送会**覆盖**云端 kb-sync-<host>.zip —— 那往往是用户唯一的整包备份。
    // 本机库刚被清空 / 误删大半时（换电脑没恢复、数据库损坏后重建）一键推上去，
    // 云端好备份就没了。所以先比一下笔记数，明显异常就拒绝，让用户去设置页手动推。
    let local_notes = db.count_notes_active().unwrap_or(0);
    let last_pushed = db
        .get_config(LAST_PUSH_NOTES_KEY)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<usize>().ok());
    if let Err(err) = check_push_safety(local_notes, last_pushed) {
        log::warn!("[sync-scheduler/{}] {}，已拒绝推送", origin, err);
        let _ = app.emit(
            event_name,
            serde_json::json!({ "success": false, "error": err }),
        );
        return;
    }

    // 用户在设置页开了加密备份就会存下备份密码：这里必须照用。
    // 之前固定传 None，托盘「立即同步」会把明文 ZIP 传上云端，违背用户开加密的本意。
    // 读不出（没开 / 换了设备解不开）才退回明文，与设置页 backupPwArg() 的口径一致。
    let backup_password = SyncService::get_backup_password(db).ok().flatten();

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
        backup_password.as_deref(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_safety_rejects_empty_library() {
        assert!(check_push_safety(0, None).is_err());
        assert!(check_push_safety(0, Some(0)).is_err());
    }

    #[test]
    fn push_safety_rejects_shrink_by_more_than_half() {
        assert!(check_push_safety(49, Some(100)).is_err());
        // 正好一半放行（删一半是可能的正常整理，再少才可疑）
        assert!(check_push_safety(50, Some(100)).is_ok());
        assert!(check_push_safety(120, Some(100)).is_ok());
    }

    #[test]
    fn push_safety_ignores_small_libraries_and_first_push() {
        // 小库：9 → 1 不拦
        assert!(check_push_safety(1, Some(9)).is_ok());
        // 从没推过：只要不是 0 就放行
        assert!(check_push_safety(3, None).is_ok());
    }
}
