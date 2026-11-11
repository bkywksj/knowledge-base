//! 软件更新：检查、后台下载更新包、验签、安装。状态只在 Rust 这一份，前端只负责显示。
//!
//! 为什么不用插件在前端的 `download()`：
//! - 状态在前端时，两次检查并发返回会各开一路下载，进度互相覆盖（进度条来回跳），
//!   哪路先下完就标「已就绪」，装的却可能是另一路没下完的实例；
//! - 插件下载不支持续传、换源，下到一半断网只能从头来；字节只在内存里，重启就没了。
//!
//! 这里的做法：
//! - 检查、开始、暂停、取消、安装都排队执行（[`UpdaterState::op`]），同一时刻最多一路下载；
//! - 每次开始下载给任务发一个代号（epoch），旧任务的进度一律不认；
//! - 下载写到 `<app_cache_dir>/updates/<文件名>.part`，断了用 Range 续传；同一源重试几次不行就换源；
//! - 下完立刻验签，通过后改成正式文件名并写 `meta.json`，下次启动检查到同一版本直接是「已就绪」；
//! - 🔴 插件的 `install()` **不验签**（验签只在它自带的 download() 里），所以安装前这里会再验一次。

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::io::AsyncWriteExt;

use crate::services::http_client;

/// 状态变化时广播给所有窗口的事件，载荷是完整的 [`UpdaterSnapshot`]。
pub const STATE_EVENT: &str = "updater://state";

const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 连续这么久没收到数据就算卡住，断开重连（续传接着下）。
const STALL_TIMEOUT: Duration = Duration::from_secs(30);
/// 同一个源连续失败（期间一个字节都没下到）这么多次就换下一个源。
const RETRIES_PER_SOURCE: u32 = 3;
const RETRY_DELAY: Duration = Duration::from_secs(2);
/// 进度事件最多每 250ms 发一次，避免每个数据块都触发前端重渲染。
const EMIT_INTERVAL: Duration = Duration::from_millis(250);
/// 等数据时每隔这么久看一眼有没有被暂停 / 取消，保证按钮按下后半秒内停住。
const POLL_INTERVAL: Duration = Duration::from_millis(500);
/// 速度按最近 3 秒的平均算，数字不会每次刷新都乱跳。
const SPEED_WINDOW: Duration = Duration::from_secs(3);

/// 发布产物在各源上的目录：`<base>/v<版本>/<文件名>`，和 CI 推送 release 时的布局一致。
/// Gitee raw 对匿名下载大文件返回 403，不作为下载源。
const MIRROR_BASES: [(&str, &str); 2] = [
    ("R2", "https://pub-9d9e6c0cb6934fb0a0c505e3c64f39b2.r2.dev/knowledge-base"),
    ("GitHub", "https://github.com/bkywksj/knowledge-base-release/raw/main/releases"),
];

const META_FILE: &str = "meta.json";

