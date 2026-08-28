---
name: collaborating-with-antigravity
description: |
  当用户明确点名要用 Google Antigravity CLI（agy）协同时使用此 Skill，把指定任务委托给 agy 执行并整合结果。

  触发场景：
  - 用户明确说"用 Antigravity / 用反重力 / 用 agy / agy 协同"
  - 用户要求把某个具体任务委托给 Antigravity CLI 执行
  - 用户要求多模型交叉验证，并点名 Antigravity 作为其中一方
  - 用户要求让外部模型返回严格 JSON 结构（--json-schema 强制结构化输出）
  - 用户要求接续之前的 agy 会话（--continue / --conversation ID）

  触发词：Antigravity、antigravity、反重力、agy、agy协同、agy CLI、委托给 Antigravity

  前置要求：
  - 已安装 Antigravity CLI（实测 v1.1.19，Windows 路径 %LOCALAPPDATA%\agy\bin\agy.exe）
  - 已完成登录认证（`agy models` 能列出模型即为已认证）

  🔴 不适用场景（未点名 Antigravity 一律不激活本技能）：
  - UI / UX / 前端原型 / 样式设计 → 走 ui-frontend、theme-system，
    或用户指定的工具（如 AI 工作站）
  - 代码审查 / 规范检查 → 走 code-patterns；Bug 排查 → 走 bug-detective
  - 方案探索 / 技术选型 → 走 brainstorm、tech-decision、architecture-design
  - 泛泛的"多模型""交叉验证"字样但没点名用哪个 CLI → 不要自作主张拉起本技能
---

# 与 Antigravity CLI（agy）协同开发

> Google Antigravity 的命令行代理。**原生支持非交互 + 结构化输出，不需要 Python 桥接脚本** ——
> 这是它与 `collaborating-with-gemini` / `collaborating-with-codex` 最大的工程差异（那两个都要靠
> `scripts/*_bridge.py` 包一层）。

## 与另外两个协同技能的边界

| 能力 | `agy`（本技能） | `gemini` CLI | `codex` CLI |
|------|----------------|--------------|-------------|
| 调用方式 | 直接命令行 | `gemini_bridge.py` | `codex_bridge.py` |
| 结构化输出 | ✅ 原生 `--output-format json` | 桥接自己包 | 桥接自己包 |
| 强制 JSON Schema | ✅ `--json-schema` | ❌ | ❌ |
| 可选模型 | **15 个（跨三家厂商）** | 仅 Gemini | 仅 GPT |
| 最适合 | 多模型交叉验证、要求严格结构化返回 | 前端原型 | Rust 算法、复杂逻辑 |

**选它的理由**：`agy` 是唯一能从一个入口同时调到 Gemini、Claude、GPT-OSS 的 CLI。本项目是
Rust + React 双栈，做"同一段 IPC 设计让不同厂商模型各评一遍"时，比分别去调 gemini/codex
两个桥接干净得多。

---

## 前置检查（每次激活先跑）

```powershell
agy --version          # 期望输出版本号，如 1.1.19
agy models             # 能列出模型 = 已认证；报错 = 未登录
```

未安装或未认证时**停下告知用户**，不要自己去装、也不要回退到别的 CLI。

---

## 快速开始

```powershell
# PowerShell —— prompt 必须用单引号包裹，理由见「坑 2」
# 需要它读代码/跑命令时必须加 --dangerously-skip-permissions，理由见「坑 1」
agy -p '说明 src-tauri/src/commands 的分层职责' `
    --output-format json --dangerously-skip-permissions --print-timeout 10m
