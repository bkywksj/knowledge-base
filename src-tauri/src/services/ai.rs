use futures::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

use crate::database::Database;
use crate::error::AppError;
use crate::models::{
    AiMessage, AiModel, AiModelInput, AiModelTestResult, DraftNoteRequest, DraftNoteResponse,
    Folder, MilestoneDraft, PlanFromExcelRequest, PlanFromGoalRequest, PlanFromGoalResponse,
    PlanTodayRequest, PlanTodayResponse, SkillCall, TaskQuery, TaskSuggestion,
};
use crate::services::skills;

/// 事件发射器 trait，用于抽象不同事件前缀
trait AiEventEmitter: Send + Sync {
    fn emit_token(&self, content: &str);
    fn emit_error(&self, error: &str);
}

/// 写作辅助事件发射器（ai-write: 前缀）
struct WriteAssistEmitter {
    app: AppHandle,
}

impl AiEventEmitter for WriteAssistEmitter {
    fn emit_token(&self, content: &str) {
        let _ = self.app.emit("ai-write:token", content);
    }
    fn emit_error(&self, error: &str) {
        let _ = self.app.emit("ai-write:error", error);
    }
}

/// 聊天事件发射器（ai: 前缀）
#[allow(dead_code)]
struct ChatEmitter {
    app: AppHandle,
}

impl AiEventEmitter for ChatEmitter {
    fn emit_token(&self, content: &str) {
        let _ = self.app.emit("ai:token", content);
    }
    fn emit_error(&self, error: &str) {
        let _ = self.app.emit("ai:error", error);
    }
}

pub struct AiService;

/// 获取用于 Ollama 的 HTTP 客户端：始终绕过系统代理。
///
/// Ollama 是本地 / 内网服务（localhost、127.0.0.1、192.168.x、10.x、Tailscale 100.64.0.0/10 等），
/// 走 Clash 等系统 HTTP 代理只会被劫持导致连接失败。
///
/// 返回全局单例引用，避免每次流式请求都重建连接池。
fn build_ollama_client() -> &'static Client {
    crate::services::http_client::shared_no_proxy()
}

/// 根据用户配置的 api_url 构造 OpenAI 兼容的 chat/completions 完整 URL。
///
/// 兼容三类写法：
/// - `https://api.openai.com`                 → `.../v1/chat/completions`（补默认 v1）
/// - `https://api.deepseek.com/v1`            → `.../v1/chat/completions`（已带版本段，只补端点）
/// - `https://open.bigmodel.cn/api/paas/v4`   → `.../paas/v4/chat/completions`（智谱等非 /v1 版本）
/// - `https://x.y/v1/chat/completions`        → 原样使用
fn build_openai_chat_url(api_url: &str) -> String {
    let base = api_url.trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        return base.to_string();
    }
    // 检测最后一段是否为 vN / vN.M 形式的版本号
    let has_version_segment = base.rsplit('/').next().is_some_and(|seg| {
        seg.starts_with('v')
            && seg.len() > 1
            && seg[1..].chars().all(|c| c.is_ascii_digit() || c == '.')
    });
    if has_version_segment {
        format!("{}/chat/completions", base)
    } else {
        format!("{}/v1/chat/completions", base)
    }
}

/// 将 reqwest 错误格式化为对用户友好的 Ollama 错误提示
fn format_ollama_send_error(e: &reqwest::Error, url: &str) -> String {
    if e.is_connect() || e.is_timeout() {
        format!(
            "无法连接到 Ollama 服务 ({})。请确认：\n\
             1. Ollama 已启动（命令行运行 `ollama serve`）\n\
             2. 设置里的 API 地址正确\n\
             3. 若设置了系统代理，确保其不拦截本地请求\n\
             原始错误: {}",
            url, e
        )
    } else {
        format!("Ollama 请求失败: {}", e)
    }
}

/// 将 OpenAI 兼容接口（OpenAI / DeepSeek / 智谱 / Claude 代理）的 HTTP 错误
/// 转成用户友好的中文提示。优先解析 body 里的 `error.message`。
fn format_openai_api_error(status: reqwest::StatusCode, body: &str) -> String {
    // 尝试从 body 提取 OpenAI 风格的 error.message
    let api_msg = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| body.chars().take(200).collect());

    let (title, hint) = match status.as_u16() {
        401 => (
            "API Key 无效或已过期",
            "请到设置页重新检查 API Key；注意不同厂商 Key 不通用（OpenAI/DeepSeek/智谱 各有各的）。",
        ),
        402 => (
            "账户余额不足",
            "请到对应厂商控制台充值：\n\
             · DeepSeek: https://platform.deepseek.com\n\
             · OpenAI:   https://platform.openai.com/account/billing\n\
             · 智谱 GLM: https://open.bigmodel.cn\n\
             想免费试用可切到「智谱 GLM」→ 模型选 glm-4-flash。",
        ),
        403 => (
            "无访问权限",
            "该 API Key 没有此模型/接口的权限，检查后台是否开通对应能力。",
        ),
        404 => (
            "模型或接口不存在",
            "检查「模型标识」是否填对（如 deepseek-chat / glm-4-flash / gpt-4o-mini），以及 API 地址是否正确。",
        ),
        429 => (
            "请求被限流",
            "短时间内请求过多，稍等片刻再试；付费账户限流更宽松。",
        ),
        500..=599 => (
            "服务端暂时故障",
            "不是你的配置问题，稍后再试；如持续报错可到厂商状态页查看。",
        ),
        _ => ("AI 服务返回错误", ""),
    };

    if hint.is_empty() {
        format!("{} ({})\n详情: {}", title, status, api_msg)
    } else {
        format!("{} ({})\n{}\n\n详情: {}", title, status, hint, api_msg)
    }
}

/// 从用户首条消息生成会话标题：去首尾空白、压缩换行、截断至 24 个字符。
///
/// 超过限制时追加省略号；空串返回空串（调用方据此跳过重命名）。
fn derive_conversation_title(user_message: &str) -> String {
    const MAX_CHARS: usize = 24;
    let cleaned: String = user_message
        .replace(['\r', '\n', '\t'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= MAX_CHARS {
        trimmed.to_string()
    } else {
        let prefix: String = chars.iter().take(MAX_CHARS).collect();
        format!("{}…", prefix)
    }
}

/// 剥掉 AI 在最后一轮（tools 已禁用）退化输出的"伪工具调用文本"。
///
/// 当 `chat_stream_with_skills` 进入 finalization 轮（不带 tools schema）时，
/// 模型有时会因为前几轮的工具调用惯性，仍按训练数据里的 ChatML / 自定义格式
/// 在 content 通道吐出工具调用语法。这些字符串没有任何执行效果，但会被前端
/// 当成正文 markdown 渲染给用户，看起来很迷惑。
///
/// 兜底处理：把这些片段从 content 里抹掉。覆盖三种常见伪格式：
/// - `<tool_call>{...}</tool_call>` / `<tool_use>{...}</tool_use>`（XML 风格）
/// - 围栏代码块 ` ```tool_call ... ``` ` / ` ```tool_code ... ``` `
/// - 行首 `functions.search_notes({...})` 这种"函数调用看起来像 JS"的形式
///
/// 多个空行会被合并为单空行，避免剥完留下大段空白。
pub fn strip_pseudo_tool_calls(s: &str) -> String {
    use std::sync::OnceLock;
    static XML_RE: OnceLock<regex::Regex> = OnceLock::new();
    static FENCE_RE: OnceLock<regex::Regex> = OnceLock::new();
    static FUNC_RE: OnceLock<regex::Regex> = OnceLock::new();
    static BLANKS_RE: OnceLock<regex::Regex> = OnceLock::new();

    let xml = XML_RE.get_or_init(|| {
        // Rust regex 不支持反向引用，所以闭合标签也用同样的 alternation。
        // 即使 model 写出错配（<tool_call>...</tool>），也属于要剥的伪文，无所谓。
        regex::Regex::new(
            r"(?is)<\s*(?:tool_call|tool_use|tool|function_call)\b[^>]*>.*?<\s*/\s*(?:tool_call|tool_use|tool|function_call)\s*>",
        )
        .expect("XML pseudo tool_call regex must compile")
    });
    let fence = FENCE_RE.get_or_init(|| {
        regex::Regex::new(r"(?is)```\s*(?:tool_call|tool_code|tool_use|function_call)\b.*?```")
            .expect("fenced pseudo tool_call regex must compile")
    });
    let func = FUNC_RE.get_or_init(|| {
        // 匹配 "functions.search_notes(...)" / "tool:search_notes(...)" 这种行
        regex::Regex::new(
            r"(?im)^\s*(?:functions\.|tool:\s*|tool_call:\s*)[a-z_][a-z0-9_]*\s*\([^\n]*\)\s*$",
        )
        .expect("function-call style pseudo tool regex must compile")
    });
    let blanks = BLANKS_RE.get_or_init(|| {
        regex::Regex::new(r"\n{3,}").expect("blank-line collapse regex must compile")
    });

    let s1 = xml.replace_all(s, "");
    let s2 = fence.replace_all(&s1, "");
    let s3 = func.replace_all(&s2, "");
    blanks.replace_all(&s3, "\n\n").trim().to_string()
}

/// 围绕用户问题关键词命中点，从笔记正文中截取窗口片段供 RAG 上下文使用。
///
/// 旧实现 `chars().take(500)` 只取开头 500 字，命中段在文档后半部时 AI 完全看不到。
/// 改为：复用 `Database::extract_keywords` 得到和检索一致的关键词集合，取**最早命中位置**
/// 居中的 `window` 字符窗口；未命中则降级为从头取 `window` 字符；首尾被裁剪用 `…` 标记，
/// 提示 AI 这是片段而非整篇。
/// 把对话挂载的 N 篇笔记拼成 system prompt 前缀字符串。
///
/// **预算计算**：模型 max_context 的 60% 留给附加笔记（剩 ~40% 给历史消息+输出+其它 system）。
/// 每篇平均分配；标题不截断，正文按 `(预算 / 笔记数 / 1.5)` 截断（中文 1.5 字符≈1 token）。
///
/// **失败容忍**：单篇笔记 `get_note` 失败时跳过该篇，不让单条坏数据搞挂整个对话。
/// 笔记列表为空时返回空串，调用方按需跳过。
fn build_attached_notes_context(
    db: &Database,
    note_ids: &[i64],
    model: &AiModel,
) -> String {
    if note_ids.is_empty() {
        return String::new();
    }
    // 拉笔记（失败的跳过；空数组直接返回空串）
    let notes: Vec<(String, String)> = note_ids
        .iter()
        .filter_map(|id| {
            db.get_note(*id)
                .ok()
                .flatten()
                .map(|n| (n.title, strip_html(&n.content)))
        })
        .collect();
    if notes.is_empty() {
        return String::new();
    }

    // 60% max_context 字符预算（粗略：1 token ≈ 1.5 字符 for CJK）
    let total_budget_chars = ((model.max_context as f64) * 0.6) as usize;
    let per_note_chars = (total_budget_chars / notes.len()).max(500);

    let mut out = String::with_capacity(total_budget_chars);
    out.push_str(&format!(
        "用户为本次对话主动挂载了以下 {} 篇笔记作为强制上下文，请优先基于这些笔记内容回答；\
         如果用户问题与挂载笔记完全无关，再考虑用一般知识回答。\n\n",
        notes.len()
    ));
    for (i, (title, plain)) in notes.iter().enumerate() {
        let truncated: String = plain.chars().take(per_note_chars).collect();
        let suffix = if plain.chars().count() > per_note_chars {
            "\n…（已截断）"
        } else {
            ""
        };
        out.push_str(&format!(
            "── 挂载笔记 {} / {} ──\n标题: {}\n内容:\n{}{}\n\n",
            i + 1,
            notes.len(),
            title,
            truncated,
            suffix
        ));
    }
    out
}

fn extract_window_for_rag(content: &str, query: &str, window: usize) -> String {
    let chars: Vec<char> = content.chars().collect();
    if chars.len() <= window {
        return content.to_string();
    }

    let keywords = crate::database::Database::extract_keywords(query);
    let lower_content: String = content.to_lowercase();

    let mut earliest_char_idx: Option<usize> = None;
    for kw in &keywords {
        let kw_lower = kw.to_lowercase();
        if let Some(byte_pos) = lower_content.find(&kw_lower) {
            let char_idx = lower_content[..byte_pos].chars().count();
            earliest_char_idx = Some(earliest_char_idx.map_or(char_idx, |c| c.min(char_idx)));
        }
    }

    match earliest_char_idx {
        Some(hit) => {
            let half = window / 2;
            let tentative_start = hit.saturating_sub(half);
            let end = (tentative_start + window).min(chars.len());
            // 贴底时反推 start，保证窗口始终是 window 大小
            let start = end.saturating_sub(window);
            let body: String = chars[start..end].iter().collect();
            let mut buf = String::with_capacity(body.len() + 6);
            if start > 0 {
                buf.push('…');
            }
            buf.push_str(&body);
            if end < chars.len() {
                buf.push('…');
            }
            buf
        }
        None => {
            let body: String = chars.iter().take(window).collect();
            format!("{}…", body)
        }
    }
}

/// 去除 HTML 标签，提取纯文本（用于 RAG 上下文）
fn strip_html(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => result.push(ch),
            _ => {}
        }
    }
    result
}

