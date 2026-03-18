---
name: collaborating-with-codex
description: |
  与 OpenAI Codex CLI 协同开发。将编码任务委托给 Codex 进行原型开发、调试分析和代码审查。

  触发场景：
  - 需要算法实现或复杂逻辑分析
  - 需要代码审查和 Bug 分析
  - 需要生成 Unified Diff 补丁
  - 用户明确要求使用 Codex 协作
  - 复杂后端逻辑的原型设计

  触发词：Codex、协作、多模型、原型、Diff、算法分析、代码审查、codex协同

  前置要求：
  - 已安装 Codex CLI (npm install -g @openai/codex)
  - 已配置 OpenAI API Key
---

# 与 Codex CLI 协同开发

> 通过 Python 桥接脚本调用 Codex CLI，获取算法实现和代码审查建议。

## 快速开始

```bash
# 相对路径（推荐，在项目根目录执行）
python .claude/skills/collaborating-with-codex/scripts/codex_bridge.py --cd . --PROMPT "Your task"
```

**输出**: JSON 格式，包含 `success`、`SESSION_ID`、`agent_messages` 和可选的 `error`。

## 参数说明

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--PROMPT` | str | ✅ | - | 发送给 Codex 的任务指令（使用英语） |
| `--cd` | Path | ✅ | - | 工作目录根路径 |
| `--sandbox` | Literal | ❌ | `read-only` | 沙箱策略：`read-only`/`workspace-write`/`danger-full-access` |
| `--SESSION_ID` | UUID | ❌ | `None` | 会话 ID（继续之前的对话） |
| `--skip-git-repo-check` | bool | ❌ | `True` | 允许在非 Git 仓库运行 |
| `--return-all-messages` | bool | ❌ | `False` | 返回完整推理信息 |
| `--image` | List[Path] | ❌ | `None` | 附加图片文件到提示词 |
| `--model` | str | ❌ | `None` | 指定模型（仅用户明确要求时使用） |
| `--yolo` | bool | ❌ | `False` | 跳过所有审批与沙箱限制（危险） |

## 使用模式

### 1. 基础调用（只读模式）

```bash
python .claude/skills/collaborating-with-codex/scripts/codex_bridge.py \
  --cd . \
  --PROMPT "Analyze the authentication flow in the login module"
```

### 2. 多轮会话

**始终保存 SESSION_ID** 用于后续对话：

```bash
# 第一轮：分析代码
python .claude/skills/collaborating-with-codex/scripts/codex_bridge.py \
  --cd "/project" \
  --PROMPT "Analyze the AdServiceImpl class"

# 后续轮次：使用 SESSION_ID 继续
python .claude/skills/collaborating-with-codex/scripts/codex_bridge.py \
  --cd "/project" \
  --SESSION_ID "uuid-from-previous-response" \
  --PROMPT "Now write unit tests for the add method"
```

### 3. 获取 Unified Diff 补丁

```bash
python .claude/skills/collaborating-with-codex/scripts/codex_bridge.py \
  --cd "/project" \
  --PROMPT "Generate a unified diff to add logging to AdServiceImpl. OUTPUT: Unified Diff Patch ONLY."
```

### 4. 调试模式（返回完整信息）

```bash
python .claude/skills/collaborating-with-codex/scripts/codex_bridge.py \
  --cd "/project" \
  --PROMPT "Debug this error: NullPointerException in line 42" \
  --return-all-messages
```

## 返回值结构

**成功时：**
```json
{
  "success": true,
  "SESSION_ID": "550e8400-e29b-41d4-a716-446655440000",
  "agent_messages": "模型回复内容..."
}
```

**失败时：**
```json
{
  "success": false,
  "error": "错误信息描述"
}
```

## 协作工作流

### 推荐场景

| 场景 | 说明 |
|------|------|
| **后端逻辑分析** | Codex 擅长复杂算法和后端逻辑 |
| **代码审查** | 获取代码质量和潜在问题的反馈 |
| **Debug 分析** | 利用其强大的调试能力定位问题 |
| **原型设计** | 快速获取实现思路（返回 Diff 而非直接修改） |

### 重要约束

1. **只读模式**: 始终使用 `--sandbox read-only`，禁止 Codex 直接修改文件
2. **英语交互**: 与 Codex 交互时使用英语，获得更好效果
3. **Diff 输出**: 在 PROMPT 中明确要求 `OUTPUT: Unified Diff Patch ONLY`
4. **重构代码**: 将 Codex 的输出视为"脏原型"，由 Claude 重构为生产代码
5. **后台运行**: 对于长时间任务，使用 `Run in the background`

## 与本项目的集成

### 典型用例：后端模块分析

```bash
# 分析 Service 层实现
python .claude/skills/collaborating-with-codex/scripts/codex_bridge.py \
  --cd . \
  --PROMPT "Analyze the four-layer architecture (Controller -> Service -> DAO -> Mapper) in ruoyi-modules/ruoyi-business. Focus on how buildQueryWrapper is implemented in DAO layer."
```

### 典型用例：代码审查

```bash
# 审查新增的业务模块
python .claude/skills/collaborating-with-codex/scripts/codex_bridge.py \
  --cd "/project" \
  --PROMPT "Review the CouponServiceImpl.java for potential bugs, security issues, and adherence to the project's four-layer architecture pattern. OUTPUT: Review comments with specific line numbers."
```

## 安装前置

```bash
# 安装 Codex CLI
npm install -g @openai/codex

# 配置 API Key（可选，如果未设置环境变量）
codex auth login
```

## 故障排除

| 问题 | 解决方案 |
|------|---------|
| `codex: command not found` | 确保已安装并添加到 PATH |
| `SESSION_ID` 获取失败 | 检查网络连接和 API Key |
| 输出被截断 | 使用 `--return-all-messages` 获取完整信息 |
| Windows 路径问题 | 使用正斜杠 `/` 或双反斜杠 `\\` |
