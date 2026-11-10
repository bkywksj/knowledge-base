# tauri-kit

自有 Tauri 应用共用的通用能力。一个库、多个模块，每个模块一个 feature，应用只开自己用的。

私有库，不发 crates.io。源码内置在各应用的 `src-tauri/vendor/tauri-kit`，版本见其中的 `.source-rev`。
**不要直接改应用里的这份副本**，下次内置会被覆盖；改动一律回到 tauri-kit 仓库。

## 模块

| 模块 | feature | 做什么 |
|---|---|---|
| `window_memory` | `window-memory` | 主窗口位置按显示器组合分别记，合盖 / 插拔副屏后回到该在的屏 |
| `net` | `net` / `net-socks` | 外网请求认 socks5 代理；授权这类国内服务先直连，连不上再走代理 |

## 接入

1. 在 tauri-kit 仓库运行 `bash tools/vendor-into.sh "<应用>/src-tauri"`
2. 应用的 `src-tauri/Cargo.toml`：

```toml
[workspace]
exclude = ["vendor/tauri-kit"]   # 有 [workspace] 时必加，否则会被当成成员

[dependencies]
tauri-kit = { path = "vendor/tauri-kit", features = ["window-memory"] }
```

## window_memory

```rust
use tauri_kit::window_memory as wm;

// setup 里、主窗口首次 show 之前。返回是否按记录摆了窗口，false 时可以走自己的默认几何
wm::init(app.handle(), will_show, wm::Options::default());
// 首次 show 之后
wm::capture_now(app.handle(), "启动显示后");
// 主窗口的 on_window_event 里（只传主窗口的事件）
wm::on_window_event(window.app_handle(), event);
// 托盘 / 双开唤回主窗口
wm::show_main(app, "托盘菜单");
// 设置页「还原默认大小」，返回实际应用的逻辑尺寸
let (w, h) = wm::reset_to_default(&app)?;
```

- 配置里主窗口要 `visible: false`、`center: true`：先摆好位置再显示，第一次运行由 `center` 放在主屏
- 主窗口里挂了子 webview（内置浏览器）的应用，feature 再加 `child-webviews`
- 旧版单条记录存在别处时，经 `Options::legacy` 传入 JSON；默认文件 `main-window-placement.json` 会自动读取
- 记录在 `<app_config_dir>/window-memory.json`，开发版是 `window-memory-dev.json`；能多开的应用用 `Options::dir` 指定各实例自己的目录
- 排查看日志里的 `[winpos]`

## net

用户设了 `ALL_PROXY=socks5://…` 时，没开 reqwest `socks` 特性的应用所有外网请求都会失败（代理开着也一样），
检查更新也在其中。开这个模块就会给 reqwest 0.12 / 0.13 打开 socks，不用改代码。

```toml
tauri-kit = { path = "vendor/tauri-kit", features = ["window-memory", "net"] }        # 用 reqwest 0.12 的应用
tauri-kit = { path = "vendor/tauri-kit", features = ["window-memory", "net-socks"] }  # 只有 reqwest 0.13 的应用
```

授权这类国内服务的请求改成先直连、连不上再按系统代理重发：

```rust
use tauri_kit::net;

let resp = net::send_direct_first(|c| c.post(&url).json(&body).timeout(timeout))
    .await
    .map_err(|e| {
        log::error!("授权请求失败: {e}");   // 直连和代理两次的原因都在里面
        "网络请求失败，请检查网络连接".to_string()
    })?;
```

- 只在连接阶段失败时换路，请求不会被服务端处理两次
- 境外服务（AI 接口等）别用它，用户装代理就是为了这些；需要按代理发的用 `net::system_proxy_client()`
- 记 reqwest 错误用 `net::describe(e)`，它会展开底层原因（`error sending request` 后面那几层）
- 排查看日志里的 `[net]`

## 升级

```bash
bash tools/check-drift.sh                    # 查哪些应用落后
bash tools/vendor-into.sh "<应用>/src-tauri" # 重新内置，再按 CHANGELOG「应用侧」改代码
```
