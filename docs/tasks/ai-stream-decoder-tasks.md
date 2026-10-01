# 任务：流式 SSE 解析改用 ai-profile 0.1.4 的 `ai_profile::stream`

**状态**: 🔵 已完成（已本地提交，未推送；待用户实机验证，见文末）
**创建时间**: 2026-10-01
**Git 分支**: master
**约束**: 只本地提交不推送；不改前端事件协议；不跑联网 git / cargo publish

---

## 📋 需求

OpenAI 兼容 / Anthropic 的流式 SSE 解析原来散在 `services/ai.rs` + `services/anthropic.rs` 多处手写，
网关怪癖覆盖参差。ai-profile 0.1.4 的 `stream` 模块（sans-IO，只吃字节吐统一事件）把它收成一份，
这里改用它，并顺带修两个已知问题：

- 流在结束标记前断掉（掉线 / 上游中途掐断）时，几处循环走到末尾当正常结束，**半截回复被当成完整回复存进历史**
- 「2xx 却不是事件流」（网关回网页 / 忽略 `stream:true` 整段回 JSON）得到**空回复**

> 任务文档位置：本仓库任务文档平铺在 `docs/tasks/`，没有 `docs/tasks/active/` 目录，沿用现有惯例。

## 🔍 第 0 步：流式站点清单（2026-10-01 核实，行号为迁移前 `services/ai.rs`）

全仓 `bytes_stream` / `"stream": true` 只出现在 `ai.rs` 的 6 个流式站点（另 `webdav.rs:148`、
`mobile_update.rs:258` 是文件下载，与对话无关）。

| # | 函数（行） | 协议 | 工具 | 取消方式 | 断流（EOF 无结束标记）迁移前 | 取消 / 出错 / 落库 | 归属 |
|---|---|---|---|---|---|---|---|
| 1 | `stream_ollama_generic`（1367） | Ollama 原生 NDJSON | 无 | `select! cancel_rx.changed()` → `Ok(已收文本)` | 当正常结束 | 写作助手：不落库 | **不迁**（NDJSON） |
| 2 | `stream_openai_generic`（1450） | OpenAI 兼容 + Anthropic | 无 | 同上 | 当正常结束 | 写作助手：`ai-write:token`；`Err` 时先 `ai-write:error`；返回值被丢弃，**不落库**。前端出错时把预览替换成「错误: …」 | **已迁** |
| 3 | `stream_ollama`（1900） | Ollama 原生 NDJSON | 无 | `send_unless_cancelled` + `select!` | 当正常结束 | `chat_stream` 存卡片 | **不迁** |
| 4 | `stream_openai_compatible`（2013） | OpenAI 兼容 + Anthropic | 无（RAG 路径） | 同上；`chat_stream` 判 `*cancel_rx.borrow()` 存「已停止」 | 当正常结束 → `save_turn(done)` + `ai:done` | `Err` → `emit_ai_error` → `fail_turn`；上下文超长标题才降档重试 | **已迁** |
| 5 | `stream_openai_with_tools`（2512） | OpenAI 兼容 + Anthropic | **有**：`ToolCallAccum{id,name,args_json 原始字符串}` | 同上 → `(Ok(content), Some(vec![]))` | 当正常结束，**半截工具参数照样进 `tool_calls` 去执行** | `Err` → `fail_turn(all_skill_calls, round_texts)`；`length` 追加截断提示（**既有行为，保留**），其它非 stop/tool_calls 报错 | **已迁** |
| 6 | `stream_ollama_with_tools`（2691） | Ollama 原生 NDJSON | 有 | 同上 | 当正常结束 | — | **不迁**。⚠️ 实际是**死路径**：`chat_stream_with_skills` 对 ollama 在早返回走 RAG，`is_ollama` 恒 false |

> **Ollama 的 OpenAI 兼容端点（`/v1/chat/completions`）在本项目只给 5 个非流式功能用**，
> 对话 / 写作的流式一律走原生 `/api/chat`，所以「Ollama 兼容端点走 SSE」在本项目没有站点。
>
> **`drain_complete_lines` 没有删**：Ollama 原生的 3 处（#1 #3 #6 一带）仍靠它切 NDJSON 行，
> 函数与它的 6 条测试保留，只更新了注释。
>
> **无非流式回落**：6 个流式函数里没有「整段 JSON 回落成非流式」的逻辑，`NotEventStream` 直接报错。

## 🔴 第 1 步：断流改报错的业务影响 → 用户已决策：方案 B

