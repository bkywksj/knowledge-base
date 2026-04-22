# /update-docs - 文档站点管理

管理 VitePress 文档站点：首次初始化、增量更新、全量重建。

**3 条核心原则**：
- 元数据以主项目根的 `.docs-meta.json` 为准
- 首次初始化必须交互询问用户（位置 / 项目信息 / 主题色）
- 更新文档 **只 commit 不 push**（推送由用户手动）

---

## 参数

| 输入 | 行为 |
|------|------|
| `/update-docs` | 自动检测：无 `.docs-meta.json` → 初始化；有 → 增量更新 |
| `/update-docs init` | 强制进入初始化流程（即使已有 meta） |
| `/update-docs update` | 增量更新（等同 `/update-docs` 在已初始化状态下） |
| `/update-docs full` | 全量重建（重新生成所有章节，保留用户手工添加的文件） |
| `/update-docs status` | 只读查看：当前文档路径、lastSyncCommit、距今变更文件数 |
| `/update-docs diff` | 展示自 lastSyncCommit 以来会影响哪些文档章节（不写文件） |

---

## 第一步：检测状态

```
1. 读主项目根 .docs-meta.json
   ├─ 不存在 或 /update-docs init          → 流程 A（初始化）
   ├─ 存在 且 无参数 或 /update-docs update → 流程 B（增量）
   ├─ 存在 且 /update-docs full             → 流程 C（全量重建）
   ├─ 存在 且 /update-docs status           → 流程 D（只读）
   └─ 存在 且 /update-docs diff             → 流程 E（预览）
```

---

## 流程 A：初始化

### A.1 交互收集

```
📝 初始化文档站点

Q1. 文档放哪里？
    [1] 同级独立仓库  ../{project-slug}-docs     ← 推荐
    [2] 本项目内部    ./website
    [3] 自定义路径    （输入绝对或相对路径）
    > 1

Q2. 项目对外展示名称？
    （检测到 tauri.conf.json productName：灵动桌面框架）
    > [回车用默认，或输入新名]

Q3. 一句话描述？
    （检测到 package.json description：Tauri 2.x 企业级开发框架）
    > [回车用默认，或输入新描述]

Q4. 主题色（HEX）？
    > [回车用 #0B6EF0]

Q5. 站点最终 URL？（用于 SEO，可跳过）
    > https://...

Q6. Logo 字母？
    （默认用项目名首字母：T）
    > [回车或输入]
```

### A.2 复制模板并替换占位符

1. `cp -r templates/update-docs-template/* <目标路径>/`
2. `cp templates/update-docs-template/.gitignore <目标路径>/`
3. `cp templates/update-docs-template/.docs-meta.template.json <主项目根>/.docs-meta.json`
4. 对 `<目标路径>` 递归替换所有占位符（见 `docs-management` 技能的占位符表）
5. 对 `.docs-meta.json` 替换占位符（`INITIAL_COMMIT` = `git rev-parse HEAD`，`INITIAL_TIME` = 当前 UTC）

### A.3 分析主项目生成首版内容

- 读 `src-tauri/src/commands/*.rs` 填充 `api/commands.md` 的索引表
- 读 `Cargo.toml` / `package.json` 填充 `guide/quickstart.md` 的版本信息
- 读主项目 `README.md` 补充 `guide/introduction.md` 的核心特性段

### A.4 git 初始化（仅 sibling 模式）

```bash
cd <目标路径>
git init
git add -A
git commit -m "📝 docs: 初始化文档站点"
```

### A.5 输出

```
✅ 文档站点已初始化

📂 位置：<目标路径>
📋 元数据：<主项目根>/.docs-meta.json
📝 已生成 7 篇文档：
   - index.md
   - guide/introduction.md
   - guide/quickstart.md
   - guide/structure.md
   - backend/architecture.md
   - frontend/overview.md
   - api/commands.md

下一步：
  cd <目标路径>
  pnpm install
  pnpm dev           # http://localhost:5173
```

---

## 流程 B：增量更新

### B.1 检测变更

```bash
git diff --name-only <lastSyncCommit>..HEAD
```

### B.2 路由到文档章节

按 `docs-management` 技能里的映射表执行。举例：

