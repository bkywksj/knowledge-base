# Tauri Desktop App — Claude Code AI 辅助系统 安装说明

## 系统要求

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 已安装
- Node.js >= 18（Hooks 运行需要）
- 目标项目为 Tauri 2.x 桌面应用（Rust + React + TypeScript）

## 安装步骤

1. **复制 `CLAUDE.md`** 到 Tauri 项目根目录
2. **复制 `.claude/` 目录** 到 Tauri 项目根目录
3. **启动 Claude Code**：在项目根目录运行 `claude`

```
your-tauri-project/
├── CLAUDE.md               ← 复制到这里
├── .claude/                 ← 复制到这里
│   ├── settings.json
│   ├── hooks/
│   │   ├── skill-forced-eval.js
│   │   └── pre-tool-use.js
│   ├── commands/
│   │   ├── dev.md
│   │   ├── command.md
│   │   ├── check.md
│   │   ├── start.md
│   │   ├── progress.md
│   │   └── next.md
│   └── skills/
│       └── (31 个技能目录)
├── src/                     ← 你的 React 前端
├── src-tauri/               ← 你的 Rust 后端
├── package.json
└── ...
```

> **注意**：不要复制 `analysis/` 和 `status.json`，它们是定制过程的中间产物。

## 验证安装

在 Claude Code 中输入任意开发问题，确认技能被正确评估和激活：

```
你: 帮我创建一个文件管理功能

Claude 应该：
1. 列出匹配技能（如 tauri-commands、file-storage、tauri-plugins）
2. 逐个调用 Skill() 激活
3. 然后开始实现
```

---

## 技能清单（31 个）

### L1 通用技能（8 个）— 直接复用

| # | 技能 | 说明 |
|---|------|------|
| 1 | brainstorm | 头脑风暴、方案探索、创意思维 |
| 2 | task-tracker | 任务跟踪与进度管理 |
| 3 | git-workflow | Git 工作流与版本管理 |
| 4 | code-patterns | 代码模式与编码规范（Rust + TypeScript） |
| 5 | tech-decision | 技术选型与架构决策 |
| 6 | bug-detective | Bug 排查与调试 |
| 7 | collaborating-with-codex | 与 OpenAI Codex 协作开发 |
| 8 | collaborating-with-gemini | 与 Google Gemini 协作开发 |

### L3 深度定制（15 个）— 适配 Tauri 技术栈

| # | 技能 | 说明 |
|---|------|------|
| 9 | project-navigator | 项目结构导航，快速定位代码 |
| 10 | error-handler | 异常处理（Rust Result + React 错误边界） |
| 11 | api-development | Tauri Command (IPC API) 设计与实现 |
| 12 | architecture-design | 双进程架构设计与模块拆分 |
| 13 | json-serialization | JSON 序列化（Rust serde + TypeScript 类型） |
| 14 | utils-toolkit | 工具函数与常用 crate |
| 15 | test-development | 测试开发（cargo test + React 测试） |
| 16 | ui-frontend | React 前端 UI 组件开发 |
| 17 | store-management | 状态管理（React 状态 + Rust State） |
| 18 | file-storage | 文件操作（Rust fs + Tauri FS Plugin） |
| 19 | security-permissions | 安全与权限（Capabilities 配置） |
| 20 | database-ops | 本地数据库（SQLite / tauri-plugin-sql） |
| 21 | i18n-development | 国际化（react-i18next） |
| 22 | notification-system | 系统通知（tauri-plugin-notification） |
| 23 | performance-doctor | 性能诊断与优化 |

### L4 框架专属（8 个）— Tauri 独有特性

| # | 技能 | 说明 |
|---|------|------|
| 24 | tauri-commands | Tauri Command 高级开发（异步、状态注入、流式传输） |
| 25 | tauri-plugins | 插件开发与集成（官方 + 自定义） |
| 26 | tauri-window-management | 窗口管理（多窗口、无边框、系统托盘） |
| 27 | tauri-capabilities | Capabilities 深度配置与权限管理 |
| 28 | tauri-packaging | 跨平台打包与分发（MSI/DMG/AppImage） |
| 29 | rust-fundamentals | Rust 语言基础（所有权、借用、生命周期） |
| 30 | tauri-events | 事件系统（前后端双向事件通信） |
| 31 | tauri-updater | 应用自动更新 |

---

## 命令清单（6 个）

| 命令 | 说明 |
|------|------|
| `/dev` | 开发新功能（Rust Command + React UI + Capabilities 全栈生成） |
| `/command` | 快速创建 Tauri Command（单个 IPC 函数） |
| `/check` | 代码规范检查（Rust clippy 规则 + TypeScript 规则） |
| `/start` | 新窗口快速了解项目 |
| `/progress` | 项目进度报告 |
| `/next` | 下一步开发建议 |

---

## Hooks 说明

| Hook | 触发时机 | 功能 |
|------|---------|------|
| `skill-forced-eval.js` | 每次用户提问 | 注入技能评估指令，将技能激活率提升至 90%+ |
| `pre-tool-use.js` | Bash/Write 操作前 | 阻止危险命令、提醒敏感文件操作 |

---

## 技术栈适配说明

本 AI 辅助系统专为以下技术栈定制：

| 层级 | 技术 | 版本 |
|------|------|------|
| 后端 | Rust | 2021 edition |
| 桌面框架 | Tauri | 2.x |
| 前端 | React | 19 |
| 类型系统 | TypeScript | 5.8 |
| 构建工具 | Vite | 7 |
| 序列化 | serde + serde_json | — |
| 包管理 | Cargo (Rust) + pnpm (Node.js) | — |

---

## 常见问题

**Q: Hook 不生效？**
A: 确认 `.claude/settings.json` 中的 hooks 配置正确，且 Node.js 已安装。

**Q: 技能没有被自动激活？**
A: 检查 `.claude/hooks/skill-forced-eval.js` 是否存在且可执行。

**Q: 如何添加新技能？**
A: 在 `.claude/skills/` 下创建新目录，添加 `SKILL.md` 文件，然后更新 `skill-forced-eval.js` 中的技能列表。