impl AiService {
    /// AI 写作辅助：选中文本 + 操作指令 → 流式返回结果
    ///
    /// 事件前缀 `ai-write:token` / `ai-write:done` / `ai-write:error`
    ///
    /// `action` 支持两种格式：
    /// - `prompt:{id}`：从 prompt_templates 表查模板，`{{selection}} {{context}} {{title}}` 占位符
    ///   替换成实际值后作为 user message 发送（推荐路径，v19 起前端 AI 菜单都走这里）
    /// - 裸词如 `continue` / `summarize`：先尝试按 `builtin_code` 查 DB，查不到再回退到内置硬编码
    ///   提示（保留这条路径是为了兼容老版本或外部脚本直接调用）
    pub async fn write_assist(
        app: AppHandle,
        db: &Database,
        action: &str,
        selected_text: &str,
        context: &str,
        cancel_rx: watch::Receiver<bool>,
    ) -> Result<(), AppError> {
        let model = db.get_default_ai_model()?;

        // 选中文本 / 上下文统一走 HTML 剥离，避免 <p>/<br> 污染 Prompt
        let selection_plain = strip_html(selected_text);
        let context_plain_full = strip_html(context);
        // 上下文窗口限制：旧逻辑 500 字，保持不变；太长会侵蚀 selection 的 token 预算
        let context_snippet: String = context_plain_full.chars().take(500).collect();

        // 优先按 DB Prompt 走（prompt:id 或 builtin_code）
        let rendered = if let Ok(tmpl) = crate::services::prompt::PromptService::resolve(db, action)
        {
            let vars = crate::services::prompt::PromptVars {
                selection: &selection_plain,
                context: &context_snippet,
                title: "",
                language: "zh-CN",
            };
            Some(crate::services::prompt::render(&tmpl.prompt, &vars))
        } else {
            None
        };

        let messages = if let Some(user_content) = rendered {
            // DB Prompt 路径：单轮 user message（模板里已经把上下文/选区织进去了）
            vec![
                json!({
                    "role": "system",
                    "content": "你是一个写作助手。请按照用户的指令处理文本，只输出最终结果，不要额外解释。使用中文。"
                }),
                json!({ "role": "user", "content": user_content }),
            ]
        } else {
            // 兜底硬编码路径：DB 里没有对应模板时保持旧行为，防止功能完全不可用
            let system_prompt = match action {
                "continue" => "你是一个写作助手。请根据上下文和已有内容，自然地续写下去。只输出续写内容，不要重复已有内容。使用中文。",
                "summarize" => "你是一个写作助手。请对以下文本进行简洁的总结概括。使用中文。",
                "rewrite" => "你是一个写作助手。请改写以下文本，使其表达更加流畅、专业。保持原意不变。只输出改写后的内容。使用中文。",
                "translate_en" => "你是一个翻译助手。请将以下文本翻译为英文。只输出翻译结果。",
                "translate_zh" => "你是一个翻译助手。请将以下文本翻译为中文。只输出翻译结果。",
                "expand" => "你是一个写作助手。请对以下文本进行扩展，补充更多细节和论述。使用中文。",
                "shorten" => "你是一个写作助手。请精简以下文本，保留核心信息，减少冗余。使用中文。",
                _ => "你是一个写作助手。请按照用户的要求处理文本。使用中文。",
            };
            let mut messages = vec![json!({ "role": "system", "content": system_prompt })];
            if !context_snippet.is_empty() {
                messages.push(json!({
                    "role": "user",
                    "content": format!("以下是笔记的上下文内容（供参考）：\n{}", context_snippet)
                }));
                messages.push(json!({
                    "role": "assistant",
                    "content": "好的，我已了解上下文。请提供需要处理的文本。"
                }));
            }
            messages.push(json!({ "role": "user", "content": selection_plain }));
            messages
        };

        // 创建一个包装 app handle 发送 ai-write: 前缀事件
        let write_app = WriteAssistEmitter { app: app.clone() };

        let _full = match model.provider.as_str() {
            "ollama" => {
                Self::stream_ollama_generic(&write_app, &model, &messages, cancel_rx).await?
            }
            // T-012: 默认走 OpenAI 兼容（含 LM Studio / 自定义 baseUrl）
            _ => {
                Self::stream_openai_generic(&write_app, &model, &messages, cancel_rx).await?
            }
        };

        let _ = app.emit("ai-write:done", "");
        Ok(())
    }

