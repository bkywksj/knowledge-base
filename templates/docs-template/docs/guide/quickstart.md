# 快速开始

## 环境要求

| 工具 | 最低版本 | 检查命令 |
|------|---------|---------|
| Node.js | 18+ | `node -v` |
| pnpm | 8+ | `pnpm -v` |
| Rust | 1.77+ | `rustc --version` |

<!-- 项目特定环境要求由 /docs 命令从 package.json / Cargo.toml 自动补全 -->

## 安装依赖

```bash
pnpm install
cd src-tauri && cargo fetch
```

## 开发模式

```bash
pnpm tauri dev
```

前端 HMR 地址：`http://localhost:1420`

## 生产构建

```bash
pnpm tauri build
```

构建产物位于 `src-tauri/target/release/bundle/`。

## 常用命令

| 命令 | 用途 |
|------|------|
| `pnpm tauri dev` | 开发模式（前端 HMR + Rust 热编译） |
| `pnpm tauri build` | 生产构建 |
| `pnpm build` | 仅构建前端 |
| `npx tsc --noEmit` | TypeScript 类型检查 |
| `cd src-tauri && cargo clippy` | Rust 静态检查 |
| `cd src-tauri && cargo test` | Rust 单元测试 |

## 下一步

- [项目结构](./structure.md) — 了解代码组织
- [三层架构](../backend/architecture.md) — 后端分层职责
