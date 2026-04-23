# /exp-to-framework - 沉淀经验到原框架

作为本项目到"原框架"的经验输送员。分析子项目的近期 commit / 未提交 diff / 本会话上下文，把**通用的**坑、模式、配置、工具函数、skill 条目抽取出来，建议同步到原框架目录。

**4 条核心原则**：
- 只建议沉淀**通用可复用**的东西；纯业务逻辑一律跳过
- 两阶段工作流：**analyze（默认）→ apply**
- analyze 产出写到文件持久化；apply 从文件读，确保跨 turn/跨窗口可用
- apply 只写文件，**绝不自动 commit/push**，由用户自己提交

---

## 参数解析

| 输入形式 | 行为 |
|---------|------|
| `/exp-to-framework` 或 `/exp-to-framework analyze` | 分析最近 10 个 commit + 未提交改动 + 本会话 |
| `/exp-to-framework analyze 20` | 分析最近 20 个 commit + 其他 |
| `/exp-to-framework analyze <sha1>..<sha2>` | 分析指定 commit 范围 |
| `/exp-to-framework analyze session` | **仅**分析本会话上下文（不看 git） |
| `/exp-to-framework apply <ids>` | 应用指定 ID 的建议（`1,3,5` 或 `all`） |
| `/exp-to-framework reset-path` | 清除缓存的框架路径 |

---

## 第一步：定位原框架

1. 缓存文件路径：`.claude/.local/framework-path.txt`（`.local/` 按约定默认不提交）
2. 若缓存存在且内容指向的目录有效 → 直接用
3. 否则试默认路径：`E:/my/桌面软件tauri/tauri`（统一用正斜杠，Git Bash 兼容）
   - 用 `test -d <path>` 检测存在
   - 存在即写缓存
4. 不存在 → 向用户索取绝对路径，写缓存

**框架路径校验**（必须全满足）：
- `test -d <fw>/.git`（是 git 仓库）
- `test -d <fw>/.claude/skills`（有技能目录）
- 任一不满足 → 报错请用户确认

**.gitignore 自检**（首次创建缓存时）：
- 检查子项目 `.gitignore` 是否已忽略 `.claude/.local/`
- 没有则提示用户："建议把 `.claude/.local/` 加到 .gitignore"，**不自动改**

---

## 第二步：收集材料（analyze 模式）

三个来源，按模式选取：

### 2.1 Git 提交 diff（`analyze` / `analyze N` / `analyze <range>`）

```
Bash: git log -<N> --format="%H|%s" --no-merges
Bash: git show --stat <sha>   # 对每个 sha 跑一遍，了解改了什么
Bash: git show <sha>          # 按需看具体 diff
```

### 2.2 未提交改动（所有模式都看）

```
Bash: git status --porcelain
Bash: git diff HEAD
```

### 2.3 本会话上下文（所有模式都看，session 模式只看这个）

**回顾范围**：自会话开始，或自上次 `/exp-to-framework analyze` 完成之后（以靠后者为准）。

**要提取的信息**：
- 用户报告的 bug → 根因 → 修复方式（尤其是"反直觉"的）
- 采用的设计模式（reka 借鉴的、踩坑绕开的）
- 被否决的方案 + 理由（经验就是哪条路走不通）
- 新引入的库 / 配置 / 工具函数
- 对 skill 文档本身的更新（说明这个经验本身已经沉淀过）

---

## 第三步：分类判断

对每条原材料，按下表归类：

| 类型 | 判断依据 | 建议去处 |
|------|----------|---------|
| 通用坑/症状→根因 | 症状可描述 + 根因不涉及业务 | `<fw>/.claude/skills/bug-detective/SKILL.md` 对应表格 |
| 最佳实践/反模式 | 可复用的代码模式、陷阱 | 对应领域 skill 的"常见错误"或新增章节 |
| 配置默认值 | `tauri.conf.json` / `capabilities/*.json` 的**通用**默认值 | 框架同路径文件 |
| 通用工具函数 | 不依赖业务模型的 utility | 框架 `src/lib/utils/` 或 `src-tauri/src/` 对应位置 |
| 新增依赖 | **仅基础设施类**（错误处理 / 日志 / 通用 utils / 序列化） | 框架 `Cargo.toml` / `package.json` |
| 会话经验 | 本次对话里解决的非业务问题 | 对应 skill 或新建 skill 条目 |
| 路由模式改动 | **结构性**改动（HashRouter、ErrorBoundary 包裹、全局 guard 等） | 框架 `src/Router.tsx` |

**跳过规则（硬）**：

| 跳过项 | 理由 |
|---|---|
| 业务模型变更（数据表、实体 struct） | 业务特定 |
| 业务流程（笔记 CRUD、订单状态机等） | 业务特定 |
| 产品文案 / UI 文本 | 业务特定 |
| 项目专属 plugin 注册 | 每个项目不同 |
| 具体业务页面的路由新增 | 业务特定（**路由结构模式**可沉淀，**具体页面**不可） |
| 业务相关依赖（HTTP client、AI SDK、特定协议库等） | 业务特定 |

**去重**：生成建议前，在框架对应文件 Grep 检查是否已存在。已存在 → 标 `[已在框架中]` 跳过。

---

## 第四步：持久化 + 输出建议表

### 4.1 写持久化文件

把每条建议以 JSON 形式写入 `.claude/.local/exp-to-framework-last.json`：

