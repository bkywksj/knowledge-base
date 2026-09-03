//! 关闭请求看门狗：WebView 死掉时保证进程仍然退得掉。
//!
//! ## 为什么需要
//!
//! 本应用的**每一条**退出路径最终都要经过 WebView 里的 React 组件：
//!
//! | 入口 | 路径 |
//! |---|---|
//! | 窗口关闭按钮 | 按钮本身就在 WebView 里（`decorations:false` + 自绘标题栏） |
//! | Alt+F4 / 系统关闭 | `lib.rs` 无条件 `api.prevent_close()` → emit → `CloseRequestedListener` |
//! | 托盘「退出」 | `tray.rs` emit `tray:request-exit` → `ExitConfirmListener` → `exit(0)` |
//!
//! 于是 WebView 一旦白屏 / 渲染进程崩溃，**一条都走不通**，进程变成关不掉的僵尸，
//! 用户只能开任务管理器结束进程。这个缺陷从 v1.1.0 起一直存在。
//!
//! ## 做法
//!
//! `CloseRequested` 时 arm 一个定时器；前端 `CloseRequestedListener` 在监听回调的
//! **第一行**（任何 await 之前）回一个 `app:close-ack`，Rust 收到就 disarm。
//! 超时仍未收到 → 判定前端已死 → `app.exit(0)`。
//!
//! 因为 ack 无任何前置 IO，活着的前端必然在毫秒级回应，`ACK_TIMEOUT` 给到秒级
//! 足够宽松，不会误杀"活着但正在弹确认框 / 正在跑退出同步"的前端。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Listener};

/// 等待前端 ack 的上限。前端 ack 是监听回调的第一行、无 IO 前置，
/// 正常情况下毫秒级返回；给到 5s 是为了覆盖"主线程正巧被一次长任务占住"的极端情况。
const ACK_TIMEOUT: Duration = Duration::from_secs(5);

/// 单调递增的关闭请求序号。看门狗只对"自己那一轮"负责：
/// 用户连点几次关闭时，旧的看门狗醒来发现序号已经变了就直接退场，
/// 避免第 1 轮的超时误杀掉第 3 轮里正常活着的前端。
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// 当前这一轮是否已收到前端 ack。
static ACKED: AtomicBool = AtomicBool::new(false);

/// 全局 ack 监听器是否已注册（只需注册一次）。
static LISTENER_READY: AtomicBool = AtomicBool::new(false);

/// 前端确认"我还活着，关闭流程我接管了"的事件名。
pub const ACK_EVENT: &str = "app:close-ack";

/// 起一轮看门狗。由 `CloseRequested` 在 `prevent_close()` 之后调用。
pub fn arm(app: AppHandle) {
    ensure_listener(&app);

    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    ACKED.store(false, Ordering::SeqCst);

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(ACK_TIMEOUT).await;

        // 期间又来了新的关闭请求 → 那一轮有它自己的看门狗，本轮退场。
        if GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        if ACKED.load(Ordering::SeqCst) {
            return;
        }

        log::error!(
            "[close-watchdog] 关闭请求发出后 {}s 内未收到前端 ack，判定 WebView 已无响应，强制退出进程。\\
             （若非用户主动关闭，请把本条日志连同 crash 目录一起反馈）",
            ACK_TIMEOUT.as_secs()
        );
        app.exit(0);
    });
}

/// 注册 `app:close-ack` 监听（幂等，只有第一次真正注册）。
fn ensure_listener(app: &AppHandle) {
    if LISTENER_READY.swap(true, Ordering::SeqCst) {
        return;
    }
    app.listen(ACK_EVENT, |_| {
        ACKED.store(true, Ordering::SeqCst);
    });
}
