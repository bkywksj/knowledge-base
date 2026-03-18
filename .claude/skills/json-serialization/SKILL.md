---
name: json-serialization
description: |
  Tauri 项目中 JSON 序列化/反序列化技能，覆盖 Rust serde 和 TypeScript 类型系统。

  触发场景：
  - 需要定义 Rust 和 TypeScript 之间的数据传输类型
  - 需要处理 JSON 序列化/反序列化
  - 需要处理复杂嵌套数据结构
  - serde 配置和自定义序列化

  触发词：JSON、序列化、serde、类型转换、数据传输、Serialize、Deserialize
---

# JSON 序列化与类型映射

## 核心概念

Tauri IPC 通信基于 JSON：Rust 数据 ←→ JSON ←→ TypeScript 数据。

`serde` 是 Rust 的标准序列化框架，负责 Rust struct ↔ JSON 的自动转换。

---

## 项目三层架构中的类型流动

在本项目中，数据类型在三层之间流动：

```
models/mod.rs (数据模型)
    ↓ 序列化
database/ (数据库层) → services/ (业务层) → commands/ (命令层)
    ↓ JSON
TypeScript types (src/types/index.ts)
    ↓
React 组件 (src/pages/)
```

### 实际示例：AppConfig

**Rust 数据模型** (`src-tauri/src/models/mod.rs`):

```rust
use serde::{Deserialize, Serialize};

/// 应用配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub key: String,
    pub value: String,
}
```

**TypeScript 类型** (`src/types/index.ts`):

```typescript
export interface AppConfig {
  key: string;
  value: string;
}
```

**在 Database 层使用**:

```rust
// database/config.rs
use crate::models::AppConfig;

pub fn get_config(conn: &Connection, key: &str) -> Result<AppConfig, AppError> {
    // 从数据库查询并反序列化为 AppConfig
    Ok(AppConfig { key: key.into(), value: "...".into() })
}
```

**在 Service 层传递**:

```rust
// services/config.rs
use crate::models::AppConfig;

pub fn read_config(key: &str) -> Result<AppConfig, AppError> {
    let conn = get_connection()?;
    database::config::get_config(&conn, key)
}
```

**在 Command 层返回**:

```rust
// commands/config.rs
use crate::models::AppConfig;

#[tauri::command]
pub fn get_config(key: String) -> Result<AppConfig, String> {
    services::config::read_config(&key)
        .map_err(|e| e.to_string())
}
```

**前端调用** (`src/lib/api/index.ts`):

```typescript
import { invoke } from "@tauri-apps/api/core";
import type { AppConfig } from "@/types";

export const api = {
  getConfig: (key: string) => invoke<AppConfig>("get_config", { key }),
};
```

---

## Rust ↔ TypeScript 类型映射

| Rust 类型 | JSON 类型 | TypeScript 类型 |
|-----------|----------|----------------|
| `String` | `string` | `string` |
| `&str` | `string` | `string` |
| `i32` / `i64` / `u32` / `u64` | `number` | `number` |
| `f32` / `f64` | `number` | `number` |
| `bool` | `boolean` | `boolean` |
| `Vec<T>` | `array` | `T[]` |
| `Option<T>` | `T \| null` | `T \| null` |
| `HashMap<String, T>` | `object` | `Record<string, T>` |
| `()` | `null` | `void` |
| `(A, B)` | `[A, B]` | `[A, B]` |
| enum (unit variants) | `string` | `string literal union` |
| enum (data variants) | `object` | `discriminated union` |

---

## 实际项目示例

### SystemInfo（只序列化）

```rust
// src-tauri/src/models/mod.rs
use serde::Serialize;

/// 系统信息（仅发送给前端，不需要反序列化）
#[derive(Debug, Clone, Serialize)]
pub struct SystemInfo {
    pub os: String,
    pub arch: String,
    pub app_version: String,
    pub data_dir: String,
}
```

对应 TypeScript:

```typescript
// src/types/index.ts
export interface SystemInfo {
  os: string;
  arch: string;
  app_version: string;
  data_dir: string;
}
```

### 高级用法：字段重命名