    /// 测试 AI 模型连通性。
    ///
    /// 不依赖数据库，直接基于 `AiModelInput` 试探，方便用户在「添加/编辑模型」Modal
    /// 还没保存时就先验证。策略：
    /// - Ollama: POST /api/chat，`num_predict=1`，绕系统代理（Clash 会劫本地包）
    /// - 其它（OpenAI 兼容）: POST /chat/completions，`max_tokens=5`
    ///
    /// 整体每次请求 12s 超时，失败错误经 `format_*_error` 中文化，前端 `Modal.error`
    /// 多行展示。
    pub async fn test_model_connection(
        input: &AiModelInput,
    ) -> Result<AiModelTestResult, AppError> {
        if input.api_url.trim().is_empty() {
            return Err(AppError::InvalidInput("API 地址不能为空".into()));
        }
        if input.model_id.trim().is_empty() {
            return Err(AppError::InvalidInput("模型标识不能为空".into()));
        }

        let timeout = std::time::Duration::from_secs(12);
        let started = std::time::Instant::now();

        if input.provider == "ollama" {
            let client = build_ollama_client();
            let url = format!("{}/api/chat", input.api_url.trim_end_matches('/'));
            let response = client
                .post(&url)
                .timeout(timeout)
                .json(&json!({
                    "model": input.model_id,
                    "messages": [{ "role": "user", "content": "ping" }],
                    "stream": false,
                    "options": { "num_predict": 1 }
                }))
                .send()
                .await
                .map_err(|e| AppError::Custom(format_ollama_send_error(&e, &url)))?;
            if !response.status().is_success() {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                let snippet: String = body.chars().take(200).collect();
                return Err(AppError::Custom(format!(
                    "Ollama 返回错误 {}\n详情: {}\n\n建议：先确认本地已 `ollama pull {}` 拉到此模型",
                    status, snippet, input.model_id
                )));
            }
            let body: Value = response
                .json()
                .await
                .map_err(|e| AppError::Custom(format!("Ollama 响应解析失败: {}", e)))?;
            let sample = body["message"]["content"]
                .as_str()
                .map(|s| s.chars().take(40).collect::<String>());
            return Ok(AiModelTestResult {
                ok: true,
                latency_ms: started.elapsed().as_millis() as u64,
                sample,
            });
        }

        // OpenAI 兼容（含 lmstudio / deepseek / zhipu / claude proxy / minimax / siliconflow / custom）
        let client = crate::services::http_client::shared();
        let url = build_openai_chat_url(&input.api_url);
        let mut request = client
            .post(&url)
            .timeout(timeout)
            .header("Content-Type", "application/json")
            .json(&json!({
                "model": input.model_id,
                "messages": [{ "role": "user", "content": "ping" }],
                "max_tokens": 5,
                "stream": false
            }));
        if let Some(key) = &input.api_key {
            if !key.trim().is_empty() {
                request = request.header("Authorization", format!("Bearer {}", key));
            }
        }
        let response = request
            .send()
            .await
            .map_err(|e| AppError::Custom(format!("API 请求失败: {}", e)))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Custom(format_openai_api_error(status, &body)));
        }
        let body: Value = response
            .json()
            .await
            .map_err(|e| AppError::Custom(format!("响应解析失败: {}", e)))?;
        let sample = body["choices"][0]["message"]["content"]
            .as_str()
            .map(|s| s.chars().take(40).collect::<String>());
        Ok(AiModelTestResult {
            ok: true,
            latency_ms: started.elapsed().as_millis() as u64,
            sample,
        })
    }

    /// 通用 Ollama 流式请求（使用 EventEmitter trait）
    async fn stream_ollama_generic(
        emitter: &dyn AiEventEmitter,
        model: &AiModel,
        messages: &[Value],
        mut cancel_rx: watch::Receiver<bool>,
    ) -> Result<String, AppError> {
        let url = format!("{}/api/chat", model.api_url.trim_end_matches('/'));
        let client = build_ollama_client();
        let response = client
            .post(&url)
            .json(&json!({
                "model": model.model_id,
                "messages": messages,
                "stream": true
            }))
            .send()
            .await
            .map_err(|e| AppError::Custom(format_ollama_send_error(&e, &url)))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Custom(format!("Ollama 返回错误 {}: {}", status, body)));
        }

        let mut stream = response.bytes_stream();
        let mut full_response = String::new();
        loop {
            tokio::select! {
                chunk = stream.next() => {
                    match chunk {
                        Some(Ok(bytes)) => {
                            let text = String::from_utf8_lossy(&bytes);
                            for line in text.lines() {
                                if line.is_empty() { continue; }
                                if let Ok(data) = serde_json::from_str::<Value>(line) {
                                    if let Some(content) = data["message"]["content"].as_str() {
                                        full_response.push_str(content);
                                        emitter.emit_token(content);
                                    }
                                    if data["done"].as_bool() == Some(true) {
                                        return Ok(full_response);
                                    }
                                }
                            }
                        }
                        Some(Err(e)) => {
                            emitter.emit_error(&e.to_string());
                            return Err(AppError::Custom(format!("流读取错误: {}", e)));
                        }
                        None => break,
                    }
                }
                _ = cancel_rx.changed() => {
                    if *cancel_rx.borrow() {
                        return Ok(full_response);
                    }
                }
            }
        }
        Ok(full_response)
    }

    /// 通用 OpenAI 兼容流式请求（使用 EventEmitter trait）
    async fn stream_openai_generic(
        emitter: &dyn AiEventEmitter,
        model: &AiModel,
        messages: &[Value],
        mut cancel_rx: watch::Receiver<bool>,
    ) -> Result<String, AppError> {
        let client = crate::services::http_client::shared();
        let url = build_openai_chat_url(&model.api_url);
        let mut request = client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&json!({
                "model": model.model_id,
                "messages": messages,
                "stream": true
            }));
        if let Some(key) = &model.api_key {
            if !key.is_empty() {
                request = request.header("Authorization", format!("Bearer {}", key));
            }
        }
        let response = request.send().await.map_err(|e| AppError::Custom(format!("API 请求失败: {}", e)))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Custom(format_openai_api_error(status, &body)));
        }

        let mut stream = response.bytes_stream();
        let mut full_response = String::new();
        let mut buffer = String::new();
        loop {
            tokio::select! {
                chunk = stream.next() => {
                    match chunk {
                        Some(Ok(bytes)) => {
                            buffer.push_str(&String::from_utf8_lossy(&bytes));
                            while let Some(pos) = buffer.find('\n') {
                                let line = buffer[..pos].trim().to_string();
                                buffer = buffer[pos + 1..].to_string();
                                if line.is_empty() || line == "data: [DONE]" { continue; }
                                if let Some(json_str) = line.strip_prefix("data: ") {
                                    if let Ok(data) = serde_json::from_str::<Value>(json_str) {
                                        if let Some(content) = data["choices"][0]["delta"]["content"].as_str() {
                                            full_response.push_str(content);
                                            emitter.emit_token(content);
                                        }
                                    }
                                }
                            }
                        }
                        Some(Err(e)) => {
                            emitter.emit_error(&e.to_string());
                            return Err(AppError::Custom(format!("流读取错误: {}", e)));
                        }
                        None => break,
                    }
                }
                _ = cancel_rx.changed() => {
                    if *cancel_rx.borrow() {
                        return Ok(full_response);
                    }
                }
            }
        }
        Ok(full_response)
    }

    /// 流式聊天：发送消息 → 检索笔记 → 调用 AI → 流式返回
    ///
    /// 通过 Tauri Event 实时推送 token 到前端：
    /// - `ai:token`  每个生成的 token
    /// - `ai:done`   生成完成
    /// - `ai:error`  发生错误
    pub async fn chat_stream(
        app: AppHandle,
        db: &Database,
        conversation_id: i64,
        user_message: &str,
        use_rag: bool,
        cancel_rx: watch::Receiver<bool>,
    ) -> Result<(), AppError> {
        // 1. 获取对话（含附加笔记 IDs）和使用的模型
        let conv = db.get_ai_conversation(conversation_id)?;
        let model = db.get_ai_model(conv.model_id)?;

        // 2. 附加笔记上下文（A 方向：用户在 AI 页用 chip 选了 N 篇笔记作为强制上下文）
        //    跟 RAG 独立：附加 = 必含；RAG = 智能补全；可叠加
        let attached_context = build_attached_notes_context(
            db,
            &conv.attached_note_ids,
            &model,
        );

        // 3. RAG: 检索相关笔记
        let mut rag_context = String::new();
        let mut ref_ids: Vec<i64> = Vec::new();
        if use_rag {
            let notes = db.search_notes_for_rag(user_message, 5)?;
            if !notes.is_empty() {
                rag_context.push_str(
                    "以下是通过关键词检索到的笔记内容（可能相关，也可能无关）：\n\n",
                );
                for (id, title, content) in &notes {
                    let plain = strip_html(content);
                    let snippet = extract_window_for_rag(&plain, user_message, 4000);
                    rag_context.push_str(&format!("---\n标题: {}\n内容: {}\n\n", title, snippet));
                    ref_ids.push(*id);
                }
            }
        }

        // 3. 保存用户消息到数据库
        let refs_json = if ref_ids.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&ref_ids).unwrap_or_default())
        };
        let user_msg = db.add_ai_message(
            conversation_id,
            "user",
            user_message,
            refs_json.as_deref(),
        )?;
        db.touch_ai_conversation(conversation_id)?;

        // 4. 构建历史消息并发送（支持自动重试递减历史）
        let history = db.list_ai_messages(conversation_id)?;

        // 尝试不同的历史长度：20 → 10 → 4 → 0（仅当前消息）
        let max_history_attempts = [20usize, 10, 4, 0];
        let mut last_error = None;

        for &max_hist in &max_history_attempts {
            let messages = Self::build_messages(
                &model,
                &history,
                &rag_context,
                &attached_context,
                max_hist,
            );

            log::info!("AI Request: model={}, messages={}, max_history={}",
                model.model_id, messages.len(), max_hist);

            let result = match model.provider.as_str() {
                "ollama" => {
                    Self::stream_ollama(&app, &model, &messages, cancel_rx.clone()).await
                }
                // T-012: 默认走 OpenAI 兼容协议（OpenAI / Claude 代理 / DeepSeek / 智谱 /
                // Minimax / SiliconFlow / LM Studio / 用户自定义 baseUrl）
                _ => {
                    Self::stream_openai_compatible(&app, &model, &messages, cancel_rx.clone())
                        .await
                }
            };

            match result {
                Ok(response) => {
                    // 成功：保存 AI 回复
                    db.add_ai_message(conversation_id, "assistant", &response, None)?;
                    db.touch_ai_conversation(conversation_id)?;

                    // 若会话仍是"新对话"默认名，用用户首问的前 24 个字符作为标题
                    let auto_title = derive_conversation_title(user_message);
                    if !auto_title.is_empty() {
                        let _ = db
                            .rename_ai_conversation_if_default(conversation_id, &auto_title);
                    }

                    let _ = app.emit("ai:done", conversation_id);
                    return Ok(());
                }
                Err(ref e) => {
                    let err_str = e.to_string();
                    // 仅在消息格式/轮数限制错误时重试（减少历史）
                    if err_str.contains("convert_request_failed")
                        || err_str.contains("context_length_exceeded")
                    {
                        log::warn!(
                            "API 请求失败(max_history={}), 尝试减少历史: {}",
                            max_hist, err_str
                        );
                        last_error = Some(e.to_string());
                        continue;
                    }
                    // 其他错误不重试，直接返回
                    let _ = db.delete_ai_message(user_msg.id);
                    return Err(AppError::Custom(err_str));
                }
            }
        }

        // 所有重试都失败了
        let _ = db.delete_ai_message(user_msg.id);
        Err(AppError::Custom(
            last_error.unwrap_or_else(|| "AI 请求失败".to_string()),
        ))
    }

    /// 构建发送给 AI 的消息列表
    fn build_messages(
        model: &AiModel,
        history: &[AiMessage],
        rag_context: &str,
        attached_context: &str,
        max_history: usize,
    ) -> Vec<Value> {
        let mut messages = Vec::new();

        // 系统提示
        let mut system_prompt = String::from(
            "你是一个知识库助手，帮助用户回答问题。请使用中文回答，回答要准确、简洁。\n\n\
             原则：\n\
             1. 只根据已知信息作答，不要编造事实。\n\
             2. 不确定或信息不足时，请明确说明，不要强行给出结论。",
        );
        // 附加笔记（用户主动挂载的强制上下文）放在最前面，权重最高
        if !attached_context.is_empty() {
            system_prompt.push_str("\n\n");
            system_prompt.push_str(attached_context);
        }
        if !rag_context.is_empty() {
            system_prompt.push_str(
                "\n\n接下来会提供检索到的笔记片段。请先判断这些笔记是否真的与用户问题相关：\n\
                 · 若相关：基于笔记内容回答，必要时引用标题。\n\
                 · 若不相关（例如笔记内容与用户问的主题明显无关）：\
                 请直接回答「未在笔记中找到相关内容」，不要从无关笔记里拼凑答案。\n\n",
            );
            system_prompt.push_str(rag_context);
        }

        // Claude 使用 system 字段，OpenAI/Ollama 使用 system role message
        if model.provider != "claude" {
            messages.push(json!({
                "role": "system",
                "content": system_prompt
            }));
        }

        // 历史消息：按 max_history 限制数量
        let start = if history.len() > max_history {
            history.len() - max_history
        } else {
            0
        };
        // 确保从 user 消息开始（不要从 assistant 消息开头）
        let mut slice_start = start;
        for i in start..history.len() {
            if history[i].role == "user" {
                slice_start = i;
                break;
            }
        }
        // 过滤连续相同 role 的消息（保留最后一条），避免 API 报错
        let mut last_role = "system".to_string();
        for msg in &history[slice_start..] {
            if msg.role == last_role {
                messages.pop();
            }
            messages.push(json!({
                "role": msg.role,
                "content": msg.content
            }));
            last_role = msg.role.clone();
        }

        messages
    }

    /// Ollama 流式请求
    async fn stream_ollama(
        app: &AppHandle,
        model: &AiModel,
        messages: &[Value],
        mut cancel_rx: watch::Receiver<bool>,
    ) -> Result<String, AppError> {
        let url = format!("{}/api/chat", model.api_url.trim_end_matches('/'));
        let client = build_ollama_client();

        let response = client
            .post(&url)
            .json(&json!({
                "model": model.model_id,
                "messages": messages,
                "stream": true
            }))
            .send()
            .await
            .map_err(|e| AppError::Custom(format_ollama_send_error(&e, &url)))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Custom(format!(
                "Ollama 返回错误 {}: {}",
                status, body
            )));
        }

        let mut stream = response.bytes_stream();
        let mut full_response = String::new();

        loop {
            tokio::select! {
                chunk = stream.next() => {
                    match chunk {
                        Some(Ok(bytes)) => {
                            let text = String::from_utf8_lossy(&bytes);
                            for line in text.lines() {
                                if line.is_empty() { continue; }
                                if let Ok(data) = serde_json::from_str::<Value>(line) {
                                    if let Some(content) = data["message"]["content"].as_str() {
                                        full_response.push_str(content);
                                        let _ = app.emit("ai:token", content);
                                    }
                                    if data["done"].as_bool() == Some(true) {
                                        return Ok(full_response);
                                    }
                                }
                            }
                        }
                        Some(Err(e)) => {
                            let _ = app.emit("ai:error", e.to_string());
                            return Err(AppError::Custom(format!("流读取错误: {}", e)));
                        }
                        None => break,
                    }
                }
                _ = cancel_rx.changed() => {
                    if *cancel_rx.borrow() {
                        let _ = app.emit("ai:done", "cancelled");
                        return Ok(full_response);
                    }
                }
            }
        }

        Ok(full_response)
    }

    /// OpenAI 兼容 API 流式请求（也支持 Claude 通过兼容接口）
    async fn stream_openai_compatible(
        app: &AppHandle,
        model: &AiModel,
        messages: &[Value],
        mut cancel_rx: watch::Receiver<bool>,
    ) -> Result<String, AppError> {
        let client = crate::services::http_client::shared();
        let url = build_openai_chat_url(&model.api_url);

        let mut request = client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&json!({
                "model": model.model_id,
                "messages": messages,
                "stream": true
            }));

        if let Some(key) = &model.api_key {
            if !key.is_empty() {
                request = request.header("Authorization", format!("Bearer {}", key));
            }
        }

        let response = request
            .send()
            .await
            .map_err(|e| AppError::Custom(format!("API 请求失败: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Custom(format_openai_api_error(status, &body)));
        }

        let mut stream = response.bytes_stream();
        let mut full_response = String::new();
        let mut buffer = String::new();

        loop {
            tokio::select! {
                chunk = stream.next() => {
                    match chunk {
                        Some(Ok(bytes)) => {
                            buffer.push_str(&String::from_utf8_lossy(&bytes));
                            // SSE 格式：data: {...}\n\n
                            while let Some(pos) = buffer.find('\n') {
                                let line = buffer[..pos].trim().to_string();
                                buffer = buffer[pos + 1..].to_string();

                                if line.is_empty() || line == "data: [DONE]" {
                                    continue;
                                }
                                if let Some(json_str) = line.strip_prefix("data: ") {
                                    if let Ok(data) = serde_json::from_str::<Value>(json_str) {
                                        if let Some(content) =
                                            data["choices"][0]["delta"]["content"].as_str()
                                        {
                                            full_response.push_str(content);
                                            let _ = app.emit("ai:token", content);
                                        }
                                    }
                                }
                            }
                        }
                        Some(Err(e)) => {
                            let _ = app.emit("ai:error", e.to_string());
                            return Err(AppError::Custom(format!("流读取错误: {}", e)));
                        }
                        None => break,
                    }
                }
                _ = cancel_rx.changed() => {
                    if *cancel_rx.borrow() {
                        let _ = app.emit("ai:done", "cancelled");
                        return Ok(full_response);
                    }
                }
            }
        }

        Ok(full_response)
    }

    // ══════════════════════════════════════════════════════════════════
    // T-004 Skills 框架：带工具调用的流式聊天
    // ══════════════════════════════════════════════════════════════════

    /// 带 Skills（OpenAI function-calling）的流式聊天
    ///
    /// 与 `chat_stream` 的差异：
    /// - 请求里带 `tools` 字段，AI 可调 search_notes / get_note / list_tags 等
    /// - 支持最多 `MAX_TOOL_ROUNDS` 轮 tool_call → tool_result → 再生成 的循环
    /// - 每次 tool_call 通过 `ai:tool_call` 事件推给前端（含 running / ok / error 状态）
    /// - 最终 assistant 消息的 `skill_calls_json` 字段记录整次对话的所有工具调用
    ///
    /// 设计上刻意不复用 `chat_stream`，因为：
    /// 1. 消息结构不同（需带 tool_calls/tool role 消息）
    /// 2. 流式解析多维护一个 tool_calls 累加器
    /// 3. RAG 被替换为工具（AI 自己调 search_notes）
    ///
    /// 仅支持 OpenAI 兼容协议族（openai / claude / deepseek / zhipu）。
    /// Ollama 先不支持——各模型对 function calling streaming 支持差异大，放 v2 再补。
    pub async fn chat_stream_with_skills(
        app: AppHandle,
        db: &Database,
        conversation_id: i64,
        user_message: &str,
        cancel_rx: watch::Receiver<bool>,
    ) -> Result<(), AppError> {
        // 最多 3 轮"AI 调工具"，外加 1 轮"finalization"（不带 tools schema，强制最终答复）。
        // 所以 `for round in 0..=MAX_TOOL_ROUNDS` 实际跑 4 次，最后一次 round=3 时
        // `allow_tools=false`。这种结构能防死循环，但需要小心 finalization 轮里模型
        // 可能输出"伪工具调用文本"（详见 strip_pseudo_tool_calls 的注释）。
        const MAX_TOOL_ROUNDS: usize = 3;

        // 1. 取会话使用的模型
        let conv_model_id = {
            let conn_guard = db.conn_lock()?;
            let model_id: i64 = conn_guard.query_row(
                "SELECT model_id FROM ai_conversations WHERE id = ?1",
                [conversation_id],
                |row| row.get(0),
            )?;
            model_id
        };
        let model = db.get_ai_model(conv_model_id)?;

        // T-012: Skills 仅在非 ollama 时启用；其他 provider 都按 OpenAI 兼容协议处理
        // （含 LM Studio / 自定义 baseUrl —— 用户得自己保证模型支持 tool_calls）
        if model.provider == "ollama" {
            return Err(AppError::Custom(
                "Skills 功能暂不支持 Ollama 协议，请切换到 OpenAI 兼容模型（含本地 LM Studio）。"
                    .into(),
            ));
        }

        // 2. 保存用户消息
        let user_msg = db.add_ai_message(conversation_id, "user", user_message, None)?;
        db.touch_ai_conversation(conversation_id)?;

        // 3. 构建消息数组（带 skills 指引的 system prompt + 历史）
        let history = db.list_ai_messages(conversation_id)?;
        let system_prompt = "你是一个知识库助手。你可以调用以下工具辅助回答：\n\
            - search_notes(query, limit?)：搜笔记\n\
            - get_note(id)：读单篇笔记全文\n\
            - list_tags()：列所有标签\n\
            - find_related(note_id)：找相关笔记（反向链接）\n\
            - get_today_tasks()：今日待办\n\
            \n原则：\n\
            1. 回答涉及用户笔记内容时，先用 search_notes 搜索，再按需 get_note 读全文；不要凭空编造。\n\
            2. 工具返回的内容可能有省略（标记 `…（已截断）`），必要时再次调用获取更多。\n\
            3. 最终给用户的回答用中文，简洁准确。";

        let mut messages: Vec<Value> = vec![json!({
            "role": "system",
            "content": system_prompt,
        })];
        // 注意：历史里已经包含了刚保存的 user_msg
        for msg in &history {
            messages.push(json!({
                "role": msg.role,
                "content": msg.content,
            }));
        }
        // 兜底：如果 list 因某种原因没拿到新写入的 user_msg，补上
        if !messages.iter().rev().any(|m| {
            m["role"].as_str() == Some("user") && m["content"].as_str() == Some(user_message)
        }) {
            messages.push(json!({ "role": "user", "content": user_message }));
        }

        // 4. tool-use 循环
        let mut all_skill_calls: Vec<SkillCall> = Vec::new();
        let mut final_content = String::new();
        let tool_schemas = skills::tool_schemas();

        for round in 0..=MAX_TOOL_ROUNDS {
            // 最后一轮不给 tools，强制 AI 给出最终答复（防死循环）
            let allow_tools = round < MAX_TOOL_ROUNDS;

            // finalization 轮：临时往 messages 里加一条 system 提示，劝模型不要继续模仿
            // 工具调用语法（前几轮的 tool_calls 历史会让模型有"再调一次"的惯性）。
            // 用本地 Cow 避免污染主 messages 数组——下一轮请求又得用原始版。
            let req_messages: std::borrow::Cow<'_, [Value]> = if allow_tools {
                std::borrow::Cow::Borrowed(&messages[..])
            } else {
                let mut m = messages.clone();
                m.push(json!({
                    "role": "system",
                    "content": "工具调用次数已达上限，工具不再可用。请基于你已经从工具拿到的信息，\
                                直接给出最终中文答复。\
                                绝对不要再输出 <tool_call>、<tool_use>、```tool_call、\
                                functions.xxx(...) 等任何形式的工具调用语法或代码块；\
                                如果信息不足以回答，明确告诉用户笔记里没有相关内容。"
                }));
                std::borrow::Cow::Owned(m)
            };

            let (content, tool_calls) = Self::stream_openai_with_tools(
                &app,
                &model,
                req_messages.as_ref(),
                if allow_tools { &tool_schemas } else { &[] },
                cancel_rx.clone(),
            )
            .await;

            let (content, tool_calls) = match content {
                Ok(c) => (c, tool_calls.unwrap_or_default()),
                Err(e) => {
                    let _ = db.delete_ai_message(user_msg.id);
                    return Err(e);
                }
            };

            // 取消信号：上面 stream 函数已经 emit ai:done "cancelled"，直接返回
            if *cancel_rx.borrow() {
                // 不删用户消息（用户想保留这条），直接结束
                return Ok(());
            }

            if tool_calls.is_empty() {
                // 模型给出最终答复——剥掉伪工具调用残文（仅 finalization 轮容易触发，
                // 其他轮模型本就该走 tool_calls 通道；剥一下零成本，多一道兜底）
                final_content = strip_pseudo_tool_calls(&content);
                break;
            }

            // 有工具调用：追加 assistant tool_calls 消息 + 各 tool 结果
            messages.push(json!({
                "role": "assistant",
                "content": if content.is_empty() { Value::Null } else { Value::String(content) },
                "tool_calls": tool_calls.iter().map(|tc| json!({
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.name,
                        "arguments": tc.args_json,
                    }
                })).collect::<Vec<_>>(),
            }));

            for tc in &tool_calls {
                // 通知前端"正在调用"
                let _ = app.emit(
                    "ai:tool_call",
                    json!({
                        "id": tc.id,
                        "name": tc.name,
                        "argsJson": tc.args_json,
                        "result": "",
                        "status": "running",
                    }),
                );

                // 执行
                let (result_text, status) = match skills::dispatch(db, &tc.name, &tc.args_json) {
                    Ok(r) => (r, "ok"),
                    Err(e) => (format!("ERROR: {}", e), "error"),
                };

                let sc = SkillCall {
                    id: tc.id.clone(),
                    name: tc.name.clone(),
                    args_json: tc.args_json.clone(),
                    result: result_text.clone(),
                    status: status.to_string(),
                };
                let _ = app.emit("ai:tool_call", &sc);
                all_skill_calls.push(sc);

                // 回注给模型
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result_text,
                }));
            }
            // 继续下一轮请求
        }

        // 5. 保存 assistant 最终消息
        let skill_calls_json = if all_skill_calls.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&all_skill_calls).unwrap_or_default())
        };
        db.add_ai_message_full(
            conversation_id,
            "assistant",
            &final_content,
            None,
            skill_calls_json.as_deref(),
        )?;
        db.touch_ai_conversation(conversation_id)?;

        // 6. 自动生成会话标题（沿用 chat_stream 的策略）
        let auto_title = derive_conversation_title(user_message);
        if !auto_title.is_empty() {
            let _ = db.rename_ai_conversation_if_default(conversation_id, &auto_title);
        }

        let _ = app.emit("ai:done", conversation_id);
        Ok(())
    }

    /// OpenAI 兼容流式请求（支持 tool_calls delta 累加）
    ///
    /// 返回 `(content, tool_calls)`：
    /// - `content` 累加所有 delta.content
    /// - `tool_calls` 按 `index` 聚合每个工具调用（OpenAI 流式 tool_calls 按分片返回
    ///   name/arguments，必须按 index 累加到完整 JSON 才能 dispatch）
    ///
    /// 被取消时：发 `ai:done` 带 "cancelled" 并返回当前累积内容（tool_calls 清空）。
    async fn stream_openai_with_tools(
        app: &AppHandle,
        model: &AiModel,
        messages: &[Value],
        tools: &[Value],
        mut cancel_rx: watch::Receiver<bool>,
    ) -> (Result<String, AppError>, Option<Vec<ToolCallAccum>>) {
        let client = crate::services::http_client::shared();
        let url = build_openai_chat_url(&model.api_url);

        let mut request_body = json!({
            "model": model.model_id,
            "messages": messages,
            "stream": true,
        });
        if !tools.is_empty() {
            request_body["tools"] = json!(tools);
            request_body["tool_choice"] = json!("auto");
        }

        let mut request = client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&request_body);
        if let Some(key) = &model.api_key {
            if !key.is_empty() {
                request = request.header("Authorization", format!("Bearer {}", key));
            }
        }

        let response = match request.send().await {
            Ok(r) => r,
            Err(e) => {
                return (
                    Err(AppError::Custom(format!("API 请求失败: {}", e))),
                    None,
                );
            }
        };
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return (
                Err(AppError::Custom(format_openai_api_error(status, &body))),
                None,
            );
        }

        let mut stream = response.bytes_stream();
        let mut content = String::new();
        // BTreeMap 按 index 有序，保证 dispatch 时工具顺序稳定
        let mut tool_accum: std::collections::BTreeMap<u64, ToolCallAccum> =
            std::collections::BTreeMap::new();
        let mut buffer = String::new();

        loop {
            tokio::select! {
                chunk = stream.next() => {
                    match chunk {
                        Some(Ok(bytes)) => {
                            buffer.push_str(&String::from_utf8_lossy(&bytes));
                            while let Some(pos) = buffer.find('\n') {
                                let line = buffer[..pos].trim().to_string();
                                buffer = buffer[pos + 1..].to_string();

                                if line.is_empty() || line == "data: [DONE]" { continue; }
                                if let Some(json_str) = line.strip_prefix("data: ") {
                                    let data: Value = match serde_json::from_str(json_str) {
                                        Ok(v) => v,
                                        Err(_) => continue,
                                    };
                                    let delta = &data["choices"][0]["delta"];
                                    // 文本 token
                                    if let Some(c) = delta["content"].as_str() {
                                        content.push_str(c);
                                        let _ = app.emit("ai:token", c);
                                    }
                                    // tool_calls 分片
                                    if let Some(tcs) = delta["tool_calls"].as_array() {
                                        for tc in tcs {
                                            let idx = tc["index"].as_u64().unwrap_or(0);
                                            let entry = tool_accum.entry(idx)
                                                .or_insert_with(ToolCallAccum::default);
                                            if let Some(id) = tc["id"].as_str() {
                                                if !id.is_empty() { entry.id = id.to_string(); }
                                            }
                                            if let Some(name) = tc["function"]["name"].as_str() {
                                                entry.name.push_str(name);
                                            }
                                            if let Some(args) = tc["function"]["arguments"].as_str() {
                                                entry.args_json.push_str(args);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        Some(Err(e)) => {
                            let _ = app.emit("ai:error", e.to_string());
                            return (Err(AppError::Custom(format!("流读取错误: {}", e))), None);
                        }
                        None => break,
                    }
                }
                _ = cancel_rx.changed() => {
                    if *cancel_rx.borrow() {
                        let _ = app.emit("ai:done", "cancelled");
                        return (Ok(content), Some(Vec::new()));
                    }
                }
            }
        }

        // 收尾：过滤掉 id / name 为空的条目（极端情况下 API 返回不完整）
        let tool_calls: Vec<ToolCallAccum> = tool_accum
            .into_values()
            .filter(|t| !t.id.is_empty() && !t.name.is_empty())
            .collect();

        (Ok(content), Some(tool_calls))
    }
}

/// 流式解析过程中累加的一次工具调用（OpenAI 分片返回格式）
#[derive(Default, Debug, Clone)]
struct ToolCallAccum {
    id: String,
    name: String,
    /// 累加后的 arguments JSON 字符串（尚未解析）
    args_json: String,
}

impl AiService {
    // ══════════════════════════════════════════════════════════════════
    // T-005 AI 规划今日待办
    // ══════════════════════════════════════════════════════════════════

    /// 聚合上下文（昨日/今日 daily 笔记 + 未完成任务 + 今日已有任务）→ 喂 AI → 解析 JSON
    ///
    /// 故意走非流式：`response_format: json_object` 需要完整响应 + 前端不需要 token-by-token 体验。
    /// 返回 `PlanTodayResponse`，前端把 `tasks` 展示为可编辑清单，用户确认后批量写库。
    pub async fn plan_today(
        db: &Database,
        req: PlanTodayRequest,
    ) -> Result<PlanTodayResponse, AppError> {
        let model = db.get_default_ai_model()?;
        // T-012: 仅 Ollama 不支持（本地 generate API 不返回 JSON 模式）；其他都按 OpenAI 兼容
        if model.provider == "ollama" {
            return Err(AppError::Custom(
                "AI 规划功能暂不支持 Ollama 协议，请切换到 OpenAI 兼容模型（含本地 LM Studio）。"
                    .into(),
            ));
        }

        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let yesterday = (chrono::Local::now() - chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();

        // ─── 聚合上下文 ────────────────────────
        let daily_today = db.get_daily(&today)?;
        let daily_yesterday = db.get_daily(&yesterday)?;

        // 未完成任务；按需过滤出"昨日未完成 + 过期"
        let unfinished = db.list_tasks(TaskQuery {
            status: Some(0),
            keyword: None,
            priority: None,
            category_id: None,
            uncategorized: None,
        })?;

        let carry_over: Vec<_> = if req.include_yesterday_unfinished {
            unfinished
                .iter()
                .filter(|t| match &t.due_date {
                    Some(d) => d.as_str() < today.as_str(), // 过期
                    None => false,
                })
                .cloned()
                .collect()
        } else {
            Vec::new()
        };

        let today_existing: Vec<_> = unfinished
            .iter()
            .filter(|t| matches!(&t.due_date, Some(d) if d.starts_with(&today)))
            .cloned()
            .collect();

        // ─── 构造 prompt ────────────────────────
        let mut user_sections = Vec::<String>::new();
        if let Some(goal) = req.goal.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            user_sections.push(format!("## 今日目标\n{}", goal));
        }
        if let Some(n) = &daily_yesterday {
            let plain = strip_html(&n.content);
            let snippet: String = plain.chars().take(600).collect();
            if !snippet.trim().is_empty() {
                user_sections.push(format!("## 昨日笔记摘要\n{}", snippet));
            }
        }
        if let Some(n) = &daily_today {
            let plain = strip_html(&n.content);
            let snippet: String = plain.chars().take(600).collect();
            if !snippet.trim().is_empty() {
                user_sections.push(format!("## 今日笔记已有内容\n{}", snippet));
            }
        }
        if !carry_over.is_empty() {
            let lines: Vec<String> = carry_over
                .iter()
                .map(|t| {
                    format!(
                        "- 「{}」(过期于 {})",
                        t.title,
                        t.due_date.clone().unwrap_or_default()
                    )
                })
                .collect();
            user_sections.push(format!(
                "## 需要顺延的过期未完成任务（{} 条）\n{}",
                carry_over.len(),
                lines.join("\n")
            ));
        }
        if !today_existing.is_empty() {
            let lines: Vec<String> = today_existing
                .iter()
                .map(|t| format!("- 「{}」", t.title))
                .collect();
            user_sections.push(format!(
                "## 今天已有的任务（请不要重复建议）\n{}",
                lines.join("\n")
            ));
        }
        if user_sections.is_empty() {
            user_sections.push(
                "（无任何上下文；请根据常规工作/学习场景合理安排今天的 3~7 条待办）".to_string(),
            );
        }

        let user_content = format!("请为我规划今天（{}）的待办。\n\n{}", today, user_sections.join("\n\n"));

        let system_prompt = format!(
            "你是一个日程规划助手，使用艾森豪威尔四象限法则做决策。\
             根据用户的笔记和已有任务，给出 3~7 条今天要做的具体待办。\
             严格返回 JSON 对象，不要 markdown 代码块，不要任何额外文字，格式如下：\n\
             {{\n  \
             \"tasks\": [\n    \
             {{\"title\": \"任务标题（简洁可执行）\", \"priority\": 0|1|2, \"important\": true|false, \"dueDate\": \"{}\", \"remindBefore\": null|0|15|30|60|180|1440|10080, \"reason\": \"为什么建议做这条\"}}\n  \
             ],\n  \
             \"summary\": \"今日总体思路（一句话）\"\n\
             }}\n\n\
             ⚠️ 关键：priority 和 important 是两个独立维度，必须分别判断！\n\
             - priority（紧急度）：0=紧急（今天/明天必须完成，逾期有明显代价） / 1=一般（本周内即可） / 2=不急（无明确截止）\n\
             - important（重要性）：true=对长期目标/健康/关键产出有显著贡献；false=琐事、被动响应、社交礼节\n\n\
             两者组合成四象限，分布建议：\n\
             - Q1 紧急+重要 (priority=0, important=true)：今日必做，控制在 1-2 条，太多说明在救火\n\
             - Q2 不紧急+重要 (priority=1或2, important=true)：长期受益，每天至少 1-2 条（学习、锻炼、复盘）\n\
             - Q3 紧急+不重要 (priority=0, important=false)：能委派就委派，否则快速处理\n\
             - Q4 不紧急+不重要 (priority=2, important=false)：尽量少安排，能删则删\n\n\
             ⏰ remindBefore 提醒策略（单位分钟，按象限智能选择）：\n\
             - Q1 紧急重要：0（准时提醒）或 15（提前 15 分钟）\n\
             - Q2 重要不紧急：60（提前 1 小时）或 1440（提前 1 天）\n\
             - Q3 紧急不重要：0 或 15\n\
             - Q4 不重要不紧急：null（不打扰）\n\
             - 仪式感强 / 容易被遗忘的任务（如健身、读书）→ 1440\n\
             可选值固定：null / 0 / 15 / 30 / 60 / 180 / 1440 / 10080；其他值视为 null。\n\n\
             其他规则：\n\
             1. dueDate 都填成 {}\n\
             2. title 必须是可执行动作（如『完成 xx』、『写 xx』），不要模糊项如『放松一下』\n\
             3. reason 一句话点明象限归属（例：『Q2 长期健康投资』『Q1 今日截稿』）\n\
             4. 不要重复用户『已有任务』列表里的内容\n\
             5. 用中文。\n\
             6. 🔴 JSON 字符串字段（title / reason / summary）中若需要引用名称或概念，一律使用中文书名号「」或中文单引号 『』，严禁使用英文双引号 \" 或 \\\"（否则会破坏 JSON 结构导致解析失败）。",
            today, today
        );

        let messages = vec![
            json!({ "role": "system", "content": system_prompt }),
            json!({ "role": "user", "content": user_content }),
        ];

        // ─── 发请求 ────────────────────────────
        let client = crate::services::http_client::shared();
        let url = build_openai_chat_url(&model.api_url);
        let mut req_body = json!({
            "model": model.model_id,
            "messages": messages,
            "stream": false,
            "response_format": { "type": "json_object" },
            "max_tokens": 2000,
        });
        // Claude 兼容代理有些不支持 response_format，去掉该字段以防报错
        if model.provider == "claude" {
            req_body.as_object_mut().and_then(|m| m.remove("response_format"));
        }

        let mut builder = client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&req_body);
        if let Some(key) = &model.api_key {
            if !key.is_empty() {
                builder = builder.header("Authorization", format!("Bearer {}", key));
            }
        }
        let response = builder
            .send()
            .await
            .map_err(|e| AppError::Custom(format!("API 请求失败: {}", e)))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Custom(format_openai_api_error(status, &body)));
        }

        let resp_json: Value = response
            .json()
            .await
            .map_err(|e| AppError::Custom(format!("解析响应失败: {}", e)))?;
        let content = resp_json["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| AppError::Custom("AI 返回格式异常：缺少 choices[0].message.content".to_string()))?;

        parse_plan_today_response(content).ok_or_else(|| {
            AppError::Custom(format!(
                "AI 返回的 JSON 无法解析。原始响应：\n{}",
                content.chars().take(400).collect::<String>()
            ))
        })
    }

    // ══════════════════════════════════════════════════════════════════
    // T-006 AI 写笔记并归档
    // ══════════════════════════════════════════════════════════════════

    /// AI 生成一篇 Markdown 笔记 + 建议归档目录
    ///
    /// 输入：主题 / 参考材料 / 目标长度 + 当前所有目录的扁平化路径列表
    /// 输出：`{title, content, folderPath, reason}`（未写入 DB，由前端弹 Modal 让用户确认）
    ///
    /// 设计要点：
    /// 1. 只把**目录路径字符串**喂给 AI，不喂笔记内容 → 避免大 prompt + 信息泄露
    /// 2. 非流式 + `response_format: json_object`（Claude 兼容代理会自动去掉该字段）
    /// 3. 两轮兜底解析（原始 / 剥 markdown ``` ）
    ///
    /// 调用方不在这里写库；save 逻辑由前端 `folderApi` + `noteApi` 在 Modal 确认时触发。
    pub async fn draft_note(
        db: &Database,
        req: DraftNoteRequest,
    ) -> Result<DraftNoteResponse, AppError> {
        let topic = req.topic.trim();
        if topic.is_empty() {
            return Err(AppError::Custom("主题不能为空".to_string()));
        }

        let model = db.get_default_ai_model()?;
        // T-012: 仅 Ollama 不支持（无 JSON 模式）；其他都按 OpenAI 兼容协议
        if model.provider == "ollama" {
            return Err(AppError::Custom(
                "AI 写笔记暂不支持 Ollama 协议，请切换到 OpenAI 兼容模型（含本地 LM Studio）。"
                    .into(),
            ));
        }

        // 扁平化现有目录树为 "父/子/孙" 路径列表，供 AI 参考选择归档
        let tree = db.list_folders_tree()?;
        let mut flat_paths: Vec<String> = Vec::new();
        collect_folder_paths(&tree, "", &mut flat_paths);

        // 构造 prompt
        let paths_hint = if flat_paths.is_empty() {
            "（当前还没有任何文件夹，建议创建合适的新目录）".to_string()
        } else {
            flat_paths
                .iter()
                .map(|p| format!("- {}", p))
                .collect::<Vec<_>>()
                .join("\n")
        };
        let reference_section = req
            .reference
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| format!("\n\n## 参考材料\n{}", s))
            .unwrap_or_default();

        let user_content = format!(
            "请帮我写一篇关于【{}】的 Markdown 笔记，目标长度 {}。{}\n\n\
             ## 现有目录（供归档参考）\n{}\n\n\
             请严格以 JSON 对象返回（不要 markdown 代码块、不要解释），格式：\n\
             {{\n  \
             \"title\": \"笔记标题（简洁、能检索）\",\n  \
             \"content\": \"Markdown 正文（不要带外层 H1，因为标题已单独存）\",\n  \
             \"folderPath\": \"建议的归档路径，如 工作/周报；可填新目录；空串=根目录\",\n  \
             \"reason\": \"为什么归到这个目录（一句话）\"\n\
             }}",
            topic,
            req.target_length.word_hint(),
            reference_section,
            paths_hint,
        );

        let system_prompt =
            "你是一个笔记助手。根据用户提供的主题和参考材料，写一篇结构清晰的 Markdown 笔记，\
             并根据【现有目录】列表建议最合适的归档路径。\n\
             原则：\n\
             1. 正文用 Markdown；用合适的小标题、列表、代码块\n\
             2. 不要在正文开头放重复的 H1 标题（title 字段已单独给出）\n\
             3. folderPath 优先复用【现有目录】里已有的路径；只有找不到合适目录时才建议新路径\n\
             4. 用中文写作，除非主题本身是外语";

        let messages = vec![
            serde_json::json!({ "role": "system", "content": system_prompt }),
            serde_json::json!({ "role": "user", "content": user_content }),
        ];

        let client = crate::services::http_client::shared();
        let url = build_openai_chat_url(&model.api_url);
        let mut req_body = serde_json::json!({
            "model": model.model_id,
            "messages": messages,
            "stream": false,
            "response_format": { "type": "json_object" },
        });
        if model.provider == "claude" {
            req_body
                .as_object_mut()
                .and_then(|m| m.remove("response_format"));
        }

        let mut builder = client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&req_body);
        if let Some(key) = &model.api_key {
            if !key.is_empty() {
                builder = builder.header("Authorization", format!("Bearer {}", key));
            }
        }
        let response = builder
            .send()
            .await
            .map_err(|e| AppError::Custom(format!("API 请求失败: {}", e)))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Custom(format_openai_api_error(status, &body)));
        }

        let resp_json: Value = response
            .json()
            .await
            .map_err(|e| AppError::Custom(format!("解析响应失败: {}", e)))?;
        let content = resp_json["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| {
                AppError::Custom(
                    "AI 返回格式异常：缺少 choices[0].message.content".to_string(),
                )
            })?;

        parse_draft_note_response(content).ok_or_else(|| {
            AppError::Custom(format!(
                "AI 返回的 JSON 无法解析。原始响应：\n{}",
                content.chars().take(400).collect::<String>()
            ))
        })
    }

    // ══════════════════════════════════════════════════════════════════
    // 目标驱动 AI 智能规划（plan_from_goal）
    // ══════════════════════════════════════════════════════════════════

    /// 根据用户目标 + 计划周期，AI 一次性产出多条结构化待办 + 阶段里程碑。
    ///
    /// 与 `plan_today` 的区别：plan_today 只看今天 3~7 条且依赖笔记上下文；
    /// 本方法是"开新计划"，无历史依赖，按 horizon_days 跨度铺到未来。
    ///
    /// 落库由前端在预览页勾选后调 `taskApi.create`，**必须**把响应里的
    /// `batch_id` 透传到每条任务的 `source_batch_id` 字段，方便整批撤销。
    pub async fn plan_from_goal(
        db: &Database,
        req: PlanFromGoalRequest,
    ) -> Result<PlanFromGoalResponse, AppError> {
        let goal = req.goal.trim();
        if goal.is_empty() {
            return Err(AppError::InvalidInput("目标不能为空".into()));
        }
        if goal.chars().count() < 4 {
            return Err(AppError::InvalidInput(
                "目标太短了（至少 4 个字），AI 难以理解你想做什么".into(),
            ));
        }
        let horizon = req.horizon_days.clamp(1, 365);

        let model = db.get_default_ai_model()?;
        if model.provider == "ollama" {
            return Err(AppError::Custom(
                "AI 智能规划暂不支持 Ollama 协议，请切换到 OpenAI 兼容模型（含本地 LM Studio）。"
                    .into(),
            ));
        }

        // 起始日期：用户传入或默认今天
        let start_date = req
            .start_date
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string());
        let end_date = chrono::NaiveDate::parse_from_str(&start_date, "%Y-%m-%d")
            .ok()
            .map(|d| d + chrono::Duration::days((horizon as i64) - 1))
            .map(|d| d.format("%Y-%m-%d").to_string())
            .unwrap_or_else(|| start_date.clone());

        let profile_section = req
            .profile_hint
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| format!("\n\n## 用户补充信息\n{}", s))
            .unwrap_or_default();

        let user_content = format!(
            "请帮我用艾森豪威尔四象限法则规划一个 {} 天的计划。\n\n\
             ## 我的目标\n{}\n\n\
             ## 计划周期\n{} ~ {}（共 {} 天）{}\n\n\
             请按下方 JSON 格式严格输出（不要 markdown 代码块、不要任何解释）。",
            horizon, goal, start_date, end_date, horizon, profile_section,
        );

        let system_prompt = format!(
            "你是一个用艾森豪威尔四象限法则规划长期目标的助手。\
             根据用户给的目标和周期，把目标拆成可执行的待办（10~30 条）\
             + 阶段里程碑（2~6 条）。\n\n\
             严格返回 JSON 对象，不要 markdown 代码块、不要任何额外文字，格式如下：\n\
             {{\n  \
             \"tasks\": [\n    \
             {{\"title\": \"任务标题（具体可执行）\", \"priority\": 0|1|2, \"important\": true|false, \"dueDate\": \"YYYY-MM-DD\", \"remindBefore\": null|0|15|30|60|180|1440|10080, \"reason\": \"为什么做这条 + Q几\"}}\n  \
             ],\n  \
             \"milestones\": [\n    \
             {{\"title\": \"阶段标题（如『第1月：身体激活』）\", \"dateRange\": \"5月1日-5月31日\", \"description\": \"该阶段重点\"}}\n  \
             ],\n  \
             \"summary\": \"整体规划思路（1~3 句）\"\n\
             }}\n\n\
             ⚠️ 关键：priority 和 important 是两个独立维度！\n\
             - priority（紧急度）：0=紧急（短期内必须完成）/ 1=一般 / 2=不急\n\
             - important（重要性）：true=对长期目标显著贡献；false=琐事或被动响应\n\n\
             组合成四象限：\n\
             - Q1 紧急+重要 (0,true)：关键 deadline / 关键节点\n\
             - Q2 不紧急+重要 (1或2,true)：长期投入、积累型任务，应占主体（>60%）\n\
             - Q3 紧急+不重要 (0,false)：处理一下就行的琐事\n\
             - Q4 不紧急+不重要 (1或2,false)：能不做就不做\n\n\
             ⏰ remindBefore 提醒策略（分钟）：\n\
             - Q1 紧急重要：0（准时）或 15\n\
             - Q2 重要不紧急：60 / 1440（提前 1 天）/ 10080（提前 1 周，适合习惯类）\n\
             - Q3 紧急不重要：0 或 15\n\
             - Q4：null（不打扰）\n\
             - 仪式感任务（健身、学习打卡）→ 1440 让用户提前一天看到；deadline 类→ 0 准时提醒\n\
             可选值固定：null / 0 / 15 / 30 / 60 / 180 / 1440 / 10080。\n\n\
             其他规则：\n\
             1. dueDate 必须落在 {} ~ {} 范围内，按计划进度合理铺开\n\
             2. 任务粒度要可执行，避免『加油』『坚持』之类不可量化的词\n\
             3. milestones 是阶段级总结，颗粒度比 tasks 大\n\
             4. 全部用中文。\n\
             5. 🔴 JSON 字符串字段中若需要引用名称，一律使用中文书名号「」或单引号 『』，严禁使用英文双引号 \"（否则会破坏 JSON 结构）。",
            start_date, end_date
        );

        let messages = vec![
            json!({ "role": "system", "content": system_prompt }),
            json!({ "role": "user", "content": user_content }),
        ];

        let client = crate::services::http_client::shared();
        let url = build_openai_chat_url(&model.api_url);
        let mut req_body = json!({
            "model": model.model_id,
            "messages": messages,
            "stream": false,
            "response_format": { "type": "json_object" },
            "max_tokens": 4000,
        });
        if model.provider == "claude" {
            req_body
                .as_object_mut()
                .and_then(|m| m.remove("response_format"));
        }

        let mut builder = client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&req_body);
        if let Some(key) = &model.api_key {
            if !key.is_empty() {
                builder = builder.header("Authorization", format!("Bearer {}", key));
            }
        }
        let response = builder
            .send()
            .await
            .map_err(|e| AppError::Custom(format!("API 请求失败: {}", e)))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Custom(format_openai_api_error(status, &body)));
        }

        let resp_json: Value = response
            .json()
            .await
            .map_err(|e| AppError::Custom(format!("解析响应失败: {}", e)))?;
        let content = resp_json["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| {
                AppError::Custom(
                    "AI 返回格式异常：缺少 choices[0].message.content".to_string(),
                )
            })?;

        let mut parsed = parse_plan_from_goal_response(content).ok_or_else(|| {
            AppError::Custom(format!(
                "AI 返回的 JSON 无法解析。原始响应：\n{}",
                content.chars().take(400).collect::<String>()
            ))
        })?;

        // 服务端生成 batch_id（前端落库时回填到每条任务的 source_batch_id）
        parsed.batch_id = generate_batch_id();
        // 兜底：AI 偶尔会跳过这两个字段
        if parsed.tasks.is_empty() {
            return Err(AppError::Custom(
                "AI 没有生成任何待办，请补充更多目标细节后重试".into(),
            ));
        }
        // 提示编译器引用 TaskSuggestion / MilestoneDraft（被反序列化使用）
        let _ = std::mem::size_of::<TaskSuggestion>();
        let _ = std::mem::size_of::<MilestoneDraft>();

        Ok(parsed)
    }

    // ══════════════════════════════════════════════════════════════════
    // Excel 文件 → AI 智能规划（plan_from_excel）
    // ══════════════════════════════════════════════════════════════════

    /// 用户上传一个 Excel/ODS 文件 → calamine 解析为 markdown 多 Sheet 表 → 喂 AI 拆四象限待办。
    ///
    /// 与 `plan_from_goal` 的区别：本方法以 Excel 内容作为主要素材，AI 从中提炼可执行任务，
    /// 而不是从用户的一段文字目标拆分。
    ///
    /// 自动截断策略：
    /// - 单 Sheet > 30k 字符 → 取头 40 行 + 尾 10 行
    /// - 总长度 > 60k 字符 → 对最大的几个 Sheet 进一步截断
    /// - 截断信息通过 `warnings` 字段返回给前端，UI 友好提示
    pub async fn plan_from_excel(
        db: &Database,
        req: PlanFromExcelRequest,
    ) -> Result<PlanFromGoalResponse, AppError> {
        let file_path = req.file_path.trim();
        if file_path.is_empty() {
            return Err(AppError::InvalidInput("Excel 文件路径不能为空".into()));
        }
        let path = std::path::Path::new(file_path);
        if !path.exists() {
            return Err(AppError::Custom(format!("文件不存在: {}", file_path)));
        }
        let file_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("Excel")
            .to_string();

        let model = db.get_default_ai_model()?;
        if model.provider == "ollama" {
            return Err(AppError::Custom(
                "AI 智能规划暂不支持 Ollama 协议，请切换到 OpenAI 兼容模型（含本地 LM Studio）。"
                    .into(),
            ));
        }

        // 解析 Excel → 多 Sheet 快照 + markdown 全文
        let summary = crate::services::excel_parser::read_workbook(file_path)?;

        let horizon = req.horizon_days.clamp(1, 365);
        let start_date = req
            .start_date
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string());
        let end_date = chrono::NaiveDate::parse_from_str(&start_date, "%Y-%m-%d")
            .ok()
            .map(|d| d + chrono::Duration::days((horizon as i64) - 1))
            .map(|d| d.format("%Y-%m-%d").to_string())
            .unwrap_or_else(|| start_date.clone());

        let extra_section = req
            .extra_goal
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| format!("\n\n## 用户额外说明\n{}", s))
            .unwrap_or_default();

        let user_content = format!(
            "请基于以下 Excel 表格内容，按艾森豪威尔四象限法则规划一个 {} 天的可执行计划。\n\n\
             ## 文件\n{}\n\n\
             ## 计划周期\n{} ~ {}（共 {} 天）{}\n\n\
             ## Excel 内容（多 Sheet 拼接的 markdown 表）\n{}\n\n\
             请按下方 JSON 格式严格输出（不要 markdown 代码块、不要任何解释）。",
            horizon, file_name, start_date, end_date, horizon, extra_section, summary.markdown,
        );

        let system_prompt = format!(
            "你是一个用艾森豪威尔四象限法则做规划的助手。\
             用户上传了一个 Excel 文件，里面可能是计划草稿、任务清单、参考资料、时间表等混合内容。\
             你的任务是理解 Excel 内容，把可执行部分提炼为 10~30 条具体待办 + 2~6 个阶段里程碑。\n\n\
             严格返回 JSON 对象，不要 markdown 代码块、不要任何额外文字，格式如下：\n\
             {{\n  \
             \"tasks\": [\n    \
             {{\"title\": \"任务标题（具体可执行）\", \"priority\": 0|1|2, \"important\": true|false, \"dueDate\": \"YYYY-MM-DD\", \"remindBefore\": null|0|15|30|60|180|1440|10080, \"reason\": \"为什么做这条 + Q几\"}}\n  \
             ],\n  \
             \"milestones\": [\n    \
             {{\"title\": \"阶段标题（如『第1月：身体激活』）\", \"dateRange\": \"5月1日-5月31日\", \"description\": \"该阶段重点\"}}\n  \
             ],\n  \
             \"summary\": \"整体规划思路（1~3 句，说明从 Excel 中提炼出了什么主题）\"\n\
             }}\n\n\
             ⚠️ 关键：priority 和 important 是两个独立维度！\n\
             - priority（紧急度）：0=紧急（短期内必须完成）/ 1=一般 / 2=不急\n\
             - important（重要性）：true=对长期目标显著贡献；false=琐事或被动响应\n\n\
             组合成四象限：\n\
             - Q1 紧急+重要 (0,true)：关键 deadline / 关键节点\n\
             - Q2 不紧急+重要 (1或2,true)：长期投入、积累型任务，应占主体（>60%）\n\
             - Q3 紧急+不重要 (0,false)：处理一下就行的琐事\n\
             - Q4 不紧急+不重要 (1或2,false)：能不做就不做\n\n\
             ⏰ remindBefore 提醒策略（分钟）：\n\
             - Q1 紧急重要：0（准时）或 15\n\
             - Q2 重要不紧急：60 / 1440 / 10080（习惯打卡型适合提前 1 周也提醒）\n\
             - Q3 紧急不重要：0 或 15\n\
             - Q4：null（不打扰）\n\
             - 健身 / 学习 / 服药 / 早睡这类容易遗忘的习惯任务 → 1440\n\
             - 一次性 deadline 任务 → 0 准时提醒\n\
             可选值固定：null / 0 / 15 / 30 / 60 / 180 / 1440 / 10080。\n\n\
             重要的提取规则：\n\
             1. dueDate 必须落在 {} ~ {} 范围内，按 Excel 暗示的时间节奏铺开\n\
             2. **不要原样抄录 Excel 行**，要提炼成可执行动作（如『完成 xx』『建立 xx 习惯』）\n\
             3. 如果某些 Sheet 明显是参考资料类型（如『补剂方案』『备餐手册』『动作要点』），不要为每条生成待办，可在 milestones 或 summary 中提及\n\
             4. 如果 Excel 含『启动清单』之类的一次性任务，每条尽量保留\n\
             5. 如果 Excel 含『每日执行表』『时间表』，提炼为具有代表性的几条重复型任务，不要展开成几十条\n\
             6. milestones 是阶段级总结（如月度目标），颗粒度比 tasks 大\n\
             7. 全部用中文。\n\
             8. 🔴 JSON 字符串字段中若需引用名称或概念，一律使用中文书名号「」或单引号 『』，严禁使用英文双引号 \"（否则会破坏 JSON 结构）。",
            start_date, end_date,
        );

        let messages = vec![
            json!({ "role": "system", "content": system_prompt }),
            json!({ "role": "user", "content": user_content }),
        ];

        let client = crate::services::http_client::shared();
        let url = build_openai_chat_url(&model.api_url);
        let mut req_body = json!({
            "model": model.model_id,
            "messages": messages,
            "stream": false,
            "response_format": { "type": "json_object" },
            "max_tokens": 6000,
        });
        if model.provider == "claude" {
            req_body
                .as_object_mut()
                .and_then(|m| m.remove("response_format"));
        }

        let mut builder = client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&req_body);
        if let Some(key) = &model.api_key {
            if !key.is_empty() {
                builder = builder.header("Authorization", format!("Bearer {}", key));
            }
        }
        let response = builder
            .send()
            .await
            .map_err(|e| AppError::Custom(format!("API 请求失败: {}", e)))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Custom(format_openai_api_error(status, &body)));
        }

        let resp_json: Value = response
            .json()
            .await
            .map_err(|e| AppError::Custom(format!("解析响应失败: {}", e)))?;
        let content = resp_json["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| {
                AppError::Custom(
                    "AI 返回格式异常：缺少 choices[0].message.content".to_string(),
                )
            })?;

        let mut parsed = parse_plan_from_goal_response(content).ok_or_else(|| {
            AppError::Custom(format!(
                "AI 返回的 JSON 无法解析。原始响应：\n{}",
                content.chars().take(400).collect::<String>()
            ))
        })?;

        parsed.batch_id = generate_batch_id();
        if parsed.tasks.is_empty() {
            return Err(AppError::Custom(
                "AI 没有从 Excel 中提取出任何待办，可能内容太散；建议在『额外说明』里告诉 AI 你想从 Excel 中拿什么后重试".into(),
            ));
        }

        // 把 Excel 解析过程的提示信息透传给前端
        parsed.warnings = build_excel_warnings(&summary, &file_name);

        Ok(parsed)
    }
}