const CTRL_RUN: u8 = 0;
const CTRL_PAUSE: u8 = 1;
const CTRL_CANCEL: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// 没有可用更新（或还没检查）
    #[default]
    Idle,
    Checking,
    /// 发现新版本，还没开始下载（关了自动更新、或取消了下载）
    Available,
    Downloading,
    Paused,
    /// 下完了，正在校验签名
    Verifying,
    /// 更新包已下载并验签，点重启即可安装
    Ready,
    Installing,
    /// 所有源都下载失败，或签名校验失败
    Error,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceFailure {
    pub source: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterSnapshot {
    pub phase: Phase,
    /// 新版本号；没有可用更新时为空
    pub version: Option<String>,
    /// 更新说明
    pub body: Option<String>,
    /// 已下载字节数（含续传前已有的部分）
    pub downloaded: u64,
    /// 总字节数，服务器没给长度时为 0
    pub total: u64,
    /// 下载速度，字节 / 秒
    pub speed: u64,
    /// 当前下载源的名字（R2 / GitHub …）
    pub source: Option<String>,
    /// 自动换源这类不影响状态的提示
    pub notice: Option<String>,
    pub error: Option<String>,
    /// 每个下载源的失败原因，全部失败时给用户看
    pub failures: Vec<SourceFailure>,
    /// 已就绪的包是本次启动从磁盘恢复的（上次就下好了），前端据此执行「下次启动时安装」
    pub restored: bool,
}

#[derive(Serialize, Deserialize)]
struct PackageMeta {
    version: String,
    signature: String,
    file: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Source {
    pub name: String,
    pub url: String,
}

/// 由 `.manage()` 注册的全局状态。
#[derive(Default)]
pub struct UpdaterState {
    inner: Mutex<Inner>,
    /// 检查 / 开始 / 暂停 / 取消 / 安装逐个执行，杜绝两次检查并发各开一路下载
    op: tokio::sync::Mutex<()>,
    /// 下载任务读写 .part 期间持有：暂停后马上继续时，新任务要等旧任务真正松手
    file: tokio::sync::Mutex<()>,
}

#[derive(Default)]
struct Inner {
    snap: UpdaterSnapshot,
    update: Option<Arc<Update>>,
    /// 已验签的正式文件
    package: Option<PathBuf>,
    /// 当前下载任务的代号，旧任务发现对不上就不再写状态
    epoch: u64,
    /// 当前下载任务的暂停 / 取消开关
    ctrl: Arc<AtomicU8>,
}

enum DlError {
    /// 被暂停或取消
    Stopped,
    /// 可以在同一个源上重试；progressed = 这次下到了数据（重试计数清零）
    Retry { reason: String, progressed: bool },
    /// 这个源不行（404 / 403），换下一个
    SourceDead(String),
    /// 换源也没用（写盘失败），直接报错
    Abort(String),
}

// ─── 状态读写 ─────────────────────────────────────────────

fn lock(st: &UpdaterState) -> MutexGuard<'_, Inner> {
    // 持锁时只碰数据、不会 panic，中毒了也照用里面的数据
    st.inner.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn snapshot(app: &AppHandle) -> UpdaterSnapshot {
    lock(&app.state::<UpdaterState>()).snap.clone()
}

/// 改状态并广播。`epoch` 给了的话只在它仍是当前任务时才改（旧任务的进度丢掉）。
fn update_snap(app: &AppHandle, epoch: Option<u64>, f: impl FnOnce(&mut Inner)) -> bool {
    let snap = {
        let st = app.state::<UpdaterState>();
        let mut g = lock(&st);
        if epoch.is_some_and(|e| e != g.epoch) {
            return false;
        }
        f(&mut g);
        g.snap.clone()
    };
    let _ = app.emit(STATE_EVENT, snap);
    true
}

fn is_busy(phase: Phase) -> bool {
    matches!(phase, Phase::Downloading | Phase::Paused | Phase::Verifying | Phase::Ready | Phase::Installing)
}

// ─── 对外操作 ─────────────────────────────────────────────

/// 检查更新。正在下载 / 已暂停 / 已就绪时不重复检查，直接返回当前状态。
/// 发现新版本时：上次已经下好并验签的直接进入「已就绪」；否则 `auto_download` 为真就开始下载。
pub async fn check(app: &AppHandle, auto_download: bool) -> Result<UpdaterSnapshot, String> {
    let should_start = {
        let st = app.state::<UpdaterState>();
        let _op = st.op.lock().await;
        let before = lock(&st).snap.clone();
        if is_busy(before.phase) {
            return Ok(before);
        }
        update_snap(app, None, |g| g.snap.phase = Phase::Checking);

        let found = match check_remote(app).await {
            Ok(found) => found,
            Err(e) => {
                update_snap(app, None, |g| g.snap.phase = before.phase);
                return Err(e);
            }
        };
        let Some(update) = found else {
            update_snap(app, None, |g| {
                g.snap = UpdaterSnapshot::default();
                g.update = None;
                g.package = None;
            });
            return Ok(snapshot(app));
        };

        let update = Arc::new(update);
        let same_version = before.version.as_deref() == Some(update.version.as_str());
        update_snap(app, None, |g| {
            if !same_version {
                g.snap = UpdaterSnapshot::default();
            }
            g.snap.version = Some(update.version.clone());
            g.snap.body = update.body.clone();
            g.snap.phase = if before.phase == Phase::Error && same_version { Phase::Error } else { Phase::Available };
            g.update = Some(update.clone());
        });

        if let Some(path) = restore_package(app, &update).await {
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            update_snap(app, None, |g| {
                g.snap.phase = Phase::Ready;
                g.snap.downloaded = size;
                g.snap.total = size;
                g.snap.error = None;
                g.snap.restored = true;
                g.package = Some(path);
            });
            return Ok(snapshot(app));
        }
        auto_download
    };
    if should_start {
        return start(app).await;
    }
    Ok(snapshot(app))
}

/// 开始 / 继续下载（已暂停的从断点接着下）。
pub async fn start(app: &AppHandle) -> Result<UpdaterSnapshot, String> {
    let st = app.state::<UpdaterState>();
    let _op = st.op.lock().await;
    let (update, epoch, ctrl) = {
        let mut g = lock(&st);
        if matches!(g.snap.phase, Phase::Downloading | Phase::Verifying | Phase::Ready | Phase::Installing) {
            return Ok(g.snap.clone());
        }
        let update = g.update.clone().ok_or("还没有检查到新版本")?;
        g.epoch += 1;
        g.ctrl = Arc::new(AtomicU8::new(CTRL_RUN));
        (update, g.epoch, g.ctrl.clone())
    };
    update_snap(app, Some(epoch), |g| {
        g.snap.phase = Phase::Downloading;
        g.snap.speed = 0;
        g.snap.error = None;
        g.snap.notice = None;
        g.snap.failures.clear();
        g.snap.restored = false;
    });
    let task_app = app.clone();
    tauri::async_runtime::spawn(async move { run_download(task_app, update, epoch, ctrl).await });
    Ok(snapshot(app))
}

/// 暂停：已下载的部分留着，继续时接着下。
pub async fn pause(app: &AppHandle) -> UpdaterSnapshot {
    let st = app.state::<UpdaterState>();
    let _op = st.op.lock().await;
    let g = lock(&st);
    if g.snap.phase == Phase::Downloading {
        g.ctrl.store(CTRL_PAUSE, Ordering::SeqCst);
    }
    g.snap.clone()
}

/// 取消下载并删掉已下载的部分，回到「发现新版本」。
pub async fn cancel(app: &AppHandle) -> UpdaterSnapshot {
    let st = app.state::<UpdaterState>();
    let _op = st.op.lock().await;
    let phase = lock(&st).snap.phase;
    match phase {
        // 正在下：交给任务自己停下并清理，免得和它抢文件
        Phase::Downloading => {
            lock(&st).ctrl.store(CTRL_CANCEL, Ordering::SeqCst);
        }
        Phase::Paused | Phase::Error => {
            if let Ok(dir) = updates_dir(app) {
                let _file = st.file.lock().await;
                clear_dir(&dir, &[]);
            }
            update_snap(app, None, |g| reset_progress(&mut g.snap, Phase::Available));
        }
        _ => {}
    }
    snapshot(app)
}

/// 安装已下载好的更新。Windows 上安装器会接管并结束本进程；其它平台装完由前端调 relaunch。
pub async fn install(app: &AppHandle) -> Result<(), String> {
    let st = app.state::<UpdaterState>();
    let _op = st.op.lock().await;
    let (update, path) = {
        let g = lock(&st);
        if g.snap.phase != Phase::Ready {
            return Err("更新包还没下载完成".into());
        }
        match (g.update.clone(), g.package.clone()) {
            (Some(u), Some(p)) => (u, p),
            _ => return Err("找不到已下载的更新包，请重新检查更新".into()),
        }
    };
    update_snap(app, None, |g| {
        g.snap.phase = Phase::Installing;
        g.snap.error = None;
    });

    let pubkey = updater_pubkey(app)?;
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let bytes = std::fs::read(&path).map_err(|e| format!("读取更新包失败：{e}"))?;
        // 落盘后到安装前这段时间文件可能被改动，装之前再验一次
        verify_signature(&bytes, &update.signature, &pubkey)?;
        update.install(bytes).map_err(|e| format!("安装失败：{e}"))
    })
    .await
    .map_err(|e| format!("安装任务异常：{e}"))?;

    if let Err(e) = &result {
        log::warn!("[updater] 安装失败：{e}");
        update_snap(app, None, |g| {
            g.snap.phase = Phase::Ready;
            g.snap.error = Some(e.clone());
        });
    }
    result
}

