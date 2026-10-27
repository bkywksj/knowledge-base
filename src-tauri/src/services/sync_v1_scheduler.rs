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
//! 单实例：应用是单实例守护（第二个进程会退出），scheduler 在唯一实例里启动，
//! 不存在多个进程对同一远端做"同步竞速"互相覆盖的问题。

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use chrono::{Local, NaiveDateTime};
use tauri::{AppHandle, Emitter, Manager};

use crate::models::{SyncBackend, SyncPullResult, SyncPushResult};
use crate::services::sync_v1;
use crate::state::AppState;

/// 主循环 tick 间隔。每 60 秒重新查一遍 backend 表。
/// 用户最小可设 5 分钟，60 秒精度对周期性同步足够。
const TICK_SECS: u64 = 60;

/// 连续失败退避状态：backend_id → (连续失败次数, 最近一次失败时刻)。
///
/// 为什么需要：[`is_due`] 以 `last_push_ts` 为基准，而 pull 失败会跳过 push → `last_push_ts`
/// 永不更新 → 每个 tick 都判"到期" → 失败后每 60 秒重试一次、每次都弹失败 toast
/// （2026-10 Mac 用户实录：25 分钟连失败 25 次，看起来像 `sync_interval_min` 没生效）。
///
/// 策略：按 1、2、4、8… 分钟指数退避，上限为该 backend 自己的同步间隔（所以退避再久也不会比
/// 正常周期更稀）；成功一次即清零。
/// - 只放内存：重启应用后先立即试一次是合理的（用户多半刚修了网络 / 改了配置）。
/// - 只约束调度器的自动触发：手动「后台同步」不经过 [`tick_once`]，不受退避限制，
///   用户修好问题后点一下就能立刻验证；手动同步成功同样会清零退避。
static FAILURE_BACKOFF: OnceLock<Mutex<HashMap<i64, (u32, Instant)>>> = OnceLock::new();

/// tick 与退避到期时刻的对齐容差：tick 不是精确 60s，没有容差时"退避 1 分钟"
/// 常会因差几百毫秒被推迟到下下个 tick。
const BACKOFF_SLACK: Duration = Duration::from_secs(5);

fn backoff_map() -> MutexGuard<'static, HashMap<i64, (u32, Instant)>> {
    FAILURE_BACKOFF
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        // 锁中毒只可能来自别处 panic；这里只是一张计数表，继续用里面的数据无害
        .unwrap_or_else(|p| p.into_inner())
}

/// 第 `failures` 次连续失败后应等待的时长：TICK × 2^(n-1)，封顶为 backend 的同步间隔
fn backoff_delay(failures: u32, interval_min: i64) -> Duration {
    let cap_secs = (interval_min.max(5) as u64) * 60;
    let shift = failures.saturating_sub(1).min(16);
    Duration::from_secs(TICK_SECS.saturating_mul(1u64 << shift).min(cap_secs))
}

/// 仍在退避期内则返回剩余时长；不在退避（从没失败过 / 已过期）返回 None
fn backoff_remaining(backend_id: i64, interval_min: i64) -> Option<Duration> {
    let (failures, last_failed) = *backoff_map().get(&backend_id)?;
    let wait = backoff_delay(failures, interval_min).saturating_sub(BACKOFF_SLACK);
    wait.checked_sub(last_failed.elapsed()).filter(|d| !d.is_zero())
}

/// 记一次失败，返回当前连续失败次数
fn record_failure(backend_id: i64) -> u32 {
    let mut map = backoff_map();
    let entry = map.entry(backend_id).or_insert((0, Instant::now()));
    entry.0 = entry.0.saturating_add(1);
    entry.1 = Instant::now();
    entry.0
}

fn record_success(backend_id: i64) {
    backoff_map().remove(&backend_id);
}

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
        if let Some(left) = backoff_remaining(backend.id, backend.sync_interval_min) {
            log::debug!(
                "[sync-v1-scheduler] backend #{} 处于失败退避期，约 {} 秒后再试",
                backend.id,
                left.as_secs()
            );
            continue;
        }
        log::info!(
            "[sync-v1-scheduler] backend #{} ({}) 到期，开始双向同步",
            backend.id,
            backend.name
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
            Ok(parsed) => {
                (now.and_utc().timestamp() - parsed.and_utc().timestamp()) >= interval_secs
            }
            Err(_) => true,
        },
    }
}