```json
{
  "generated_at": "2026-04-18T15:30:00+08:00",
  "framework_path": "E:/my/桌面软件tauri/tauri",
  "analysis_range": "last 10 commits + uncommitted + session",
  "items": [
    {
      "id": 1,
      "source": "commit 4ace968",
      "type": "config",
      "target_file": "<fw>/src-tauri/tauri.conf.json",
      "summary": "窗口配置加 dragDropEnabled: false",
      "edit_plan": {
        "action": "edit",
        "old_string": "...",
        "new_string": "..."
      },
      "status": "pending"
    }
  ]
}
```

**字段说明**：
- `edit_plan.action`: `edit` / `write` / `append-table-row`
- `status`: `pending` / `applied` / `skipped` / `conflict`

### 4.2 控制台输出

```markdown
## 框架经验沉淀分析

**框架路径**: `E:/my/桌面软件tauri/tauri`  
**分析范围**: 近 10 个 commit + 未提交改动 + 本会话  
**待沉淀**: N 条 / 跳过 M 条 / 已存在 K 条

| ID | 来源 | 类型 | 目标文件（相对框架） | 摘要 | 状态 |
|----|------|------|-----|------|------|
| 1 | commit 4ace968 | 配置 | `src-tauri/tauri.conf.json` | 加 `dragDropEnabled: false` | 待同步 |
| 2 | commit 4ace968 | skill 章节 | `.claude/skills/tauri-window-management/SKILL.md` | dragDropEnabled 专章+错误表行 | 待同步 |
| 3 | 会话经验 | skill 表格 | `.claude/skills/ui-frontend/SKILL.md` | titleRender 内嵌 Dropdown 的陷阱 | 待同步 |
| 4 | commit xxxxx | 业务逻辑 | — | 笔记 CRUD | 🚫 跳过（业务特定）|
| 5 | commit yyyyy | skill 表格 | `.claude/skills/bug-detective/SKILL.md` | dragDrop 🚫 光标 | ⊙ 已在框架中 |

## 下一步
- 全部同步：`/exp-to-framework apply all`
- 部分同步：`/exp-to-framework apply 1,3`
- 直接退出：什么都不输（建议已保存在 `.claude/.local/exp-to-framework-last.json`）
```

然后**停止，等用户指示**。

---

## 第五步：Apply 模式

当用户输入 `/exp-to-framework apply <ids>`：

### 5.1 前置校验

1. 读 `.claude/.local/exp-to-framework-last.json`
   - 不存在 → 报错："请先运行 /exp-to-framework analyze"
2. 读框架路径缓存
3. 检查框架仓库状态：
   - `git -C <fw> status --porcelain` 非空 → warn："框架仓库有未提交改动，apply 将叠加到现有改动上。继续？"用户未明确确认则**停**
   - `git -C <fw> branch --show-current` ≠ master/main → warn，同上

### 5.2 执行

按 ID 顺序，对每条：

1. 读目标文件
2. 执行 `edit_plan`：
   - `edit`：Edit 工具精确替换
   - `write`：Write 工具（仅新文件）
   - `append-table-row`：在 Markdown 表格末行后加一行（用 Edit，`old_string` = 最后一行表格内容，`new_string` = 最后一行 + 新行）
3. 更新 JSON 中该条的 `status`：`applied` / `conflict`
4. 冲突（Edit 的 `old_string` 不存在或多处匹配）→ 标 `conflict`，**跳过不强改**，继续下一条

### 5.3 报告 + 写回 JSON

```
✅ 已应用 X 条，冲突 Y 条，已跳过 Z 条

改动文件：
  - <fw>/src-tauri/tauri.conf.json
  - <fw>/.claude/skills/tauri-window-management/SKILL.md

冲突（需手工处理）：
  - ID 3: 目标 old_string 在框架中找不到（可能已修改过）

下一步（在框架目录执行）：
  cd E:/my/桌面软件tauri/tauri
  git status
  git diff                   # 人工核对
  git add ... && git commit  # 提交信息自拟

⚠️ 本指令不自动 commit。冲突项保留在 .claude/.local/exp-to-framework-last.json 中，
   可修改 edit_plan 后重试，或手工到框架仓库修改。
```

---

## 硬性规则

| 规则 | 说明 |
|------|------|
| **不自动 commit** | 任何模式下都不在框架仓库执行 git commit/push |
| **不沉淀业务** | 业务模型/流程/文案/业务依赖一律跳过，并在表中注明理由 |
| **先去重** | 生成建议前 grep 框架对应文件，已存在标 `已在框架中` |
| **结果必须持久化** | analyze 产出写 `.claude/.local/exp-to-framework-last.json`；apply 从文件读 |
| **冲突透明化** | Edit 的 old_string 不匹配/多处匹配 → 标 conflict 跳过，不强改 |
| **分支/脏改动检测** | apply 前检查框架仓库是否脏/是否 master，非则 warn 并等待确认 |
| **缓存位置** | 框架路径缓存、analyze 结果都放 `.claude/.local/`，与项目代码隔离 |

---

## 何时用

- 本项目里解决了一个"框架级"的坑（配置/模式/症状）
- 完成一轮重构，沉淀可复用模式
- 会话中发现"这经验下次其他项目也会遇到"

---

## 与其他指令的关系

| 指令 | 关系 |
|------|------|
| `/commit` | 先在当前项目 commit，再 `/exp-to-framework` 沉淀 |
| `/next` | `/next` 指引下一步开发；`/exp-to-framework` 指引经验回流 |
| `/check` | `/check` 查当前代码问题；`/exp-to-framework` 查"本项目→框架"的回流机会 |
