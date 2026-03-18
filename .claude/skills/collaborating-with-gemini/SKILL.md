---
name: collaborating-with-gemini
description: |
  与 Google Gemini CLI 协同开发。将编码任务委托给 Gemini 进行前端原型、UI设计和代码审查。

  触发场景：
  - 需要前端/UI/样式原型设计
  - 需要 CSS/React/Vue 组件设计
  - 需要代码审查和 Bug 分析
  - 用户明确要求使用 Gemini 协作
  - 复杂前端逻辑的原型设计

  触发词：Gemini、协作、多模型、前端原型、UI设计、CSS、样式、gemini协同

  前置要求：
  - 已安装 Gemini CLI (npm install -g @google/gemini-cli)
  - 已配置 Google API Key (GEMINI_API_KEY 环境变量或 gemini auth login)

  注意：Gemini 对后端逻辑理解有缺陷，后端任务优先使用 Codex。
---

# 与 Gemini CLI 协同开发

> 通过 Python 桥接脚本调用 Gemini CLI，获取前端原型和 UI 设计建议。

## 快速开始

```bash
# 相对路径（推荐，在项目根目录执行）
python .claude/skills/collaborating-with-gemini/scripts/gemini_bridge.py --cd . --PROMPT "Your task"
```

**输出**: JSON 格式，包含 `success`、`SESSION_ID`、`agent_messages` 和可选的 `error`。

## 参数说明

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--PROMPT` | str | ✅ | - | 发送给 Gemini 的任务指令（使用英语） |
| `--cd` | Path | ✅ | - | 工作目录根路径 |
| `--sandbox` | bool | ❌ | `True` | 沙箱模式（只读），默认开启 |
| `--no-sandbox` | bool | ❌ | `False` | 禁用沙箱（允许 Gemini 执行工具） |
| `--SESSION_ID` | str | ❌ | `""` | 会话索引号或 `latest`（继续之前的对话） |
| `--return-all-messages` | bool | ❌ | `False` | 返回完整推理信息（含工具调用和推理过程） |
| `--model` | str | ❌ | `None` | 指定模型（仅用户明确要求时使用） |
| `--yolo` | bool | ❌ | `False` | 跳过所有审批（覆盖 --approval-mode，危险） |
| `--include-directories` | List[Path] | ❌ | `[]` | 额外工作区目录（跨项目引用） |

## 使用模式

### 1. 基础调用（默认只读模式）

```bash
python .claude/skills/collaborating-with-gemini/scripts/gemini_bridge.py \
  --cd . \
  --PROMPT "Design a responsive card component for product display"
```

### 2. 多轮会话

**始终保存 SESSION_ID** 用于后续对话：

```bash
# 第一轮：设计 UI
python .claude/skills/collaborating-with-gemini/scripts/gemini_bridge.py \
  --cd . \
  --PROMPT "Design a mobile-first login page with form validation"

# 后续轮次：使用返回的 SESSION_ID（索引号）继续
python .claude/skills/collaborating-with-gemini/scripts/gemini_bridge.py \
  --cd . \
  --SESSION_ID "latest" \
  --PROMPT "Add dark mode support to the login page design"
```

### 3. 获取 Unified Diff 补丁

```bash
python .claude/skills/collaborating-with-gemini/scripts/gemini_bridge.py \
  --cd . \
  --PROMPT "Generate a unified diff to improve the CSS layout. OUTPUT: Unified Diff Patch ONLY."
```

### 4. 调试模式（返回完整信息）

```bash
python .claude/skills/collaborating-with-gemini/scripts/gemini_bridge.py \
  --cd . \
  --PROMPT "Debug this styling issue: elements overflow on mobile" \
  --return-all-messages
```

### 5. 引用项目文件（@file 语法）

Gemini CLI 支持 `@file` 语法直接引用文件内容：

```bash
python .claude/skills/collaborating-with-gemini/scripts/gemini_bridge.py \
  --cd . \
  --PROMPT "Review the component in @src/components/MyComponent.vue and suggest improvements for accessibility. OUTPUT: Unified Diff Patch ONLY."
```

### 6. 跨目录工作区

```bash
python .claude/skills/collaborating-with-gemini/scripts/gemini_bridge.py \
  --cd . \
  --include-directories "../shared-lib" \
  --PROMPT "Analyze how shared-lib types are used in this project"
