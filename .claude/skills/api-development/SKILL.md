---
name: api-development
description: |
  Tauri Command (IPC API) 开发技能，指导如何设计和实现 Rust Command 供前端调用。

  触发场景：
  - 需要创建新的 Tauri Command
  - 需要设计前后端通信接口
  - 需要处理 Command 的参数和返回值
  - 需要实现异步 Command

  触发词：Command、API、invoke、IPC、接口、通信、前后端
---

# Tauri Command (IPC API) 开发

## 核心概念

在 Tauri 中，前后端通信通过 **Command** 实现，替代传统 Web 应用的 HTTP REST API。

```
传统 Web:  GET /api/users  →  Controller  →  Service  →  DAO
Tauri:     invoke("get_users")  →  Command  →  Service  →  Database
```

---

## 三层架构 Command 开发流程

### 完整步骤

```
1. 定义数据模型 (models.rs: struct + Serialize/Deserialize)
2. 实现 Database 层 (database/mod.rs: CRUD 方法)
3. 实现 Service 层（可选） (services/*.rs: 业务逻辑)
4. 实现 Command 层 (commands/*.rs: #[tauri::command])
5. 注册到 Builder (lib.rs: generate_handler![])
6. 定义 TypeScript 接口 (src/types/index.ts)
7. 封装前端 API (src/lib/api/index.ts)
8. 组件中调用 (src/pages/*.tsx)
```

---

## 示例：配置管理 API

### 第 1 步：定义数据模型

```rust
// src-tauri/src/models.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Deserialize)]
pub struct SetConfigInput {
    pub key: String,
    pub value: String,
}
```

### 第 2 步：实现 Database 层

```rust
// src-tauri/src/database/mod.rs
use crate::error::AppError;
use crate::models::AppConfig;

impl Database {
    /// 获取所有配置
    pub fn get_all_config(&self) -> Result<Vec<AppConfig>, AppError> {
        let conn = self.conn.lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let mut stmt = conn.prepare("SELECT key, value FROM app_config ORDER BY key")?;
        let configs = stmt
            .query_map([], |row| {
                Ok(AppConfig {
                    key: row.get(0)?,
                    value: row.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(configs)
    }

    /// 获取单个配置
    pub fn get_config(&self, key: &str) -> Result<Option<String>, AppError> {
        let conn = self.conn.lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let mut stmt = conn.prepare("SELECT value FROM app_config WHERE key = ?1")?;
        Ok(stmt.query_row([key], |row| row.get(0)).ok())
    }

    /// 设置配置（Upsert）
    pub fn set_config(&self, key: &str, value: &str) -> Result<(), AppError> {
        let conn = self.conn.lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        conn.execute(
            "INSERT INTO app_config (key, value, updated_at)
             VALUES (?1, ?2, datetime('now', 'localtime'))
             ON CONFLICT(key) DO UPDATE SET
               value = excluded.value,
               updated_at = excluded.updated_at",
            [key, value],
        )?;

        Ok(())
    }

    /// 删除配置
    pub fn delete_config(&self, key: &str) -> Result<bool, AppError> {
        let conn = self.conn.lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let affected = conn.execute("DELETE FROM app_config WHERE key = ?1", [key])?;
        Ok(affected > 0)
    }
}
```

### 第 3 步：实现 Service 层（可选）

```rust
// src-tauri/src/services/config_service.rs
use crate::database::Database;
use crate::error::AppError;

pub struct ConfigService;

impl ConfigService {
    pub fn new() -> Self {
        Self
    }

    /// 业务逻辑：获取必需配置（不存在则报错）
    pub fn get_required(&self, db: &Database, key: &str) -> Result<String, AppError> {
        db.get_config(key)?
            .ok_or_else(|| AppError::NotFound(format!("配置 {} 不存在", key)))
    }

    /// 业务逻辑：验证配置值格式
    pub fn set_with_validation(
        &self,
        db: &Database,
        key: &str,
        value: &str,
    ) -> Result<(), AppError> {
        // 示例：验证主题值
        if key == "theme" && !["light", "dark"].contains(&value) {
            return Err(AppError::InvalidInput(
                "主题只能是 light 或 dark".into()
            ));
        }

        db.set_config(key, value)
    }
}
```