/// 根据 Excel 解析结果生成给前端的友好警告
fn build_excel_warnings(
    summary: &crate::services::excel_parser::ExcelSummary,
    file_name: &str,
) -> Vec<String> {
    let mut warnings = Vec::new();
    if !summary.truncated_sheet_names.is_empty() {
        warnings.push(format!(
            "Excel「{}」共 {} 行 / {} 个 Sheet，因体积较大，以下 Sheet 已截取代表性内容：{}",
            file_name,
            summary.total_rows,
            summary.sheets.len(),
            summary.truncated_sheet_names.join("、"),
        ));
    } else if summary.total_rows > 500 {
        warnings.push(format!(
            "Excel「{}」共 {} 行 / {} 个 Sheet，AI 处理可能稍慢，请耐心等待。",
            file_name,
            summary.total_rows,
            summary.sheets.len(),
        ));
    }
    warnings
}

/// 递归扁平化 Folder 树为 "父/子/孙" 路径字符串
fn collect_folder_paths(tree: &[Folder], prefix: &str, out: &mut Vec<String>) {
    for f in tree {
        let path = if prefix.is_empty() {
            f.name.clone()
        } else {
            format!("{}/{}", prefix, f.name)
        };
        out.push(path.clone());
        if !f.children.is_empty() {
            collect_folder_paths(&f.children, &path, out);
        }
    }
}