| 主项目变更 | 影响文档 |
|-----------|---------|
| `src-tauri/src/commands/user.rs` | `api/commands.md` |
| `src-tauri/src/services/user.rs` | `backend/services.md` |
| `src/pages/users/index.tsx` | `frontend/pages.md` |
| `package.json` | `guide/dependencies.md` |

### B.3 展示影响范围

```
## 本次将更新的文档章节

距上次同步（a1c6cc8）已有 12 个文件变更。

| 章节 | 受影响的源文件 |
|------|---------------|
| api/commands.md | src-tauri/src/commands/user.rs (+2 命令) |
| backend/services.md | src-tauri/src/services/user.rs |
| frontend/pages.md | src/pages/users/index.tsx |
| guide/dependencies.md | package.json (新增 2 个依赖) |

确认更新吗？[y/N]
```

### B.4 用户确认后

1. 只重写 `<!-- 本章由 /update-docs ... -->` 标记段落
2. 索引表（如 Command 清单）整表重生成
3. 用户手工添加的段落/文件保留
4. 追加 `updateHistory` 条目
5. 更新 `lastSyncCommit` 和 `lastSyncTime`

### B.5 输出

```
✅ 已更新 4 篇文档

改动文件（在 <docsPath> 下）：
  - docs/api/commands.md
  - docs/backend/services.md
  - docs/frontend/pages.md
  - docs/guide/dependencies.md

主项目：
  .docs-meta.json 已更新（lastSyncCommit → b2d7ef1）

下一步：
  cd <docsPath>
  pnpm dev              # 本地预览
  git diff              # 查看改动
  git commit -am "📝 docs: 同步代码变更到 b2d7ef1"

⚠️ 未自动 push。
```

---

## 流程 C：全量重建

与 B 类似，但：

- 不读 `lastSyncCommit`，所有已覆盖章节（`coveredSections`）重新生成
- `updateHistory.type = "full"`
- 保留 `docs/public/` 下用户添加的图片
- 保留用户手动新增的非模板 `.md` 文件

---

## 流程 D：status（只读）

```
📋 文档站点状态

路径：   ../tauri-docs  (sibling)
主题色： #0B6EF0
上次同步：a1c6cc8  (2026-04-19 15:30)
已覆盖章节：guide, api, backend, frontend

距上次同步的主项目变更：12 个文件
  - src-tauri/src/commands/user.rs      (new)
  - src-tauri/src/services/user.rs      (new)
  - package.json                         (modified)
  ... 还有 9 个

运行 /update-docs diff 查看影响的文档章节
运行 /update-docs update 执行增量更新
```

---

## 流程 E：diff（只读预览）

与 B.3 相同的影响范围表，但**不写任何文件**，仅展示。

---

## 硬性规则

| 规则 | 说明 |
|------|------|
| **元数据位置** | `.docs-meta.json` 放主项目根，不放文档目录 |
| **禁占 `./update-docs/`** | 本项目内部模式用 `./website/`，`./update-docs/` 留给内部研发文档 |
| **不自动 push** | 只 `git init` + `commit`，push 由用户手动 |
| **覆盖前保护** | 只改 `<!-- 本章由 /update-docs ... -->` 标记的段落，用户手改段保留 |
| **聚合章节** | 多文件变更合并到章节级文档，不做"一文件一文档" |
| **初始化必交互** | 至少询问位置、项目名、主题色 |
| **apply 前确认** | `/update-docs update` 展示影响表后必须等用户 `y/N` |

---

## 何时用

- 新项目建好后，首次生成对外文档站点 → `/update-docs`
- 主项目迭代了一轮，代码变化后同步到文档 → `/update-docs update`
- 大版本发布，重写大部分文档 → `/update-docs full`
- 想看当前同步状态 → `/update-docs status`
- 提交前预览哪些文档会变 → `/update-docs diff`

---

## 与其他命令的关系

| 命令 | 关系 |
|------|------|
| `/release` | 发版流程中可顺手调用 `/update-docs update` 同步文档 |
| `/sync-from-framework` | 同步框架规范，与文档站点无关 |
| `/dev` | 开发新功能后，建议跟一个 `/update-docs update` |
| `/check` | 代码规范检查，与文档站点无关 |