```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]  // 全部字段转 camelCase
struct Config {
    max_retries: u32,       // JSON: "maxRetries"
    timeout_ms: u64,        // JSON: "timeoutMs"
}

#[derive(Serialize, Deserialize)]
struct Item {
    #[serde(rename = "type")]  // Rust 保留字
    item_type: String,
}
```

### 默认值

```rust
#[derive(Serialize, Deserialize)]
struct Settings {
    #[serde(default)]
    dark_mode: bool,            // 缺失时默认 false

    #[serde(default = "default_port")]
    port: u16,                  // 缺失时使用自定义默认值
}

fn default_port() -> u16 { 8080 }
```

### 跳过序列化

```rust
#[derive(Serialize, Deserialize)]
struct Internal {
    name: String,

    #[serde(skip)]
    cache: Vec<u8>,             // 不参与序列化/反序列化

    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>, // None 时不输出字段
}
```

### 枚举序列化

```rust
// 简单枚举 → 字符串
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Status {
    Active,      // "active"
    Inactive,    // "inactive"
    Pending,     // "pending"
}

// 带数据的枚举 → tagged union
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
enum Message {
    Text(String),                    // {"type":"Text","data":"hello"}
    Image { url: String, width: u32 }, // {"type":"Image","data":{"url":"...","width":100}}
}
```

对应 TypeScript:

```typescript
type Status = "active" | "inactive" | "pending";

type Message =
  | { type: "Text"; data: string }
  | { type: "Image"; data: { url: string; width: number } };
```

---

## 在三层架构中使用

### 定义模型 (models/mod.rs)

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: i64,
    pub name: String,
    pub email: Option<String>,
}
```

### Database 层返回模型

```rust
// database/user.rs
use crate::models::User;

pub fn get_user(conn: &Connection, id: i64) -> Result<User, AppError> {
    // 查询并构造 User
    Ok(User { id, name: "Alice".into(), email: None })
}
```

### Service 层处理业务

```rust
// services/user.rs
use crate::models::User;

pub fn fetch_user(id: i64) -> Result<User, AppError> {
    let conn = get_connection()?;
    database::user::get_user(&conn, id)
}
```

### Command 层对接前端

```rust
// commands/user.rs
use crate::models::User;

#[tauri::command]
pub fn get_user(id: i64) -> Result<User, String> {
    services::user::fetch_user(id)
        .map_err(|e| e.to_string())
}
```

### 前端类型安全调用

```typescript
// src/types/index.ts
export interface User {
  id: number;
  name: string;
  email: string | null;
}

// src/lib/api/index.ts
import { invoke } from "@tauri-apps/api/core";
import type { User } from "@/types";

export const api = {
  getUser: (id: number) => invoke<User>("get_user", { id }),
};

// src/pages/UserPage.tsx
import { api } from "@/lib/api";

const user = await api.getUser(1); // 类型安全
```

---

## 错误处理中的序列化

项目使用 `thiserror` 定义统一错误类型：

```rust
// src-tauri/src/error.rs
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),

    #[error("数据库错误: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("未找到: {0}")]
    NotFound(String),
}

// 转换为 String 供 Tauri Command 使用
impl From<AppError> for String {
    fn from(err: AppError) -> String {
        err.to_string()
    }
}
```

Command 中使用：

```rust
#[tauri::command]
pub fn my_command() -> Result<MyData, String> {
    let data = services::my_service()
        .map_err(|e: AppError| e.to_string())?; // 自动转换
    Ok(data)
}
```

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 忘记 derive Serialize/Deserialize | Command 参数和返回值都需要 derive |
| Rust snake_case 不加 rename_all | 添加 `#[serde(rename_all = "camelCase")]` 或让 Tauri 自动转换 |
| Option 字段在 TS 中标记为 T | 正确标记为 `T \| null` |
| 不处理枚举的序列化格式 | 使用 `#[serde(tag, content)]` 控制格式 |
| models 中的类型不共享 | 在 models/mod.rs 中统一定义，三层共享 |
| TypeScript 类型与 Rust 不一致 | 保持 src/types/index.ts 与 models/mod.rs 同步 |