/// 解析 AI 返回的 JSON 字符串为 DraftNoteResponse（两轮兜底）
fn parse_draft_note_response(raw: &str) -> Option<DraftNoteResponse> {
    if let Ok(r) = serde_json::from_str::<DraftNoteResponse>(raw.trim()) {
        return Some(r);
    }
    let stripped = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    serde_json::from_str(stripped).ok()
}

#[cfg(test)]
mod draft_note_tests {
    use super::*;

    #[test]
    fn parse_plain_json() {
        // 内容里同时含 "# 和 "## 序列，避开 raw string `"##` 闭合歧义，
        // 这里直接用普通字符串 + 反斜杠转义
        let raw = "{\"title\":\"Rust 学习笔记\",\"content\":\"## 所有权\",\"folderPath\":\"学习/Rust\",\"reason\":\"与 Rust 主题相关\"}";
        let r = parse_draft_note_response(raw).unwrap();
        assert_eq!(r.title, "Rust 学习笔记");
        assert_eq!(r.folder_path, "学习/Rust");
    }

    #[test]
    fn parse_with_fence() {
        let raw = "```json\n{\"title\":\"x\",\"content\":\"c\",\"folderPath\":\"\",\"reason\":null}\n```";
        let r = parse_draft_note_response(raw).unwrap();
        assert_eq!(r.title, "x");
        assert_eq!(r.folder_path, "");
    }

