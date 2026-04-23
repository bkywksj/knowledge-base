---
name: test-development
description: |
  Tauri 项目测试开发技能，覆盖 Rust 单元测试和 React 组件测试。

  触发场景：
  - 需要为 Rust Command 编写测试
  - 需要为 React 组件编写测试
  - 需要设计测试策略
  - 需要运行和调试测试

  触发词：测试、test、单元测试、集成测试、TDD、测试用例
---

# Tauri 测试开发

## 测试策略

```
               ┌──────────────────┐
               │   E2E 测试        │  (可选: Playwright/WebdriverIO)
               │  完整应用流程      │
              ┌┴──────────────────┴┐
              │   集成测试          │  (Rust: Command + Service + Database)
              │  模块间交互         │
             ┌┴────────────────────┴┐
             │   单元测试            │  (Rust: cargo test / TS: Vitest)
             │  函数/组件级别        │
             └──────────────────────┘
```

---

## Rust 三层架构测试

本项目采用三层架构（models → database → services → commands），测试应覆盖各层。

### 测试金字塔

```
     ┌─────────────┐
     │ Command 测试 │  集成测试（调用 Service）
    ┌┴──────────────┴┐
    │  Service 测试   │  业务逻辑测试（调用 Database）
   ┌┴─────────────────┴┐
   │  Database 测试     │  单元测试（纯函数）
   └───────────────────┘
```

---

## Database 层测试（单元测试）

### 示例：测试数据库操作

```rust
// src-tauri/src/database/user.rs
use rusqlite::{Connection, Result};
use crate::models::User;

pub fn create_table(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL
        )",
        [],
    )?;
    Ok(())
}

pub fn insert_user(conn: &Connection, user: &User) -> Result<()> {
    conn.execute(
        "INSERT INTO users (name, email) VALUES (?1, ?2)",
        [&user.name, &user.email],
    )?;
    Ok(())
}

pub fn get_user(conn: &Connection, id: i64) -> Result<User> {
    conn.query_row(
        "SELECT id, name, email FROM users WHERE id = ?1",
        [id],
        |row| Ok(User {
            id: row.get(0)?,
            name: row.get(1)?,
            email: row.get(2)?,
        })
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        create_table(&conn).unwrap();
        conn
    }

    #[test]
    fn test_insert_and_get_user() {
        let conn = setup_test_db();

        let user = User {
            id: 0,
            name: "Alice".into(),
            email: "alice@example.com".into(),
        };

        insert_user(&conn, &user).unwrap();

        let retrieved = get_user(&conn, 1).unwrap();
        assert_eq!(retrieved.name, "Alice");
        assert_eq!(retrieved.email, "alice@example.com");
    }

    #[test]
    fn test_get_nonexistent_user() {
        let conn = setup_test_db();
        let result = get_user(&conn, 999);
        assert!(result.is_err());
    }
}
```

---

## Service 层测试（业务逻辑测试）

### 示例：测试业务逻辑

```rust
// src-tauri/src/services/user.rs
use crate::database;
use crate::models::User;
use crate::error::AppError;
use rusqlite::Connection;

pub fn validate_email(email: &str) -> Result<(), AppError> {
    if !email.contains('@') || !email.contains('.') {
        return Err(AppError::InvalidInput("无效的邮箱格式".into()));
    }
    Ok(())
}

pub fn add_user(conn: &Connection, name: &str, email: &str) -> Result<(), AppError> {
    validate_email(email)?;

    let user = User {
        id: 0,
        name: name.into(),
        email: email.into(),
    };

    database::user::insert_user(conn, &user)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        database::user::create_table(&conn).unwrap();
        conn
    }

    #[test]
    fn test_validate_email_valid() {
        assert!(validate_email("test@example.com").is_ok());
    }

    #[test]
    fn test_validate_email_invalid() {
        assert!(validate_email("invalid").is_err());
        assert!(validate_email("no-at-sign.com").is_err());
        assert!(validate_email("no-dot@com").is_err());
    }

    #[test]
    fn test_add_user_success() {
        let conn = setup_test_db();
        let result = add_user(&conn, "Alice", "alice@example.com");
        assert!(result.is_ok());
    }

    #[test]
    fn test_add_user_invalid_email() {
        let conn = setup_test_db();
        let result = add_user(&conn, "Bob", "invalid-email");
        assert!(result.is_err());

        if let Err(AppError::InvalidInput(msg)) = result {
            assert!(msg.contains("邮箱"));
        }
    }
}
```

---

## Command 层测试（集成测试）

### 示例：测试 Tauri Command

