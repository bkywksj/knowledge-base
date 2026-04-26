//! V1 多端同步自动调度器
//!
//! 与 V0 `sync_scheduler` 的差异：
//! - V0 是单条配置（app_config.sync.auto_*），周期推一份整库 ZIP
//! - V1 是多 backend，每条 backend 自己的 `auto_sync` + `sync_interval_min`，
//!   到期时跑「先 pull 再 push」双向同步（git workflow 习惯）
//!
//! 实现策略：
//! - 单 tokio task 每分钟 tick 一次
//! - 每次 tick 重新查表（不维护内存副本，backend 增/删/改最多延迟 60 秒生效；
//!   省掉 notify 信号 + reload Command 一整套设施）
//! - 串行处理到期 backend：单实例多 backend 通常 1-3 个，不并发也够快；
//!   并发反而可能触发 WebDAV 服务端的速率限制
//! - push/pull 内部是同步阻塞 IO（reqwest blocking），用 `spawn_blocking` 包起来
//!   避免阻塞 tokio worker 影响其他后台任务
//!
//! 与多实例的关系：仅默认实例启动 scheduler（lib.rs setup 里判 instance_id.is_none），
//! 避免多实例对同一远端做"同步竞速"互相覆盖。

use std::time::Duration;

use chrono::{Local, NaiveDateTime};
use tauri::{AppHandle, Emitter, Manager};

use crate::models::SyncBackend;
use crate::services::sync_v1;
use crate::state::AppState;

/// 主循环 tick 间隔。每 60 秒重新查一遍 backend 表。
/// 用户最小可设 5 分钟，60 秒精度对周期性同步足够。
const TICK_SECS: u64 = 60;

/// 启动 V1 自动同步调度器（在 Tauri setup 里 spawn）
pub async fn run_v1_scheduler(app: AppHandle) {
    log::info!("[sync-v1-scheduler] 启动");
    loop {
        tokio::time::sleep(Duration::from_secs(TICK_SECS)).await;
        if let Err(e) = tick_once(&app).await {
            log::warn!("[sync-v1-scheduler] tick 异常: {}", e);
        }
    }
}

/// 一次 tick：扫描所有到期的 backend 并执行双向同步
async fn tick_once(app: &AppHandle) -> Result<(), String> {
    let backends = {
        let state = app.state::<AppState>();
        state.db.list_sync_backends().map_err(|e| e.to_string())?
    };

    let now = Local::now().naive_local();
    for backend in backends {
        if !backend.enabled || !backend.auto_sync {
            continue;
        }
        if !is_due(&backend, &now) {
            continue;
        }
        log::info!(
            "[sync-v1-scheduler] backend #{} ({}) 到期，开始双向同步",
            backend.id, backend.name
        );
        run_backend_sync(app, backend.id).await;
    }
    Ok(())
}

/// 判断 backend 是否到达下一次同步时机
///
/// 规则：以 `last_push_ts` 为基准（push 是更新远端的关键动作；pull 之间间隔短没关系）。
/// 没有 last_push_ts → 立即视为到期（首次自动同步）。
/// last_push_ts 解析失败也视为到期（不阻塞用户）。
fn is_due(backend: &SyncBackend, now: &NaiveDateTime) -> bool {
    let interval_secs = backend.sync_interval_min.max(5) * 60;
    match backend.last_push_ts.as_deref() {
        None | Some("") => true,
        Some(ts) => match NaiveDateTime::parse_from_str(ts, "%Y-%m-%d %H:%M:%S") {
            Ok(parsed) => (now.and_utc().timestamp() - parsed.and_utc().timestamp())
                >= interval_secs,
            Err(_) => true,
        },
    }
}

