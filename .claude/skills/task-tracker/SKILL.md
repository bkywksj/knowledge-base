---
name: task-tracker
description: |
  任务跟踪与进度管理技能，管理开发任务的创建、分解、状态更新和归档。

  触发场景：
  - 用户需要创建或查看开发任务
  - 用户需要更新任务进度或状态
  - 用户需要归档已完成的任务

  触发词：任务、进度、待办、TODO、跟踪
---

# 任务跟踪与进度管理

## 概述

Tauri Desktop App 的任务跟踪与进度管理技能，提供任务创建、分解、状态流转和归档的完整工作流。

---

## 任务生命周期

```
创建 → 分解 → 开发中 → 测试 → 完成 → 归档
```

### 状态定义

| 状态 | 说明 | 触发条件 |
|------|------|---------|
| `pending` | 待处理 | 任务创建时 |
| `in_progress` | 开发中 | 开始实现时 |
| `testing` | 测试中 | 代码完成、开始测试 |
| `completed` | 已完成 | 测试通过 |
| `archived` | 已归档 | 长期完成的任务 |

---

## 任务分解原则（三层架构）

### 项目架构

本项目采用**三层 Rust 后端 + React 前端**架构：

```
后端三层:
  models/     (数据模型)
    ↓
  database/   (数据访问层)
    ↓
  services/   (业务逻辑层)
    ↓
  commands/   (命令层，对接前端)

前端:
  types/      (TypeScript 类型)
    ↓
  lib/api/    (API 封装)
    ↓
  pages/      (页面组件)
```

---

## 任务模板（三层架构版）

### 完整功能开发模板

```markdown
## [功能名称]

### 后端子任务
- [ ] 定义数据模型 (models/mod.rs)
  - [ ] 定义 struct 并 derive Serialize/Deserialize
  - [ ] 添加必要的字段和文档注释
- [ ] 实现 Database 层 (database/*.rs)
  - [ ] 编写 CRUD 函数（使用 rusqlite）
  - [ ] 处理 rusqlite::Error
- [ ] 实现 Service 层 (services/*.rs)
  - [ ] 编写业务逻辑函数
  - [ ] 处理 AppError
- [ ] 实现 Command 层 (commands/*.rs)
  - [ ] 定义 #[tauri::command]
  - [ ] 转换 AppError -> String
  - [ ] 在 lib.rs 中注册 Command

### 前端子任务
- [ ] 定义 TypeScript 类型 (src/types/index.ts)
  - [ ] 与 Rust models 保持一致
- [ ] 封装 API 调用 (src/lib/api/index.ts)
  - [ ] 使用 invoke 调用 Command
  - [ ] 提供类型安全的接口
- [ ] 实现 UI 组件 (src/pages/*.tsx)
  - [ ] 使用 Ant Design 组件
  - [ ] 实现表单/表格/按钮等 UI
  - [ ] 使用 Zustand 管理状态（如需）

### 路由与状态
- [ ] 添加路由配置 (src/routes.tsx)
  - [ ] 使用 React Router v7
- [ ] 配置全局状态 (src/store/*.ts)（如需）
  - [ ] 使用 Zustand

### 权限与配置
- [ ] 添加 Capabilities 权限声明（如需新插件）
  - [ ] 在 capabilities/default.json 添加权限

### 测试
- [ ] 编写 Rust 单元测试
  - [ ] 测试 Database 层函数
  - [ ] 测试 Service 层逻辑
- [ ] 编写前端测试（可选）
  - [ ] Vitest 组件测试

### 验证
- [ ] 验证跨平台兼容性
  - [ ] Windows
  - [ ] macOS（如有条件）
  - [ ] Linux（如有条件）
```

---

## 快速任务模板

### 纯前端功能（不需要后端支持）

