# 项目介绍

**{{PROJECT_NAME}}** — {{PROJECT_DESC}}

## 核心特性

<!-- 本段由 /docs 命令基于主项目代码自动生成，可手动补充 -->

- 基于 Tauri 2.x 的双进程架构
- Rust 后端 + React 前端，通过 IPC 通信
- 本地 SQLite 持久化
- 严格的 Capabilities 权限模型

## 技术栈

| 层级 | 技术 | 说明 |
|-----|------|-----|
| 桌面框架 | Tauri 2.x | 跨平台桌面应用 |
| 后端 | Rust 2021 | 内存安全的系统编程语言 |
| 前端 | React 19 + TypeScript 5.8 | 现代化前端框架 |
| UI | Ant Design + TailwindCSS | 企业级组件库 + 原子化 CSS |
| 状态 | Zustand | 轻量级状态管理 |
| 路由 | React Router 7 | HashRouter |
| 数据库 | SQLite (rusqlite) | 本地关系型数据库 |

## 架构总览

```
┌───────────────────────────────────────────────────────┐
│                 {{PROJECT_NAME}}                      │
│                                                       │
│  ┌──────────────────┐  IPC (invoke)  ┌──────────────────┐
│  │   WebView 进程    │ ◄════════════► │   Rust Core 进程  │
│  │  React 19 + Antd │                │  Commands/Services│
│  └──────────────────┘                └──────────────────┘
└───────────────────────────────────────────────────────┘
```

## 下一步

- [快速开始](./quickstart.md) — 本地启动与调试
- [项目结构](./structure.md) — 代码目录组织