迁移前 `fail_turn` 存空正文：失败时「当前这一轮已流给用户看的半截正文」本来就不存（网络读取错误、
Anthropic 流内 `error` 已是如此）。「断流改报错」把第三类情形（连接被干净关闭但没有结束标记）也并入，
意味着**长回答说到 90% 断线，用户看到的 ~2000 字被一张只有错误提示的卡片替换，刷新后找不回**，
而以前这种情况是「存成完整回复」（历史被污染，但内容还在）。触发了「丢失已看到的大段内容」条件，
故停下来问用户。

| 方案 | 做法 | 结论 |
|---|---|---|
| A | 沿用 `fail_turn` 空正文错误卡片 | 未选 |
| **B** | 错误卡片保留半截正文，`end_reason` 仍是 `error` | ✅ **用户选定（2026-10-01）** |
| C | onestop 口径：保留 + 追加「[未完成]」，不报错 | 未选（半截话进模型上下文，与「断流 → 报错」目标相反） |

选 B 的依据（已核实代码）：`TurnCard` 不论状态都渲染 `view.answer`（`TurnCard.tsx:133`），错误条挂在正文下面；
`usable_in_history`（`ai.rs`）已把 `endReason=error` 的卡片排除出模型上下文（已有单测
`history_skips_failed_and_empty_replies` 覆盖「error + 有正文」）。所以半截话**既不丢也不污染历史**，无需前端改动。

### 最终处置表

| 情形 | 已 emit 的 token | 半截回复入库 | 已执行的工具 | 未执行的工具 |
|---|---|---|---|---|
| 断流 / 流内错误 / 网络读取错误，RAG 对话 | 前端先显示 | **存进错误卡片**（`end_reason=error`，不进模型上下文） | — | — |
| 同上，智能模式第 N 轮 | 同上 | 当前轮正文存进卡片；此前各轮的工具调用 + `round_texts` 保留 | 保留（已跑完且结果已记录） | **不执行**（`Complete` 才交出工具调用） |
| 写作助手 | 预览框先显示，随后被「错误: …」替换（既有） | 不入库（本来就不入库） | — | — |
| 点停止 | 不变 | 不变：存「已停止」卡片 + 已收文本 | 不变 | 不执行 |
| Ollama 原生 | 不变 | 不变（失败时不带半截正文） | 不变 | 不变 |

> 副作用（已向用户说明的代价）：网络读取错误、流内 `error` 事件失败时也会保留半截正文（以前只留错误条）。

## ✅ 实施记录（本地 4 个提交 + 本次收尾）

| 提交 | 内容 |
|---|---|
| `6d3ec0f` | `refactor(ai)`：新增 `read_sse_stream` + `consume_text_stream` / `consume_tool_stream`，迁移 3 个 SSE 站点；删 `stream_text_delta` / `handle_*_stream_line` / `anthropic::parse_stream_line` / `StreamEvent` |
| `a3d8ecb` | `feat(ai)`：`StreamFailure{error, partial}` + `fail_turn(partial)`，方案 B |
| `6adcf3b` | `test(ai)`：假服务端端到端测试 15 条 + 失败卡片保留半截正文单测，含 2 处反证 |
| `1bce97b` | `docs(skill)`：`ai-profile-integration` 补「流式（0.1.4 起）」一节，`.claude` / `.codex` 镜像一致 |
| 收尾提交 | clippy 小修（测试 `expect_err`）+ 本文档 |

### 设计要点

- **一个读流函数**：`read_sse_stream(response, protocol, cancel_rx, on_event) -> SseRead{end, outcome}`，
  结局 `Complete` / `Cancelled` / `Failed(原因)`。`consume_text_stream`（#2 #4）与 `consume_tool_stream`（#5）包在外面
- **取消**：`wait_cancelled` 先看当前值再等变化。顺带修了原 `cancel_rx.changed()` 在 Sender 被 drop 后会空转的隐患
- **工具调用**：按 `ToolUseStart` / `ToolUseDelta` 逐块累积，**保留模型给的原始参数字符串**
  （`dispatch_with_mcp` 与回填给模型的 `arguments` 都吃字符串；取 `outcome.content` 会把畸形 JSON 改写成 `{}`）；
  **只有 `Complete` 才交出工具调用**，取消 / 断流 / 流内错误一律丢弃
