# /sync-from-framework - 从原框架同步更新到本项目

作为原框架到子项目的"更新拉取员"。对比框架当前状态和本项目，把框架里有**但本项目没有或已落后**的通用内容（skills / commands / 配置字段 / 基础依赖 / 通用工具）找出来，给用户逐个建议。**每一条差异都让用户确认，没例外**。

**4 条核心原则**：
- 2-way diff：对比"框架当前版本 vs 子项目当前版本"，**所有差异都报给用户确认**
- 两阶段：analyze（默认）→ apply
- analyze 结果持久化到文件，跨 turn/跨窗口可用
- apply 只写文件，**绝不自动 commit/push**

---

## 参数

| 输入 | 行为 |
|------|------|
| `/sync-from-framework` 或 `/sync-from-framework analyze` | 分析：本地优先，本地缺则用远程 |
| `/sync-from-framework analyze --remote` | 强制用远程（即使有本地） |
| `/sync-from-framework analyze --local-only` | 只用本地，不 fallback |
| `/sync-from-framework apply <ids>` | 应用指定 ID（`1,3` 或 `all`） |
| `/sync-from-framework diff <id>` | 查看某条差异的完整 patch |
| `/sync-from-framework set-remote <url>` | 覆盖默认远程 URL |
| `/sync-from-framework reset` | 清所有缓存（路径、远程 URL、clone cache、analyze 结果） |

---

## 第一步：定位框架源

### 默认配置（硬编码）
- **默认本地路径**：`E:/my/桌面软件tauri/tauri`
- **默认远程 URL**：`https://gitcode.com/zhuawashi/tauri`（gitcode 主仓）
- **备用远程**：`https://gitee.com/bkywksj/tauri.git`（gitee 镜像）

### 选择顺序
1. 若 `.claude/.local/framework-path.txt` 缓存存在且路径有效（`test -d <path>/.git && test -d <path>/.claude/skills`） → 用本地
2. 否则试默认本地路径，有效则写缓存
3. 本地无效或 `--remote` 强制 → 用远程 clone 到 `.claude/.local/fw-cache/`
   - 远程 URL 优先级：`.claude/.local/framework-remote.txt` 缓存 > 默认 gitcode
   - 首次：`git clone --depth=50 <url> .claude/.local/fw-cache`
   - 后续：`git -C .claude/.local/fw-cache fetch origin master --depth=50 && git -C .claude/.local/fw-cache reset --hard origin/master`
   - clone 失败（网络/权限）→ 尝试备用 gitee 镜像
   - 仍失败 → 报错让用户 `set-remote`
4. `--local-only` 模式下本地无效直接报错

---

## 第二步：收集框架侧可同步内容

在框架目录遍历白名单路径，把每个文件的元数据收集起来：

### 白名单（严格）

| 路径/类型 | 同步粒度 | 说明 |
|---|---|---|
| `.claude/skills/**/SKILL.md` | 文件级 | skill 文档 |
| `.claude/commands/*.md` | 文件级 | 指令文档 |
| `.claude/skills/*/` 新目录 | 整目录 | 新增 skill 整体 |
| `src-tauri/tauri.conf.json` 特定字段 | **字段级** | `app.windows[0].dragDropEnabled` / `app.security.csp` 等通用字段 |
| `src-tauri/capabilities/*.json` | **条目级 add** | 只建议 add 权限条目，不覆盖整体 |
| `package.json` 基础设施 devDeps | 条目级 | 不同步业务 deps |
| `src-tauri/Cargo.toml` 基础设施 deps | 条目级 | 同上 |
| `src/components/ui/ErrorBoundary.tsx` 等模板组件 | 文件级（仅内容未改） | 用 hash 比对 |
| `src/lib/utils/` 通用工具 | 文件级（仅内容未改） | 同上 |
| `src-tauri/src/error.rs` 模板 | 文件级（仅内容未改） | 同上 |

### 黑名单（绝不触碰）