/// 手动触发一次"后台同步"：立即返回，同步在 tokio task 里跑（先 pull 再 push），
/// 完成 / 失败都通过 `sync_v1:auto-triggered` 事件回报前端（SyncV1Section 已监听弹 toast）。
///
/// 给设置页"后台同步"按钮用 —— 点了不阻塞界面，可以继续干别的。
pub fn trigger_background_sync(app: &AppHandle, backend_id: i64) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        run_backend_sync(&app, backend_id).await;
    });
}

/// 跑一次 backend 双向同步（先 pull 再 push，模仿 git pull && git push）
///
/// push/pull 是同步阻塞函数（webdav reqwest blocking），必须 spawn_blocking
/// 包起来避免阻塞 tokio worker。结果通过 `sync_v1:auto-triggered` 事件回报前端。
async fn run_backend_sync(app: &AppHandle, backend_id: i64) {
    // 同步互斥：拿不到锁说明已有一次同步（手动 / 上一轮调度）在跑 → 本次直接跳过，等下个周期
    let _sync_guard = {
        let state = app.state::<AppState>();
        match state.sync_v1_gate.try_acquire(backend_id) {
            Some(g) => g,
            None => {
                log::info!(
                    "[sync-v1-scheduler] backend #{} 已在同步中，跳过本次（等下个周期）",
                    backend_id
                );
                return;
            }
        }
    };

    // 先 pull
    let pull_app = app.clone();
    let pull_outcome: Result<SyncPullResult, String> =
        tauri::async_runtime::spawn_blocking(move || run_pull_blocking(&pull_app, backend_id))
            .await
            .unwrap_or_else(|e| Err(format!("pull task panic: {}", e)));

    let encrypted_skipped = match &pull_outcome {
        Ok(r) => {
            log::info!(
                "[sync-v1-scheduler] backend #{} pull 完成: 下载 {} / 删本地 {} / 冲突 {}",
                backend_id,
                r.downloaded,
                r.deleted_local,
                r.conflicts
            );
            r.encrypted_skipped
        }
        Err(e) => {
            let failures = record_failure(backend_id);
            log::warn!(
                "[sync-v1-scheduler] backend #{} pull 失败（连续第 {} 次，自动重试将逐次拉长间隔）: {}（跳过 push）",
                backend_id,
                failures,
                e
            );
            emit_result(app, backend_id, false, Some(format!("pull 失败: {}", e)), 0);
            return;
        }
    };

    // pull 成功才 push（否则可能把过期数据推给远端）
    let push_app = app.clone();
    let push_outcome: Result<SyncPushResult, String> =
        tauri::async_runtime::spawn_blocking(move || run_push_blocking(&push_app, backend_id))
            .await
            .unwrap_or_else(|e| Err(format!("push task panic: {}", e)));

    match push_outcome {
        Ok(r) => {
            log::info!(
                "[sync-v1-scheduler] backend #{} 双向同步完成: 上传 {} / 跳过 {} / 错误 {}",
                backend_id,
                r.uploaded,
                r.skipped,
                r.errors.len()
            );
            record_success(backend_id);
            emit_result(app, backend_id, true, None, encrypted_skipped);
        }
        Err(e) => {
            let failures = record_failure(backend_id);
            log::warn!(
                "[sync-v1-scheduler] backend #{} push 失败（连续第 {} 次）: {}",
                backend_id,
                failures,
                e
            );
            emit_result(
                app,
                backend_id,
                false,
                Some(format!("push 失败: {}", e)),
                encrypted_skipped,
            );
        }
    }
}