```

## 返回值结构

**成功时：**
```json
{
  "success": true,
  "SESSION_ID": "5",
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

## 安全模式说明

| 模式 | 参数 | 说明 | 适用场景 |
|------|------|------|---------|
| **沙箱（默认）** | 默认或 `--sandbox` | 只读模式，Gemini 不修改文件 | 代码审查、设计讨论、原型建议 |
| **非沙箱** | `--no-sandbox` | 允许 Gemini 执行工具（每次需确认） | 需要 Gemini 直接操作文件 |
| **YOLO** | `--yolo` | 自动批准所有工具（危险） | 快速原型（仅限信任环境） |

> **推荐**：始终使用默认的沙箱模式。将 Gemini 的输出视为"脏原型"，由 Claude 重构为生产代码。

## 协作工作流

### 推荐场景

| 场景 | 说明 |
|------|------|
| **前端/UI/UX** | Gemini 擅长 CSS、样式和视觉设计 |
| **组件设计** | React/Vue 组件的原型设计 |
| **响应式布局** | 移动端适配和布局优化 |
| **样式审查** | CSS 代码质量和最佳实践 |
| **文件引用分析** | 利用 `@file` 语法让 Gemini 直接读取项目文件 |

### 重要约束

1. **默认只读**: 默认 `--approval-mode plan`，Gemini 不会修改任何文件
2. **英语交互**: 与 Gemini 交互时使用英语，获得更好效果
3. **Diff 输出**: 在 PROMPT 中明确要求 `OUTPUT: Unified Diff Patch ONLY`
4. **后端逻辑**: Gemini 对后端逻辑理解有缺陷，后端任务优先使用 Codex
5. **重构代码**: 将 Gemini 的输出视为"脏原型"，由 Claude 重构为生产代码
6. **后台运行**: 对于长时间任务，使用 `Run in the background`

## 与本项目的集成

### 典型用例：组件设计

```bash
python .claude/skills/collaborating-with-gemini/scripts/gemini_bridge.py \
  --cd . \
  --PROMPT "Design a React/Vue component for @src/components/MyComponent.vue. Focus on clean layout with dark mode support. OUTPUT: Complete component code."
```

### 典型用例：样式审查

```bash
python .claude/skills/collaborating-with-gemini/scripts/gemini_bridge.py \
  --cd . \
  --PROMPT "Review the CSS in @src/styles/main.css for consistency, unused rules, and best practices."
```

### 典型用例：UI 原型

```bash
python .claude/skills/collaborating-with-gemini/scripts/gemini_bridge.py \
  --cd . \
  --PROMPT "Design a file browser panel UI with tree navigation, search, and context menu. Use the project's existing UI framework. OUTPUT: Complete component code."
```

## 安装前置

```bash
# 安装 Gemini CLI
npm install -g @google/gemini-cli

# 配置 API Key（方式一：环境变量）
# 设置 GEMINI_API_KEY 环境变量

# 配置 API Key（方式二：CLI 登录）
gemini auth login
```

## 故障排除

| 问题 | 解决方案 |
|------|---------|
| `gemini: command not found` | `npm install -g @google/gemini-cli` 并确保在 PATH 中 |
| `GEMINI_API_KEY` 未设置 | 设置环境变量或执行 `gemini auth login` |
| `SESSION_ID` 获取失败 | 检查网络连接和 API Key |
| 输出被截断 | 使用 `--return-all-messages` 获取完整信息 |
| 脚本超时无响应 | 检查是否因无 `result` 事件导致，用 `--return-all-messages` 调试 |
| Windows 路径问题 | 使用正斜杠 `/` 或双反斜杠 `\\` |
| 会话恢复失败 | 使用 `--SESSION_ID latest` 或具体索引号（非 UUID） |

## Gemini vs Codex 选择指南

| 任务类型 | 推荐模型 | 原因 |
|---------|---------|------|
| 前端 UI/CSS | Gemini | 视觉设计能力强 |
| 后端逻辑 | Codex | 算法和逻辑分析强 |
| 组件样式 | Gemini | CSS 和布局专长 |
| API 设计 | Codex | 接口设计和架构 |
| 代码审查 | 两者皆可 | 双模型交叉验证更好 |
| 文件引用分析 | Gemini | `@file` 语法直接读文件 |
