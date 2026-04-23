---
name: tauri-commands
description: |
  Tauri Command 高级开发技能，覆盖异步 Command、状态注入、流式传输、事件通知等高级模式。

  触发场景：
  - 需要开发复杂的 Tauri Command
  - 需要 Command 中访问 AppHandle/Window
  - 需要实现进度回报/流式数据
  - 需要 Command 之间共享逻辑

  触发词：Command、tauri::command、invoke、高级Command、async command、进度、stream
---

# Tauri Command 高级开发

## 模块化组织（三层架构）

### 按功能拆分 Command

```
src-tauri/src/
├── commands/           → Command 模块（薄 IPC 包装）
│   ├── mod.rs          → 导出所有 Command 模块
│   ├── config.rs       → 配置管理 Commands
│   ├── system.rs       → 系统信息 Commands
│   └── user.rs         → 用户管理 Commands (示例)
├── services/           → Service 模块（业务逻辑）
│   ├── mod.rs
│   ├── config.rs       → 配置业务逻辑
│   └── user.rs         → 用户业务逻辑
├── database/
│   ├── mod.rs          → Database 结构体 + CRUD 方法
│   └── schema.rs       → 版本化 Schema 迁移
├── models/
│   └── mod.rs          → 所有数据模型
└── lib.rs              → 统一注册 Commands
```

### commands/mod.rs 模式

```rust
// src-tauri/src/commands/mod.rs
pub mod config;
pub mod system;
pub mod user;
```

### 实现 Command 模块（薄包装模式）

> Command 只做：接收参数 → 调用 Service → 转换错误。不包含业务逻辑。

```rust
// src-tauri/src/commands/config.rs
use crate::services::config::ConfigService;
use crate::state::AppState;
use tauri::State;

/// 获取所有配置
#[tauri::command]
pub fn get_all_config(state: State<'_, AppState>) -> Result<Vec<AppConfig>, String> {
    ConfigService::get_all(&state.db).map_err(|e| e.to_string())
}

/// 设置配置
#[tauri::command]
pub fn set_config(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    ConfigService::set(&state.db, &key, &value).map_err(|e| e.to_string())
}
```

```rust
// src-tauri/src/commands/system.rs
use tauri::Manager;
use crate::models::SystemInfo;

/// 获取系统信息
#[tauri::command]
pub fn get_system_info(app: tauri::AppHandle) -> Result<SystemInfo, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "unknown".into());

    Ok(SystemInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        app_version: app.package_info().version.to_string(),
        data_dir,
    })
}

/// 简单的 greet 命令（保留为示例）
#[tauri::command]
pub fn greet(name: &str) -> Result<String, String> {
    if name.is_empty() {
        return Err("名称不能为空".into());
    }
    Ok(format!("Hello, {}! 来自 Rust 的问候!", name))
}
```

### lib.rs 统一注册

```rust
// src-tauri/src/lib.rs
mod commands;
mod database;
mod error;
mod models;
mod services;
mod state;

use database::Database;
use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("app.db");
            let db = Database::init(db_path.to_str().unwrap())?;
            app.manage(AppState { db });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // config Commands
            commands::config::get_all_config,
            commands::config::get_config,
            commands::config::set_config,
            commands::config::delete_config,
            // system Commands
            commands::system::get_system_info,
            commands::system::greet,
            // user Commands
            commands::user::list_users,
            commands::user::create_user,
            // 随项目增长添加更多模块...
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

---

## Command 注入参数

Tauri Command 除了接收前端传来的参数，还可以注入框架对象。

### 注入 AppHandle（应用句柄）

```rust
#[tauri::command]
fn with_app(app: tauri::AppHandle) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    Ok(data_dir.to_string_lossy().into())
}
```

### 注入 Window（当前窗口）

```rust
#[tauri::command]
fn with_window(window: tauri::Window) -> Result<(), String> {
    window.set_title("新标题")
        .map_err(|e| e.to_string())?;
    Ok(())
}
```

### 注入 State（全局状态）

```rust
use tauri::State;
use crate::database::Database;