// ─── 检查 ─────────────────────────────────────────────────

async fn check_remote(app: &AppHandle) -> Result<Option<Update>, String> {
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|e| format!("初始化更新检查失败：{e}"))?;
    updater.check().await.map_err(|e| format!("检查更新失败：{e}"))
}

/// 上次已经下好并验签的同一版本包：再验一次签名，通过就直接用。
async fn restore_package(app: &AppHandle, update: &Update) -> Option<PathBuf> {
    let dir = updates_dir(app).ok()?;
    let meta: PackageMeta = serde_json::from_slice(&std::fs::read(dir.join(META_FILE)).ok()?).ok()?;
    if meta.version != update.version || meta.signature != update.signature {
        return None;
    }
    let path = dir.join(&meta.file);
    if !path.is_file() {
        return None;
    }
    match verify_file(app, &path, &update.signature).await {
        Ok(()) => {
            log::info!("[updater] 复用上次下载好的 {}：{}", meta.version, path.display());
            Some(path)
        }
        Err(e) => {
            log::warn!("[updater] 上次下载的更新包校验不过，丢弃：{e}");
            clear_dir(&dir, &[]);
            None
        }
    }
}

// ─── 下载 ─────────────────────────────────────────────────

async fn run_download(app: AppHandle, update: Arc<Update>, epoch: u64, ctrl: Arc<AtomicU8>) {
    let st = app.state::<UpdaterState>();
    let _file = st.file.lock().await;

    let dir = match updates_dir(&app).and_then(|d| std::fs::create_dir_all(&d).map(|_| d).map_err(|e| e.to_string())) {
        Ok(d) => d,
        Err(e) => {
            fail(&app, epoch, format!("无法创建更新包缓存目录：{e}"), Vec::new());
            return;
        }
    };
    let name = package_file_name(update.download_url.as_str());
    let part = dir.join(format!("{name}.part"));
    let final_path = dir.join(&name);
    // 旧版本留下的包、上一次的 meta 都清掉，只留这次的断点文件
    clear_dir(&dir, &[part.as_path()]);

    let sources = build_sources(update.download_url.as_str(), &update.version);
    let mut failures: Vec<SourceFailure> = Vec::new();
    let mut previous: Option<&Source> = None;
    let mut done = false;

    'sources: for source in &sources {
        let kept = file_len(&part).await;
        update_snap(&app, Some(epoch), |g| {
            g.snap.source = Some(source.name.clone());
            if let Some(prev) = previous {
                g.snap.notice = Some(format!(
                    "{} 连接中断，已切换到 {} 继续下载（已保留 {}）",
                    prev.name,
                    source.name,
                    format_mb(kept)
                ));
            }
        });

        let mut attempts = 0;
        loop {
            match download_once(&app, epoch, &ctrl, &source.url, &part).await {
                Ok(()) => {
                    done = true;
                    break 'sources;
                }
                Err(DlError::Stopped) => {
                    finish_stopped(&app, epoch, &ctrl, &dir).await;
                    return;
                }
                Err(DlError::Abort(reason)) => {
                    fail(&app, epoch, reason, failures);
                    return;
                }
                Err(DlError::SourceDead(reason)) => {
                    log::warn!("[updater] {} 不可用：{reason}", source.name);
                    failures.push(SourceFailure { source: source.name.clone(), reason });
                    break;
                }
                Err(DlError::Retry { reason, progressed }) => {
                    log::warn!("[updater] {} 下载中断：{reason}", source.name);
                    attempts = if progressed { 0 } else { attempts + 1 };
                    if attempts >= RETRIES_PER_SOURCE {
                        failures.push(SourceFailure { source: source.name.clone(), reason });
                        break;
                    }
                    if !sleep_unless_stopped(&ctrl, RETRY_DELAY).await {
                        finish_stopped(&app, epoch, &ctrl, &dir).await;
                        return;
                    }
                }
            }
        }
        previous = Some(source);
    }

    if !done {
        fail(&app, epoch, "所有下载源都失败了".into(), failures);
        return;
    }

    update_snap(&app, Some(epoch), |g| {
        g.snap.phase = Phase::Verifying;
        g.snap.speed = 0;
    });
    if let Err(e) = verify_file(&app, &part, &update.signature).await {
        let _ = std::fs::remove_file(&part);
        update_snap(&app, Some(epoch), |g| {
            g.snap.downloaded = 0;
            g.snap.total = 0;
        });
        fail(&app, epoch, format!("更新包签名校验失败，已删除，请重新下载：{e}"), failures);
        return;
    }
    if let Err(e) = std::fs::rename(&part, &final_path) {
        fail(&app, epoch, format!("保存更新包失败：{e}"), failures);
        return;
    }
    let meta = PackageMeta { version: update.version.clone(), signature: update.signature.clone(), file: name };
    if let Ok(json) = serde_json::to_vec(&meta) {
        // 写不进去只是下次启动要重下，不影响这次安装
        let _ = std::fs::write(dir.join(META_FILE), json);
    }
    let size = file_len(&final_path).await;
    log::info!("[updater] {} 下载完成并已验签（{}）", update.version, format_mb(size));
    update_snap(&app, Some(epoch), |g| {
        g.snap.phase = Phase::Ready;
        g.snap.downloaded = size;
        g.snap.total = size;
        g.snap.speed = 0;
        g.snap.notice = None;
        g.package = Some(final_path);
    });
}

