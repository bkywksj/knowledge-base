---
name: docs-management
description: |
  VitePress 文档站点管理技能。负责初始化文档站点、增量同步代码变更到文档、追踪同步元数据（.docs-meta.json），生成的文档风格模仿同目录 tauri-docs / tauri-cc-docs / knowledge-base-docs。

  触发场景：
  - 需要为项目生成对外文档站点（VitePress）
  - 需要基于代码变更增量更新已有文档
  - 需要从零初始化独立 docs 仓库（同级目录）
  - 需要在本项目内部生成 ./website/ 文档
  - 需要检查文档同步状态（.docs-meta.json）

  触发词：文档站点、VitePress、docs 站点、用户手册、更新文档、文档同步、docs-management、.docs-meta.json、website 目录、文档仓库
---

# VitePress 文档站点管理指南

## 概述

本技能负责"产品级对外文档站点"的完整生命周期管理：

- **初始化**：从 `templates/update-docs-template/` 复制骨架，根据主项目信息替换占位符
- **增量更新**：读取 `.docs-meta.json` 的 `lastSyncCommit`，基于 `git diff` 识别受影响的文档章节
- **风格对齐**：生成的文档风格与同级目录的 `tauri-docs` / `tauri-cc-docs` / `knowledge-base-docs` 保持一致（VitePress 1.6.3、纯中文、Hero+Features 首页、h2/h3 分层、表格密集）

> **与 `doc-generation` 的区别**：`doc-generation` 生成的是**本地 Markdown 文件**（给开发者看的 API 参考，输出到 `docs/` 作为内部笔记）；本技能管理的是**VitePress 站点**（面向用户的产品文档，输出到 `./website/` 或 `../xxx-docs/`）。

---

## 核心规则

| 规则 | 说明 |
|------|------|
| 元数据位置 | `.docs-meta.json` **放主项目根目录**（不是文档目录），这样 `git log` 能看到同步历史 |
| 文档位置 | 默认同级独立仓库（`../{project}-docs`），备选本项目内 `./website/` 或用户自定目录 |
| VitePress 命令 | **只在文档目录内执行**（`cd website && pnpm dev`），不在主项目根暴露 |
| 禁占 `./update-docs/` | 主项目 `./update-docs/` 是内部研发文档目录（如 `development-guide.md`），**不得**占用 |
| 章节聚合 | 同模块的代码变更聚合成一篇文档，不是"一个文件一篇" |
| git 操作 | 首次初始化 sibling 时自动 `git init` + 首次 commit；**从不自动 push** |
| 保留手工改动 | 增量更新只改 `<!-- 本章由 /update-docs ... -->` 注释标记的段落，其他保留 |

---

## 文档放置决策树

```
首次运行（无 .docs-meta.json）
├── 询问用户选择：
│   ├── [1] 同级独立仓库 → ../{project-slug}-docs     （默认 ★ 推荐）
│   ├── [2] 本项目内部    → ./website
│   └── [3] 自定义路径    → 用户输入
├── 读 {project}/package.json 和 src-tauri/tauri.conf.json 获取项目名/描述
├── 复制 templates/update-docs-template/ → 目标位置
├── 替换占位符（见下表）
├── 分析代码生成首版内容
└── 写 .docs-meta.json 到主项目根

后续运行（已有 .docs-meta.json）
├── 读取 lastSyncCommit
├── git diff --name-only {lastSyncCommit}..HEAD
├── 按文件路径 → 文档章节映射（见下表）
├── 聚合同章节变更
├── 展示影响范围给用户确认
├── 生成/更新受影响的 .md
├── 追加 updateHistory 到 .docs-meta.json
└── 提示用户 cd 到文档目录 commit
```

---

## 占位符替换表

初始化时从 `templates/update-docs-template/` 复制后，全局替换以下占位符：