#[tauri::command]
fn with_state(db: State<'_, Database>) -> Result<Vec<String>, String> {
    // 使用 Database 状态
    db.get_all_config()
        .map(|configs| configs.into_iter().map(|c| c.key).collect())
        .map_err(|e| e.to_string())
}
```

### 组合注入

```rust
#[tauri::command]
async fn complex_cmd(
    app: tauri::AppHandle,          // 注入 AppHandle
    window: tauri::Window,          // 注入 Window
    db: State<'_, Database>,        // 注入 State
    user_id: u32,                   // 前端参数
    name: String,                   // 前端参数
) -> Result<String, String> {
    // 1. 使用 AppHandle 获取应用信息
    let version = app.package_info().version.to_string();

    // 2. 使用 Window 操作窗口
    window.set_title(&format!("用户 {}", name))
        .map_err(|e| e.to_string())?;

    // 3. 使用 Database 查询数据
    let config = db.get_config("theme")
        .map_err(|e| e.to_string())?;

    // 4. 使用前端参数
    Ok(format!("版本: {}, 用户: {}, ID: {}", version, name, user_id))
}
```

---

## 异步 Command

### 基础异步 Command

```rust
// 异步 Command（不阻塞主线程）
#[tauri::command]
async fn fetch_url(url: String) -> Result<String, String> {
    reqwest::get(&url)
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())
}
```

### 依赖配置

```toml
# Cargo.toml
[dependencies]
reqwest = { version = "0.12", features = ["json"] }
tokio = { version = "1", features = ["full"] }
```

### 前端调用（无需改变）

```typescript
// 前端调用异步 Command 与同步 Command 完全一样
const result = await invoke<string>("fetch_url", {
  url: "https://example.com/api/data"
});
```

---

## 进度回报模式

### 后端：使用事件发送进度

```rust
use tauri::{Emitter, Window};

#[tauri::command]
async fn long_task(window: Window) -> Result<String, String> {
    for i in 0..100 {
        // 模拟长时间任务
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // 发送进度事件
        window.emit("progress", i)
            .map_err(|e| e.to_string())?;
    }

    Ok("任务完成".into())
}
```

### 前端：监听进度事件

```typescript
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Progress, message } from "antd";