/// 从一个源下载一次：有断点就续传。正常下完返回 Ok。
async fn download_once(
    app: &AppHandle,
    epoch: u64,
    ctrl: &AtomicU8,
    url: &str,
    part: &Path,
) -> Result<(), DlError> {
    let resume_from = file_len(part).await;
    let client = http_client::with_system_proxy(reqwest::Client::builder())
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|e| DlError::Abort(format!("创建下载客户端失败：{e}")))?;
    let mut request = client.get(url).header(reqwest::header::ACCEPT, "application/octet-stream");
    if resume_from > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={resume_from}-"));
    }

    let send = request.send();
    tokio::pin!(send);
    let response = loop {
        if ctrl.load(Ordering::SeqCst) != CTRL_RUN {
            return Err(DlError::Stopped);
        }
        match tokio::time::timeout(POLL_INTERVAL, &mut send).await {
            Ok(r) => break r,
            Err(_) => continue,
        }
    };
    let mut response = response.map_err(|e| DlError::Retry {
        reason: format!("连接失败：{}", http_client::describe_error(&e.without_url())),
        progressed: false,
    })?;

    let status = response.status();
    let (mut offset, append) = match status.as_u16() {
        206 => (resume_from, true),
        // 服务器不认 Range，整个文件重新给：从头写
        200 => (0, false),
        416 => {
            let _ = tokio::fs::remove_file(part).await;
            return Err(DlError::Retry { reason: "本地断点和服务器文件对不上，已清掉重下".into(), progressed: false });
        }
        403 | 404 | 410 => return Err(DlError::SourceDead(format!("HTTP {status}"))),
        _ => return Err(DlError::Retry { reason: format!("HTTP {status}"), progressed: false }),
    };
    let total = response.content_length().map(|n| n + offset).unwrap_or(0);

    let mut options = tokio::fs::OpenOptions::new();
    if append {
        options.append(true);
    } else {
        options.write(true).create(true).truncate(true);
    }
    let mut file = options
        .open(part)
        .await
        .map_err(|e| DlError::Abort(format!("无法写入更新包：{e}")))?;

    update_snap(app, Some(epoch), |g| {
        g.snap.downloaded = offset;
        g.snap.total = total;
    });

    let start = offset;
    let mut meter = SpeedMeter::default();
    meter.push(Instant::now(), offset);
    let mut last_emit = Instant::now();
    let mut last_data = Instant::now();

    let result = loop {
        if ctrl.load(Ordering::SeqCst) != CTRL_RUN {
            break Err(DlError::Stopped);
        }
        match tokio::time::timeout(POLL_INTERVAL, response.chunk()).await {
            Err(_) => {
                if last_data.elapsed() >= STALL_TIMEOUT {
                    break Err(DlError::Retry {
                        reason: format!("超过 {} 秒没收到数据", STALL_TIMEOUT.as_secs()),
                        progressed: offset > start,
                    });
                }
            }
            Ok(Err(e)) => {
                break Err(DlError::Retry {
                    reason: http_client::describe_error(&e.without_url()),
                    progressed: offset > start,
                })
            }
            Ok(Ok(None)) => break Ok(()),
            Ok(Ok(Some(bytes))) => {
                if let Err(e) = file.write_all(&bytes).await {
                    break Err(DlError::Abort(format!("写入更新包失败（磁盘空间不足？）：{e}")));
                }
                offset += bytes.len() as u64;
                let now = Instant::now();
                last_data = now;
                meter.push(now, offset);
                if now.duration_since(last_emit) >= EMIT_INTERVAL {
                    last_emit = now;
                    let speed = meter.speed();
                    update_snap(app, Some(epoch), |g| {
                        g.snap.downloaded = offset;
                        g.snap.speed = speed;
                    });
                }
            }
        }
    };
    // 出错返回前也先落盘，免得缓冲里的数据晚到、把续传起点算错
    let _ = file.flush().await;
    drop(file);
    result?;

    if total > 0 && offset != total {
        return Err(DlError::Retry { reason: format!("下载不完整（{offset} / {total} 字节）"), progressed: offset > start });
    }
    update_snap(app, Some(epoch), |g| {
        g.snap.downloaded = offset;
        g.snap.total = total.max(offset);
    });
    Ok(())
}