```

```bash
# Git Bash
agy -p '说明 src-tauri/src/commands 的分层职责' --output-format json --dangerously-skip-permissions
```

---

## 参数速查（`agy --help` 实测）

| 参数 | 说明 |
|------|------|
| `-p` / `--print` / `--prompt` | 非交互跑一轮并打印结果（**协同调用一律用它**） |
| `--output-format` | `text`（默认）/ `json` / `stream-json` |
| `--input-format` | `text`（默认）/ `stream-json`（多轮 NDJSON，需配 `--output-format stream-json`） |
| `--json-schema` | JSON Schema 字符串**或文件路径**，强制结构化输出 |
| `--model` | 指定模型，取值见 `agy models` |
| `--effort` | 推理档位 `low` / `medium` / `high` |
| `--mode` | `plan`（只读规划，不落盘）/ `accept-edits`（自动接受改动） |
| `--sandbox` | 启用终端限制沙箱 |
| `--continue` / `-c` | 接着最近一次对话 |
| `--conversation <ID>` | 按 ID 恢复指定对话 |
| `--add-dir` | 追加工作区目录（可重复） |
| `--print-timeout` | print 模式超时，**默认仅 5m** |
| `--dangerously-skip-permissions` | 自动批准所有工具权限（见「坑 1」） |
| `--disable-slash-commands` | print 模式下禁用斜杠命令 / 技能展开 |

子命令：`models` / `agents` / `mcp` / `plugin` / `update` / `changelog`。

---

## 返回值结构（`--output-format json` 实测原文）

```json
{
  "conversation_id": "4684259f-2a5e-4226-b491-e015c353eac9",
  "status": "SUCCESS",
  "response": "……模型回复……",
  "duration_seconds": 3.63,
  "num_turns": 1,
  "usage": {
    "input_tokens": 13826,
    "output_tokens": 69,
    "thinking_tokens": 0,
    "cache_read_tokens": 0,
    "total_tokens": 13895
  }
}
```

带 `--json-schema` 时**额外**多出两个顶层字段：

```json
{
  "structured_output": { "verdict": "fail", "score": 20, "reason": "..." },
  "json_schema": { "type": "object", "properties": { } }
}
```

- `conversation_id` → 存下来给 `--conversation` 续接用
- `usage` → 报告 token 消耗时用真实值，不要估算

---

## 🔴 四个必踩的坑（全部实测复现，务必照做）

### 坑 1：权限被拒 = 静默假成功（最危险，且是默认路径上的常态）

headless 模式没法弹审批框，需要 `command` 权限的工具会被**自动拒绝**，但进程**照样返回成功**。
实测在本仓库根目录只问了一句"用一句话说明这个仓库是做什么的"，就触发了：

```jsonc
// stderr（真相在这里）：
// jetski: no output produced — a tool required the "command" permission that headless
// mode cannot prompt for, so it was auto-denied. Add an allow-rule under
// permissions.allow in settings.json (e.g. command(<target>)).
// Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.

// stdout（骗人的）：
{"status":"SUCCESS","response":"","duration_seconds":2.0,"num_turns":1}
// 退出码：0
```

`status` 是 `SUCCESS`、退出码是 `0`、`response` 却是**空字符串**。

> ⚠️ 注意这**不是边缘情况**：只要任务需要它看代码、跑命令（也就是绝大多数真实任务），
> 不加放行参数就会空手而归。**默认就该带 `--dangerously-skip-permissions`**，
> 除非你只是让它做纯文本推理。

**判定成功的正确姿势 —— 三个条件缺一不可**：

1. 退出码 `== 0`
2. `status == "SUCCESS"`
3. **`response` 非空**（带 schema 时改判 `structured_output` 存在）

只要 `response` 是空串，就当失败处理并去看 stderr。

**放行二选一**：

```powershell
# 方案 A：本次放行（推荐，配合 --mode plan 可只读不写盘）
agy -p '...' --dangerously-skip-permissions --mode plan

# 方案 B：长期白名单，编辑 ~/.gemini/antigravity-cli/settings.json
#   permissions.allow 里加 command(<target>) 规则
```

> `--dangerously-skip-permissions` 会放行**全部**工具（含写文件、跑命令）。
> 在本仓库用它前，先确认工作区干净（`git status -s` 无输出），或加 `--mode plan` 只读分析。
> Rust 侧尤其注意：别让它在未确认的情况下动 `src-tauri/` 或跑 `cargo` 构建。

### 坑 2：PowerShell 里 prompt 必须用单引号

反引号转义的双引号传给原生 exe 会被按空格拆词：

```powershell
# ❌ 报 Error: unexpected argument "..."，退出码 2
agy -p "评价这段注释：`"// 处理数据`"。给出结论"

