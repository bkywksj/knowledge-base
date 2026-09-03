//! Windows 专属：拦掉 Alt 键触发的「系统菜单模态循环」，根治无边框窗口按 Alt 卡死。
//!
//! ## 问题
//!
//! 用户反馈：写日记时用微信输入法的**语音输入（长按 Alt）**，一晚上白屏卡死四五次；
//! 卡死后任何按键、鼠标都没反应，窗口也关不掉，只能从任务管理器杀进程。
//! 诊断包里 JS 无报错、Rust 无 panic、无 crash log —— 整个进程"安静地死了"。
//!
//! ## 根因（逐环核实过，缺一不可）
//!
//! 1. `wry` 0.54 没注册 `AcceleratorKeyPressed`，Alt 键会从 WebView2 冒泡到宿主窗口；
//! 2. `tao` 0.34 `keyboard.rs` 对 `WM_SYSKEYDOWN` 返回 `DefSubclassProc`，把 Alt 原样交还系统；
//! 3. `tao` 0.34 的 `WM_SYSCOMMAND` 分支只处理 `SC_RESTORE` / `SC_MINIMIZE` / `SC_SCREENSAVE`，
//!    **`SC_KEYMENU` 完全没拦**，直接落到 `DefWindowProc`。
//!
//! 于是按下并松开 Alt → `DefWindowProc` 发出 `WM_SYSCOMMAND(SC_KEYMENU)` →
//! **Windows 进入 USER32 内部的菜单模态消息循环**。本应用是无边框窗口
//! （`tauri.conf.json` 的 `decorations: false`），既没有菜单栏也没有可见的系统菜单，
//! 什么都弹不出来，就干耗在那个 nested loop 里：
//!
//! - 键鼠输入全被 nested loop 截走 → 「任何按键没反应」
//! - 宿主 UI 线程被顶替，WebView2 得不到调度、不重绘 → 「白屏」
//! - WebView2 是 STA COM，同步调用拿不到消息泵时会从"可退出的菜单循环"恶化成**真死锁**
//!
//! 有系统标题栏时按 Alt 至少会点亮菜单栏、按 Esc 能退，用户有感知；无边框窗口下
//! 界面毫无变化，用户只会以为死机了继续猛敲键盘 —— 而每次敲击又重新喂进这个循环。
//!
//! ## 修法
//!
//! 给主窗口挂一层 `SetWindowSubclass`，把 `WM_SYSCOMMAND` 里的 `SC_KEYMENU` 直接吞掉。
//! 这是 Chromium (`HWNDMessageHandler::OnSysCommand`) 和 Electron 无边框窗口的标准做法。
//!
//! **为什么安全**：
//! - `SC_KEYMENU` 的语义就是"打开窗口菜单"。无边框窗口本来就没有菜单可开，
//!   吞掉它零功能损失。
//! - 只吞 `SC_KEYMENU` 一条，其余 `WM_SYSCOMMAND`（`SC_MINIMIZE` / `SC_RESTORE` /
//!   `SC_CLOSE` / `SC_MOVE` …）原样往下传，tao 赖以维护最小化状态的逻辑不受影响。
//! - **不影响前端拿 Alt**：`SC_KEYMENU` 是 `DefWindowProc` 在 `WM_SYSKEYUP` /
//!   `WM_SYSCHAR` **之后**补发的派生消息；`WM_SYSKEYDOWN` / `WM_SYSKEYUP` 本身照常
//!   流到 WebView2，JS 侧 `e.altKey`、Alt+←/→ 历史导航（AppLayout）全都照旧。
//! - **不影响 Alt+F4**：那是 `SC_CLOSE`，不是 `SC_KEYMENU`。
//!
//! **为什么能插进 tao 前面**：`SetWindowSubclass` 是 LIFO 链，tao 自己也是用它挂的
//! （`tao/event_loop.rs:703`），我们在窗口建好后再挂，所以排在 tao 前面先执行；
//! 放行的消息经 `DefSubclassProc` 继续往下走到 tao，行为完全不变。

use std::sync::atomic::{AtomicBool, Ordering};

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{SC_KEYMENU, WM_SYSCOMMAND};

/// 本模块 subclass 的唯一 id（同一 hwnd 上区分不同 subclass 用，任取一个不冲突的常量）。
const SUBCLASS_ID: usize = 0x4B42_0001;

/// `WM_SYSCOMMAND` 的 wParam 低 4 位被系统留作类型内部信息（如鼠标 / 键盘来源），
/// 判断命令类型前必须掩掉，否则 `SC_KEYMENU` 会漏判。见 MSDN WM_SYSCOMMAND 备注。
const SC_MASK: usize = 0xFFF0;

/// 防重复安装：多次调用 `install` 只有第一次生效。
static INSTALLED: AtomicBool = AtomicBool::new(false);

/// 挂在主窗口上的消息过滤器：吞掉 `SC_KEYMENU`，其余原样下传。
///
/// # Safety
/// 由 Windows 在窗口消息派发时调用，签名必须与 `SUBCLASSPROC` 完全一致。
unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    _ref_data: usize,
) -> LRESULT {
    if msg == WM_SYSCOMMAND && (wparam & SC_MASK) == SC_KEYMENU as usize {
        // 返回 0 = 已处理，DefWindowProc 永远看不到它 → 不会进菜单模态循环。
        return 0;
    }
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// 给主窗口安装 Alt 菜单循环防护。
///
/// 失败只记 warn 不阻断启动：拿不到 hwnd 或安装失败时，退化成"和以前一样"，
/// 不该因为一个加固措施让应用起不来。
pub fn install(window: &tauri::WebviewWindow) {
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }

    let hwnd = match window.hwnd() {
        Ok(h) => h.0 as HWND,
        Err(e) => {
            log::warn!("[win-msg-guard] 取窗口 hwnd 失败，跳过 Alt 菜单循环防护: {e}");
            INSTALLED.store(false, Ordering::SeqCst);
            return;
        }
    };

    // SAFETY: hwnd 来自刚创建好的主窗口，subclass_proc 签名与 SUBCLASSPROC 一致，
    // 且不持有任何 ref_data（传 0），无生命周期问题。
    let ok = unsafe { SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0) };
    if ok == 0 {
        log::warn!("[win-msg-guard] SetWindowSubclass 失败，Alt 菜单循环防护未生效");
        INSTALLED.store(false, Ordering::SeqCst);
    } else {
        log::info!("[win-msg-guard] 已拦截 SC_KEYMENU（Alt 不再触发系统菜单模态循环）");
    }
}