/// 任务因暂停 / 取消停下：暂停保留断点，取消删掉。
async fn finish_stopped(app: &AppHandle, epoch: u64, ctrl: &AtomicU8, dir: &Path) {
    if ctrl.load(Ordering::SeqCst) == CTRL_CANCEL {
        clear_dir(dir, &[]);
        update_snap(app, Some(epoch), |g| reset_progress(&mut g.snap, Phase::Available));
    } else {
        update_snap(app, Some(epoch), |g| {
            g.snap.phase = Phase::Paused;
            g.snap.speed = 0;
        });
    }
}

fn fail(app: &AppHandle, epoch: u64, error: String, failures: Vec<SourceFailure>) {
    log::warn!("[updater] 下载失败：{error}");
    update_snap(app, Some(epoch), |g| {
        g.snap.phase = Phase::Error;
        g.snap.speed = 0;
        g.snap.notice = None;
        g.snap.error = Some(error);
        g.snap.failures = failures;
    });
}

fn reset_progress(snap: &mut UpdaterSnapshot, phase: Phase) {
    snap.phase = phase;
    snap.downloaded = 0;
    snap.total = 0;
    snap.speed = 0;
    snap.source = None;
    snap.notice = None;
    snap.error = None;
    snap.failures.clear();
}

/// 等一段时间；中途被暂停 / 取消返回 false。
async fn sleep_unless_stopped(ctrl: &AtomicU8, total: Duration) -> bool {
    let deadline = Instant::now() + total;
    while Instant::now() < deadline {
        if ctrl.load(Ordering::SeqCst) != CTRL_RUN {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    ctrl.load(Ordering::SeqCst) == CTRL_RUN
}

// ─── 文件与验签 ───────────────────────────────────────────

fn updates_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|d| d.join("updates"))
        .map_err(|e| format!("找不到缓存目录：{e}"))
}