### 第 4 步：实现 Command 层

```rust
// src-tauri/src/commands/config.rs
use tauri::State;
use crate::database::Database;
use crate::models::AppConfig;

/// 获取所有配置
#[tauri::command]
pub fn get_all_config(db: State<'_, Database>) -> Result<Vec<AppConfig>, String> {
    db.get_all_config()
        .map_err(|e| e.to_string())
}

/// 获取单个配置
#[tauri::command]
pub fn get_config(db: State<'_, Database>, key: String) -> Result<String, String> {
    db.get_config(&key)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("配置 {} 不存在", key))
}

/// 设置配置
#[tauri::command]
pub fn set_config(
    db: State<'_, Database>,
    key: String,
    value: String,
) -> Result<(), String> {
    // 可以在这里调用 Service 层做业务验证
    db.set_config(&key, &value)
        .map_err(|e| e.to_string())
}

/// 删除配置
#[tauri::command]
pub fn delete_config(db: State<'_, Database>, key: String) -> Result<bool, String> {
    db.delete_config(&key)
        .map_err(|e| e.to_string())
}
```

### 第 5 步：注册 Command

```rust
// src-tauri/src/commands/mod.rs
pub mod config;
pub mod system;

// src-tauri/src/lib.rs
mod commands;
mod database;
mod error;
mod models;
mod services;

use database::Database;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("app.db");
            let db = Database::init(db_path.to_str().unwrap())?;
            app.manage(db);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::config::get_all_config,
            commands::config::get_config,
            commands::config::set_config,
            commands::config::delete_config,
            commands::system::get_system_info,
            commands::system::greet,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 第 6 步：定义 TypeScript 接口

```typescript
// src/types/index.ts
export interface AppConfig {
  key: string;
  value: string;
}

export interface SystemInfo {
  os: string;
  arch: string;
  app_version: string;
  data_dir: string;
}
```

### 第 7 步：封装前端 API

```typescript
// src/lib/api/index.ts
import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, SystemInfo } from "@/types";

/** 配置管理 API */
export const configApi = {
  getAll: () => invoke<AppConfig[]>("get_all_config"),
  get: (key: string) => invoke<string>("get_config", { key }),
  set: (key: string, value: string) =>
    invoke<void>("set_config", { key, value }),
  delete: (key: string) => invoke<boolean>("delete_config", { key }),
};

/** 系统相关 API */
export const systemApi = {
  greet: (name: string) => invoke<string>("greet", { name }),
  getSystemInfo: () => invoke<SystemInfo>("get_system_info"),
};
```

### 第 8 步：组件中调用

```tsx
// src/pages/ConfigPage.tsx
import { useState, useEffect } from "react";
import { Button, Table, message } from "antd";
import { configApi } from "@/lib/api";
import type { AppConfig } from "@/types";