| 占位符 | 来源 | 示例 |
|--------|------|------|
| `{{PROJECT_NAME}}` | `tauri.conf.json` 的 `productName` 或 `package.json` 的 `name` | `灵动桌面框架` |
| `{{PROJECT_SLUG}}` | `package.json` 的 `name`（kebab-case） | `tauri` |
| `{{PROJECT_DESC}}` | `package.json` 的 `description`（用户可补充） | `Tauri 2.x 企业级桌面开发框架` |
| `{{PROJECT_TAGLINE}}` | 用户输入或自动生成（基于技术栈） | `Tauri 2.x + React 19 + Rust` |
| `{{SITE_URL}}` | 用户输入，默认 `https://example.com` | `https://tauri.ruoyi.plus` |
| `{{THEME_COLOR}}` | 用户输入，默认 `#0B6EF0` | `#0B6EF0` |
| `{{KEYWORDS}}` | 自动从技术栈生成 | `Tauri,React,Rust,桌面应用` |
| `{{DOCS_PROJECT_NAME}}` | `{PROJECT_SLUG}-docs` | `tauri-docs` |
| `{{LOGO_LETTER}}` | `PROJECT_SLUG` 首字母大写 | `T` |
| `{{INITIAL_COMMIT}}` | `git rev-parse HEAD`（主项目） | `a1c6cc8` |
| `{{INITIAL_TIME}}` | ISO 8601 UTC 时间 | `2026-04-19T15:30:00Z` |

---

## 文件路径 → 文档章节映射

增量更新时用此表把主项目的代码变更路由到对应文档章节：

| 主项目路径 | 映射到 | 说明 |
|-----------|--------|------|
| `src-tauri/src/commands/*.rs` | `api/commands.md` | 扫描 `#[tauri::command]` 生成签名 + 说明 |
| `src-tauri/src/services/*.rs` | `backend/services.md`（按需创建） | 业务逻辑说明 |
| `src-tauri/src/database/*.rs` | `backend/database.md`（按需创建） | Schema + DAO 说明 |
| `src-tauri/src/models/*.rs` | `api/models.md`（按需创建） | 数据结构说明 |
| `src-tauri/src/error.rs` | `backend/error-handling.md`（按需创建） | 错误码列表 |
| `src-tauri/Cargo.toml` | `guide/dependencies.md`（按需创建） | Rust 依赖清单 |
| `src-tauri/tauri.conf.json` | `guide/configuration.md`（按需创建） | 窗口/打包配置 |
| `src-tauri/capabilities/*.json` | `backend/capabilities.md`（按需创建） | 权限声明 |
| `src/pages/*/index.tsx` | `frontend/pages.md`（按需创建） | 页面功能说明 |
| `src/store/*.ts` | `frontend/state.md`（按需创建） | 状态管理 |
| `src/lib/api/*.ts` | `frontend/api.md`（按需创建） | invoke 封装 |
| `package.json` | `guide/dependencies.md` | 前端依赖清单 |
| `README.md` | `guide/introduction.md` | 项目介绍 |
| `CLAUDE.md` | 跳过（内部指令，不入文档站点） | — |

**聚合规则**：同一文档章节的多个源文件变更合并成一篇文档的一次更新，不按文件拆小节。

---

## `.docs-meta.json` 结构

放在**主项目根目录**。完整结构：

```json
{
  "version": "1.0.0",
  "docsProject": "tauri-docs",
  "docsLocation": "sibling",
  "docsPath": "../tauri-docs",
  "themeColor": "#0B6EF0",
  "lastSyncCommit": "a1c6cc8",
  "lastSyncTime": "2026-04-19T15:30:00Z",
  "coveredSections": ["guide", "api", "backend", "frontend"],
  "updateHistory": [
    {
      "commit": "a1c6cc8",
      "time": "2026-04-19T15:30:00Z",
      "type": "init",
      "affectedDocs": ["index.md", "guide/introduction.md", ...],
      "sourceChanges": []
    },
    {
      "commit": "b2d7ef1",
      "time": "2026-04-20T10:00:00Z",
      "type": "incremental",
      "affectedDocs": ["api/commands.md"],
      "sourceChanges": ["src-tauri/src/commands/user.rs"]
    }
  ]
}
```