/// 跑一次 backend 双向同步（先 pull 再 push，模仿 git pull && git push）
///
/// push/pull 是同步阻塞函数（webdav reqwest blocking），必须 spawn_blocking
/// 包起来避免阻塞 tokio worker。结果通过 `sync_v1:auto-triggered` 事件回报前端。
async fn run_backend_sync(app: &AppHandle, backend_id: i64) {
    // 先 pull
    let pull_app = app.clone();
    let pull_outcome: Result<String, String> = tauri::async_runtime::spawn_blocking(move || {
        run_pull_blocking(&pull_app, backend_id)
    })
    .await
    .unwrap_or_else(|e| Err(format!("pull task panic: {}", e)));

    if let Err(e) = &pull_outcome {
        log::warn!(
            "[sync-v1-scheduler] backend #{} pull 失败: {}（跳过 push，等下个周期）",
            backend_id, e
        );
        emit_result(app, backend_id, false, Some(format!("pull 失败: {}", e)));
        return;
    }

    // pull 成功才 push（否则可能把过期数据推给远端）
    let push_app = app.clone();
    let push_outcome: Result<String, String> = tauri::async_runtime::spawn_blocking(move || {
        run_push_blocking(&push_app, backend_id)
    })
    .await
    .unwrap_or_else(|e| Err(format!("push task panic: {}", e)));

    match push_outcome {
        Ok(summary) => {
            log::info!(
                "[sync-v1-scheduler] backend #{} 双向同步完成: {}",
                backend_id, summary
            );
            emit_result(app, backend_id, true, None);
        }
        Err(e) => {
            log::warn!("[sync-v1-scheduler] backend #{} push 失败: {}", backend_id, e);
            emit_result(app, backend_id, false, Some(format!("push 失败: {}", e)));
        }
    }
}

/// 同步阻塞 pull：在 spawn_blocking 上下文里运行，可安全调用 sync_v1::pull
fn run_pull_blocking(app: &AppHandle, backend_id: i64) -> Result<String, String> {
    let state = app.state::<AppState>();
    let cfg = state
        .db
        .get_sync_backend(backend_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("backend {} 不存在", backend_id))?;
    let auth =
        sync_v1::backend::parse_auth(cfg.kind, &cfg.config_json).map_err(|e| e.to_string())?;
    let backend_impl = sync_v1::backend::create_backend(auth).map_err(|e| e.to_string())?;

    let app_version = app.package_info().version.to_string();
    let device = hostname_short();
    let conflicts_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("sync_conflicts")
        .join(format!("backend_{}", backend_id));

    let r = sync_v1::pull::pull(
        &state.db,
        backend_id,
        backend_impl.as_ref(),
        &app_version,
        &device,
        &conflicts_dir,
        app, // AppHandle 自身实现 Emitter
    )
    .map_err(|e| e.to_string())?;
    Ok(format!(
        "下载 {} / 删本地 {} / 冲突 {}",
        r.downloaded, r.deleted_local, r.conflicts
    ))
}

/// 同步阻塞 push
fn run_push_blocking(app: &AppHandle, backend_id: i64) -> Result<String, String> {
    let state = app.state::<AppState>();
    let cfg = state
        .db
        .get_sync_backend(backend_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("backend {} 不存在", backend_id))?;
    let auth =
        sync_v1::backend::parse_auth(cfg.kind, &cfg.config_json).map_err(|e| e.to_string())?;
    let backend_impl = sync_v1::backend::create_backend(auth).map_err(|e| e.to_string())?;

    let app_version = app.package_info().version.to_string();
    let device = hostname_short();

    let r = sync_v1::push::push(
        &state.db,
        backend_id,
        backend_impl.as_ref(),
        &app_version,
        &device,
        app,
    )
    .map_err(|e| e.to_string())?;
    Ok(format!(
        "上传 {} / 跳过 {} / 错误 {}",
        r.uploaded,
        r.skipped,
        r.errors.len()
    ))
}

/// emit 同步结果给前端（设置页 SyncV1Section 监听，失败时弹 toast 提示）
fn emit_result(app: &AppHandle, backend_id: i64, ok: bool, error: Option<String>) {
    let payload = serde_json::json!({
        "backendId": backend_id,
        "ok": ok,
        "error": error,
    });
    let _ = app.emit("sync_v1:auto-triggered", payload);
}

/// 取本机 hostname 短名（与 commands/sync_v1.rs 同名工具一致）
fn hostname_short() -> String {
    hostname::get()
        .ok()
        .and_then(|s| s.into_string().ok())
        .unwrap_or_else(|| "unknown-host".into())
}