    #[test]
    fn collect_paths_flatten() {
        let f = Folder {
            id: 1,
            name: "工作".to_string(),
            parent_id: None,
            sort_order: 0,
            children: vec![Folder {
                id: 2,
                name: "周报".to_string(),
                parent_id: Some(1),
                sort_order: 0,
                children: vec![],
                note_count: 0,
            }],
            note_count: 0,
        };
        let mut out = Vec::new();
        collect_folder_paths(&[f], "", &mut out);
        assert_eq!(out, vec!["工作".to_string(), "工作/周报".to_string()]);
    }
}

/// 解析 AI 返回的 JSON 字符串为 PlanTodayResponse
///
/// 三轮兜底：
/// 1. 直接 `serde_json::from_str`
/// 2. 失败则剥 markdown 代码块 (```json ... ```) 再 parse
/// 3. 仍失败则截取首个 `{` 到最后一个 `}` 的子串再 parse（兜掉 AI 在 JSON
///    前后夹带解释性文字的情况）
/// 都失败返回 None，调用方把 None 当作"格式异常"错误。
fn parse_plan_today_response(raw: &str) -> Option<PlanTodayResponse> {
    if let Ok(r) = serde_json::from_str::<PlanTodayResponse>(raw.trim()) {
        return Some(r);
    }
    // 剥 ```json ... ```（容忍 ``` 前后的空行）
    let stripped = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    if let Ok(r) = serde_json::from_str::<PlanTodayResponse>(stripped) {
        return Some(r);
    }
    // 截取首个 `{` 到最后一个 `}` 的子串
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str(&raw[start..=end]).ok()
}

