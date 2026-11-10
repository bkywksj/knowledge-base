---
name: tauri-kit-integration
description: |
  用于本应用中与 tauri-kit 公共库相关的开发：主窗口位置记忆、外网请求的代理处理、升级内置版本、排查 [winpos] / [net] 问题。

  触发场景：
  - 主窗口启动位置不对、合盖或插拔副屏后跑到别的屏
  - 浏览器能打开、应用连不上；授权一直未确认；检查更新失败；用户设了 ALL_PROXY / socks5 代理
  - 要升级内置的 tauri-kit 版本，或升级 reqwest 大版本
  - 想改 vendor/tauri-kit 里的代码，或发现应用里有 main_window_placement 旧实现
  - 想把一段通用能力抽出来给多个应用共用

  触发词：tauri-kit、vendor/tauri-kit、窗口记忆、window_memory、窗口位置、显示器、副屏、合盖、[winpos]、window-memory.json、.source-rev、代理、socks5、ALL_PROXY、直连、send_direct_first、[net]
---

# tauri-kit 应用侧指南

本文件由 tauri-kit 的 `tools/vendor-into.sh` 安装，**每次内置都会覆盖**，不要在这里写应用自己的内容。

## 这是什么

`src-tauri/vendor/tauri-kit` 是自有应用共用的私有库的内置副本，版本见其中的 `.source-rev`，用法见 `README.md`，每版要做的事见 `CHANGELOG.md`「应用侧」。

## 🔴 别改副本

| 想做的事 | 做法 |
|---|---|
| 改库的行为、修库里的 bug | 去 `E:/my/桌面软件tauri/tauri-kit` 改 → 发版 → 重新内置（改副本下次内置就没了） |
| 升级到新版本 | 在 tauri-kit 仓库跑 `bash tools/vendor-into.sh "<本应用>/src-tauri"`，按 CHANGELOG「应用侧」改代码，再全量测试 |
| 新增通用能力 | 在 tauri-kit 里加模块（技能 `add-module`），不要在应用里再写一份 |
| 发现应用里还有 `main_window_placement` | 那是旧实现，接入后应删除 |

提交时只提交 `vendor/tauri-kit`、`.claude/skills/tauri-kit-integration`、`.codex/skills/tauri-kit-integration`、`Cargo.lock` 和相关接入代码。

## window_memory 速查

调用都在 `tauri_kit::window_memory`：

| 时机 | 调用 |
|---|---|
| `setup` 里、主窗口首次 show 之前 | `init(handle, will_show, Options::default())` |
| 首次 show 之后 | `capture_now(handle, "启动显示后")` |
| 主窗口 `on_window_event`（子窗口的事件别传进来） | `on_window_event(handle, event)` |
| 托盘 / 双开 / 通知唤回主窗口 | `show_main(handle, "来源")` |
| 要自己抢前台的唤回 | `correct_before_show(handle, "来源")`，随后自己 show |
| 设置页「还原默认大小」 | `reset_to_default(&app)` |

行为：每种显示器组合各记一份位置；组合变化时恢复对应那份，第一次见到的组合放主屏居中；换屏只认用户拖动，系统挪的不记。

## 排查

日志里搜 `[winpos]`，几个关键句：

| 日志 | 含义 |
|---|---|
| `启动：显示器 […]；组合 … 的记录：…` | 启动时看到哪些屏、这个组合记的是哪里，`[主]` 标主屏 |
| `显示器拓扑变化` | 插拔、合盖、换主屏被感知到了 |
| `纠偏（…）：放回记录的屏 / 没有记录，放主屏` | 把窗口搬回去了，后面带搬之前的状态 |
| `记录位置（…）` | 换屏的位置被记下，要么是用户拖的，要么是该组合的第一条 |

记录文件是 `<app_config_dir>/window-memory.json`，开发版是 `window-memory-dev.json`。要清记录，退出应用后删掉它，下次启动回到默认位置（还留着旧版记录的话，会用主屏上的旧记录打底）。

## net 速查

开了 `net` / `net-socks` 就给 reqwest 0.12 / 0.13 打开 socks（不开的话，用户设了 `ALL_PROXY=socks5://…` 时所有外网请求连同检查更新都会失败，代理开着也一样）。调用都在 `tauri_kit::net`：

| 场景 | 调用 |
|---|---|
| 授权这类国内服务的请求 | `send_direct_first(\|c\| c.post(&url).json(&body).timeout(t))`：先直连，连接阶段失败才按系统代理重发 |
| 要按系统代理发的请求 | `system_proxy_client()` |
| 一定不走代理的请求 | `direct_client()`（连接超时 5 秒） |
| 记 reqwest 错误 | `describe(e)`：展开 `error sending request` 后面的真正原因 |

- 境外服务（AI 接口等）别用 `send_direct_first`，用户装代理就是为了这些
- 应用升级 reqwest 大版本（0.14 等）时，tauri-kit 也要加上新版本的声明，否则 socks 又是关的

排查：先让用户在 PowerShell 跑 `Get-ChildItem Env: | Where-Object Name -match 'proxy'`；日志里搜 `[net]` 和请求失败的原因：

| 原因里有 | 含义 |
|---|---|
| `unsupported scheme socks5` / `scheme is not http` | socks 没开：没开 `net`，或 reqwest 升了大版本 |
| `error connecting to socks proxy` | 代理没在运行（梯子关了，环境变量还在） |
| `invalid peer certificate` / `UnknownIssuer` | HTTPS 被本机软件拦截（杀软 HTTPS 扫描、抓包工具） |
