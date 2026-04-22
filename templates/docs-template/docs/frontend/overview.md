# 前端概览

<!-- 本章由 /docs 命令基于 src/ 实际代码自动更新 -->

## 技术栈

| 技术 | 版本 | 用途 |
|------|-----|-----|
| React | 19 | UI 框架 |
| TypeScript | 5.8 | 类型系统 |
| Ant Design | 5+ | 组件库 |
| TailwindCSS | 4 | 原子化样式 |
| Zustand | 5+ | 状态管理 |
| React Router | 7 | 路由（HashRouter） |
| Vite | 7 | 构建工具 |

## 分层约定

| 层级 | 目录 | 职责 |
|------|------|------|
| 入口 | `src/main.tsx` | React 根节点挂载 |
| 根组件 | `src/App.tsx` | Provider + 主题 + ErrorBoundary |
| 路由 | `src/Router.tsx` | 路由配置 |
| 页面 | `src/pages/` | 具体页面组件 |
| 组件 | `src/components/` | 通用组件（layout/ui） |
| API | `src/lib/api/` | invoke 调用封装 |
| 状态 | `src/store/` | Zustand store |
| 类型 | `src/types/` | TypeScript 接口 |

## invoke 调用模式

前端**不直接调用** `invoke()`，而是通过 `src/lib/api/` 封装：

```typescript
// ─── src/lib/api/config.ts ───
import { invoke } from "@tauri-apps/api/core";
import type { AppConfig } from "@/types";

export const configApi = {
  getAll: () => invoke<AppConfig[]>("get_all_config"),
  set: (key: string, value: string) =>
    invoke<void>("set_config", { key, value }),
};
```

## 主题系统

三层主题架构：

| 层级 | 文件 | 职责 |
|------|------|------|
| CSS 变量 | `src/styles/variables.css` | 设计令牌（颜色/间距/阴影） |
| Ant Design | `src/theme/antdTheme.ts` | 组件库主题 |
| 状态 | `src/store/app.ts` | 三态切换（dark/light/system） |

## 路径别名

全部使用 `@/` 导入：

```typescript
import { configApi } from "@/lib/api";
import { useAppStore } from "@/store";
import type { AppConfig } from "@/types";
```