#[cfg(test)]
mod plan_today_tests {
    use super::*;

    #[test]
    fn parse_plain_json() {
        let raw = r#"{"tasks":[{"title":"写周报","priority":1,"dueDate":"2026-04-24"}],"summary":"忙"}"#;
        let r = parse_plan_today_response(raw).unwrap();
        assert_eq!(r.tasks.len(), 1);
        assert_eq!(r.tasks[0].title, "写周报");
        assert_eq!(r.summary.as_deref(), Some("忙"));
    }

    #[test]
    fn parse_with_markdown_fence() {
        let raw = "```json\n{\"tasks\":[],\"summary\":\"\"}\n```";
        let r = parse_plan_today_response(raw).unwrap();
        assert!(r.tasks.is_empty());
    }

    #[test]
    fn parse_fails_on_garbage() {
        assert!(parse_plan_today_response("not json").is_none());
    }

    #[test]
    fn parse_with_prefix_and_suffix_text() {
        // AI 有时会在 JSON 前后夹带解释性文字，靠第三轮兜底截取
        let raw = "好的，我来为你规划：\n{\"tasks\":[{\"title\":\"写周报\",\"priority\":1}],\"summary\":\"\"}\n希望对你有帮助";
        let r = parse_plan_today_response(raw).unwrap();
        assert_eq!(r.tasks.len(), 1);
    }
}

