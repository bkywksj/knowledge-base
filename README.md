# Tauri Desktop Framework

基于 Tauri 2.x 的桌面应用开发框架，采用 Rust 三层后端架构 + React 19 现代前端技术栈，开箱即用。

## 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| 桌面框架 | Tauri | 2.x |
| 后端语言 | Rust | 2021 edition |
| 前端框架 | React | 19 |
| 类型系统 | TypeScript | 5.8 |
| 构建工具 | Vite | 7 |
| UI 组件库 | Ant Design | 6 |
| 样式方案 | TailwindCSS | 4 |
| 状态管理 | Zustand | 5 |
| 路由 | React Router | 7 |
| 数据库 | rusqlite (SQLite) | 0.31 |
| 错误处理 | thiserror | 2 |

## 项目结构

```
tauri/
├── src/                          # 前端源码
│   ├── main.tsx                  # 入口
│   ├── App.tsx                   # 根组件（主题 + 路由）
│   ├── Router.tsx                # 路由配置
│   ├── components/               # 组件
│   │   ├── layout/               #   布局（AppLayout + Sidebar）
│   │   └── ui/                   #   通用 UI（ErrorBoundary）
│   ├── hooks/                    # 自定义 Hooks
│   ├── lib/api/                  # API 封装（invoke 统一管理）
│   ├── pages/                    # 页面
│   │   ├── home/                 #   首页
│   │   ├── settings/             #   设置
│   │   └── about/                #   关于
│   ├── store/                    # Zustand 全局状态
│   ├── styles/                   # 全局样式
│   └── types/                    # TypeScript 类型定义
│
├── src-tauri/                    # Rust 后端
│   ├── src/
│   │   ├── main.rs               # 进程入口
│   │   ├── lib.rs                # Builder 注册（插件 / 状态 / Commands）
│   │   ├── state.rs              # 全局状态（AppState）
│   │   ├── error.rs              # 错误类型（AppError + thiserror）
│   │   ├── models/               # 数据模型（serde 序列化）
│   │   ├── commands/             # Layer 1: IPC 入口
│   │   │   ├── system.rs         #   系统命令（greet / get_system_info）
│   │   │   └── config.rs         #   配置 CRUD
│   │   ├── services/             # Layer 2: 业务逻辑
│   │   │   └── config.rs         #   配置业务
│   │   └── database/             # Layer 3: 数据访问（rusqlite）
│   │       ├── mod.rs            #   Database 结构体 + 连接管理
│   │       └── schema.rs         #   Schema 迁移（PRAGMA user_version）
│   ├── Cargo.toml                # Rust 依赖
│   ├── tauri.conf.json           # Tauri 配置
│   └── capabilities/             # 权限声明
│       └── default.json
│
├── package.json                  # 前端依赖
├── vite.config.ts                # Vite 配置
└── tsconfig.json                 # TypeScript 配置
```

## 后端三层架构

```
前端 invoke()
      ↓
┌─────────────────────────────────────┐
│  Commands 层（src/commands/）        │  IPC 入口，参数校验
│         ↓                           │
│  Services 层（src/services/）        │  业务逻辑
│         ↓                           │
│  Database 层（src/database/）        │  数据持久化（rusqlite）
└─────────────────────────────────────┘
```

- **Commands**: `#[tauri::command]` 标记，负责接收前端参数并调用 Service
- **Services**: 纯业务逻辑，不涉及 Tauri API
- **Database**: `Mutex<Connection>` 线程安全的 SQLite 操作

## 快速开始

### 环境要求

- [Rust](https://www.rust-lang.org/tools/install) (stable)
- [Node.js](https://nodejs.org/) (>= 18)
- [pnpm](https://pnpm.io/) (>= 8)
- 系统依赖参考 [Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/)

### 安装和运行

```bash
# 安装前端依赖
pnpm install

# 开发模式（前端 HMR + Rust 热编译）
pnpm tauri dev

# 生产构建（生成安装包）
pnpm tauri build
```

### 常用命令

```bash
pnpm dev              # 仅启动前端开发服务器
pnpm dev:clean        # 清理端口 1420 后启动前端
pnpm build            # 构建前端产物
pnpm tauri dev        # 启动完整 Tauri 开发环境
pnpm tauri build      # 构建桌面安装包
```

## 开发指南

### 添加新功能的完整流程

1. **数据模型** — `src-tauri/src/models/mod.rs` 定义 Rust struct
2. **数据库操作** — `src-tauri/src/database/` 实现 CRUD 方法
3. **业务逻辑** — `src-tauri/src/services/` 编写业务规则
4. **Command 定义** — `src-tauri/src/commands/` 暴露 IPC 接口
5. **Command 注册** — `src-tauri/src/lib.rs` 添加到 `generate_handler![]`
6. **TS 类型** — `src/types/index.ts` 定义对应 TypeScript 接口
7. **API 封装** — `src/lib/api/index.ts` 封装 invoke 调用
8. **页面组件** — `src/pages/` 实现 React 页面
9. **路由注册** — `src/Router.tsx` 添加路由
10. **导航入口** — `src/components/layout/Sidebar.tsx` 添加菜单项

### 内置的 Tauri 插件

| 插件 | 用途 |
|------|------|
| tauri-plugin-opener | 打开 URL / 文件 |
| tauri-plugin-store | 键值持久化存储 |
| tauri-plugin-log | 日志系统 |

### Capabilities 权限

当前已声明的权限（`src-tauri/capabilities/default.json`）：

- `core:default` — 核心默认权限
- `opener:default` — 打开 URL / 文件
- `store:default` — 键值存储
- `log:default` — 日志

使用新的 Tauri 插件时，需在此文件中添加对应权限。

## 推荐 IDE

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
- [Cursor](https://cursor.sh/) / [Claude Code](https://claude.com/claude-code)（AI 辅助开发）