# ✅ 单引号包裹整串，内部双引号原样保留
agy -p '评价这段注释："// 处理数据"。给出结论'
```

prompt 很长或含复杂引号时，**落成文件再读进来**，不要在命令行里拼：

```powershell
$prompt = Get-Content "$env:TEMP\agy-prompt.txt" -Raw -Encoding utf8
agy -p $prompt --output-format json --dangerously-skip-permissions
```

### 坑 3：带 schema 时别去解析 `response`

`--json-schema` 生效后，`response` 正文里会混进模型自己写的 JSON，还可能多出
`toolAction` / `toolSummary` 等 schema 里没有的字段。**只读顶层 `structured_output`**：

```powershell
# ✅ 正确
$r = agy -p '...' --output-format json --json-schema .\schema.json | ConvertFrom-Json
$r.structured_output.verdict

# ❌ 错误：response 里混着自然语言 + 冗余字段，解析必翻车
$r.response | ConvertFrom-Json
```

另外带 schema 会多跑一轮（实测 `num_turns` 从 1 变 2），耗时和 token 都会涨。

### 坑 4：每次调用有约 1.4 万 token 的固定基线（换目录省不掉）

实测三个完全不同的工作目录，`input_tokens` 几乎一样：

| 工作目录 | input_tokens |
|---------|--------------|
| 空临时目录 | 13,830 |
| 本 Tauri 仓库根 | 13,826 |
| 另一个大型 Java 仓库根 | 13,819 |

说明这 ~13.8k **是 agy 自身系统提示 + 工具定义的固定开销，与项目大小无关**。

**因此**：

- ❌ 别指望"换到空目录调用"能省 token —— 省不掉，纯属白折腾
- ✅ 真正能省的是**续接**：`-c` / `--conversation` 会命中缓存（实测 `cache_read_tokens` 复用 8,130）
- ⚠️ 带 `--json-schema` 因为多跑一轮，实测涨到约 28,459
- 结论：**agy 适合"问得少而重"的任务**，不适合拿来做几十次的碎问碎答

---

## 使用模式

### 1. 基础委托

```powershell
agy -p '解释 src-tauri/src/state.rs 里 AppState 的生命周期与线程安全设计' `
    --output-format json --dangerously-skip-permissions --print-timeout 10m
```

### 2. 强制结构化输出（推荐用于任何需要机读结果的场景）

先把 schema 落成文件（避免命令行引号地狱）：

```json
// review-schema.json
{
  "type": "object",
  "properties": {
    "verdict": { "type": "string", "enum": ["pass", "warn", "fail"] },
    "score":   { "type": "integer" },
    "reason":  { "type": "string" }
  },
  "required": ["verdict", "score", "reason"]
}
```

```powershell
$r = agy -p '按项目三层架构规范评估这个 Command 实现' `
        --output-format json --json-schema .\review-schema.json `
        --dangerously-skip-permissions | ConvertFrom-Json
if ($r.structured_output) { $r.structured_output.verdict } else { "调用失败，检查 stderr" }
```

### 3. 多模型交叉验证（本技能的主场）

同一问题分别交给三家模型，再由 Claude Code 汇总分歧点：

```powershell
$q = '这个 Tauri Command 的 State 注入有没有跨线程数据竞争或死锁风险？'
agy -p $q --model gemini-3.1-pro-high      --output-format json --effort high --dangerously-skip-permissions
agy -p $q --model claude-opus-4-6-thinking --output-format json --effort high --dangerously-skip-permissions
agy -p $q --model gpt-oss-120b-medium      --output-format json --dangerously-skip-permissions
```

> 三次调用互相独立、无共享上下文，这正是交叉验证要的"互不污染"。

### 4. 只读规划模式（不让它碰文件）

```powershell
agy -p '分析 commands → services → database 三层的依赖方向，指出越层调用' `
    --mode plan --output-format json --dangerously-skip-permissions
```

### 5. 会话续接

```powershell
# 第一轮，记下 conversation_id
$r1 = agy -p '梳理 IPC 事件的错误传播路径' --output-format json --dangerously-skip-permissions | ConvertFrom-Json

# 后续轮次（能吃到缓存，比重开一轮省）
agy -p '基于上面的结论，补充 ErrorBoundary 侧的兜底' --conversation $r1.conversation_id --output-format json

# 或直接接最近一次
agy -c -p '再补充一下 thiserror 的分类建议'
```

### 6. 流式多轮（CI / 批处理）

```bash
printf '%s\n' \
  '{"event":"user","message":{"content":"第一问"}}' \
  '{"event":"user","message":{"content":"第二问"}}' \
  | agy --input-format stream-json --output-format stream-json
