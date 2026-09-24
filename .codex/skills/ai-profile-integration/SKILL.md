---
name: ai-profile-integration
description: |
  用于本项目中与 ai-profile crate 相关的开发：模型服务预置、ai.profile 导入导出、「获取」零成本验证、上下文窗口限额。

  触发场景：
  - 要加新模型、新服务商，或改某个预置的默认 model / 地址
  - 修改 AI 模型配置表单（桌面设置页 / 手机弹窗）、「获取」「测试连接」
  - 修改配置分享 / 导入里 ai.profile 相关的逻辑
  - 改上下文预算、max_tokens 封顶、上下文超长的降档重试
  - 升级 ai-profile 依赖版本

  触发词：ai-profile、模型服务、预置、provider、服务商、新模型、加模型、ai.profile、获取模型、测试连接、限额、上下文窗口、max_context、升级crate
---

# ai-profile 接入（knowledge_base）

## 🔴 先判断改哪个仓库

| 要做的事 | 去哪改 |
|---|---|
| 加模型 / 加服务商 / 改默认 model / 改地址 / 改静态限额 | **ai-profile 仓库**（`E:/my/桌面软件tauri/ai-profile`，技能 `preset-maintenance`），本项目只升依赖 |
| ai.profile 解析规则、端点拼接、模型清洗、验证错误、超长识别 | **ai-profile 仓库** |
| `ai_models` 存储、密钥加密、对话（Ollama 原生 + OpenAI 兼容 SSE）、RAG / 附件预算、历史降档阶梯、`kbConfig` 信封、界面 | 本项目 |

**不要在本项目里写预置清单、模型列表、端点拼接规则、ai.profile 解析器。**
接入时删掉的副本：前端 `aiProviderPresets.ts` 里 24 家 / 5 张平行表、`configShare.ts` 的 TS 版
ai.profile 解析（只认 `v === 1`）、`services/ai.rs` 的 `build_openai_api_url`（自动补 `/v1`）与
`list_remote_models`。

## 本项目只说 OpenAI 兼容协议

对话只有 Ollama 原生 `/api/chat` 与 OpenAI `chat/completions` 两种，**没有 Anthropic 原生 `/v1/messages`**。

- 预置只暴露 crate 里 `protocol == OpenAiCompatible` 的（`model_service::presets`）
- 导入 Anthropic 协议的 ai.profile：按 OpenAI 兼容导入（官方地址有兼容端点能用），
  标记 `unsupported_protocol`，导入后提醒用户「只开放 /v1/messages 的中转用不了」
- 以后要加 Anthropic 原生对话，是在 `services/ai.rs` 里加一条对话实现，不是改 crate

## 接入点

| 能力 | 文件 |
|---|---|
| 依赖声明（crates.io 版本，`chat` + `client`，rustls） | `src-tauri/Cargo.toml` |
| 与 crate 的接缝（预置 / 验证 / 限额 / ai.profile / 旧配置修正） | `src-tauri/src/services/model_service.rs` |
| Commands | `commands/ai.rs`：`list_ai_provider_presets` / `verify_ai_model_endpoint` / `parse_ai_profile_text` / `ai_model_to_ai_profile` / `fix_legacy_ai_model` |
| 端点拼接 | `services/ai.rs` 的 `build_openai_chat_url`（转发 crate）/ `ollama_native_root` |
| 前端适配层 | `src/lib/aiProviderPresets.ts`（`useAiProviderPresets` 等，**只做形状适配**） |
| 表单 | `src/pages/settings/index.tsx`、`src/components/ai/MobileAiModelModal.tsx` |
| 分享 / 导入 | `src/lib/configShare.ts`（`kbConfig` 信封归本项目；ai.profile 交给后端） |

## `ai_models.provider` 存的是 crate 预置 key

schema v62 起是 `deepseek` / `moonshot` / `openai_official` / `ollama` / `openai_compatible_custom`……
不再是本项目自己的旧 id（`kimi` / `doubao` / `openai` / `claude` / `custom`）。

