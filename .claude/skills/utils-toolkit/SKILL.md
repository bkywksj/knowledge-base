---
name: utils-toolkit
description: |
  Tauri 项目工具函数和常用 crate 技能，提供 Rust 和 TypeScript 的实用工具集。

  触发场景：
  - 需要常用工具函数
  - 需要选择合适的 Rust crate
  - 需要封装通用功能
  - 需要日期/文件/字符串处理工具

  触发词：工具、工具函数、crate、工具类、日期处理、文件处理、字符串处理、通用
---

# 工具函数与常用 Crate

## Rust 常用 Crate 推荐

### 核心 Crate

| Crate | 版本 | 用途 | Cargo.toml |
|-------|------|------|-----------|
| `serde` | 1.x | 序列化/反序列化 | `serde = { version = "1", features = ["derive"] }` |
| `serde_json` | 1.x | JSON 处理 | `serde_json = "1"` |
| `thiserror` | 1.x | 错误类型定义 | `thiserror = "1"` |
| `anyhow` | 1.x | 简化错误处理 | `anyhow = "1"` |
| `tokio` | 1.x | 异步运行时 | `tokio = { version = "1", features = ["full"] }` |
| `log` | 0.4 | 日志接口 | `log = "0.4"` |

### 常用功能 Crate

| Crate | 用途 | 示例 |
|-------|------|------|
| `chrono` | 日期时间 | `chrono::Local::now()` |
| `uuid` | UUID 生成 | `Uuid::new_v4().to_string()` |
| `reqwest` | HTTP 客户端 | `reqwest::get(url).await?` |
| `regex` | 正则表达式 | `Regex::new(r"pattern")?` |
| `dirs` | 系统目录 | `dirs::home_dir()` |
| `walkdir` | 递归遍历目录 | `WalkDir::new(path)` |
| `sha2` | 哈希计算 | `Sha256::digest(data)` |
| `base64` | Base64 编解码 | `base64::encode(data)` |

### Tauri 插件

| 插件 | 用途 | 安装 |
|------|------|------|
| `tauri-plugin-sql` | SQLite/MySQL/PostgreSQL | `tauri-plugin-sql = "2"` |
| `tauri-plugin-store` | 键值存储 | `tauri-plugin-store = "2"` |
| `tauri-plugin-fs` | 文件系统 | `tauri-plugin-fs = "2"` |
| `tauri-plugin-dialog` | 对话框 | `tauri-plugin-dialog = "2"` |
| `tauri-plugin-notification` | 系统通知 | `tauri-plugin-notification = "2"` |
| `tauri-plugin-clipboard-manager` | 剪贴板 | `tauri-plugin-clipboard-manager = "2"` |
| `tauri-plugin-shell` | 执行系统命令 | `tauri-plugin-shell = "2"` |
| `tauri-plugin-http` | HTTP 请求 | `tauri-plugin-http = "2"` |
| `tauri-plugin-updater` | 应用更新 | `tauri-plugin-updater = "2"` |
| `tauri-plugin-log` | 日志系统 | `tauri-plugin-log = "2"` |

---

## 常用工具函数

### Rust 工具函数

```rust
// 日期格式化
use chrono::Local;
fn now_string() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

// UUID 生成
use uuid::Uuid;
fn new_id() -> String {
    Uuid::new_v4().to_string()
}

// 文件读写
fn read_json<T: serde::de::DeserializeOwned>(path: &str) -> Result<T, String> {
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

fn write_json<T: serde::Serialize>(path: &str, data: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}
```

### TypeScript 工具函数

```typescript
import { invoke } from "@tauri-apps/api/core";

// 通用 Command 调用封装
async function safeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<[T | null, string | null]> {
  try {
    const result = await invoke<T>(cmd, args);
    return [result, null];
  } catch (e) {
    return [null, String(e)];
  }
}

// 防抖
function debounce<T extends (...args: unknown[]) => void>(fn: T, delay: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: unknown[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  }) as T;
}

// 格式化文件大小
function formatFileSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(1)} ${units[i]}`;
}
```

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 重新实现已有 crate 的功能 | 先搜索 crates.io 看是否有现成方案 |
| 使用过大的 crate 只为一个小功能 | 权衡编译时间，考虑轻量替代品 |
| 不考虑跨平台 | 路径操作用 `std::path::Path`，避免硬编码分隔符 |
| 前端直接操作系统资源 | 通过 Rust Command 或 Tauri 插件 |