/// 同步阻塞 pull：在 spawn_blocking 上下文里运行，可安全调用 sync_v1::pull
///
/// 返回完整的 [`SyncPullResult`] —— 调度器自己格式化摘要，
/// `commands::sync_v1::sync_v1_pull` 则把它整个透传给前端（两处共用同一份实现，
/// 避免前台 Command 再写一遍"取配置 → 建 backend → 调 pull"的流程而漏掉 spawn_blocking）。
///
/// **必须在 `spawn_blocking` 上下文里调用**：内部是同步阻塞 IO（网络 + SQLite），
/// 直接在 tokio worker / 主线程上跑会卡住整个 UI。
///
/// 结果会写进 `sync_backends.last_error`（失败记录、成功清空），手动与自动同步都经过这里，
/// 设置页卡片据此展示"上次同步失败"。
pub(crate) fn run_pull_blocking(
    app: &AppHandle,
    backend_id: i64,
) -> Result<SyncPullResult, String> {
    let result = pull_inner(app, backend_id);
    record_outcome(app, backend_id, "pull", result.as_ref().err());
    result
}

/// 同步阻塞 push（约束同 [`run_pull_blocking`]：只能在 `spawn_blocking` 上下文里调）
pub(crate) fn run_push_blocking(
    app: &AppHandle,
    backend_id: i64,
) -> Result<SyncPushResult, String> {
    let result = push_inner(app, backend_id);
    record_outcome(app, backend_id, "push", result.as_ref().err());
    result
}

/// 把本次 pull / push 的成败写进 backend 的 last_error。写失败只记日志：
/// 这是展示用的附加状态，不能反过来让一次成功的同步报错。
fn record_outcome(app: &AppHandle, backend_id: i64, op: &str, err: Option<&String>) {
    let state = app.state::<AppState>();
    let msg = err.map(|e| format!("{} 失败: {}", op, e));
    if let Err(e) = state.db.set_sync_backend_error(backend_id, msg.as_deref()) {
        log::warn!(
            "[sync-v1] backend #{} 记录同步结果失败: {}",
            backend_id,
            e
        );
    }
}

fn pull_inner(app: &AppHandle, backend_id: i64) -> Result<SyncPullResult, String> {
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
        &state.data_dir,
        app, // AppHandle 自身实现 Emitter
    )
    .map_err(|e| e.to_string())?;
    Ok(r)
}

fn push_inner(app: &AppHandle, backend_id: i64) -> Result<SyncPushResult, String> {
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
        &state.data_dir,
        app,
    )
    .map_err(|e| e.to_string())?;
    Ok(r)
}

/// emit 同步结果给前端（设置页 SyncV1Section 监听，失败时弹 toast 提示）
///
/// `encrypted_skipped` >0 时前端会弹"X 篇加密笔记未同步"提示（vault salt/密码不一致）。
fn emit_result(
    app: &AppHandle,
    backend_id: i64,
    ok: bool,
    error: Option<String>,
    encrypted_skipped: usize,
) {
    let payload = serde_json::json!({
        "backendId": backend_id,
        "ok": ok,
        "error": error,
        "encryptedSkipped": encrypted_skipped,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_from_one_tick() {
        assert_eq!(backoff_delay(1, 30), Duration::from_secs(60));
        assert_eq!(backoff_delay(2, 30), Duration::from_secs(120));
        assert_eq!(backoff_delay(3, 30), Duration::from_secs(240));
        assert_eq!(backoff_delay(4, 30), Duration::from_secs(480));
    }

    #[test]
    fn backoff_caps_at_backend_interval() {
        // 30 分钟间隔：第 6 次起 32 分钟 > 30，封顶 30 分钟
        assert_eq!(backoff_delay(6, 30), Duration::from_secs(30 * 60));
        assert_eq!(backoff_delay(u32::MAX, 30), Duration::from_secs(30 * 60));
        // 间隔被钳到最小 5 分钟（与 is_due 一致）
        assert_eq!(backoff_delay(10, 1), Duration::from_secs(5 * 60));
    }

    #[test]
    fn success_clears_backoff() {
        let id = -4242; // 测试专用 id，避免与其它测试共享全局表时串扰
        assert!(backoff_remaining(id, 30).is_none());
        assert_eq!(record_failure(id), 1);
        assert_eq!(record_failure(id), 2);
        // 刚失败 2 次 → 需等约 2 分钟，此刻必在退避期
        assert!(backoff_remaining(id, 30).is_some());
        record_success(id);
        assert!(backoff_remaining(id, 30).is_none());
    }
}
