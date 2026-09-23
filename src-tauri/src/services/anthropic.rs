//! Anthropic Messages API（`/v1/messages`）适配层。
//!
//! # 为什么是「转换」而不是另写一套
//!
//! 发对话请求的地方有 11 处（对话、智能模式、写作助手、规划今日……），各自拼的都是
//! OpenAI `chat/completions` 结构的请求体。给每处再写一套 Anthropic 版，以后改一处
//! 忘一处是必然的。所以各处**照旧拼 OpenAI 结构**，发送前按模型协议在这里统一转换；
//! 响应和流也在这里统一解析回调用方熟悉的形状。
//!
//! # 与 Sigil 对齐的两个取舍（都是实测踩出来的）
//!
//! - **只发协议必需的请求头**（`x-api-key` + `anthropic-version`）。仿 Claude Code 客户端的
//!   `user-agent` / `x-app` 头会让中转站把请求路由到 Claude Code 专用账号池（常常是空的），
//!   直接 503「No available accounts」。
//! - **历史里只回传 text 与 tool_use 块**，不回传 thinking 块。思考块带签名，
//!   中转改写过签名就会整条 400；丢掉它 API 照常接受。

use ai_profile::Protocol;
use serde_json::{json, Map, Value};

use crate::models::AiModel;
use crate::services::model_service;

/// Messages API 版本头。至今仍是这个值，新特性走 `anthropic-beta`，本项目用不到。
pub const ANTHROPIC_VERSION: &str = "2023-06-01";

/// 没设单次回答上限时给多少。Anthropic 的 `max_tokens` **必填**，不能像 OpenAI 那样不传。
///
/// 8192 是 Claude 3.5 起所有型号都接受的输出上限：给得再大，中转背后若是老型号会直接 400。
const DEFAULT_MAX_TOKENS: i64 = 8192;

/// 这个预置 key 走不走 Anthropic 协议。
pub fn is_anthropic(provider: &str) -> bool {
    model_service::protocol_of(provider) == Protocol::Anthropic
}

/// `/v1/messages` 地址。官方档不存地址（crate 预置就没有），空时用官方默认。
pub fn messages_url(api_url: &str) -> String {
    let base = api_url.trim();
    let base = if base.is_empty() { Protocol::Anthropic.default_base_url() } else { base };
    ai_profile::endpoint::join_chat_endpoint(base, "messages")
}

/// 请求体没带 `max_tokens` 时用的值：用户设了按用户的（已按模型上限收紧），
/// 否则 [`DEFAULT_MAX_TOKENS`]，且不超过已知的模型输出上限。
pub fn default_max_tokens(model: &AiModel) -> i64 {
    if let Some(v) = model_service::clamp_max_tokens(model).filter(|v| *v > 0) {
        return v;
    }
    let cap = model_service::effective_limits(model)
        .and_then(|l| l.max_output)
        .map(i64::from)
        .unwrap_or(DEFAULT_MAX_TOKENS);
    DEFAULT_MAX_TOKENS.min(cap)
}

/// 挂上鉴权头。**不要**同时发 `Authorization`：部分中转两个都看，优先级不一，反而认错。
pub fn with_auth(req: reqwest::RequestBuilder, api_key: Option<&str>) -> reqwest::RequestBuilder {
    let req = req
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("Content-Type", "application/json");
    match api_key.map(str::trim).filter(|k| !k.is_empty()) {
        Some(k) => req.header("x-api-key", k),
        None => req,
    }
}

// ─────────────────────────── 请求体转换 ───────────────────────────