**字段含义**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `docsLocation` | `"sibling"` \| `"internal"` \| `"custom"` | 文档位置模式 |
| `docsPath` | string | 相对于主项目根的相对路径 |
| `lastSyncCommit` | string | 最近一次同步时主项目的 git HEAD |
| `coveredSections` | string[] | 已生成过内容的章节（`guide` / `api` / `backend` / `frontend`） |
| `updateHistory[].type` | `"init"` \| `"incremental"` \| `"full"` | 更新类型 |
| `updateHistory[].affectedDocs` | string[] | 本次改动的文档文件（相对 `docs/`） |
| `updateHistory[].sourceChanges` | string[] | 触发本次更新的主项目代码文件 |

---

## 执行流程

### 流程 A：首次初始化

```
1. 检测主项目根 .docs-meta.json 是否存在
   └─ 不存在 → 进入初始化

2. 交互收集项目信息（依次询问）:
   Q1: 文档放哪里？
       [1] 同级独立仓库 ../{slug}-docs   (推荐)
       [2] 本项目内部  ./website
       [3] 自定义路径  [用户输入]
   Q2: 项目对外名称？              (默认读 tauri.conf.json productName)
   Q3: 一句话描述？                (默认读 package.json description)
   Q4: 主题色？                     (默认 #0B6EF0)
   Q5: 站点 URL？                   (默认 https://example.com，可跳过)

3. 复制模板:
   cp -r templates/update-docs-template/* <目标路径>/
   cp templates/update-docs-template/.gitignore <目标路径>/
   cp templates/update-docs-template/.docs-meta.template.json <主项目根>/.docs-meta.json
   (注意：docs-meta 放主项目根，不是目标路径)

4. 替换占位符（见上方占位符表）:
   对 <目标路径> 下所有 .md / .ts / .css / .svg / .json 递归替换

5. 分析主项目生成初版内容:
   - 读 src-tauri/src/commands/*.rs 填充 api/commands.md 的索引表
   - 读 Cargo.toml / package.json 填充 guide/quickstart.md 的版本
   - 读 README.md 填充 guide/introduction.md 的核心特性

6. (仅 sibling) git 初始化:
   cd <目标路径>
   git init
   git add -A
   git commit -m "📝 docs: 初始化文档站点"
   (不推送，由用户手动)

7. 输出提示:
   ✅ 文档站点已初始化到 <目标路径>
   📋 元数据已写入 .docs-meta.json
   下一步：
     cd <目标路径>
     pnpm install
     pnpm dev       # http://localhost:5173
```

### 流程 B：增量更新

```
1. 读取 .docs-meta.json，确认 lastSyncCommit 和 docsPath

2. git diff --name-only <lastSyncCommit>..HEAD
   → 得到变更文件列表

3. 按"文件路径 → 文档章节映射"表路由:
   src-tauri/src/commands/user.rs → api/commands.md
   src-tauri/src/services/user.rs → backend/services.md
   ...

4. 聚合同章节变更，输出影响范围:
   ## 本次将更新的文档章节
   | 章节 | 受影响的源文件 |
   |------|---------------|
   | api/commands.md | src-tauri/src/commands/user.rs (+2 commands) |
   | backend/services.md | src-tauri/src/services/user.rs |

   确认更新吗？[y/N]

5. 用户确认后逐章节重写受影响段落:
   - 只改 <!-- 本章由 /update-docs ... --> 标记的段落
   - 手工添加的段落保留
   - 索引表（如 api/commands.md 的 Command 清单）整体重生成

6. 追加 updateHistory 到 .docs-meta.json:
   - lastSyncCommit = git rev-parse HEAD
   - lastSyncTime = now
   - 追加一条 updateHistory 记录

7. 输出提示:
   ✅ 已更新 N 篇文档
   下一步：
     cd <docsPath>
     git diff              # 查看变化
     git commit -am "..."  # 手动提交
```

### 流程 C：全量重建（`/update-docs full`）

```
与流程 B 类似，但：
- 不看 lastSyncCommit，所有章节重新基于当前代码生成
- updateHistory type = "full"
- 保留 docs/public/ 下用户添加的图片
- 保留用户手动新增的 .md 文件（不删除）
```

---

## 生成文档的写作风格（与 tauri-docs 一致）