export default function ConfigPage() {
  const [configs, setConfigs] = useState<AppConfig[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadConfigs();
  }, []);

  async function loadConfigs() {
    setLoading(true);
    try {
      const data = await configApi.getAll();
      setConfigs(data);
    } catch (error) {
      message.error(`加载失败: ${error}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(key: string) {
    try {
      const deleted = await configApi.delete(key);
      if (deleted) {
        message.success("删除成功");
        loadConfigs();
      }
    } catch (error) {
      message.error(`删除失败: ${error}`);
    }
  }

  return (
    <div className="p-6">
      <Table
        dataSource={configs}
        rowKey="key"
        loading={loading}
        columns={[
          { title: "键", dataIndex: "key" },
          { title: "值", dataIndex: "value" },
          {
            title: "操作",
            render: (_, record) => (
              <Button danger size="small" onClick={() => handleDelete(record.key)}>
                删除
              </Button>
            ),
          },
        ]}
      />
    </div>
  );
}
```

---

## Command 设计规范

### 命名规范（RESTful 风格）

| 操作 | Rust 函数名 | invoke 调用 | HTTP 类比 |
|------|-----------|------------|----------|
| 查询列表 | `get_all_config` | `invoke("get_all_config")` | `GET /api/config` |
| 查询单个 | `get_config` | `invoke("get_config", { key })` | `GET /api/config/:key` |
| 创建 | `create_user` | `invoke("create_user", { input })` | `POST /api/users` |
| 更新 | `update_user` | `invoke("update_user", { id, input })` | `PUT /api/users/:id` |
| 删除 | `delete_config` | `invoke("delete_config", { key })` | `DELETE /api/config/:key` |

### 参数传递规则

```rust
// ✅ 正确：Rust 参数名用 snake_case
#[tauri::command]
fn create_user(user_name: String, user_email: String) -> Result<User, String> {
    // ...
}

// 前端调用：TypeScript 参数名用 camelCase（Tauri 自动转换）
await invoke("create_user", {
  userName: "Alice",
  userEmail: "alice@example.com"
});
```

### 返回值规范

```rust
// ✅ 无返回值
#[tauri::command]
fn do_action() -> Result<(), String>

// ✅ 返回单个对象
#[tauri::command]
fn get_item(id: u32) -> Result<Item, String>

// ✅ 返回列表
#[tauri::command]
fn list_items() -> Result<Vec<Item>, String>

// ✅ 返回简单值
#[tauri::command]
fn get_count() -> Result<u32, String>

// ✅ 返回 Option（前端判断 null）
#[tauri::command]
fn find_item(id: u32) -> Result<Option<Item>, String>
```

---

## 异步 Command

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

// 前端调用（无需改变）
const result = await invoke<string>("fetch_url", { url: "https://example.com" });
```

---

## 注入 Tauri 对象

```rust
// 注入 AppHandle
#[tauri::command]
fn with_app(app: tauri::AppHandle) -> Result<String, String> {
    let data_dir = app.path().app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(data_dir.to_string_lossy().into())
}

// 注入 Window
#[tauri::command]
fn with_window(window: tauri::Window) -> Result<(), String> {
    window.set_title("新标题")
        .map_err(|e| e.to_string())?;
    Ok(())
}

// 注入 State
#[tauri::command]
fn with_state(state: tauri::State<'_, Database>) -> Result<String, String> {
    // 使用 state...
}

// 组合注入
#[tauri::command]
async fn complex_cmd(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, Database>,
    user_id: u32,  // 前端参数
) -> Result<String, String> {
    // 使用所有注入对象...
    Ok("done".into())
}
```

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 把所有逻辑放在 Command | 使用三层架构（Command → Service → Database） |
| Command 不返回 Result | 始终返回 `Result<T, String>` |
| 忘记注册新 Command | 添加到 `generate_handler![]` |
| 前端不处理 invoke 错误 | 每次 invoke 都 try-catch |
| struct 忘记 derive Serialize | 添加 `#[derive(Serialize, Deserialize)]` |
| 前端直接 invoke 不封装 | 在 `lib/api/` 中封装 API |
| Rust 参数名用 camelCase | Rust 用 snake_case，TypeScript 用 camelCase |
| 不使用 `@/` 路径别名 | 统一使用 `@/types`, `@/lib/api` |

---

## 快速检查清单

- [ ] 数据模型在 `models.rs` 定义
- [ ] Database 层在 `database/mod.rs` 实现
- [ ] Command 在 `commands/*.rs` 实现
- [ ] Command 已在 `lib.rs` 注册
- [ ] TypeScript 接口在 `src/types/index.ts` 定义
- [ ] API 封装在 `src/lib/api/index.ts`
- [ ] 所有 Command 返回 `Result<T, String>`
- [ ] 前端调用使用 `try-catch` 处理错误
