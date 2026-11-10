//! 外网 HTTP 请求的代理处理：认 socks5 代理；授权这类国内服务先直连，连不上再走代理。
//!
//! 来自 Reeve 的客诉（2026-11）：客户设了 `ALL_PROXY=socks5://127.0.0.1:7897`，授权、检查更新、AI 对话
//! 两个多月没联网成功过，梯子开不开都一样；接入 keystone 后没了缓存兜底，直接被锁住。两个原因：
//!
//! - reqwest 会读 `ALL_PROXY` / `HTTPS_PROXY` 这些环境变量，`socks5://` 也照读；没开 `socks` 特性时把它当
//!   HTTP 代理建隧道，必报 `unsupported scheme socks5`。开本模块的 feature 就给 reqwest 打开 `socks`：
//!   Cargo 按版本合并特性，应用里同版本的 reqwest 都跟着打开，包括 tauri-plugin-updater 用的 0.13。
//! - 代理设置常和实际不符：梯子关了变量还在，全局模式下境外出口连不上国内服务。授权这类国内服务用
//!   [`send_direct_first`]：先直连，连接阶段失败才按系统代理重发。
//!
//! feature：`net` 两项都有（要用 reqwest 0.12）；`net-socks` 只给 reqwest 0.13 打开 socks，没有代码，
//! 给没用 reqwest 0.12 的应用。诊断日志带 `[net]` 前缀。

// 不开 feature 时只有测试会用到这些纯逻辑
#[cfg_attr(not(feature = "net"), allow(dead_code))]
mod logic;

#[cfg(feature = "net")]
mod send;
#[cfg(feature = "net")]
pub use send::{describe, direct_client, send_direct_first, system_proxy_client, SendError};
