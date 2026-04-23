---
name: database-ops
description: |
  Tauri 本地数据库操作技能，使用 rusqlite 进行 SQLite 数据库操作。

  触发场景：
  - 需要在桌面应用中持久化数据
  - 需要使用 SQLite 数据库
  - 需要设计本地数据表结构
  - 需要执行 CRUD 数据库操作

  触发词：数据库、SQLite、SQL、持久化、存储、表、查询、CRUD、数据
---

# Tauri 本地数据库操作

## 核心架构

本项目采用 **三层架构**，数据库操作在最底层：

```
┌────────────────────────────────────────────┐
│  Commands (commands/*.rs)                  │  ← 前端调用
│    ↓ 调用                                   │
│  Services (services/*.rs)                  │  ← 业务逻辑
│    ↓ 调用                                   │
│  Database (database/mod.rs)                │  ← 数据访问
│    - Mutex<Connection>                     │
│    - get_all_config()                      │
│    - set_config()                          │
└────────────────────────────────────────────┘
```

---

## 技术方案：rusqlite (推荐)

本项目使用 **rusqlite**（Rust 原生 SQLite 绑定），而非 tauri-plugin-sql。

### 为什么选择 rusqlite？

| 特性 | rusqlite | tauri-plugin-sql |
|------|----------|------------------|
| **调用位置** | Rust 后端 | 前端 TypeScript |
| **类型安全** | 编译时检查 | 运行时检查 |
| **性能** | 无 IPC 开销 | 每次查询都走 IPC |
| **事务** | 原生支持 | 复杂场景支持差 |
| **安全性** | SQL 注入保护完善 | 依赖前端参数化 |
| **复杂查询** | 任意 SQL | 受插件 API 限制 |

### 安装依赖

```toml
# Cargo.toml
[dependencies]
rusqlite = { version = "0.31", features = ["bundled"] }
```

---

## Database 结构设计

### 核心模式：`Mutex<Connection>`

```rust
// src-tauri/src/database/mod.rs
use std::sync::Mutex;
use rusqlite::Connection;
use crate::error::AppError;

pub struct Database {
    conn: Mutex<Connection>,  // 线程安全的连接
}

impl Database {
    /// 初始化数据库（自动迁移）
    pub fn init(db_path: &str) -> Result<Self, AppError> {
        let conn = Connection::open(db_path)?;

        // 启用 WAL 模式提升并发性能
        conn.pragma_update(None, "journal_mode", "WAL")?;

        // 执行 Schema 迁移
        schema::migrate(&conn)?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}
```

---

## Schema 迁移（PRAGMA user_version）

### 迁移模式

```rust
// src-tauri/src/database/schema.rs
use rusqlite::Connection;
use crate::error::AppError;

pub fn migrate(conn: &Connection) -> Result<(), AppError> {
    let version: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;

    if version < 1 {
        // ────────── 版本 1: 初始化 ──────────
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS app_config (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL,
                created_at DATETIME DEFAULT (datetime('now', 'localtime')),
                updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
            );"
        )?;
        conn.pragma_update(None, "user_version", 1)?;
    }

    if version < 2 {
        // ────────── 版本 2: 新增表 ──────────
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                email TEXT NOT NULL,
                created_at DATETIME DEFAULT (datetime('now', 'localtime'))
            );"
        )?;
        conn.pragma_update(None, "user_version", 2)?;
    }

    Ok(())
}
```

### 迁移规则

| 规则 | 说明 |
|------|------|
| `PRAGMA user_version` | 当前 Schema 版本号 |
| `if version < N` | 递增式迁移 |
| 永久保留 | 不删除旧版本代码 |
| 幂等性 | 使用 `IF NOT EXISTS` |

---

## CRUD 操作模式

### 查询（Read）

```rust
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
```

### 单条查询

```rust
/// 获取单个配置（返回 Option）
pub fn get_config(&self, key: &str) -> Result<Option<String>, AppError> {
    let conn = self.conn.lock()
        .map_err(|e| AppError::Custom(e.to_string()))?;

    let mut stmt = conn.prepare("SELECT value FROM app_config WHERE key = ?1")?;

    let result = stmt
        .query_row([key], |row| row.get::<_, String>(0))
        .ok();  // 转换为 Option

    Ok(result)
}
```