```rust
// src-tauri/src/commands/user.rs
use crate::services;
use crate::models::User;

#[tauri::command]
pub fn add_user(name: String, email: String) -> Result<(), String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    services::user::add_user(&conn, &name, &email)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_user(id: i64) -> Result<User, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    database::user::get_user(&conn, id)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 注意：Command 测试需要模拟完整的应用环境
    // 可以直接调用 Command 函数，但需要确保数据库连接可用

    #[test]
    fn test_add_user_command() {
        // 设置测试数据库
        let result = add_user("Alice".into(), "alice@example.com".into());
        assert!(result.is_ok());
    }

    #[test]
    fn test_add_user_command_invalid() {
        let result = add_user("Bob".into(), "invalid".into());
        assert!(result.is_err());
    }
}
```

---

## 运行 Rust 测试

```bash
# 运行所有 Rust 测试
cd src-tauri && cargo test

# 运行特定模块的测试
cd src-tauri && cargo test database::user::tests

# 运行特定测试函数
cd src-tauri && cargo test test_add_user

# 显示输出（包括 println!）
cd src-tauri && cargo test -- --nocapture

# 并行运行测试（默认）
cd src-tauri && cargo test

# 串行运行测试（避免数据库冲突）
cd src-tauri && cargo test -- --test-threads=1
```

---

## React 测试 (Vitest)

### 安装

```bash
pnpm add -D vitest @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom
```

### vitest.config.ts

```typescript
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
```

### 组件测试

```tsx
// src/pages/UserPage.test.tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import UserPage from "./UserPage";

// Mock Tauri invoke
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("UserPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders user list", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 1, name: "Alice", email: "alice@example.com" },
      { id: 2, name: "Bob", email: "bob@example.com" },
    ]);

    render(<UserPage />);

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
      expect(screen.getByText("Bob")).toBeInTheDocument();
    });
  });

  it("adds a new user", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    render(<UserPage />);

    const nameInput = screen.getByPlaceholderText("姓名");
    const emailInput = screen.getByPlaceholderText("邮箱");
    const submitButton = screen.getByText("添加");

    fireEvent.change(nameInput, { target: { value: "Charlie" } });
    fireEvent.change(emailInput, { target: { value: "charlie@example.com" } });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("add_user", {
        name: "Charlie",
        email: "charlie@example.com",
      });
    });
  });

  it("handles error when adding user", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as ReturnType<typeof vi.fn>).mockRejectedValue("无效的邮箱格式");

    render(<UserPage />);

    const nameInput = screen.getByPlaceholderText("姓名");
    const emailInput = screen.getByPlaceholderText("邮箱");
    const submitButton = screen.getByText("添加");

    fireEvent.change(nameInput, { target: { value: "Invalid" } });
    fireEvent.change(emailInput, { target: { value: "invalid" } });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/邮箱格式/)).toBeInTheDocument();
    });
  });
});
```

### API 测试

```typescript
// src/lib/api/index.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { api } from "./index";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls getUser command", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1,
      name: "Alice",
      email: "alice@example.com",
    });

    const user = await api.getUser(1);

    expect(invoke).toHaveBeenCalledWith("get_user", { id: 1 });
    expect(user.name).toBe("Alice");
  });
});
```

### 运行前端测试

```bash
# 运行测试（watch 模式）
pnpm vitest

# 运行一次
pnpm vitest run

# 覆盖率
pnpm vitest run --coverage

# 运行特定测试文件
pnpm vitest src/pages/UserPage.test.tsx
```

---

## 测试最佳实践

### Rust 测试

1. **使用内存数据库**：测试时使用 `Connection::open_in_memory()` 避免文件冲突
2. **独立测试**：每个测试函数独立，不依赖其他测试
3. **测试边界情况**：正常情况 + 错误情况 + 边界情况
4. **使用 setup 函数**：提取通用的测试准备代码
5. **测试三层分别**：Database → Service → Command 分层测试

### React 测试

1. **Mock Tauri API**：使用 `vi.mock` 模拟 `@tauri-apps/api/core`
2. **等待异步**：使用 `waitFor` 等待异步操作完成
3. **清理 Mock**：每个测试前用 `beforeEach` 清理 mock
4. **测试用户交互**：使用 `fireEvent` 或 `@testing-library/user-event`
5. **测试错误处理**：测试 API 调用失败的情况

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 不写测试直接提交 | 至少为核心功能编写单元测试 |
| 前端测试中真实调用 invoke | Mock `@tauri-apps/api/core` |
| 只测试正常路径 | 同时测试错误路径 (Err/异常) |
| 测试中硬编码文件路径 | 使用 `Connection::open_in_memory()` |
| 不测试 Database 层 | Database 层最容易出 bug，必须测试 |
| 不测试 Service 业务逻辑 | Service 层包含关键业务逻辑，必须测试 |
| Command 测试不充分 | Command 是前端入口，需要集成测试 |
| 测试之间相互依赖 | 每个测试独立，不依赖其他测试 |