```markdown
## [前端功能名称]

### 子任务
- [ ] 实现 React 组件 (src/pages/*.tsx)
- [ ] 添加路由配置 (src/routes.tsx)
- [ ] 配置全局状态（如需）(src/store/*.ts)
- [ ] 样式调整 (TailwindCSS)
```

### 纯后端功能（不需要前端 UI）

```markdown
## [后端功能名称]

### 子任务
- [ ] 定义数据模型 (models/mod.rs)
- [ ] 实现 Database 层 (database/*.rs)
- [ ] 实现 Service 层 (services/*.rs)
- [ ] 实现 Command 层 (commands/*.rs)
- [ ] 编写单元测试
```

### 仅配置功能（如添加新插件）

```markdown
## [添加插件：XXX]

### 子任务
- [ ] 安装 Cargo 依赖 (src-tauri/Cargo.toml)
- [ ] 安装 npm 包 (package.json)
- [ ] 注册插件 (src-tauri/src/lib.rs)
- [ ] 声明权限 (capabilities/default.json)
- [ ] 编写使用示例
```

---

## 实际示例：用户管理功能

```markdown
## 用户管理功能

### 后端子任务
- [x] 定义数据模型 (models/mod.rs)
  ```rust
  #[derive(Debug, Clone, Serialize, Deserialize)]
  pub struct User {
      pub id: i64,
      pub name: String,
      pub email: String,
  }
  ```
- [x] 实现 Database 层 (database/user.rs)
  - [x] `create_table()` 创建用户表
  - [x] `insert_user()` 插入用户
  - [x] `get_user()` 查询用户
  - [x] `list_users()` 列出所有用户
  - [x] `delete_user()` 删除用户
- [x] 实现 Service 层 (services/user.rs)
  - [x] `add_user()` 业务逻辑（验证邮箱格式）
  - [x] `fetch_user()` 查询用户
  - [x] `fetch_all_users()` 列出所有用户
  - [x] `remove_user()` 删除用户
- [x] 实现 Command 层 (commands/user.rs)
  - [x] `add_user`
  - [x] `get_user`
  - [x] `list_users`
  - [x] `delete_user`
  - [x] 在 lib.rs 中注册

### 前端子任务
- [x] 定义类型 (src/types/index.ts)
  ```typescript
  export interface User {
    id: number;
    name: string;
    email: string;
  }
  ```
- [x] 封装 API (src/lib/api/index.ts)
  ```typescript
  export const api = {
    addUser: (user: User) => invoke("add_user", { user }),
    getUser: (id: number) => invoke<User>("get_user", { id }),
    listUsers: () => invoke<User[]>("list_users"),
    deleteUser: (id: number) => invoke("delete_user", { id }),
  };
  ```
- [x] 实现页面 (src/pages/UserPage.tsx)
  - [x] 用户列表（Ant Design Table）
  - [x] 添加用户表单（Ant Design Form）
  - [x] 删除用户按钮
- [x] 添加路由 (src/routes.tsx)
  ```typescript
  { path: "/users", element: <UserPage /> }
  ```

### 测试
- [x] Rust 单元测试
  ```rust
  #[cfg(test)]
  mod tests {
      #[test]
      fn test_add_user() { /* ... */ }
  }
  ```
- [ ] 前端测试（可选）

### 验证
- [x] Windows 测试通过
- [ ] macOS 测试（待测）
- [ ] Linux 测试（待测）
```

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 不记录任务直接开发 | 先创建任务文档再开发 |
| 任务粒度过大不分解 | 按三层架构（models → database → services → commands → types → api → pages）拆分子任务 |
| 跳过某一层直接实现 | 严格按三层架构顺序开发 |
| 不验证跨平台 | Windows/macOS/Linux 都要验证 |
| 前端类型与后端模型不一致 | 保持 types/index.ts 与 models/mod.rs 同步 |
| 直接在 Command 中写业务逻辑 | 业务逻辑放在 Service 层 |
| 直接在 Service 中写 SQL | SQL 放在 Database 层 |