/// 解析 AI 返回的 PlanFromGoalResponse JSON（三轮兜底，与 plan_today 同模式）
fn parse_plan_from_goal_response(raw: &str) -> Option<PlanFromGoalResponse> {
    if let Ok(r) = serde_json::from_str::<PlanFromGoalResponse>(raw.trim()) {
        return Some(r);
    }
    let stripped = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    if let Ok(r) = serde_json::from_str::<PlanFromGoalResponse>(stripped) {
        return Some(r);
    }
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str(&raw[start..=end]).ok()
}

/// 生成批次 ID：本地时间戳 + 64 位随机数 hex，避免依赖 uuid crate
fn generate_batch_id() -> String {
    use rand::RngCore;
    let mut rng = rand::thread_rng();
    let n: u64 = rng.next_u64();
    format!(
        "plan_{}_{:016x}",
        chrono::Local::now().format("%Y%m%d%H%M%S"),
        n
    )
}

#[cfg(test)]
mod plan_from_goal_tests {
    use super::*;

    #[test]
    fn parse_plain_json() {
        let raw = r#"{"tasks":[{"title":"每日跑步30分","priority":1,"important":true,"dueDate":"2026-05-01"}],"milestones":[{"title":"第1月","dateRange":"5月1日-5月31日"}],"summary":"先建立习惯"}"#;
        let r = parse_plan_from_goal_response(raw).unwrap();
        assert_eq!(r.tasks.len(), 1);
        assert_eq!(r.milestones.len(), 1);
        assert_eq!(r.batch_id, ""); // 反序列化时为空，由 service 层填充
    }

    #[test]
    fn batch_id_unique_per_call() {
        let a = generate_batch_id();
        let b = generate_batch_id();
        assert_ne!(a, b, "batch_id 必须每次都不同");
        assert!(a.starts_with("plan_"));
    }
}

#[cfg(test)]
mod strip_pseudo_tool_calls_tests {
    use super::strip_pseudo_tool_calls;

    #[test]
    fn strips_xml_tool_call_block() {
        let s = "前文。\n<tool_call>{\"name\":\"search_notes\",\"arguments\":{\"query\":\"x\"}}</tool_call>\n后文。";
        let out = strip_pseudo_tool_calls(s);
        assert!(!out.contains("tool_call"), "XML 标签未被剥除：{}", out);
        assert!(out.contains("前文") && out.contains("后文"));
    }

    #[test]
    fn strips_tool_use_and_function_call_variants() {
        let s = "<tool_use>{\"a\":1}</tool_use><function_call>foo()</function_call>";
        assert_eq!(strip_pseudo_tool_calls(s), "");
    }

    #[test]
    fn strips_fenced_tool_call_codeblock() {
        let s = "Hello\n```tool_call\n{\"name\":\"x\"}\n```\nWorld";
        let out = strip_pseudo_tool_calls(s);
        assert!(!out.contains("```"));
        assert!(out.contains("Hello") && out.contains("World"));
    }

    #[test]
    fn strips_function_call_style_line() {
        let s = "前文\nfunctions.search_notes({\"query\":\"abc\"})\n后文";
        let out = strip_pseudo_tool_calls(s);
        assert!(!out.contains("functions.search_notes"));
        assert!(out.contains("前文") && out.contains("后文"));
    }

    #[test]
    fn keeps_genuine_content_intact() {
        let s = "用户笔记里没有相关内容。建议你检索其他关键词。";
        assert_eq!(strip_pseudo_tool_calls(s), s);
    }

    #[test]
    fn collapses_blank_lines_after_strip() {
        let s = "A\n\n<tool_call>{}</tool_call>\n\n\n\nB";
        let out = strip_pseudo_tool_calls(s);
        // 不应留下连续 3+ 空行
        assert!(!out.contains("\n\n\n"), "残留连续空行：{:?}", out);
        assert!(out.contains('A') && out.contains('B'));
    }
}