```

---

## 模型选择指南（`agy models` 实测 15 个）

| 场景 | 推荐模型 | 理由 |
|------|---------|------|
| Rust 所有权 / 并发等复杂分析 | `gemini-3.1-pro-high` | Pro 档推理最强 |
| 对抗审查 / 找漏洞 | `claude-opus-4-6-thinking` | 思考型，挑刺细 |
| 快速问答 / 批量任务 | `gemini-3.7-flash-low` | 最快最省 |
| 第三方交叉验证 | `gpt-oss-120b-medium` | 与前两家同源性最低 |

完整列表：`gemini-3.7/3.6/3.5-flash-{high,medium,low}`、`gemini-3.1-pro-{high,low}`、
`claude-sonnet-4-6`、`claude-opus-4-6-thinking`、`gpt-oss-120b-medium`。

> 模型清单会随版本变化，**报给用户前先跑一次 `agy models` 核对**，不要凭本文档硬报。

---

## 与本项目的集成

### Windows / PowerShell 调用注意

```powershell
# ✅ 调 agy 前固定输出编码，否则中文回复乱码
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# ❌ 禁止给 agy 加 2>&1（PS 5.1 会把 stderr 逐行包成 NativeCommandError）
agy -p '...' 2>&1 | Select-String "SUCCESS"

# ✅ 工具层已捕获 stderr，直接跑即可
agy -p '...' --output-format json --dangerously-skip-permissions
```

> 这条尤其重要：**坑 1 的真相全在 stderr**，加了 `2>&1` 反而会把它包成异常对象，更难看清。

### 典型用例：Rust 侧三层架构审查

```powershell
agy -p '审查 src-tauri/src/ 是否存在 commands 层直接操作 database 层的越层调用（本项目要求 Commands → Services → Database 逐层下沉）' `
    --model claude-opus-4-6-thinking --effort high --mode plan `
    --output-format json --dangerously-skip-permissions
```

### 典型用例：IPC 契约双向核对

```powershell
agy -p '核对 src-tauri/src/commands 里 #[tauri::command] 的参数与返回类型，和 src/lib/api 里 invoke 调用的 TypeScript 类型是否一一对应，列出不匹配项' `
    --model gemini-3.1-pro-high --mode plan `
    --output-format json --dangerously-skip-permissions
```

### 典型用例：让外部模型产出可直接入库的结构化结论

配合 `--json-schema` 把审查结果落成机读 JSON，再由 Claude Code 汇总进任务卡
（配合 `task-tracker` 技能）。

---

## 故障排除

| 现象 | 原因 | 解决 |
|------|------|------|
| `status: SUCCESS` 但 `response` 为空 | 工具权限被 headless 自动拒绝 | 见「坑 1」，加 `--dangerously-skip-permissions` 或配 `permissions.allow` |
| `Error: unexpected argument "..."`，退出码 2 | PowerShell 引号被拆词 | 见「坑 2」，prompt 改用单引号包裹 |
| 解析 `response` 得到脏 JSON | 带 schema 时误读了 `response` | 见「坑 3」，改读 `structured_output` |
| 想靠换目录省 token 但没效果 | ~13.8k 是固定基线 | 见「坑 4」，改用 `-c` 续接吃缓存 |
| 复杂任务被截断 / 超时 | `--print-timeout` 默认只有 5m | 显式设大，如 `--print-timeout 20m` |
| `agy models` 报错 | 未登录 | 停下让用户完成认证，不要自行处理凭据 |
| 中文回复乱码 | 未固定控制台编码 | 先 `[Console]::OutputEncoding = [Text.Encoding]::UTF8` |

---

## 三个协同技能怎么选

| 任务 | 选谁 |
|------|------|
| 用户点名 Antigravity / 反重力 / agy | **本技能** |
| 用户点名 Gemini | `collaborating-with-gemini` |
| 用户点名 Codex | `collaborating-with-codex` |
| 需要多厂商模型对同一问题交叉验证 | **本技能**（一个入口调三家，最省事） |
| 需要外部模型返回严格 JSON 结构 | **本技能**（唯一支持 `--json-schema`） |
| 用户没点名任何 CLI | **一个都不激活**，走框架自有技能 |
