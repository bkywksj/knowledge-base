---
name: tauri-plugins
description: |
  Tauri 插件开发与集成技能，指导如何使用官方插件和开发自定义插件。

  触发场景：
  - 需要集成 Tauri 官方插件
  - 需要开发自定义 Tauri 插件
  - 需要理解插件的安装和配置流程
  - 需要排查插件不可用的问题

  触发词：插件、plugin、tauri-plugin、集成、扩展、第三方
---

# Tauri 插件开发与集成

## 当前项目已安装插件

### Cargo 依赖（src-tauri/Cargo.toml）

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
tauri-plugin-store = "2"
tauri-plugin-log = "2"
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
```

### 已注册插件（src-tauri/src/lib.rs）

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![...])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 已配置权限（src-tauri/capabilities/default.json）

```json
{
  "permissions": [
    "core:default",
    "opener:default",
    "store:default",
    "log:default",
    "updater:default",
    "process:default"
  ]
}
```

---

## 官方插件完整清单

### 核心功能插件

| 插件 | Cargo 依赖 | npm 包 | 用途 | 当前状态 |
|------|-----------|--------|------|---------|
| **opener** | `tauri-plugin-opener` | `@tauri-apps/plugin-opener` | 打开 URL/文件 | ✅ 已安装 |
| **store** | `tauri-plugin-store` | `@tauri-apps/plugin-store` | 键值存储 | ✅ 已安装 |
| **log** | `tauri-plugin-log` | `@tauri-apps/plugin-log` | 日志系统 | ✅ 已安装 |
| **updater** | `tauri-plugin-updater` | `@tauri-apps/plugin-updater` | 应用自动更新 | ✅ 已安装 |
| **process** | `tauri-plugin-process` | `@tauri-apps/plugin-process` | 进程管理（退出/重启） | ✅ 已安装 |
| **shell** | `tauri-plugin-shell` | `@tauri-apps/plugin-shell` | 执行系统命令 | 📦 推荐 |
| **os** | `tauri-plugin-os` | `@tauri-apps/plugin-os` | 操作系统信息（平台/架构/版本） | 📦 推荐 |
| **dialog** | `tauri-plugin-dialog` | `@tauri-apps/plugin-dialog` | 文件选择/消息对话框 | 📦 推荐 |
| **notification** | `tauri-plugin-notification` | `@tauri-apps/plugin-notification` | 系统通知 | 📦 推荐 |
| **fs** | `tauri-plugin-fs` | `@tauri-apps/plugin-fs` | 文件系统操作 | 📦 按需安装 |
| **clipboard** | `tauri-plugin-clipboard-manager` | `@tauri-apps/plugin-clipboard-manager` | 剪贴板 | 📦 按需安装 |
| **pty** | `tauri-plugin-pty` | `@anthropic-ai/tauri-plugin-pty` | 伪终端（终端模拟器） | 📦 按需安装 |

### 数据存储插件

| 插件 | 用途 | 数据库支持 | 当前状态 |
|------|------|-----------|---------|
| **store** | 键值存储 | JSON 文件持久化 | ✅ 已安装 |
| **sql** | SQL 数据库 | SQLite / MySQL / PostgreSQL | ⭕ 未安装（使用 rusqlite） |

> **注意**: 本项目使用 **rusqlite** 直接操作 SQLite，而非 tauri-plugin-sql。

### 系统交互插件

| 插件 | 用途 | 当前状态 |
|------|------|---------|
| **process** | 进程管理（退出/重启） | ✅ 已安装 |
| **updater** | 应用自动更新 | ✅ 已安装 |
| **shell** | 执行系统命令、打开终端 | 📦 推荐 |
| **os** | 获取平台、架构、版本等系统信息 | 📦 推荐 |
| **notification** | 系统原生通知 | 📦 推荐 |
| **dialog** | 文件选择、消息确认对话框 | 📦 推荐 |
| **global-shortcut** | 全局快捷键 | 📦 按需安装 |
| **http** | HTTP 请求（前端发起） | 📦 按需安装（可用 reqwest 代替） |
| **websocket** | WebSocket 连接 | 📦 按需安装 |

### 插件初始化方式速查

| 初始化方式 | 适用插件 | 示例 |
|-----------|---------|------|
| `::init()` | 大多数插件 | `tauri_plugin_opener::init()` |
| `Builder::new().build()` | 需要配置的插件 | `tauri_plugin_store::Builder::new().build()` |
| `Builder::new().xxx().build()` | 需要链式配置 | `tauri_plugin_log::Builder::new().level(...).build()` |
| `Builder::new().build()` | updater | `tauri_plugin_updater::Builder::new().build()` |

---

## 插件集成 3 步法（适配三层架构）

### 步骤 1: 安装依赖

```toml
# src-tauri/Cargo.toml
[dependencies]
tauri-plugin-fs = "2"
```

```bash
pnpm add @tauri-apps/plugin-fs
```

### 步骤 2: 注册插件

```rust
// src-tauri/src/lib.rs
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_fs::init())    // 新增
        .invoke_handler(tauri::generate_handler![...])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 步骤 3: 声明权限

