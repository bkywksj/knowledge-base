---
name: error-handler
description: |
  Tauri 异常处理技能，覆盖 Rust 错误处理和 React 错误边界。

  触发场景：
  - 需要设计错误处理策略
  - 需要处理 Rust Command 中的错误
  - 需要处理前端 invoke 调用失败
  - 需要实现全局错误处理

  触发词：异常、错误处理、Error、Result、try-catch、panic、崩溃、错误边界
---

# Tauri 异常处理

## 分层错误处理策略

```
前端 (React)                         后端 (Rust)
┌──────────────────────┐          ┌──────────────────────┐
│ message.error()      │          │ AppError 枚举        │
│ ErrorBoundary        │          │ thiserror            │
│ try-catch            │ ◄─IPC─► │ Result<T, AppError> │
│ Ant Design Result    │          │ 三层错误传播          │
└──────────────────────┘          └──────────────────────┘
```

---

## Rust 错误处理

### 1. AppError 枚举（src-tauri/src/error.rs）

```rust
use thiserror::Error;

/// 应用统一错误类型
#[derive(Debug, Error)]
pub enum AppError {
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),

    #[error("数据库错误: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("JSON 解析错误: {0}")]
    Json(#[from] serde_json::Error),

    #[error("未找到: {0}")]
    NotFound(String),

    #[error("参数无效: {0}")]
    InvalidInput(String),

    #[error("{0}")]
    Custom(String),
}

/// 让 Tauri Command 能直接使用 AppError 作为错误类型
impl From<AppError> for String {
    fn from(err: AppError) -> String {
        err.to_string()
    }
}
```

### 2. 三层错误传播

#### Database 层（返回 AppError）

```rust
// database/mod.rs
impl Database {
    pub fn get_config(&self, key: &str) -> Result<Option<String>, AppError> {
        let conn = self.conn.lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let mut stmt = conn.prepare("SELECT value FROM app_config WHERE key = ?1")?;

        let result = stmt
            .query_row([key], |row| row.get::<_, String>(0))
            .ok();

        Ok(result)
    }
}
```

#### Service 层（转换业务错误）

```rust
// services/config_service.rs
impl ConfigService {
    pub fn get_required(&self, db: &Database, key: &str) -> Result<String, AppError> {
        db.get_config(key)?
            .ok_or_else(|| AppError::NotFound(format!("配置 {} 不存在", key)))
    }
}
```

#### Command 层（转换为 String 给前端）

```rust
// commands/config.rs
use tauri::State;

#[tauri::command]
pub fn get_config(db: State<'_, Database>, key: String) -> Result<String, String> {
    db.get_config(&key)
        .map_err(|e| e.to_string())?  // AppError -> String
        .ok_or_else(|| format!("配置 {} 不存在", key))
}
```

### 3. Mutex 安全处理

```rust
// ✅ 正确：使用 map_err 转换 Mutex 错误
let conn = self.conn.lock()
    .map_err(|e| AppError::Custom(format!("锁定失败: {}", e)))?;

// ❌ 错误：使用 unwrap（会 panic）
let conn = self.conn.lock().unwrap();
```

### 4. 错误传播模式

```rust
// ✅ 推荐：使用 ? 自动传播
#[tauri::command]
fn read_config(path: String) -> Result<String, AppError> {
    let content = std::fs::read_to_string(&path)?;  // IoError 自动转换
    if content.is_empty() {
        return Err(AppError::InvalidInput("配置文件为空".into()));
    }
    Ok(content)
}

// ❌ 错误：使用 unwrap/expect
#[tauri::command]
fn bad_read(path: String) -> String {
    std::fs::read_to_string(&path).unwrap()  // panic! 崩溃整个应用
}
```

---

## React 错误处理

### 1. invoke 错误处理（Ant Design）

```tsx
import { message } from "antd";
import { invoke } from "@tauri-apps/api/core";

// ✅ 标准模式：使用 try-catch + message.error
async function loadData() {
  try {
    const result = await invoke<DataType>("get_data");
    setData(result);
    message.success("加载成功");
  } catch (error) {
    message.error(String(error));  // 显示后端返回的错误信息
    console.error("加载失败:", error);
  }
}
```

### 2. 封装 API 调用（src/lib/api/index.ts）

```typescript
import { invoke } from "@tauri-apps/api/core";
import type { AppConfig } from "@/types";

/** 配置管理 API */
export const configApi = {
  getAll: () => invoke<AppConfig[]>("get_all_config"),
  get: (key: string) => invoke<string>("get_config", { key }),
  set: (key: string, value: string) =>
    invoke<void>("set_config", { key, value }),
  delete: (key: string) => invoke<void>("delete_config", { key }),
};

// 使用时统一处理错误
try {
  const configs = await configApi.getAll();
} catch (error) {
  message.error(`获取配置失败: ${error}`);
}
```