async fn file_len(path: &Path) -> u64 {
    tokio::fs::metadata(path).await.map(|m| m.len()).unwrap_or(0)
}

/// 删掉目录里除 `keep` 以外的文件。
fn clear_dir(dir: &Path, keep: &[&Path]) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && !keep.iter().any(|k| *k == path.as_path()) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

fn updater_pubkey(app: &AppHandle) -> Result<String, String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| "配置里缺少更新签名公钥".to_string())
}

async fn verify_file(app: &AppHandle, path: &Path, signature: &str) -> Result<(), String> {
    let pubkey = updater_pubkey(app)?;
    let path = path.to_path_buf();
    let signature = signature.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let data = std::fs::read(&path).map_err(|e| format!("读取更新包失败：{e}"))?;
        verify_signature(&data, &signature, &pubkey)
    })
    .await
    .map_err(|e| format!("校验任务异常：{e}"))?
}

/// 按 tauri updater 的格式验签：公钥和签名都是 base64 包着的 minisign 文本。
pub fn verify_signature(data: &[u8], signature_b64: &str, pubkey_b64: &str) -> Result<(), String> {
    use base64::Engine;
    let decode = |s: &str| -> Result<String, String> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(s.trim())
            .map_err(|e| format!("base64 解码失败：{e}"))?;
        String::from_utf8(bytes).map_err(|_| "签名内容不是 UTF-8".to_string())
    };
    let public_key = minisign_verify::PublicKey::decode(&decode(pubkey_b64)?).map_err(|e| format!("公钥无效：{e}"))?;
    let signature = minisign_verify::Signature::decode(&decode(signature_b64)?).map_err(|e| format!("签名无效：{e}"))?;
    public_key.verify(data, &signature, true).map_err(|e| format!("签名不匹配：{e}"))
}