```json
// src-tauri/capabilities/default.json
{
  "permissions": [
    "core:default",
    "opener:default",
    "store:default",
    "log:default",
    "fs:default",              // 新增
    "fs:allow-read-text-file"  // 新增（细粒度权限）
  ]
}
```

---

## 在三层架构中使用插件

插件功能应遵循项目的三层架构（Database/Service/Command），避免在 Command 层直接堆砌业务逻辑。

### 方式一：插件功能封装到 Service 层

适用于大多数插件（shell、os、dialog、notification 等），插件提供的能力作为业务逻辑的一部分。

```rust
// ── Service 层封装插件逻辑 ──
// src-tauri/src/services/system.rs
use crate::error::AppError;

/// 获取系统信息（封装 os 插件或 std 能力）
pub fn get_system_info() -> Result<SystemInfo, AppError> {
    Ok(SystemInfo {
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    })
}

// ── Command 层暴露给前端 ──
// src-tauri/src/commands/system.rs
#[tauri::command]
pub fn get_system_info() -> Result<SystemInfo, String> {
    crate::services::system::get_system_info()
        .map_err(|e| e.to_string())
}
```

### 方式二：需要 AppHandle 的插件

某些插件 API 需要 `AppHandle`（如 notification、dialog、updater），通过 Command 参数注入。

```rust
// ── Command 层（注入 AppHandle）──
#[tauri::command]
pub async fn check_update(app: tauri::AppHandle) -> Result<bool, String> {
    crate::services::update::check_for_update(&app)
        .await
        .map_err(|e| e.to_string())
}

// ── Service 层（接收 AppHandle 引用）──
// src-tauri/src/services/update.rs
pub async fn check_for_update(app: &tauri::AppHandle) -> Result<bool, AppError> {
    let update = app.updater_builder().build()
        .map_err(|e| AppError::Custom(e.to_string()))?
        .check()
        .await
        .map_err(|e| AppError::Custom(e.to_string()))?;
    Ok(update.is_some())
}
```

### 方式三：前端直接使用插件 JS API

某些插件支持前端直接调用，无需经过 Rust Command（适用于简单场景）。

```typescript
// 前端直接使用 store 插件
import { Store } from "@tauri-apps/plugin-store";
const store = new Store("settings.json");
await store.set("theme", "dark");

// 前端直接使用 opener 插件
import { open } from "@tauri-apps/plugin-opener";
await open("https://example.com");

// 前端直接使用 process 插件
import { exit, relaunch } from "@tauri-apps/plugin-process";
await relaunch();
```

### 决策指南：Rust Command vs 前端 JS API

