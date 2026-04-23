# 项目结构

<!-- 本章由 /docs 命令自动生成/维护 -->

## 顶层目录

```
{{PROJECT_SLUG}}/
├── src/                    # 前端源码（React + TypeScript）
├── src-tauri/              # Rust 后端源码
├── public/                 # 静态资源
├── docs/                   # 内部研发文档（开发笔记）
└── package.json
```

## 前端（`src/`）

```
src/
├── main.tsx                # 入口
├── App.tsx                 # 根组件（ConfigProvider + ErrorBoundary）
├── Router.tsx              # 路由配置
├── pages/                  # 页面组件
├── components/             # 通用组件
│   ├── layout/             # 布局（AppLayout/Sidebar）
│   └── ui/                 # 基础 UI（ErrorBoundary 等）
├── lib/api/                # invoke 封装（按模块拆分）
├── store/                  # Zustand 全局状态
├── types/                  # TypeScript 类型定义
├── hooks/                  # 自定义 Hooks
├── theme/                  # Ant Design 主题
└── styles/                 # TailwindCSS + CSS 变量
```

## 后端（`src-tauri/src/`）

```
src-tauri/src/
├── main.rs                 # 进程入口
├── lib.rs                  # Builder 注册（插件 + Commands + State）
├── error.rs                # AppError / CommandError
├── state.rs                # AppState（包含 Database）
├── commands/               # Layer 1: IPC 入口
├── services/               # Layer 2: 业务逻辑
├── database/               # Layer 3: 数据访问（rusqlite）
├── models/                 # 数据模型
└── shared/                 # 公共工具
```

## 配置文件

| 文件 | 用途 |
|------|------|
| `src-tauri/tauri.conf.json` | Tauri 核心配置（窗口/打包/安全） |
| `src-tauri/capabilities/*.json` | 权限声明 |
| `src-tauri/Cargo.toml` | Rust 依赖 |
| `package.json` | 前端依赖 |
| `vite.config.ts` | 前端构建配置 |
| `tsconfig.json` | TypeScript 配置 |