// ─── 纯逻辑 ───────────────────────────────────────────────

/// 下载源：update.json 给的地址排第一，再按同一文件名拼出其它源。
/// 只有主地址是 `…/v<版本>/<文件名>` 这种发布布局时才拼，认不出布局就只用主地址。
pub fn build_sources(primary: &str, version: &str) -> Vec<Source> {
    let mut sources = vec![Source { name: source_name(primary), url: primary.to_string() }];
    let tag = format!("v{}", version.trim_start_matches('v'));
    let mut segments = primary.rsplit('/');
    let (file, parent) = (segments.next().unwrap_or(""), segments.next().unwrap_or(""));
    if file.is_empty() || parent != tag {
        return sources;
    }
    for (name, base) in MIRROR_BASES {
        let url = format!("{base}/{tag}/{file}");
        if !sources.iter().any(|s| s.url == url) {
            sources.push(Source { name: name.to_string(), url });
        }
    }
    sources
}

fn source_name(url: &str) -> String {
    let host = url.split("://").nth(1).and_then(|rest| rest.split('/').next()).unwrap_or(url);
    if host.ends_with("r2.dev") {
        "R2".into()
    } else if host.contains("github") {
        "GitHub".into()
    } else if host.contains("gitee") {
        "Gitee".into()
    } else {
        host.to_string()
    }
}

/// 下载地址最后一段作文件名，只留安全字符（落盘用）。
pub fn package_file_name(url: &str) -> String {
    let last = url.split(['?', '#']).next().unwrap_or("").rsplit('/').next().unwrap_or("");
    let name: String = last
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
        .collect();
    let name = name.trim_matches('.').to_string();
    if name.is_empty() {
        "update.bin".into()
    } else {
        name
    }
}

fn format_mb(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
}

/// 最近一段时间的平均下载速度。
#[derive(Default)]
struct SpeedMeter {
    samples: VecDeque<(Instant, u64)>,
}

impl SpeedMeter {
    fn push(&mut self, at: Instant, bytes: u64) {
        self.samples.push_back((at, bytes));
        while let Some(&(t, _)) = self.samples.front() {
            if at.duration_since(t) > SPEED_WINDOW && self.samples.len() > 2 {
                self.samples.pop_front();
            } else {
                break;
            }
        }
    }