| 维度 | 规范 |
|------|------|
| 语言 | 纯中文（避免中英混写） |
| 标题结构 | 开篇 `#` 一行，紧跟一句话概述段 |
| 层级 | `##` 主小节 / `###` 次小节，**避免** `####` 及以下 |
| 代码示例 | 带中文注释；Rust + TypeScript 各一份（若适用） |
| 表格 | 对比、速查、清单场景优先用表格 |
| 图示 | 架构图用 ASCII 框线图（盒子+箭头），不引入 mermaid |
| 章节末尾 | 加"下一步"或"相关章节"链接（内部导航） |
| emoji | 节制使用（标题偶尔用，正文不用） |

---

## 实战示例：增量更新片段

**场景**：主项目新增了 `commands/user.rs`，含两个 Command `list_users` 和 `create_user`。

**步骤 1** — diff 识别：
```
git diff --name-only a1c6cc8..HEAD
# src-tauri/src/commands/user.rs
# src-tauri/src/lib.rs  (generate_handler! 新增两项)
```

**步骤 2** — 路由：
```
src-tauri/src/commands/user.rs → api/commands.md
src-tauri/src/lib.rs            → 跳过（仅注册表，不单独成章）
```

**步骤 3** — 扫描 Command 签名：
```rust
// src-tauri/src/commands/user.rs
#[tauri::command]
pub fn list_users(state: State<'_, AppState>) -> Result<Vec<User>, CommandError> { ... }

#[tauri::command]
pub fn create_user(state: State<'_, AppState>, name: String, email: String) -> Result<User, CommandError> { ... }
```

**步骤 4** — 更新 `api/commands.md` 索引表：
```markdown
| Command | 模块 | 简述 |
|---------|------|------|
| `list_users` | user | 列出所有用户 |
| `create_user` | user | 创建新用户 |
```

**步骤 5** — 为每个新 Command 生成一节：
```markdown
### `list_users`

**签名**：`fn list_users(state: State<'_, AppState>) -> Result<Vec<User>, CommandError>`

**参数**：无（仅注入 AppState）

**返回**：`User[]`

**前端调用**：

\`\`\`typescript
import { userApi } from "@/lib/api";
const users = await userApi.list();
\`\`\`
```

**步骤 6** — 更新 `.docs-meta.json`：
```json
{
  "lastSyncCommit": "b2d7ef1",
  "lastSyncTime": "2026-04-20T10:00:00Z",
  "updateHistory": [
    ...,
    {
      "commit": "b2d7ef1",
      "time": "2026-04-20T10:00:00Z",
      "type": "incremental",
      "affectedDocs": ["api/commands.md"],
      "sourceChanges": ["src-tauri/src/commands/user.rs"]
    }
  ]
}
```

---

## 常见错误与最佳实践

| 错误做法 | 正确做法 | 原因 |
|---------|---------|------|
| 占用主项目 `./update-docs/` 放 VitePress | 用 `./website/` 或同级 `../xxx-docs` | `./update-docs/` 已被内部研发文档占用 |
| 在主项目根 `package.json` 加 `vitepress dev` 脚本 | 让脚本留在文档目录内部 | 避免主项目与文档的依赖混淆 |
| `.docs-meta.json` 放文档目录里 | 放主项目根目录 | 主项目 git log 才能追踪同步历史 |
| 增量更新整个覆盖用户手改的段落 | 只改 `<!-- 本章由 /update-docs ... -->` 标记段 | 保护用户后续补充的内容 |
| 一个 Command 一篇文档 | 同模块聚合到一篇 | 避免文档碎片化 |
| 自动 `git push` 到远程 | 只 `commit`，push 由用户手动 | 推送有风险，避免误推 |
| 初始化时不询问用户 | 交互式收集项目信息 | 确保占位符替换正确 |

---

## 相关技能

- `add-skill` — 技能维护流程（本技能本身遵循这些规范）
- `project-navigator` — 主项目结构导航（映射表的依据）
- `doc-generation` — 旧技能，生成本地 Markdown API 参考（与本技能**互补不冲突**）
- `release-publish` — 发版时可以顺便 `/update-docs` 更新文档
