---
name: project-navigator
description: |
  Tauri 项目导航技能，快速定位代码、理解项目结构、找到关键文件。

  触发场景：
  - 需要了解项目整体结构
  - 需要快速找到某个功能的代码位置
  - 需要理解 Rust 和 React 代码的关系
  - 新加入项目需要熟悉代码

  触发词：项目结构、在哪里、怎么找、代码位置、目录、文件、导航、定位
---

# Tauri 项目导航

## 项目结构速查

### 关键入口文件

| 文件 | 用途 | 何时修改 |
|------|------|---------|
| `src-tauri/src/lib.rs` | Rust Builder 统一注册（插件/状态/Commands） | 添加新模块/插件/状态 |
| `src-tauri/src/commands/mod.rs` | Command 模块导出 | 添加新 Command 模块 |
| `src-tauri/src/commands/system.rs` | 系统命令（greet/get_system_info） | 添加系统级 Command |
| `src-tauri/src/commands/config.rs` | 配置 CRUD 命令 | 添加配置相关 Command |
| `src-tauri/src/services/config.rs` | 配置业务逻辑 | 修改业务规则 |
| `src-tauri/src/database/mod.rs` | Database 结构体 | 修改数据库连接/操作 |
| `src-tauri/src/database/schema.rs` | Schema 迁移 | 添加/修改数据库表 |
| `src-tauri/src/state.rs` | AppState 定义 | 添加全局状态字段 |
| `src-tauri/src/error.rs` | thiserror 错误类型 | 添加新错误类型 |
| `src-tauri/src/models/mod.rs` | 数据模型 | 添加/修改数据结构 |
| `src-tauri/src/main.rs` | Rust 进程入口 | 极少修改 |
| `src/main.tsx` | React 入口 | 添加全局 Provider |
| `src/App.tsx` | 根组件（ConfigProvider + Router） | 修改全局配置 |
| `src/Router.tsx` | React Router 配置 | 添加新路由/页面 |
| `src/store/index.ts` | Zustand 全局状态 | 添加全局状态 |
| `src/lib/api/index.ts` | API 类型安全封装 | 添加新 Command 调用 |
| `src-tauri/tauri.conf.json` | Tauri 核心配置 | 修改窗口/打包/安全 |
| `src-tauri/Cargo.toml` | Rust 依赖 | 添加 Rust crate |
| `package.json` | 前端依赖 | 添加 npm 包 |

### 关键目录

| 目录 | 内容 | 文件类型 |
|------|------|---------|
| `src/` | React 前端源码 | `.tsx`, `.ts`, `.css` |
| `src/components/layout/` | 主布局和侧边栏导航 | `.tsx` |
| `src/components/ui/` | 通用 UI 组件（ErrorBoundary 等） | `.tsx` |
| `src/hooks/` | 自定义 Hooks（useCommand 等） | `.ts` |
| `src/lib/api/` | API 类型安全封装 | `.ts` |
| `src/pages/` | 页面组件（home/settings/about） | `.tsx` |
| `src/store/` | Zustand 全局状态 | `.ts` |
| `src/styles/` | TailwindCSS 全局样式 | `.css` |
| `src/types/` | TypeScript 类型定义 | `.ts` |
| `src-tauri/src/` | Rust 后端源码 | `.rs` |
| `src-tauri/src/commands/` | Layer 1: IPC 入口（Command 定义） | `.rs` |
| `src-tauri/src/services/` | Layer 2: 业务逻辑 | `.rs` |
| `src-tauri/src/database/` | Layer 3: 数据访问（rusqlite） | `.rs` |
| `src-tauri/src/models/` | 数据模型 | `.rs` |
| `src-tauri/capabilities/` | Tauri 权限声明 | `.json` |
| `src-tauri/icons/` | 应用图标 | `.png`, `.ico`, `.icns` |
| `public/` | 静态资源 | `.svg`, `.png` 等 |
| `docs/` | 项目文档 | `.md` |

---

## 功能定位指南

### "我想添加一个新功能"

```
1. 定义数据模型 → src-tauri/src/models/mod.rs
2. 实现数据访问 → src-tauri/src/database/ (Layer 3)
3. 实现业务逻辑 → src-tauri/src/services/ (Layer 2, 新建或修改 .rs 文件)
4. 实现 Command → src-tauri/src/commands/ (Layer 1, 新建或修改 .rs 文件)
5. 注册 Command → src-tauri/src/lib.rs 的 generate_handler![]
6. 声明权限 → src-tauri/capabilities/default.json (如使用插件)
7. 定义 TS 接口 → src/types/index.ts
8. 添加 API 封装 → src/lib/api/index.ts
9. 实现页面组件 → src/pages/ 下新建页面目录
10. 添加路由 → src/Router.tsx
11. 添加导航入口 → src/components/layout/Sidebar.tsx
```

### "我想添加一个 Tauri 插件"

```
1. Cargo.toml 添加依赖 → src-tauri/Cargo.toml
2. package.json 添加 JS 绑定 → package.json (如有)
3. 注册插件 → src-tauri/src/lib.rs 的 Builder.plugin()
4. 声明权限 → src-tauri/capabilities/default.json
5. 前端调用 → import from "@tauri-apps/plugin-xxx"
```

### "我想修改窗口配置"

```
→ src-tauri/tauri.conf.json 的 app.windows 部分
```

### "我想修改打包配置"

```
→ src-tauri/tauri.conf.json 的 bundle 部分
```

---

## 代码搜索技巧

| 想找什么 | 搜索方法 |
|---------|---------|
| 某个 Command 的定义 | Grep `#\[tauri::command\]` in `src-tauri/src/commands/` |
| 某个 Command 的调用 | Grep `invoke\("command_name"` in `src/lib/api/` |
| 所有注册的 Command | 查看 `src-tauri/src/lib.rs` 的 `generate_handler![]` 列表 |
| 某个业务逻辑 | 查看 `src-tauri/src/services/` 对应模块 |
| 数据库操作 | 查看 `src-tauri/src/database/` |
| 数据模型 | 查看 `src-tauri/src/models/mod.rs` |
| 所有插件 | Grep `.plugin(` in `src-tauri/src/lib.rs` |
| 所有权限声明 | 读取 `src-tauri/capabilities/*.json` |
| 全局状态定义 | 读取 `src-tauri/src/state.rs`（Rust）或 `src/store/index.ts`（前端） |
| 错误类型定义 | 读取 `src-tauri/src/error.rs` |
| 路由配置 | 读取 `src/Router.tsx` |
| API 封装 | 读取 `src/lib/api/index.ts` |
| Rust 依赖 | 读取 `src-tauri/Cargo.toml` |
| 前端依赖 | 读取 `package.json` |

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 不知道代码在哪就开始写 | 先用导航指南定位相关文件 |
| 只改前端忘记后端 | Tauri 功能通常涉及前后端两侧 |
| 忘记注册新 Command | 添加到 `generate_handler![]` |
| 忘记声明权限 | 使用插件 API 前检查 Capabilities |