- **结束原因**：`StopReason::as_str()` → 复用 `anthropic::finish_reason` 换成 OpenAI 词表，`length` 提示与异常终止判断不变
- **`NotEventStream`**：`looks_like_html` → 「接口返回的是网页…检查 API 地址路径」；否则「没有返回事件流」+ 响应开头 200 字；
  报错里的地址去掉 query（有的网关把 key 放 `?key=`）
- **`StreamEnd` non_exhaustive**：兜底分支按出错
- 前端事件协议（`ai:token` / `ai:reasoning` / `ai:error` / `ai:done` / `ai:tool_call` / `ai-write:*`）名字与 payload 形状**未改**

### 用户能感知的行为变化

1. 断流不再被当成完整回复；界面提示出错，**错误卡片里仍有失败前的正文**，且该卡片不进模型上下文
2. 网关回网页 / 整段 JSON：给出具体提示，不再是空回复
3. 断流 / 取消时半截工具调用不再被执行
4. 个别网关既不给 `finish_reason` 也不发 `[DONE]` 就收流，现在会报「响应在结束前中断」（以前静默当成功）
5. 少数网关用旧的 `finish_reason: "function_call"`，crate 认作 `tool_calls`（以前会被当异常终止）

## 🧪 验证结果（2026-10-01，本机）

- `cargo test --manifest-path src-tauri/Cargo.toml --workspace`：kb-core 5 过；kb_lib **904 passed / 0 failed / 6 ignored**
  （910 条，含新增 16 条：假服务端 15 + 失败卡片 1；原有 2 个长期不稳定用例本次也通过）
- `cargo clippy --workspace --all-targets`：0 error；`ai.rs` / `anthropic.rs` 里本次新增代码 0 告警
  （剩余告警均为仓库原有）
- 反证（拆守卫 → 变红 → 还原 → 转绿）：
  - 把 `StreamEnd::Truncated` 改成 `SseEnd::Complete` → `truncated_stream_is_a_failure_with_partial_text`、
    `truncated_in_tool_args_yields_no_tool_calls` 变红
  - 在 `decoder.push` 前先逐包 `String::from_utf8_lossy` → `chinese_char_split_across_packets_is_not_garbled`
    变红（得到 `你���世界`）
- 前端无改动，未跑 tsc / pnpm test
- 编码：`ai.rs` / `anthropic.rs` / 两份 SKILL.md 均 UTF-8 无 BOM、LF（与原文件一致，无 CRLF 混入）

## ⚠️ 需要用户实机验证（测试证明不了）

- [ ] **中文不乱码**：RAG 对话与智能模式各问一个长中文问题
- [ ] **对话中途断网**：界面是否提示出错；错误卡片里是否保留了断网前已显示的正文；
      **对话历史里该卡片不进下一轮上下文**（再问一句，模型不应引用半截内容）
- [ ] **带技能调用的对话**：Anthropic 与 OpenAI 兼容各一次（参数分片拼对、工具执行结果正常）；
      最好再在工具调用中途断网一次，确认不执行半截工具
- [ ] **点停止是否立即生效**：RAG / 智能模式 / 写作助手各点一次；停止后卡片是「已停止」且保留已生成内容
- [ ] **Ollama 原生路径不受影响**：Ollama 对话 + 写作助手各一次（走原生 NDJSON，本次未改动）
- [ ] 手机端对话（`MobileAiChat`）失败卡片是否同样保留正文（本次只核实了桌面 `TurnCard`）

## 📝 遗留问题

- Ollama 原生路径仍把「EOF 无 `done`」当正常结束（不在 crate 范围，按任务要求原样保留）
- `stream_ollama_with_tools` 是死路径（`is_ollama` 恒 false），本次不动，可另起任务清理
- 写作助手失败时仍是「预览被替换成错误」（既有行为；结果不入库）
- 无「整段 JSON 回落非流式」逻辑；若某网关长期忽略 `stream:true`，用户只能看到明确报错
- `NoteAiDrawer` / `MobileAiChat` 仍监听 `ai:error` 事件收尾，事件协议未改，行为不变

## ✅ 子任务

- [x] 第 0 步：站点清单
- [x] 第 1 步：业务影响分析 + 用户决策（方案 B）
- [x] 第 2 步：`read_sse_stream` + 3 个站点迁移 + 删手写解析（逐单元提交）
- [x] 第 3 步：端到端测试（假服务端，含 2 处反证）
- [x] 第 5 步：更新技能 `ai-profile-integration`（`.claude` 与 `.codex` 镜像）
- [x] 收尾：`cargo test --workspace` / `cargo clippy` / 验证记录
- [ ] 用户实机验证（上节清单）