### 3. ErrorBoundary 组件（Ant Design Result）

```tsx
import { Component, ReactNode } from "react";
import { Result, Button } from "antd";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: any) {
    console.error("ErrorBoundary 捕获错误:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <Result
          status="error"
          title="应用出现错误"
          subTitle={this.state.error?.message}
          extra={
            <Button type="primary" onClick={() => window.location.reload()}>
              刷新页面
            </Button>
          }
        />
      );
    }
    return this.props.children;
  }
}
```

### 4. 全局错误处理 Hook

```tsx
import { useState } from "react";
import { message } from "antd";
import { invoke } from "@tauri-apps/api/core";

export function useErrorHandler() {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function safeInvoke<T>(
    cmd: string,
    args?: Record<string, unknown>,
    showSuccessMsg?: string
  ): Promise<T | null> {
    setLoading(true);
    setError(null);

    try {
      const result = await invoke<T>(cmd, args);
      if (showSuccessMsg) {
        message.success(showSuccessMsg);
      }
      return result;
    } catch (e) {
      const msg = String(e);
      setError(msg);
      message.error(msg);
      console.error(`Command "${cmd}" 失败:`, msg);
      return null;
    } finally {
      setLoading(false);
    }
  }

  return {
    error,
    loading,
    safeInvoke,
    clearError: () => setError(null),
  };
}

// 使用示例
const { loading, safeInvoke } = useErrorHandler();

async function handleSave() {
  const result = await safeInvoke<string>(
    "set_config",
    { key: "theme", value: "dark" },
    "保存成功"
  );
  if (result) {
    // 成功后的逻辑
  }
}
```

---

## 错误流程图

```
┌─────────────────────────────────────────────────────────────┐
│                       Rust 后端                              │
├─────────────────────────────────────────────────────────────┤
│  Database::get_config()                                     │
│    ↓ 返回 Result<Option<String>, AppError>                 │
│  Service::get_required()                                    │
│    ↓ 业务校验，转换 None 为 NotFound 错误                   │
│  Command::get_config()                                      │
│    ↓ map_err(|e| e.to_string()) 转换为 String             │
└─────────────────────────────────────────────────────────────┘
                             ↓ IPC (invoke)
┌─────────────────────────────────────────────────────────────┐
│                      React 前端                              │
├─────────────────────────────────────────────────────────────┤
│  try { await configApi.get("theme") }                      │
│  catch (error) { message.error(String(error)) }            │
│    ↓ 用户看到 Ant Design 错误提示                           │
└─────────────────────────────────────────────────────────────┘
```

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| Rust 中 `unwrap()` 处理可能失败的操作 | 使用 `?` 运算符 + `Result<T, AppError>` |
| 不定义统一错误类型 | 使用 `thiserror` 定义 `AppError` 枚举 |
| 前端不 catch invoke 错误 | 所有 `invoke` 调用都用 `try-catch` |
| 错误信息不可读 | 提供用户友好的中文错误提示 |
| Mutex 使用 `unwrap()` | 使用 `map_err` 转换为 `AppError::Custom` |
| 前端用 `alert()` 显示错误 | 使用 Ant Design `message.error()` |
| 不处理 ErrorBoundary | 在根组件添加 `<ErrorBoundary>` |

---

## 完整示例（三层 + 前端）

### Rust 后端

```rust
// error.rs
#[derive(Debug, Error)]
pub enum AppError {
    #[error("数据库错误: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("未找到: {0}")]
    NotFound(String),
}

// database/mod.rs
impl Database {
    pub fn get_user(&self, id: i64) -> Result<Option<User>, AppError> {
        let conn = self.conn.lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        // ... SQL 查询
    }
}

// services/user_service.rs
impl UserService {
    pub fn get_required(&self, db: &Database, id: i64) -> Result<User, AppError> {
        db.get_user(id)?
            .ok_or_else(|| AppError::NotFound(format!("用户 {} 不存在", id)))
    }
}

// commands/user.rs
#[tauri::command]
pub fn get_user(db: State<'_, Database>, id: i64) -> Result<User, String> {
    let service = UserService::new();
    service.get_required(&db, id)
        .map_err(|e| e.to_string())
}
```

### React 前端

```tsx
import { message } from "antd";
import { invoke } from "@tauri-apps/api/core";

async function loadUser(id: number) {
  try {
    const user = await invoke<User>("get_user", { id });
    setUser(user);
  } catch (error) {
    message.error(`加载用户失败: ${error}`);
  }
}
```