- 按 provider 分支的代码要写新 key（`supports_json_response_format` 的白名单就踩过：
  还写 `openai` / `kimi` 时这两家的 JSON 模式被静默关掉）
- 旧 id → 新 key 的映射只在 `services/legacy_api_url.rs::legacy_provider_key`，**只给迁移与旧配置导入用**

## 🔴 存量地址修正（已完成，不要回退）

旧规则「末段不是 `vN` / `vN.M` 就自动补 `/v1`、末尾 `#` 锁定」→ crate「原样使用」。
`services/legacy_api_url.rs` 冻结了旧规则副本，对照测试断言「旧规则(原值) == crate(修正值)」—— **不要改那份副本**。

| 入口 | 条件 |
|---|---|
| schema v62 | 升级时一次；整库恢复（ZIP / WebDAV / `.bak`）后会重跑迁移，旧库同样被修正 |
| `kbConfig` 模型配置导入 | 信封没有 `api_url_verbatim`（v1.64.0 及以前导出）→ 先 `fix_legacy_ai_model` |
| ai.profile 导入 | 不修正：跨软件协议，按 crate 语义原样使用 |

- 🔴 只对旧来源修正：新数据再修会把用户刻意不带版本段的地址错补 `/v1`
- 带 `#` 的地址原样保留（幂等）；crate 拼地址时会剥掉末尾 `#`
- Ollama 存 `…/v1`（OpenAI 兼容层，5 个非流式功能走它），原生 `/api/*` 由 `ollama_native_root` 去掉 `/v1`

## 限额

| 列 | 含义 |
|---|---|
| `max_context` | 已存窗口；**0 = 未设置** |
| `limits_source` | `user` 手填 / `endpoint`「获取」时端点上报；NULL = 没存。🔴 `preset` 不落库 |
| `max_output` | 端点上报的模型输出上限，给 `max_tokens` 封顶 |
| `max_tokens` | 用户要的单次回答长度（与模型上限是两回事）；NULL = 不传，Ollama 可 -1 |

- 生效窗口一律用 `model_service::effective_context_window`（用户 > 端点 > 预置 > 未知），**别直接读 `max_context`**
- `compute_context_budget` 对 `<= 0` 走保守固定预算 —— 未知就是未知，不猜
- 「获取」拿到端点上报的限额会自动填入表单（来源 endpoint）；用户手改后来源变 user

## 上下文超长

`format_openai_api_error` 用 crate 的 `history::is_context_overflow` 识别，统一打上
`CONTEXT_OVERFLOW_TITLE` 标题；`chat_stream` 的历史降档（20 → 10 → 4 → 0）认这个标题。

`chat_stream_with_skills` **不接** crate 的 `trim_history`：本项目的消息是 OpenAI 结构（`tool_calls`），
crate 裁剪按 Anthropic 结构配对 tool —— 硬接会拆坏配对。

## 升级 ai-profile

1. 改 `src-tauri/Cargo.toml` 的 `version`；同一小版本内的补丁用 `cargo update -p ai-profile`
2. 测试（项目根目录，不要 cd）：
   ```bash
   cargo test --manifest-path src-tauri/Cargo.toml --workspace
   npx tsc --noEmit
   pnpm test
   ```
3. 回 ai-profile 仓库更新 `docs/downstream.md` 里 knowledge_base 那一行

没有多语言：crate 新增服务商时直接用它的中文 `label` / `hint`，不用补翻译。

## 本项目特有的坑

- 已知不稳定 / 已知失败的测试（与模型服务无关）：`tags::tag_path_segments_independent_namespace`
  （tags 唯一约束与测试期望矛盾，见 `docs/tasks/md-editor-mode-tasks.md`）、
  `dataview::dataview_recent_notes_orders_by_updated_at`（时间戳精确到秒，20ms 内建的两条笔记排序不定）
- Android 构建：crate 的 `client` 用 rustls，与本项目 reqwest 同一套 TLS，不会带进 OpenSSL