| 场景 | 推荐方式 | 原因 |
|------|---------|------|
| 简单读写配置 | 前端 JS API（store） | 无需业务逻辑 |
| 打开 URL/文件 | 前端 JS API（opener） | 简单操作 |
| 涉及数据库的操作 | Rust Command（三层架构） | 需要事务/校验 |
| 需要系统权限的操作 | Rust Command（三层架构） | 安全控制 |
| 复杂业务流程 | Rust Command（三层架构） | 业务逻辑属于后端 |
| 需要组合多个插件 | Rust Command（三层架构） | 统一编排 |

---

## 自定义 Tauri 插件

### 插件结构

```rust
use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

// 定义插件命令
#[tauri::command]
fn my_plugin_command() -> String {
    "Hello from plugin!".into()
}

// 构建插件
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("my-plugin")
        .invoke_handler(tauri::generate_handler![my_plugin_command])
        .build()
}
```

### 注册自定义插件

```rust
// src-tauri/src/lib.rs
mod my_plugin;

pub fn run() {
    tauri::Builder::default()
        .plugin(my_plugin::init())
        .invoke_handler(tauri::generate_handler![...])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 前端调用

```typescript
// 自定义插件的命令通过 invoke 调用
const result = await invoke("plugin:my-plugin|my_plugin_command");
```

---

## 项目数据存储策略

本项目采用双数据存储方案：

| 存储方式 | 用途 | 数据类型 | 实现方式 |
|---------|------|---------|---------|
| **tauri-plugin-store** | 应用配置 | 键值对 | JSON 文件 |
| **rusqlite** | 业务数据 | 结构化数据 | SQLite 数据库 |

### tauri-plugin-store 使用示例

```typescript
// 前端直接使用
import { Store } from "@tauri-apps/plugin-store";

const store = new Store("settings.json");
await store.set("theme", "dark");
const theme = await store.get<string>("theme");
```

### rusqlite 使用示例

```rust
// 在三层架构中使用
// database/user.rs
use rusqlite::{Connection, Result};
use crate::models::User;

pub fn get_user(conn: &Connection, id: i64) -> Result<User, rusqlite::Error> {
    conn.query_row(
        "SELECT id, name FROM users WHERE id = ?1",
        [id],
        |row| Ok(User {
            id: row.get(0)?,
            name: row.get(1)?,
        })
    )
}

// services/user.rs
use crate::database;
use crate::error::AppError;

pub fn fetch_user(id: i64) -> Result<User, AppError> {
    let conn = get_connection()?;
    Ok(database::user::get_user(&conn, id)?)
}

// commands/user.rs
#[tauri::command]
pub fn get_user(id: i64) -> Result<User, String> {
    crate::services::user::fetch_user(id)
        .map_err(|e| e.to_string())
}
```

---

## 排查插件问题

| 症状 | 可能原因 | 解决方法 |
|------|---------|---------|
| "Command not found" | 插件未注册 | 检查 lib.rs 中的 .plugin() |
| "Permission denied" | Capabilities 未声明 | 添加权限到 capabilities/default.json |
| 编译错误 | 版本不兼容 | Cargo.toml + package.json 版本对齐（都用 2.x） |
| 运行时无效 | 缺少 JS 绑定 | 检查是否安装对应的 npm 包 |
| 数据库错误 | rusqlite 配置问题 | 检查 features = ["bundled"] |
| 插件 init 方式错误 | 用了 `init()` 但插件需要 `Builder` | 参考"插件初始化方式速查"表 |

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 只装 Cargo 不装 npm | Rust 和 npm 包都要安装 |
| 注册插件但不声明权限 | 每个插件都要配 Capabilities |
| 不看插件文档直接用 | 先查看插件 README 了解 API |
| Tauri v1 API 用于 v2 | v1 和 v2 API 不同，检查版本 |
| 混用 tauri-plugin-sql 和 rusqlite | 选择一种数据库方案，本项目用 rusqlite |
| 在 Command 层直接使用插件 | 通过三层架构（Database → Service → Command）组织代码 |
| 所有操作都走 Rust Command | 简单插件操作可前端直接用 JS API |
| 不区分 init() 和 Builder 模式 | 查看插件文档确认正确的初始化方式 |
