//! 自有 Tauri 应用共用的通用能力。一个库、多个模块，每个模块一个 feature，应用只开自己用的，
//! 没开的不参与编译。
//!
//! | 模块 | feature | 做什么 |
//! |---|---|---|
//! | [`window_memory`] | `window-memory` | 主窗口位置按显示器组合分别记，合盖 / 插拔副屏后回到该在的屏 |
//! | [`net`] | `net` / `net-socks` | 外网请求认 socks5 代理；授权这类国内服务先直连，连不上再走代理 |
//!
//! 接入步骤、各模块的规则见 README 和仓库里的技能。

// 测试只跑纯逻辑，不链接 WebView2，所以 test 下不要求开 feature。
#[cfg(any(feature = "window-memory", test))]
pub mod window_memory;

// net 不碰 Tauri，开 feature 测试也安全；不开时只编译纯逻辑
#[cfg(any(feature = "net", test))]
pub mod net;