function LongTaskComponent() {
  const [progress, setProgress] = useState(0);
  const [loading, setLoading] = useState(false);

  async function startTask() {
    setLoading(true);

    // 监听进度事件
    const unlisten = await listen<number>("progress", (event) => {
      setProgress(event.payload);
    });

    try {
      const result = await invoke<string>("long_task");
      message.success(result);
    } catch (error) {
      message.error(`任务失败: ${error}`);
    } finally {
      setLoading(false);
      unlisten();  // 清理监听器
    }
  }

  return (
    <div>
      <Button onClick={startTask} loading={loading}>
        开始任务
      </Button>
      {loading && <Progress percent={progress} />}
    </div>
  );
}
```

---

## Command 中执行子进程（Windows 防弹窗）

> **强制规则**: 在 Command 中使用 `std::process::Command` 或 `tokio::process::Command` 启动子进程时，**必须**在 Windows 上设置 `CREATE_NO_WINDOW` 标志，否则打包后每次调用都会弹出 CMD 黑窗口。

### 原理

- **开发模式** (`tauri dev`)：Rust 进程运行在终端中，子进程继承父进程控制台，不弹窗
- **打包后** (`.exe`)：应用是 GUI 进程（无控制台），Windows 自动为子进程创建新控制台窗口

### std::process::Command（同步）

```rust
#[tauri::command]
pub fn detect_tool() -> Result<String, String> {
    let mut cmd = std::process::Command::new("tool");
    cmd.arg("--version");
    // Windows: 防止弹出 CMD 窗口
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
```

### tokio::process::Command（异步）

```rust
#[tauri::command]
pub async fn run_npm_command() -> Result<String, String> {
    let npm_cmd = if cfg!(target_os = "windows") { "npm.cmd" } else { "npm" };
    let mut cmd = tokio::process::Command::new(npm_cmd);
    cmd.args(["view", "some-package", "--json"]);
    // Windows: tokio Command 内置 creation_flags，无需额外 import
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().await.map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}
```

### 辅助函数模式（多处调用时推荐）

```rust
/// 创建不弹出 CMD 窗口的 Command（Windows 专用）
#[cfg(target_os = "windows")]
fn silent_command(program: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut cmd = std::process::Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

// 使用: silent_command("wmic").args(["baseboard", "get", "serialnumber"]).output()
```

### 关键区别

| API | `creation_flags` 来源 | 需要额外 import |
|-----|---------------------|----------------|
| `std::process::Command` | `std::os::windows::process::CommandExt` trait | **需要** `use std::os::windows::process::CommandExt;` |
| `tokio::process::Command` | 内置方法 | **不需要**额外 import |

---

## 错误处理最佳实践

### 使用 AppError 枚举

```rust
use crate::error::AppError;

#[tauri::command]
fn safe_read(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path)
        .map_err(|e| AppError::Io(e).to_string())
}
```

### 结构化错误响应

```rust
use serde::Serialize;

#[derive(Debug, Serialize)]
struct CommandError {
    code: String,
    message: String,
}

// 在 Command 中使用
#[tauri::command]
fn structured_error() -> Result<String, CommandError> {
    Err(CommandError {
        code: "NOT_FOUND".into(),
        message: "资源不存在".into(),
    })
}
```

```typescript
// 前端处理结构化错误
try {
  await invoke("structured_error");
} catch (e) {
  const error = e as { code: string; message: string };
  if (error.code === "NOT_FOUND") {
    message.error("资源不存在");
  }
}
```

---

## 批量操作模式

### 后端：批量处理

```rust
use crate::database::Database;
use tauri::State;

#[derive(serde::Deserialize)]
struct BatchConfigInput {
    configs: Vec<(String, String)>,
}

#[tauri::command]
fn set_batch_config(
    db: State<'_, Database>,
    input: BatchConfigInput,
) -> Result<(), String> {
    for (key, value) in input.configs {
        db.set_config(&key, &value)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
```

### 前端：批量调用

```typescript
await invoke("set_batch_config", {
  input: {
    configs: [
      ["theme", "dark"],
      ["language", "zh-CN"],
      ["fontSize", "14"]
    ]
  }
});
```

---

## Command 参数验证模式

```rust
#[tauri::command]
fn create_user(name: String, age: u32) -> Result<String, String> {
    // 验证参数
    if name.is_empty() {
        return Err("名称不能为空".into());
    }
    if age < 18 {
        return Err("年龄必须大于等于18".into());
    }

    // 业务逻辑...
    Ok(format!("用户 {} ({} 岁) 创建成功", name, age))
}
```

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 同步 Command 做网络请求 | 使用 `async` Command |
| 不用 emit 通知进度 | 长任务通过事件回报进度 |
| 所有 Command 写在 lib.rs | 按模块拆分到 `commands/` 目录 |
| 忘记 pub 导出 Command 函数 | 跨模块 Command 必须 `pub fn` |
| 组合注入时参数顺序错误 | 先注入对象，后前端参数 |
| 前端不清理事件监听 | `useEffect` 中返回 `unlisten` |
| 异步 Command 阻塞线程 | 使用 `tokio::time::sleep` 而非 `std::thread::sleep` |
| Command 中裸用 `Command::new()` 启动子进程 | Windows 必须设置 `CREATE_NO_WINDOW` (0x08000000) 标志，否则打包后弹 CMD 窗口 |

---

## 完整示例：文件批量处理

### 后端 Command

```rust
use tauri::{Emitter, Window};
use std::path::PathBuf;

#[derive(serde::Deserialize)]
struct ProcessFilesInput {
    files: Vec<String>,
}

#[tauri::command]
async fn process_files(
    window: Window,
    input: ProcessFilesInput,
) -> Result<u32, String> {
    let total = input.files.len();
    let mut processed = 0;

    for (idx, file_path) in input.files.iter().enumerate() {
        // 发送进度
        window.emit("file-progress", (idx + 1, total))
            .map_err(|e| e.to_string())?;

        // 处理文件
        match process_single_file(file_path).await {
            Ok(_) => {
                processed += 1;
                window.emit("file-success", file_path)
                    .map_err(|e| e.to_string())?;
            }
            Err(e) => {
                window.emit("file-error", (file_path, e.to_string()))
                    .map_err(|e| e.to_string())?;
            }
        }

        // 模拟处理延迟
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }

    Ok(processed)
}

async fn process_single_file(path: &str) -> Result<(), String> {
    // 实际的文件处理逻辑...
    Ok(())
}
```

### 前端调用

```typescript
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Progress, message, List } from "antd";

function FileProcessor() {
  const [progress, setProgress] = useState<[number, number]>([0, 0]);
  const [logs, setLogs] = useState<string[]>([]);

  async function handleProcess(files: string[]) {
    const listeners: UnlistenFn[] = [];

    // 监听进度
    listeners.push(
      await listen<[number, number]>("file-progress", (e) => {
        setProgress(e.payload);
      })
    );

    // 监听成功
    listeners.push(
      await listen<string>("file-success", (e) => {
        setLogs((prev) => [...prev, `✓ ${e.payload}`]);
      })
    );

    // 监听错误
    listeners.push(
      await listen<[string, string]>("file-error", (e) => {
        setLogs((prev) => [...prev, `✗ ${e.payload[0]}: ${e.payload[1]}`]);
      })
    );

    try {
      const processed = await invoke<number>("process_files", {
        input: { files }
      });
      message.success(`成功处理 ${processed} 个文件`);
    } catch (error) {
      message.error(`处理失败: ${error}`);
    } finally {
      // 清理监听器
      listeners.forEach((unlisten) => unlisten());
    }
  }

  const [current, total] = progress;
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;

  return (
    <div>
      <Progress percent={percent} status="active" />
      <List
        dataSource={logs}
        renderItem={(item) => <List.Item>{item}</List.Item>}
      />
    </div>
  );
}
```

---

## 检查清单

- [ ] Command 按模块拆分（`commands/*.rs`）
- [ ] Command 在 `commands/mod.rs` 中导出
- [ ] Command 在 `lib.rs` 中注册
- [ ] 异步 Command 使用 `async fn`
- [ ] 长任务使用 `emit` 回报进度
- [ ] 注入参数顺序正确（框架对象在前）
- [ ] 前端清理事件监听（`unlisten()`）
- [ ] 参数验证在 Command 入口处理