/// OpenAI `chat/completions` 请求体 → Anthropic `/v1/messages` 请求体。
///
/// | OpenAI | Anthropic |
/// |---|---|
/// | `role: system` 消息（可能不止一条、不在开头） | 顶层 `system`，按出现顺序拼接 |
/// | assistant 的 `tool_calls` | `tool_use` 块（`arguments` 字符串解析成对象） |
/// | 连续的 `role: tool` 消息 | **一条** user 消息里的多个 `tool_result` 块 |
/// | `tools[].function` | `{name, description, input_schema}`，只留这三个字段 |
/// | `max_tokens` 缺省 | `fallback_max_tokens`（必填） |
///
/// 丢弃：`response_format`（没有对应物，调用方的提示词本来就要求输出 JSON）、
/// `temperature` / `top_p` / `seed`（新型号不接受采样参数，带了直接 400）、Ollama 的 `options`。
pub fn to_request_body(openai: &Value, fallback_max_tokens: i64) -> Value {
    let mut system_parts: Vec<String> = Vec::new();
    let mut messages: Vec<Value> = Vec::new();
    // 攒着的 tool_result 块：连续的 tool 消息要合进同一条 user 消息
    let mut pending_results: Vec<Value> = Vec::new();

    let flush_results = |messages: &mut Vec<Value>, pending: &mut Vec<Value>| {
        if !pending.is_empty() {
            messages.push(json!({ "role": "user", "content": std::mem::take(pending) }));
        }
    };

    for m in openai["messages"].as_array().into_iter().flatten() {
        let role = m["role"].as_str().unwrap_or("");
        if role != "tool" {
            flush_results(&mut messages, &mut pending_results);
        }
        match role {
            "system" => {
                let text = content_text(&m["content"]);
                if !text.trim().is_empty() {
                    system_parts.push(text);
                }
            }
            "tool" => pending_results.push(json!({
                "type": "tool_result",
                "tool_use_id": m["tool_call_id"].as_str().unwrap_or(""),
                "content": content_text(&m["content"]),
            })),
            "assistant" => {
                if let Some(msg) = assistant_message(m) {
                    messages.push(msg);
                }
            }
            _ => {
                let text = content_text(&m["content"]);
                // 空文本块 Anthropic 直接 400（"text content blocks must be non-empty"）
                if !text.trim().is_empty() {
                    messages.push(json!({ "role": "user", "content": text }));
                }
            }
        }
    }
    flush_results(&mut messages, &mut pending_results);

    // 第一条必须是 user：历史被截断时可能以 assistant 开头
    while messages.first().is_some_and(|m| m["role"] == "assistant") {
        messages.remove(0);
    }

    let max_tokens = openai["max_tokens"]
        .as_i64()
        .filter(|v| *v > 0)
        .unwrap_or(fallback_max_tokens);
    let mut body = json!({
        "model": openai["model"],
        "max_tokens": max_tokens,
        "messages": messages,
    });
    if !system_parts.is_empty() {
        body["system"] = json!(system_parts.join("\n\n"));
    }
    if openai["stream"].as_bool() == Some(true) {
        body["stream"] = json!(true);
    }
    let tools: Vec<Value> = openai["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(tool_to_anthropic)
        .collect();
    if !tools.is_empty() {
        body["tools"] = json!(tools);
        body["tool_choice"] = json!({ "type": "auto" });
    }
    body
}

/// OpenAI 的 content 可能是字符串，也可能是 `[{type:"text", text}]` 数组 —— 统一取文本。
fn content_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// assistant 消息：纯文本原样；带 `tool_calls` 的拆成 text + tool_use 块。空消息返回 None。
fn assistant_message(m: &Value) -> Option<Value> {
    let text = content_text(&m["content"]);
    let calls = m["tool_calls"].as_array().filter(|a| !a.is_empty());
    let Some(calls) = calls else {
        return (!text.trim().is_empty()).then(|| json!({ "role": "assistant", "content": text }));
    };
    let mut blocks = Vec::new();
    if !text.trim().is_empty() {
        blocks.push(json!({ "type": "text", "text": text }));
    }
    for c in calls {
        let args = c["function"]["arguments"].as_str().unwrap_or("");
        // 解析失败（模型吐了残缺 JSON）给空对象：tool_use.input 必须是对象，否则整条 400
        let input = serde_json::from_str::<Value>(args)
            .ok()
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        blocks.push(json!({
            "type": "tool_use",
            "id": c["id"],
            "name": c["function"]["name"],
            "input": input,
        }));
    }
    Some(json!({ "role": "assistant", "content": blocks }))
}

/// `{type:"function", function:{name, description, parameters}}` → `{name, description, input_schema}`。
///
/// 只留这三个字段：Anthropic 严格校验 tools，多一个字段就整条 400（Sigil 踩过）。
/// description 缺省就不出现，别补成 null —— null 同样 400。
fn tool_to_anthropic(t: &Value) -> Option<Value> {
    let f = &t["function"];
    let name = f["name"].as_str()?;
    let mut out = Map::new();
    out.insert("name".into(), json!(name));
    if let Some(d) = f["description"].as_str() {
        out.insert("description".into(), json!(d));
    }
    let schema = match &f["parameters"] {
        Value::Object(_) => f["parameters"].clone(),
        _ => json!({ "type": "object", "properties": {} }),
    };
    out.insert("input_schema".into(), schema);
    Some(Value::Object(out))
}

// ─────────────────────────── 响应解析 ───────────────────────────

/// 非流式响应的正文：所有 text 块按顺序拼接。响应里没有 content 数组时返回 None。
pub fn response_text(resp: &Value) -> Option<String> {
    let blocks = resp["content"].as_array()?;
    Some(
        blocks
            .iter()
            .filter(|b| b["type"] == "text")
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join(""),
    )
}

/// 流里一行 SSE 解析出的事件。`event:` 行、`ping`、块起止等无关事件都归 [`StreamEvent::Other`]。
#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    Text(String),
    Thinking(String),
    /// 一个工具调用开始（参数随后以 [`StreamEvent::ToolArgs`] 分片到达）
    ToolStart { index: u64, id: String, name: String },
    ToolArgs { index: u64, partial_json: String },
    /// 结束原因，已换成 OpenAI 的叫法（见 [`finish_reason`]）
    Stop(String),
    Error(String),
    Other,
}