    fn speed(&self) -> u64 {
        match (self.samples.front(), self.samples.back()) {
            (Some(&(t0, b0)), Some(&(t1, b1))) => {
                let secs = t1.duration_since(t0).as_secs_f64();
                if secs < 0.2 {
                    0
                } else {
                    (b1.saturating_sub(b0) as f64 / secs) as u64
                }
            }
            _ => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const R2: &str = "https://pub-9d9e6c0cb6934fb0a0c505e3c64f39b2.r2.dev/knowledge-base/v3.1.0/Knowledge.Base_3.1.0_x64-setup.exe";
    const GH: &str = "https://github.com/bkywksj/knowledge-base-release/raw/main/releases/v3.1.0/Knowledge.Base_3.1.0_x64-setup.exe";

    #[test]
    fn sources_from_r2_add_github_after_primary() {
        let s = build_sources(R2, "3.1.0");
        assert_eq!(s.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["R2", "GitHub"]);
        assert_eq!(s[1].url, GH);
    }

    #[test]
    fn sources_from_github_put_r2_second() {
        let s = build_sources(GH, "v3.1.0");
        assert_eq!(s.iter().map(|s| s.url.as_str()).collect::<Vec<_>>(), [GH, R2]);
    }

    #[test]
    fn sources_from_gitee_add_both_mirrors() {
        let gitee = "https://gitee.com/bkywksj/knowledge-base-release/raw/master/releases/v3.1.0/Knowledge.Base_3.1.0_x64-setup.exe";
        let s = build_sources(gitee, "3.1.0");
        assert_eq!(s.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["Gitee", "R2", "GitHub"]);
    }

    #[test]
    fn unknown_layout_uses_primary_only() {
        let s = build_sources("https://example.com/download/latest.exe", "3.1.0");
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].name, "example.com");
        // 版本目录对不上（地址是旧版本的）也不拼
        assert_eq!(build_sources(R2, "3.2.0").len(), 1);
    }

    #[test]
    fn file_name_is_sanitized() {
        assert_eq!(package_file_name(R2), "Knowledge.Base_3.1.0_x64-setup.exe");
        assert_eq!(package_file_name("https://x/a%20b.exe?sig=1"), "a_20b.exe");
        assert_eq!(package_file_name("https://x/"), "update.bin");
        assert_eq!(package_file_name("https://x/.."), "update.bin");
    }

    #[test]
    fn speed_averages_over_window() {
        let t0 = Instant::now();
        let mut m = SpeedMeter::default();
        m.push(t0, 0);
        assert_eq!(m.speed(), 0);
        m.push(t0 + Duration::from_secs(1), 1_000_000);
        m.push(t0 + Duration::from_secs(2), 2_000_000);
        assert_eq!(m.speed(), 1_000_000);
        // 超出 3 秒窗口的老样本被丢掉，速度只看最近
        m.push(t0 + Duration::from_secs(6), 10_000_000);
        assert_eq!(m.speed(), 2_000_000);
    }

    /// 手动验证：用真实发布的安装包 + update.json 里的签名验一遍，确认和插件的验签结果一致。
    /// `KB_VERIFY_FILE=<安装包> KB_VERIFY_SIG=<签名> cargo test verify_real_package -- --ignored`
    #[test]
    #[ignore]
    fn verify_real_package() {
        let file = std::env::var("KB_VERIFY_FILE").expect("KB_VERIFY_FILE");
        let sig = std::env::var("KB_VERIFY_SIG").expect("KB_VERIFY_SIG");
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).expect("tauri.conf.json");
        let pubkey = conf["plugins"]["updater"]["pubkey"].as_str().expect("pubkey");
        let data = std::fs::read(&file).expect("read package");
        verify_signature(&data, &sig, pubkey).expect("真实安装包应当验签通过");
        // 改一个字节必须验不过
        let mut tampered = data;
        tampered[0] ^= 0xff;
        assert!(verify_signature(&tampered, &sig, pubkey).is_err());
    }

    #[test]
    fn bad_signature_is_rejected() {
        let err = verify_signature(b"data", "bm90IGEgc2ln", "bm90IGEga2V5").unwrap_err();
        assert!(err.contains("公钥无效"), "{err}");
    }
}
