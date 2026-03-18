---
name: code-patterns
description: |
  代码模式与最佳实践技能，提供 Tauri 项目中常用的设计模式和编码规范。

  触发场景：
  - 用户需要了解项目的编码规范
  - 用户需要应用设计模式解决问题
  - 用户需要重构代码以符合最佳实践

  触发词：设计模式、编码规范、最佳实践、代码风格、重构
---

# 代码模式与最佳实践

## 概述

Tauri Desktop App 的代码模式与最佳实践技能，涵盖 Rust 后端三层架构和 React 前端的编码规范和设计模式。

---

## Rust 后端模式（三层架构）

### 架构总览

```
commands/        → IPC 接口层（前端可调用）
  ↓ 调用
services/        → 业务逻辑层（可选）
  ↓ 调用
database/        → 数据访问层（DAO）
```

### 1. Database 层模式（数据访问）

```rust
// src-tauri/src/database/mod.rs
use std::sync::Mutex;
use rusqlite::Connection;
use crate::error::AppError;
use crate::models::AppConfig;

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    /// 初始化数据库（自动迁移）
    pub fn init(db_path: &str) -> Result<Self, AppError> {
        let conn = Connection::open(db_path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        schema::migrate(&conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// CRUD 模式：获取所有
    pub fn get_all_config(&self) -> Result<Vec<AppConfig>, AppError> {
        let conn = self.conn.lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let mut stmt = conn.prepare("SELECT key, value FROM app_config")?;
        let configs = stmt.query_map([], |row| {
            Ok(AppConfig {
                key: row.get(0)?,
                value: row.get(1)?,
            })
        })?.collect::<Result<Vec<_>, _>>()?;

        Ok(configs)
    }

    /// CRUD 模式：获取单个（返回 Option）
    pub fn get_config(&self, key: &str) -> Result<Option<String>, AppError> {
        let conn = self.conn.lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let mut stmt = conn.prepare("SELECT value FROM app_config WHERE key = ?1")?;
        Ok(stmt.query_row([key], |row| row.get(0)).ok())
    }

    /// CRUD 模式：Upsert（插入或更新）
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

    /// CRUD 模式：删除（返回是否成功）
    pub fn delete_config(&self, key: &str) -> Result<bool, AppError> {
        let conn = self.conn.lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let affected = conn.execute("DELETE FROM app_config WHERE key = ?1", [key])?;
        Ok(affected > 0)
    }
}
```

### 2. Service 层模式（业务逻辑）

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

    /// 业务逻辑：批量设置配置
    pub fn set_multiple(
        &self,
        db: &Database,
        configs: Vec<(String, String)>,
    ) -> Result<(), AppError> {
        for (key, value) in configs {
            db.set_config(&key, &value)?;
        }
        Ok(())
    }

    /// 业务逻辑：重置配置为默认值
    pub fn reset_to_default(&self, db: &Database) -> Result<(), AppError> {
        let defaults = vec![
            ("theme".to_string(), "light".to_string()),
            ("language".to_string(), "zh-CN".to_string()),
        ];
        self.set_multiple(db, defaults)
    }
}
```

### 3. Command 层模式（IPC 接口）

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

### 4. 模块组织模式

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

---

## React 前端模式

### 1. 组件模式（Ant Design + TypeScript）

```tsx
// src/pages/ConfigPage.tsx
import { useState, useEffect } from "react";
import { Table, Button, message, Modal, Form, Input } from "antd";
import type { ColumnsType } from "antd/es/table";
import { configApi } from "@/lib/api";
import type { AppConfig } from "@/types";