### Upsert（Insert or Update）

```rust
/// 设置配置（如存在则更新）
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
```

### 删除（Delete）

```rust
/// 删除配置（返回是否删除成功）
pub fn delete_config(&self, key: &str) -> Result<bool, AppError> {
    let conn = self.conn.lock()
        .map_err(|e| AppError::Custom(e.to_string()))?;

    let affected = conn.execute("DELETE FROM app_config WHERE key = ?1", [key])?;
    Ok(affected > 0)
}
```

---

## 调用链示例（三层架构）

### 1. Database 层（数据访问）

```rust
// database/mod.rs
impl Database {
    pub fn get_all_config(&self) -> Result<Vec<AppConfig>, AppError> {
        // SQL 查询...
    }
}
```

### 2. Service 层（业务逻辑）

```rust
// services/config_service.rs
impl ConfigService {
    pub fn get_all(&self, db: &Database) -> Result<Vec<AppConfig>, AppError> {
        // 可以在这里添加业务逻辑（如缓存、验证）
        db.get_all_config()
    }
}
```

### 3. Command 层（IPC 接口）

```rust
// commands/config.rs
use tauri::State;

#[tauri::command]
pub fn get_all_config(db: State<'_, Database>) -> Result<Vec<AppConfig>, String> {
    db.get_all_config()
        .map_err(|e| e.to_string())
}
```

### 4. 前端调用

```typescript
// src/lib/api/index.ts
import { invoke } from "@tauri-apps/api/core";

export const configApi = {
  getAll: () => invoke<AppConfig[]>("get_all_config"),
  set: (key: string, value: string) =>
    invoke<void>("set_config", { key, value }),
};

// 组件中使用
const configs = await configApi.getAll();
```

---

## 数据库设计规范

### 建表模板

```sql
CREATE TABLE IF NOT EXISTS {table_name} (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,

    -- 业务字段
    name        TEXT NOT NULL,
    status      INTEGER DEFAULT 1,  -- 0: 禁用, 1: 正常

    -- 审计字段
    created_at  DATETIME DEFAULT (datetime('now', 'localtime')),
    updated_at  DATETIME DEFAULT (datetime('now', 'localtime'))
);
```

### SQLite 类型映射

| SQLite 类型 | Rust 类型 | TypeScript 类型 |
|------------|-----------|----------------|
| INTEGER | `i32` / `i64` | `number` |
| TEXT | `String` | `string` |
| REAL | `f64` | `number` |
| BOOLEAN | `bool` (存为 0/1) | `boolean` |
| DATETIME | `String` | `string` |
| BLOB | `Vec<u8>` | `Uint8Array` |

---

## 线程安全与错误处理

### Mutex 安全加锁

```rust
// ✅ 正确：map_err 转换错误
let conn = self.conn.lock()
    .map_err(|e| AppError::Custom(e.to_string()))?;

// ❌ 错误：unwrap 会 panic
let conn = self.conn.lock().unwrap();  // 永远不要这样做
```

### SQL 注入防护

```rust
// ✅ 正确：使用 ? 占位符
conn.execute("SELECT * FROM users WHERE id = ?1", [id])?;

// ❌ 错误：字符串拼接（SQL 注入风险）
let sql = format!("SELECT * FROM users WHERE id = {}", id);
conn.execute(&sql, [])?;
```

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 在前端直接操作数据库 | 所有数据库操作在 Rust 后端 |
| 使用 `unwrap()` 处理 Mutex | 使用 `map_err` 转换错误 |
| 字符串拼接 SQL | 始终使用 `?` 占位符防注入 |
| 不做数据库迁移 | 使用 `PRAGMA user_version` 管理版本 |
| 数据库文件用绝对路径 | 使用 `app_data_dir()` 获取路径 |
| 忘记 WAL 模式 | `pragma_update(None, "journal_mode", "WAL")` |