- `src-tauri/tauri.conf.json` 的 `productName` / `identifier` / `version` / `title` / `bundle` 等**项目特定字段**
- `src/App.tsx` / `src/Router.tsx` / `src/pages/**` / `src/store/**`（业务代码）
- `src-tauri/src/commands/**` / `src-tauri/src/services/**` / `src-tauri/src/database/**` / `src-tauri/src/models/**`（业务代码）
- `package.json` / `Cargo.toml` 的业务依赖（HTTP client、AI SDK、特定协议库等）
- `.git/**`、`node_modules/**`、`target/**`、`dist/**`

---

## 第三步：对比 + 分类（2-way diff）

对白名单内每个文件/字段，判断 4 种情况：

| 情况 | 子项目侧 | 框架侧 | 建议标签 |
|---|---|---|---|
| A. 子项目没有 | 不存在 | 存在 | ✅ **新增**（待确认） |
| B. 内容一致 | 存在 | 存在 | ⊙ 无差异（跳过，不入表） |
| C. 内容不同 | 存在 | 存在 | ⚠️ **差异**（待确认，默认保留子项目） |
| D. 框架删除 | 存在 | 不存在 | 🗑️ **删除建议**（待确认，**高危**） |

**关键约定**：
- 所有 A/C/D 情况都进建议表，让用户**逐一确认**
- D 类默认排序到最后，并加醒目提示
- C 类在 diff 详情里显示双方内容，让用户对比
- 字段级对比（tauri.conf.json、capabilities）用 JSON 结构 diff，不是整文件 diff

### 特殊规则

- `.claude/commands/sync-from-framework.md` 和 `.claude/commands/exp-to-framework.md` 本身也在白名单——这两个指令的更新也能通过自己同步（自举）
- 新 skill 整目录进子项目时，检查是否和子项目专属 skill 重名

---

## 第四步：持久化 + 输出

### 4.1 写文件

`.claude/.local/sync-from-framework-last.json`：

```json
{
  "generated_at": "2026-04-18T16:00:00+08:00",
  "framework_source": "local:E:/my/桌面软件tauri/tauri",
  "framework_head": "ddc70aa",
  "mode": "2-way",
  "items": [
    {
      "id": 1,
      "kind": "add",
      "category": "skill",
      "target": ".claude/skills/env-isolation/SKILL.md",
      "framework_path": "<fw>/.claude/skills/env-isolation/SKILL.md",
      "summary": "新 skill：dev/prod 环境隔离",
      "status": "pending"
    },
    {
      "id": 2,
      "kind": "diff",
      "category": "skill-content",
      "target": ".claude/skills/tauri-window-management/SKILL.md",
      "framework_path": "<fw>/.claude/skills/tauri-window-management/SKILL.md",
      "summary": "框架新增 dragDropEnabled 专章",
      "sub_lines_changed": 15,
      "fw_lines_changed": 20,
      "status": "pending"
    },
    {
      "id": 3,
      "kind": "add-field",
      "category": "config",
      "target": "src-tauri/tauri.conf.json",
      "path": "app.windows[0].dragDropEnabled",
      "value": false,
      "summary": "加字段 dragDropEnabled: false",
      "status": "pending"
    },
    {
      "id": 4,
      "kind": "delete",
      "category": "skill",
      "target": ".claude/skills/old-stuff/SKILL.md",
      "summary": "框架已移除该 skill，子项目存在",
      "status": "pending"
    }
  ]
}
```

`kind` 枚举：`add` / `diff` / `add-field` / `add-dep` / `delete`

### 4.2 控制台输出

```markdown
## 框架更新分析

**来源**: 本地 `E:/my/桌面软件tauri/tauri` @ master (`ddc70aa`)  
**模式**: 2-way（所有差异待确认）  
**共发现**: 4 条待同步

| ID | 动作 | 分类 | 目标 | 摘要 |
|----|------|------|-----|------|
| 1  | ✅ 新增 | skill | .claude/skills/env-isolation/SKILL.md | 新 skill：dev/prod 环境隔离 |
| 2  | ⚠️ 差异 | skill 内容 | .claude/skills/tauri-window-management/SKILL.md | 框架新增 dragDropEnabled 专章（子 15 行 / 框 20 行不同） |
| 3  | ✅ 新增字段 | tauri.conf.json | `app.windows[0].dragDropEnabled` | = false |
| 4  | 🗑️ 删除 | skill | .claude/skills/old-stuff/SKILL.md | 框架已移除（⚠️ 高危，默认不建议删）|

## 下一步
- 全部同步：`/sync-from-framework apply all`
- 部分同步：`/sync-from-framework apply 1,3`
- 看差异详情：`/sync-from-framework diff 2`
- 退出：什么都不输

💡 提示：ID 4 是删除操作，需单独指定，`apply all` 不会触发删除。
```

