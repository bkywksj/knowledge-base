# 任务：支持 Anthropic 协议 + 「AI 模型」改名「模型服务」

**状态**: 🔵 已完成（未提交）
**创建时间**: 2026-09-23
**Git 分支**: master

---

## 📋 需求

1. 设置里的「AI 模型」统一改叫「模型服务」，与 Sigil 一致
2. 服务商列表与 Sigil 一样：补上 crate 里 Anthropic 协议的两档
   （`anthropic_official` Anthropic 官方、`claude_code` Claude Code 客户端/中转），
   并真正支持 `/v1/messages` 对话，而不是只在下拉里多两项

## 🔍 现状（2026-09-23 核实）

- 两边预置同源（ai-profile crate，本项目 `2a32261` / Sigil `6ef686a`，之间只差文档提交）
- 本项目 `model_service::presets()` 过滤掉 Anthropic 协议 → 23 家；Sigil 25 家
- 下拉样式已一致（分组、双行、可搜）
- 对话只有 Ollama 原生 + OpenAI 兼容；crate `client` 只做验证/拉模型，不做对话
- 发对话请求的地方 11 处，全在 `services/ai.rs`：
  suggest_prompt / complete_once / test_model_connection / stream_openai_generic（写作助手）/
  stream_openai_compatible（RAG 对话）/ stream_openai_with_tools（智能模式）/
  plan_today / extract_task_from_text / draft_note / plan_from_goal / plan_from_excel

## 🎨 方案

**不在 11 处各写一套 Anthropic**：新增 `services/anthropic.rs` 适配层，各处照旧拼 OpenAI 结构的
请求体，发送前按模型协议转换；响应 / 流按协议解析。

| 适配点 | 做法 |
|---|---|
| 协议判断 | `model_service::protocol_of(provider)`：按预置 key 查 crate；不认识的 key 按 OpenAI 兼容 |
| 地址 | `join_chat_endpoint(base, "messages")`；官方档地址为空时用 `Protocol::Anthropic.default_base_url()` |
| 请求头 | 只发 `x-api-key` + `anthropic-version: 2023-06-01`（照 Sigil：仿 Claude Code 头会让中转路由到空账号池 503） |
| 请求体 | system 消息并入顶层 `system`；assistant `tool_calls` → `tool_use` 块；`tool` 消息 → user 里的 `tool_result` 块（连续的合并成一条）；tools → `name/description/input_schema` 白名单；丢 `response_format` / `tool_choice:"auto"`→`{type:auto}` |
| max_tokens | Anthropic 必填：用户设了按用户（已按上限收紧）；否则 4096，且不超过已知输出上限 / 8192（同 Sigil） |
| 非流式 | 拼接 `content[].text` |
| 流式 | `data:` 行按 `type` 解析：text_delta / thinking_delta / tool_use 块开始 / input_json_delta / message_delta.stop_reason / error |
| 思考块 | 不回传历史（照 Sigil，只回传 text + tool_use），流式思考发 `ai:reasoning` |

## 🎯 步骤

- [x] 1. 改名：前端 22 处（9 个文件 + 设置页按钮 + 回复卡片按钮）+ 后端 2 句用户可见提示
- [x] 2. 后端 `services/anthropic.rs`：转换 + 流解析 + 6 个单测
- [x] 3. `model_service`：`protocol_of`；`presets()` 全量（官方档补默认地址）；verify / ai.profile 导入导出按协议；`unsupported_protocol` 整条链路删掉
- [x] 4. `services/ai.rs` 11 处接入：`chat_request` / `model_chat_request` / `completion_text` / `stream_text_delta` / `handle_stream_line`
- [x] 5. 前端：表单说明、`AiProviderPreset.protocol`、导出带 provider、去掉导入警告
- [x] 6. 测试：cargo test（885 过 + 2 个已知失败）/ tsc / vitest 445 过；
  真实端点 `live_anthropic_protocol`（dev 库临时 `claude_code` → DeepSeek `https://api.deepseek.com/anthropic`，测完已删）：
  非流式 ✅ / 流式工具调用两轮往返 ✅ / 「获取」404（该端点没有 `/models`，非本项目问题）
  —— 用户当时在用电脑，没做界面点击实测，设置页下拉 25 家未肉眼确认

## ⚠️ 已知坑

- **中转地址要带版本段**：crate 规定地址原样使用，`https://relay.com` 会拼成 `…/messages`。
  Claude Code 的 `ANTHROPIC_BASE_URL` 习惯不带 `/v1`，用户照抄会 404；「获取」会给出带 `/v1` 的建议地址

## ⚠️ 注意

- ~~第 2 步「Codex 挪组」~~：补上 Anthropic 两档后该组恢复 3 家，不再需要
- 存量「claude」配置（v62 迁到 `openai_compatible_custom`，走官方 OpenAI 兼容地址）不动，照常可用