/// 解析一行 SSE。Anthropic 每个事件是 `event: xxx` + `data: {...}` 两行，
/// `data` 里自带 `type`，所以只看 `data` 行就够了。
pub fn parse_stream_line(line: &str) -> StreamEvent {
    let Some(json_str) = line.strip_prefix("data:").map(str::trim_start) else {
        return StreamEvent::Other;
    };
    let Ok(v) = serde_json::from_str::<Value>(json_str) else {
        return StreamEvent::Other;
    };
    match v["type"].as_str().unwrap_or("") {
        "content_block_start" if v["content_block"]["type"] == "tool_use" => StreamEvent::ToolStart {
            index: v["index"].as_u64().unwrap_or(0),
            id: v["content_block"]["id"].as_str().unwrap_or("").to_string(),
            name: v["content_block"]["name"].as_str().unwrap_or("").to_string(),
        },
        "content_block_delta" => {
            let d = &v["delta"];
            match d["type"].as_str().unwrap_or("") {
                "text_delta" => StreamEvent::Text(d["text"].as_str().unwrap_or("").to_string()),
                "thinking_delta" => {
                    StreamEvent::Thinking(d["thinking"].as_str().unwrap_or("").to_string())
                }
                "input_json_delta" => StreamEvent::ToolArgs {
                    index: v["index"].as_u64().unwrap_or(0),
                    partial_json: d["partial_json"].as_str().unwrap_or("").to_string(),
                },
                _ => StreamEvent::Other,
            }
        }
        "message_delta" => match v["delta"]["stop_reason"].as_str() {
            Some(r) => StreamEvent::Stop(finish_reason(r).to_string()),
            None => StreamEvent::Other,
        },
        // 流中途的错误（如 overloaded_error）：HTTP 已经是 200，只能从事件里认出来
        "error" => StreamEvent::Error(
            v["error"]["message"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| v["error"].to_string()),
        ),
        _ => StreamEvent::Other,
    }
}

