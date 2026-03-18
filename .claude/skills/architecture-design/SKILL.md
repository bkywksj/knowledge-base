---
name: architecture-design
description: |
  Tauri 架构设计技能，指导双进程架构下的模块拆分和代码组织。

  触发场景：
  - 需要设计新模块的架构
  - 需要重构现有代码结构
  - 需要决定功能放在 Rust 还是 React 侧
  - 需要设计插件集成方案

  触发词：架构、设计、模块、拆分、重构、组织、结构
---

# Tauri 架构设计

## 核心原则

### 前后端分工原则

| 放在 Rust 侧 | 放在 React 侧 |
|-------------|--------------|
| 文件系统操作 | UI 渲染和交互 |
| 系统 API 调用 | 表单处理 |
| 数据库操作 | 状态管理（UI 状态） |
| 网络请求（安全原因） | 路由导航 |
| 计算密集型任务 | 动画和视觉效果 |
| 安全敏感操作 | 用户输入验证（前置） |
| 后台任务/定时器 | 国际化文本 |

### 关键决策：哪些逻辑该放在哪里？

```
用户点击 → React 处理交互
需要系统资源? → Rust Command
纯 UI 逻辑? → React 组件
需要持久化? → Rust (文件/数据库)
需要安全? → Rust (不暴露给 WebView)
```

---

## 当前项目结构（三层架构）

```
src/                              # React 前端
├── components/
│   ├── layout/
│   │   ├── AppLayout.tsx        # 主布局（Ant Design Layout）
│   │   └── Sidebar.tsx          # 侧边栏导航
│   └── ui/
│       └── ErrorBoundary.tsx    # 错误边界
├── hooks/
│   └── useCommand.ts           # invoke 封装
├── lib/
│   └── api/
│       └── index.ts            # API 类型安全封装
├── pages/
│   ├── home/index.tsx           # 首页
│   ├── settings/index.tsx       # 设置页
│   └── about/index.tsx          # 关于页
├── store/
│   └── index.ts                # Zustand 全局状态
├── styles/
│   └── global.css              # TailwindCSS
├── types/
│   └── index.ts                # TS 类型
├── App.tsx                      # 根组件（ConfigProvider + Router）
├── Router.tsx                   # React Router 配置
└── main.tsx                     # 入口

src-tauri/src/                    # Rust 后端（三层架构）
├── commands/                    # Layer 1: IPC 入口
│   ├── mod.rs
│   ├── system.rs               # 系统命令（greet/get_system_info）
│   └── config.rs               # 配置 CRUD 命令
├── services/                    # Layer 2: 业务逻辑
│   ├── mod.rs
│   └── config.rs               # 配置服务
├── database/                    # Layer 3: 数据访问
│   ├── mod.rs                  # Database 结构体
│   └── schema.rs               # Schema 迁移
├── models/
│   └── mod.rs                  # 数据模型
├── error.rs                     # thiserror 错误类型
├── state.rs                     # AppState 定义
├── lib.rs                       # Builder 统一注册
└── main.rs                      # 进程入口
```

### 三层架构职责

| 层级 | 目录 | 职责 | 依赖方向 |
|------|------|------|---------|
| Layer 1: Commands | `commands/` | IPC 入口，参数校验，调用 Service | 向下调用 Service |
| Layer 2: Services | `services/` | 业务逻辑，事务编排 | 向下调用 Database |
| Layer 3: Database | `database/` | 数据访问，SQL 执行，Schema 迁移 | 直接操作 rusqlite |

---

## 三层架构 Command 注册

### lib.rs 统一注册示例

```rust
mod commands;
mod services;
mod database;
mod models;
mod state;
mod error;

use state::AppState;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_log::Builder::new().build())
        .manage(AppState::new())  // 包含 Database 实例
        .invoke_handler(tauri::generate_handler![
            // 系统模块
            commands::system::greet,
            commands::system::get_system_info,
            // 配置模块
            commands::config::get_config,
            commands::config::set_config,
            commands::config::list_configs,
            commands::config::delete_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 调用链路

```
前端 invoke("get_config", { key })
  → commands/config.rs::get_config()     // Layer 1: 参数校验
    → services/config.rs::get()          // Layer 2: 业务逻辑
      → database/mod.rs::query()         // Layer 3: SQL 执行
```

---

## 状态管理架构

```
全局状态 (Rust tauri::State<AppState>)
├── Database (rusqlite) → 持久化结构化数据
├── tauri-plugin-store → 键值持久化（设置/偏好）
└── 运行时状态（进程级 Mutex<T>）

UI 状态 (React)
├── 组件内 useState
├── 全局状态 Zustand (src/store/index.ts)
└── API 封装 src/lib/api/index.ts
```

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 前端直接操作文件/网络 | 通过 Rust Command 代理 |
| 所有代码堆在 lib.rs | 按三层架构拆分（commands/services/database） |
| Command 中直接写 SQL | Command 调用 Service，Service 调用 Database |
| 不考虑跨平台差异 | 路径/API 使用跨平台方案 |
| 前端直接 invoke 不封装 | 通过 `src/lib/api/index.ts` 统一封装 |
