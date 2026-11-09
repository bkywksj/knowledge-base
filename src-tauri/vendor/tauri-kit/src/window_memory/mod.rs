//! 记住 Tauri 主窗口的位置，**按显示器组合分别记**。
//!
//! 只存一条记录时，「合盖只剩副屏」的位置会盖掉「双屏时在主屏」的选择：开盖后窗口就留在副屏了。
//! 这里每种组合（双屏 / 只有副屏 / 只有笔记本屏）各存一份，组合变化时恢复对应那份。
//!
//! 接入：
//! - `setup` 里、主窗口首次 show 之前调 [`init`]，首次显示后调 [`capture_now`]；
//! - 主窗口的 `on_window_event` 里调 [`on_window_event`]；
//! - 托盘 / 双开唤回主窗口统一走 [`show_main`]（要自己抢前台的用 [`correct_before_show`]）；
//! - 「还原默认大小」按钮调 [`reset_to_default`]。
//!
//! 记录存在 `<app_config_dir>/window-memory.json`（开发版是 `window-memory-dev.json`），
//! 能多开的应用用 [`Options::dir`] 指定各实例的目录。诊断日志带 `[winpos]` 前缀。

// 不开 feature 时只有测试会用到这些纯逻辑
#[cfg_attr(not(feature = "window-memory"), allow(dead_code))]
mod logic;

#[cfg(feature = "window-memory")]
mod glue;
#[cfg(feature = "window-memory")]
pub use glue::{capture_now, correct_before_show, init, on_window_event, reset_to_default, show_main, Options};