export default function ConfigPage() {
  const [configs, setConfigs] = useState<AppConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();

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

  async function handleSave(values: { key: string; value: string }) {
    try {
      await configApi.set(values.key, values.value);
      message.success("保存成功");
      setModalOpen(false);
      loadConfigs();
    } catch (error) {
      message.error(`保存失败: ${error}`);
    }
  }

  const columns: ColumnsType<AppConfig> = [
    { title: "键", dataIndex: "key", key: "key" },
    { title: "值", dataIndex: "value", key: "value" },
    {
      title: "操作",
      key: "action",
      render: (_, record) => (
        <Button danger size="small" onClick={() => handleDelete(record.key)}>
          删除
        </Button>
      ),
    },
  ];

  async function handleDelete(key: string) {
    try {
      await configApi.delete(key);
      message.success("删除成功");
      loadConfigs();
    } catch (error) {
      message.error(`删除失败: ${error}`);
    }
  }

  return (
    <div className="p-6">
      <div className="mb-4">
        <Button type="primary" onClick={() => setModalOpen(true)}>
          新增配置
        </Button>
      </div>

      <Table
        columns={columns}
        dataSource={configs}
        rowKey="key"
        loading={loading}
      />

      <Modal
        title="新增配置"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
      >
        <Form form={form} onFinish={handleSave}>
          <Form.Item name="key" label="键" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="value" label="值" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
```

### 2. API 封装模式

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
  delete: (key: string) => invoke<void>("delete_config", { key }),
};

/** 系统相关 API */
export const systemApi = {
  greet: (name: string) => invoke<string>("greet", { name }),
  getSystemInfo: () => invoke<SystemInfo>("get_system_info"),
};
```

### 3. 自定义 Hook 模式

```tsx
// src/hooks/useConfig.ts
import { useState, useCallback } from "react";
import { message } from "antd";
import { configApi } from "@/lib/api";
import type { AppConfig } from "@/types";

export function useConfig() {
  const [configs, setConfigs] = useState<AppConfig[]>([]);
  const [loading, setLoading] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const data = await configApi.getAll();
      setConfigs(data);
    } catch (error) {
      message.error(`加载失败: ${error}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const save = useCallback(async (key: string, value: string) => {
    try {
      await configApi.set(key, value);
      message.success("保存成功");
      await loadAll();
    } catch (error) {
      message.error(`保存失败: ${error}`);
      throw error;
    }
  }, [loadAll]);

  return { configs, loading, loadAll, save };
}

// 使用
function MyComponent() {
  const { configs, loading, loadAll } = useConfig();

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  return <div>{/* ... */}</div>;
}
```

### 4. Zustand 状态管理模式

```typescript
// src/store/index.ts
import { create } from "zustand";

interface AppStore {
  theme: "light" | "dark";
  sidebarCollapsed: boolean;
  toggleTheme: () => void;
  setTheme: (theme: "light" | "dark") => void;
  toggleSidebar: () => void;
}

export const useAppStore = create<AppStore>((set) => ({
  theme: "light",
  sidebarCollapsed: false,
  toggleTheme: () =>
    set((s) => ({ theme: s.theme === "light" ? "dark" : "light" })),
  setTheme: (theme) => set({ theme }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
}));

// 使用
function ThemeButton() {
  const { theme, toggleTheme } = useAppStore();

  return (
    <Button onClick={toggleTheme}>
      当前主题: {theme === "light" ? "亮色" : "暗色"}
    </Button>
  );
}
```

---

## 命名约定

### 文件命名

| 层级 | Rust | TypeScript/React |
|------|------|------------------|
| **Database** | `database/mod.rs`, `database/schema.rs` | - |
| **Service** | `services/config_service.rs` | - |
| **Command** | `commands/config.rs`, `commands/system.rs` | - |
| **Model** | `models.rs` | `types/index.ts` |
| **API 封装** | - | `lib/api/index.ts` |
| **组件** | - | `pages/ConfigPage.tsx`, `components/Header.tsx` |
| **Store** | - | `store/index.ts` |
| **Hook** | - | `hooks/useConfig.ts` |

### 标识符命名

| 项目 | Rust | TypeScript |
|------|------|-----------|
| 文件名 | `snake_case.rs` | `PascalCase.tsx` (组件) / `camelCase.ts` (工具) |
| 函数名 | `snake_case` | `camelCase` |
| 类型名 | `PascalCase` | `PascalCase` |
| 常量 | `SCREAMING_SNAKE_CASE` | `SCREAMING_SNAKE_CASE` |
| Command 名 | `get_all_config` | `invoke("get_all_config")` |
| 组件 | - | `PascalCase` (函数组件) |
| Hook | - | `useCamelCase` |

---

## TailwindCSS 样式模式

```tsx
// ✅ 推荐：使用 TailwindCSS 工具类
<div className="flex items-center justify-between p-4 bg-white rounded-lg shadow-md">
  <h1 className="text-2xl font-bold text-gray-900">标题</h1>
  <Button type="primary">操作</Button>
</div>

// ✅ 推荐：组合 Ant Design + TailwindCSS
<Card className="w-full max-w-2xl mx-auto mt-8">
  <div className="space-y-4">
    <Input placeholder="输入内容" className="w-full" />
  </div>
</Card>

// ❌ 避免：内联样式
<div style={{ padding: "16px", backgroundColor: "white" }}>
  {/* ... */}
</div>
```

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 不遵循项目已有模式 | 先阅读参考代码再编写 |
| 把所有逻辑放在 Command 层 | 使用三层架构拆分职责 |
| Rust 中过度使用 `clone()` | 合理使用引用和借用 |
| React 中不拆分大组件 | 按功能拆分为小组件 |
| 不定义 TypeScript 接口 | 为每个 Command 返回值定义接口 |
| 直接 `invoke()` 不封装 | 在 `lib/api/` 中封装 API |
| 不使用 Zustand 管理全局状态 | 复杂状态用 Zustand |
| 混用多种状态管理方案 | 统一使用 Zustand |
| 不使用 TailwindCSS | 优先使用 TailwindCSS 工具类 |
| 前端路径不使用 `@/` 别名 | 统一使用 `@/` 别名 |

---

## 代码审查清单

### Rust 后端

- [ ] 使用三层架构（Database → Service → Command）
- [ ] 所有 Command 返回 `Result<T, String>`
- [ ] Mutex 加锁使用 `map_err` 处理错误
- [ ] SQL 查询使用 `?` 占位符防注入
- [ ] 模块在 `mod.rs` 中导出并在 `lib.rs` 注册

### React 前端

- [ ] 组件使用函数组件 + Hooks
- [ ] API 调用封装在 `lib/api/`
- [ ] 错误处理使用 `try-catch` + `message.error()`
- [ ] 类型定义在 `types/index.ts`
- [ ] 全局状态使用 Zustand
- [ ] 样式优先使用 TailwindCSS
- [ ] 路径使用 `@/` 别名