**安全约定**：`apply all` **不包含 `kind=delete`**，删除必须显式指定 ID。

---

## 第五步：Apply

用户 `/sync-from-framework apply <ids>`：

1. **前置**：
   - 读 `.claude/.local/sync-from-framework-last.json`，不存在报错
   - 读缓存框架路径
   - 子项目仓库脏状态 warn（但不阻）

2. **执行**（按 ID 顺序）：
   - `add` / `add-field` / `add-dep`：读框架，写入子项目
   - `diff`：**整文件覆盖子项目内容**（因为已经用户确认过），但保留项目特定字段（如 tauri.conf.json 的整体覆盖受黑名单约束，只能用字段级 add）
   - `delete`：显式确认后才 `rm` 或从 JSON 中移除对应条目

3. **更新 JSON**：每条 `status` 改为 `applied` / `skipped` / `conflict`

4. **报告**：

```
✅ 已应用 X 条，跳过 Y 条

改动文件：
  - .claude/skills/env-isolation/SKILL.md（新建）
  - .claude/skills/tauri-window-management/SKILL.md（覆盖）
  - src-tauri/tauri.conf.json（加字段）

⚠️ ID 2 覆盖前的原内容已备份到 .claude/.local/backups/<timestamp>/

下一步：
  git status
  git diff
  git add ... && git commit -m "chore: 从框架同步更新"

⚠️ 未自动 commit。
```

### 5.1 备份约定

`diff` 类型覆盖前必须**把子项目原文件备份**到 `.claude/.local/backups/<YYYYMMDD-HHMMSS>/<same-path>`，便于用户后悔时回滚。

---

## 第六步：Diff 模式

`/sync-from-framework diff <id>`：

- 读 JSON，找到对应条目
- 打印三段：
  1. **子项目当前内容**（摘录关键段）
  2. **框架当前内容**（摘录关键段）
  3. **Unified diff**（两者差异）
- 不写文件，只展示

---

## 硬性规则

| 规则 | 说明 |
|------|------|
| **2-way 无 base** | 所有内容差异都让用户确认，不自动判定 |
| **apply all 不触发删除** | `kind=delete` 必须显式 ID |
| **覆盖前必备份** | `.claude/.local/backups/<timestamp>/` |
| **不自动 commit** | 写完打印 commit 提示 |
| **黑名单强制** | 项目特定字段（identifier/productName/version）绝不同步 |
| **先去重** | 内容 hash 一致的跳过，不入表 |
| **结果必持久化** | analyze 写 JSON，apply 从 JSON 读 |

---

## 何时用

- 原框架发了新 skill / 通用坑沉淀，想同步到本项目
- 其他人 push 到框架的改动需要拉取
- 定期"合并框架主干"（比如月度）

---

## 与 `/exp-to-framework` 的关系

| 维度 | `/exp-to-framework` | `/sync-from-framework` |
|------|---------------------|----------------------|
| 方向 | 子项目 → 框架 | 框架 → 子项目 |
| 源 | 本项目 git commit + 会话 | 框架仓库 |
| 支持远程 | ❌ 仅本地 | ✅ 远程 clone fallback |
| 冲突 | Edit 找不到 old_string → 跳过 | 2-way 所有差异 → 用户确认 |
| 持久化文件 | `exp-to-framework-last.json` | `sync-from-framework-last.json` |
| 共享缓存 | `framework-path.txt` | `framework-path.txt`（同） |

**典型工作流**：
1. 本项目踩坑修好 → `/exp-to-framework` 推经验到框架
2. 其他子项目：`/sync-from-framework` 拉这条经验下来
3. 反过来：本项目久未更新 → `/sync-from-framework` 拉框架的新东西