/// Anthropic 的 `stop_reason` → OpenAI 的 `finish_reason`，让调用方共用一套收尾判断。
pub fn finish_reason(stop_reason: &str) -> &str {
    match stop_reason {
        "end_turn" | "stop_sequence" | "pause_turn" => "stop",
        "tool_use" => "tool_calls",
        "max_tokens" => "length",
        // refusal 等原样返回：调用方按「异常终止」处理，把原因展示给用户
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_messages_move_to_top_level_and_join() {
        let body = to_request_body(
            &json!({
                "model": "claude-opus-5",
                "messages": [
                    {"role": "system", "content": "你是知识库助手"},
                    {"role": "user", "content": "你好"},
                    {"role": "system", "content": "工具调用次数已达上限"},
                ],
            }),
            4096,
        );
        assert_eq!(body["system"], "你是知识库助手\n\n工具调用次数已达上限");
        assert_eq!(body["messages"], json!([{"role": "user", "content": "你好"}]));
        assert_eq!(body["max_tokens"], 4096, "缺省时用兜底值（Anthropic 必填）");
    }

    #[test]
    fn tool_round_trip_becomes_tool_use_and_merged_tool_results() {
        let body = to_request_body(
            &json!({
                "model": "m",
                "max_tokens": 800,
                "messages": [
                    {"role": "user", "content": "搜一下"},
                    {"role": "assistant", "content": "我先搜", "tool_calls": [
                        {"id": "a", "type": "function", "function": {"name": "search_notes", "arguments": "{\"query\":\"周报\"}"}},
                        {"id": "b", "type": "function", "function": {"name": "list_tags", "arguments": ""}},
                    ]},
                    {"role": "tool", "tool_call_id": "a", "content": "[1,2]"},
                    {"role": "tool", "tool_call_id": "b", "content": "[]"},
                ],
            }),
            4096,
        );
        assert_eq!(body["max_tokens"], 800, "请求体自带的优先");
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3, "两条 tool 消息必须合进同一条 user 消息");
        assert_eq!(msgs[1]["content"][0], json!({"type": "text", "text": "我先搜"}));
        assert_eq!(msgs[1]["content"][1]["input"], json!({"query": "周报"}));
        assert_eq!(msgs[1]["content"][2]["input"], json!({}), "空 arguments 也要是对象");
        assert_eq!(msgs[2]["role"], "user");
        assert_eq!(msgs[2]["content"].as_array().unwrap().len(), 2);
        assert_eq!(msgs[2]["content"][1]["tool_use_id"], "b");
    }

    #[test]
    fn drops_fields_anthropic_rejects() {
        let body = to_request_body(
            &json!({
                "model": "m",
                "messages": [
                    {"role": "assistant", "content": "被截断的历史以回答开头"},
                    {"role": "user", "content": "问"},
                    {"role": "assistant", "content": ""},
                ],
                "temperature": 0.8, "top_p": 0.9, "seed": 1,
                "response_format": {"type": "json_object"},
                "tools": [{"type": "function", "function": {"name": "t", "parameters": {"type": "object"}, "strict": true}}],
            }),
            4096,
        );
        for k in ["temperature", "top_p", "seed", "response_format"] {
            assert!(body.get(k).is_none(), "{k} 不能发给 Anthropic");
        }
        assert_eq!(body["messages"], json!([{"role": "user", "content": "问"}]), "开头的 assistant 和空消息都要去掉");
        let tool = body["tools"][0].as_object().unwrap();
        assert_eq!(tool.len(), 2, "只剩 name + input_schema（没有 description 就不出现）");
        assert_eq!(body["tool_choice"], json!({"type": "auto"}));
    }

    #[test]
    fn parses_stream_events() {
        assert_eq!(
            parse_stream_line(r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}"#),
            StreamEvent::Text("你好".into())
        );
        assert_eq!(
            parse_stream_line(r#"data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"search_notes","input":{}}}"#),
            StreamEvent::ToolStart { index: 1, id: "t1".into(), name: "search_notes".into() }
        );
        assert_eq!(
            parse_stream_line(r#"data:{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"q"}}"#),
            StreamEvent::ToolArgs { index: 1, partial_json: "{\"q".into() },
            "data: 后没空格也要认"
        );
        assert_eq!(
            parse_stream_line(r#"data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{}}"#),
            StreamEvent::Stop("tool_calls".into())
        );
        assert_eq!(
            parse_stream_line(r#"data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#),
            StreamEvent::Error("Overloaded".into())
        );
        assert_eq!(parse_stream_line("event: ping"), StreamEvent::Other);
        assert_eq!(parse_stream_line(r#"data: {"type":"ping"}"#), StreamEvent::Other);
    }

    #[test]
    fn response_text_joins_text_blocks_only() {
        let r = json!({"content": [
            {"type": "thinking", "thinking": "想"},
            {"type": "text", "text": "答"},
            {"type": "text", "text": "案"},
        ]});
        assert_eq!(response_text(&r).as_deref(), Some("答案"));
        assert_eq!(response_text(&json!({"choices": []})), None);
    }

    #[test]
    fn messages_url_uses_official_default_when_empty() {
        assert_eq!(messages_url(""), "https://api.anthropic.com/v1/messages");
        assert_eq!(messages_url("https://relay.example.com/v1"), "https://relay.example.com/v1/messages");
        assert_eq!(
            messages_url("https://relay.example.com/v1/messages"),
            "https://relay.example.com/v1/messages",
            "粘了完整端点就原样用"
        );
    }
}
