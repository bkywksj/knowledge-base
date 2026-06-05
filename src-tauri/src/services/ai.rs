use futures::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

use crate::database::Database;
use crate::error::AppError;
use crate::models::{
    AiMessage, AiModel, AiModelInput, AiModelTestResult, AttachmentPreview, DraftNoteRequest,
    DraftNoteResponse, ExcelPreview, Folder, MessageAttachment, MilestoneDraft, PdfPreview,
    PlanFromExcelRequest, PlanFromGoalRequest, PlanFromGoalResponse, PlanTodayRequest,
    PlanTodayResponse, SkillCall, TaskQuery, TaskSuggestion, TextPreview,
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
/// Ollama 通常是本地 / 内网 / Tailscale 等地址，走 Clash 等系统 HTTP 代理只会被劫持导致连接失败。
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

/// 把一个 error 链展开成 `msg ← cause ← cause …`，并对每一层尝试 downcast 成 `std::io::Error`，
/// 带上 `kind` 和 `raw_os_error`（Windows 上 10061=连接被拒、10060=超时、10065=无路由…）。
/// 日志里能看到 reqwest 之下 hyper/IO 的真实原因。
fn err_chain(e: &(dyn std::error::Error + 'static)) -> String {
    fn fmt_one(e: &(dyn std::error::Error + 'static)) -> String {
        if let Some(io) = e.downcast_ref::<std::io::Error>() {
            format!("{} [io kind={:?} os_error={:?}]", io, io.kind(), io.raw_os_error())
        } else {
            e.to_string()
        }
    }
    let mut s = fmt_one(e);
    let mut src = e.source();
    while let Some(cause) = src {
        s.push_str(" ← ");
        s.push_str(&fmt_one(cause));
        src = cause.source();
    }
    s
}

/// 把 reqwest 发送错误的关键诊断位（错误链 + is_* 分类）拼成一行，给 `log::warn!` 用。
fn ollama_send_error_diag(e: &reqwest::Error, url: &str) -> String {
    format!(
        "url={} | is_connect={} is_timeout={} is_request={} is_body={} is_builder={} | proxy_env={:?} | chain: {}",
        url,
        e.is_connect(),
        e.is_timeout(),
        e.is_request(),
        e.is_body(),
        e.is_builder(),
        ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"]
            .iter()
            .filter(|k| std::env::var_os(k).is_some())
            .collect::<Vec<_>>(),
        err_chain(e)
    )
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
            url, err_chain(e)
        )
    } else {
        format!("Ollama 请求失败: {}", err_chain(e))
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

/// 发 `ai:token` 事件，payload `{ conversationId, content }`。
///
/// 带上会话 ID 是为了让前端能按会话过滤：会话 A 流式回答还没结束时，用户切到 / 新建
/// 会话 B 发消息，A 后续吐出的 token 不能再贴到 B 的流式气泡上（多会话串台）。
fn emit_ai_token(app: &AppHandle, conversation_id: i64, content: &str) {
    let _ = app.emit(
        "ai:token",
        json!({ "conversationId": conversation_id, "content": content }),
    );
}

/// 发 `ai:error` 事件，payload `{ conversationId, error }`。同 `emit_ai_token`，带会话 ID。
fn emit_ai_error(app: &AppHandle, conversation_id: i64, error: &str) {
    let _ = app.emit(
        "ai:error",
        json!({ "conversationId": conversation_id, "error": error }),
    );
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
fn build_attached_notes_context(db: &Database, note_ids: &[i64], model: &AiModel) -> String {
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
    /// `action` 支持三种格式：
    /// - `prompt:{id}`：从 prompt_templates 表查模板，`{{selection}} {{context}} {{title}}` 占位符
    ///   替换成实际值后作为 user message 发送（推荐路径，v19 起前端 AI 菜单都走这里）
    /// - `custom:{指令}`：前端"自定义提问"路径，把用户即兴写的指令和选区/上下文打包成
    ///   一条 user message 发送（不写回 DB）
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

        // 自定义提问路径：前端把用户即兴指令塞进 action 的 `custom:` 前缀里
        let custom_instruction = action
            .strip_prefix("custom:")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        // 优先按 DB Prompt 走（prompt:id 或 builtin_code），custom 路径跳过 resolve
        let rendered = if custom_instruction.is_some() {
            None
        } else if let Ok(tmpl) = crate::services::prompt::PromptService::resolve(db, action) {
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

        let messages = if let Some(instruction) = custom_instruction {
            // 自定义提问：把指令 + 上下文 + 选区组装成一条 user message
            let mut user_content = format!("【指令】\n{}\n", instruction);
            if !context_snippet.is_empty() {
                user_content.push_str(&format!("\n【上下文（参考）】\n{}\n", context_snippet));
            }
            user_content.push_str(&format!("\n【待处理文本】\n{}", selection_plain));
            vec![
                json!({
                    "role": "system",
                    "content": "你是一个写作助手。请严格按照用户的指令处理文本，只输出最终结果，不要额外解释。使用中文。"
                }),
                json!({ "role": "user", "content": user_content }),
            ]
        } else if let Some(user_content) = rendered {
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
            _ => Self::stream_openai_generic(&write_app, &model, &messages, cancel_rx).await?,
        };

        let _ = app.emit("ai-write:done", "");
        Ok(())
    }

    /// 给定选区 + 上下文，让 AI 提出"最有用的一条处理指令"，供前端"自定义提问"
    /// 的输入框下方做建议气泡。
    ///
    /// 设计：
    /// - 一次性（非流式）请求，10s 超时；失败直接返回 Err 让前端静默隐藏建议区
    /// - 强约束输出：单条祈使句、≤30 字、不带前后缀；后端再做清洗（去引号 / 截断）
    /// - 用 default ai model；没配置默认模型时返回 Err
    pub async fn suggest_prompt(
        db: &Database,
        selected_text: &str,
        context: &str,
    ) -> Result<String, AppError> {
        let model = db.get_default_ai_model()?;
        let selection_plain = strip_html(selected_text);
        let context_plain_full = strip_html(context);
        let context_snippet: String = context_plain_full.chars().take(300).collect();

        // 文本特征：长度、是否含 CJK、是否含代码片段。给模型作为硬约束的输入，
        // 抑制"无脑总结"——这是 LLM 在写作助手任务上的高频默认坍塌。
        let char_count = selection_plain.chars().count();
        let has_cjk = selection_plain
            .chars()
            .any(|c| ('\u{4E00}'..='\u{9FFF}').contains(&c));
        let has_code_signal = selection_plain.contains("```")
            || selection_plain.contains("    ")
            || selection_plain.contains("function ")
            || selection_plain.contains("def ")
            || selection_plain.contains("=> ")
            || selection_plain.contains("const ")
            || selection_plain.contains("import ");
        let language_hint = if has_cjk {
            "中文"
        } else {
            "外文（英/日/其他）"
        };
        let length_band = if char_count < 30 {
            "极短（<30 字）"
        } else if char_count < 120 {
            "短（30–120 字）"
        } else if char_count < 400 {
            "中等（120–400 字）"
        } else {
            "长（>400 字）"
        };

        let user_content = format!(
            "【文本特征】\n语言: {language_hint}\n长度: {length_band}（共 {char_count} 字）\n含代码痕迹: {code}\n\n【待处理文本】\n{selection}{ctx}",
            language_hint = language_hint,
            length_band = length_band,
            char_count = char_count,
            code = if has_code_signal { "是" } else { "否" },
            selection = selection_plain,
            ctx = if context_snippet.is_empty() {
                String::new()
            } else {
                format!("\n\n【周围上下文（仅参考）】\n{}", context_snippet)
            },
        );

        // 重写过的 system prompt：
        // - 用动词谱更广的示例（翻译/改写/扩写/修订/找错字/转表格/列术语/挑反例 …）
        // - 显式禁止"总结/提炼要点/概括"作为默认（除非真的是长篇散文）
        // - 强制先看文本特征再选指令，挑"用户最可能想做下一步"那条
        let messages = vec![
            json!({
                "role": "system",
                "content": "你是贴心的写作助理。用户会发来一段他刚选中的文本和它的特征摘要，你要给出**针对这段具体内容**最可能有用的一条处理指令。\n\n挑选指令的思考路径：\n1) 先识别文本类型：是中文还是外文？是诗/段落/列表/代码/表格/对话/数据/标题？\n2) 再判断它最缺什么：缺翻译？缺校对？缺更生动的表达？缺结构化？缺扩展？缺反例？缺转换为另一种格式？\n3) 选一条与该文本特征**最匹配**的处理指令。\n\n动作多样性参考（不要只在'总结/提炼'里打转）：\n - 翻译为英文/日文/古文/白话\n - 改写得更口语 / 更正式 / 更幽默 / 更简洁\n - 扩展为 200 字详细论述\n - 续写下一段\n - 找出错别字和病句\n - 列出关键术语并解释\n - 挑出逻辑漏洞并提反例\n - 转成 Markdown 表格 / 列表 / 代码块\n - 抽取所有数字/日期/人名\n - 标注重点字词加粗\n - 把这段代码加注释 / 重构得更可读 / 找潜在 bug\n - 把对话整理成纪要\n\n硬性约束：\n① **禁止**默认建议「总结」「概括」「提炼要点」这类指令——除非文本明显是长篇叙述（>300 字且非列表/代码/对话）；优先选其他动作。\n② 命令式祈使句，直接以动词开头。\n③ 不超过 25 个字。\n④ 只输出指令本身，不要解释、不要引号、不要前后缀、不要句末标点。\n⑤ 使用中文。\n⑥ 不同次调用要尽量给不同的指令，不要重复。"
            }),
            json!({ "role": "user", "content": user_content }),
        ];

        // 每次调用换一个 seed，避免相同输入坍塌到同一答案；OpenAI / Ollama 都认这个键
        let seed: u32 = rand::random();
        let timeout = std::time::Duration::from_secs(10);
        let raw = if model.provider == "ollama" {
            let url = format!("{}/api/chat", model.api_url.trim().trim_end_matches('/'));
            let client = build_ollama_client();
            let response = client
                .post(&url)
                .timeout(timeout)
                .json(&json!({
                    "model": model.model_id,
                    "messages": messages,
                    "stream": false,
                    "options": {
                        "num_predict": 64,
                        "temperature": 0.85,
                        "top_p": 0.95,
                        "seed": seed,
                    }
                }))
                .send()
                .await
                .map_err(|e| AppError::Custom(format_ollama_send_error(&e, &url)))?;
            if !response.status().is_success() {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                return Err(AppError::Custom(format!(
                    "Ollama 返回错误 {}：{}",
                    status,
                    body.chars().take(200).collect::<String>()
                )));
            }
            let body: Value = response
                .json()
                .await
                .map_err(|e| AppError::Custom(format!("Ollama 响应解析失败: {}", e)))?;
            body["message"]["content"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        } else {
            let client = crate::services::http_client::shared();
            let url = build_openai_chat_url(&model.api_url);
            let mut request = client
                .post(&url)
                .timeout(timeout)
                .header("Content-Type", "application/json")
                .json(&json!({
                    "model": model.model_id,
                    "messages": messages,
                    "max_tokens": 64,
                    "temperature": 0.85,
                    "top_p": 0.95,
                    "seed": seed,
                    "stream": false
                }));
            if let Some(key) = &model.api_key {
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
            body["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        };

        // 清洗：去首尾空白 / 引号 / 句号；截断到 60 字（保险，模型偶尔不守 25 字约束）
        let cleaned: String = raw
            .trim()
            .trim_matches(|c: char| {
                c == '"' || c == '\'' || c == '「' || c == '」' || c == '“' || c == '”'
            })
            .trim_end_matches(|c: char| c == '。' || c == '.' || c == '：' || c == ':')
            .chars()
            .take(60)
            .collect();

        if cleaned.is_empty() {
            return Err(AppError::Custom("AI 未返回有效建议".into()));
        }
        Ok(cleaned)
    }

    /// 无人值守的单轮补全：给一段提示词，返回 AI 的完整文本。
    ///
    /// 与 `chat_stream` / `write_assist` 的区别：**非流式**（`stream: false`）、不 emit 事件、
    /// 不依赖 window/AppHandle/cancel_rx，适合后台调度器（定时推送）直接调用。
    /// 请求构造与错误中文化复用 `suggest_prompt` 的同款逻辑（OpenAI 兼容 / Ollama 两分支）。
    ///
    /// - `model`：None 时取默认模型；Some(id) 时取指定模型
    /// - 超时 90s（生成型内容可能较长，比 suggest 的 10s 宽松）
    /// - `max_tokens` / `num_predict` 给 800，覆盖一段简报/格言/单词卡的长度
    pub async fn complete_once(
        db: &Database,
        prompt: &str,
        model_id: Option<i64>,
    ) -> Result<String, AppError> {
        let model = match model_id {
            Some(id) => db.get_ai_model(id)?,
            None => db.get_default_ai_model()?,
        };

        let messages = vec![json!({ "role": "user", "content": prompt })];
        let timeout = std::time::Duration::from_secs(90);

        let raw = if model.provider == "ollama" {
            let url = format!("{}/api/chat", model.api_url.trim().trim_end_matches('/'));
            let client = build_ollama_client();
            let response = client
                .post(&url)
                .timeout(timeout)
                .json(&json!({
                    "model": model.model_id,
                    "messages": messages,
                    "stream": false,
                    "options": { "num_predict": 800 }
                }))
                .send()
                .await
                .map_err(|e| AppError::Custom(format_ollama_send_error(&e, &url)))?;
            if !response.status().is_success() {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                return Err(AppError::Custom(format!(
                    "Ollama 返回错误 {}：{}",
                    status,
                    body.chars().take(200).collect::<String>()
                )));
            }
            let body: Value = response
                .json()
                .await
                .map_err(|e| AppError::Custom(format!("Ollama 响应解析失败: {}", e)))?;
            body["message"]["content"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        } else {
            let client = crate::services::http_client::shared();
            let url = build_openai_chat_url(&model.api_url);
            let mut request = client
                .post(&url)
                .timeout(timeout)
                .header("Content-Type", "application/json")
                .json(&json!({
                    "model": model.model_id,
                    "messages": messages,
                    "max_tokens": 800,
                    "stream": false
                }));
            if let Some(key) = &model.api_key {
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
            body["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        };

        // 去掉小模型偶尔输出的伪 <think>/工具调用噪声，再 trim
        let cleaned = strip_pseudo_tool_calls(&raw).trim().to_string();
        if cleaned.is_empty() {
            return Err(AppError::Custom("AI 未返回有效内容".into()));
        }
        Ok(cleaned)
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
            let url = format!("{}/api/chat", input.api_url.trim().trim_end_matches('/'));
            let client = build_ollama_client();
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
        let url = format!("{}/api/chat", model.api_url.trim().trim_end_matches('/'));
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
        let attached_context = build_attached_notes_context(db, &conv.attached_note_ids, &model);

        // 3. RAG: 检索相关笔记
        //
        // 上下文预算策略（2026-04-30 重写）：
        // - 旧版：硬编码 top 5 × 4000 字符 = 20K 字符。在 DeepSeek/Claude/GPT 等
        //   长上下文模型下用率仅 10-15%，且单篇被强制截断常丢关键内容。
        // - 新版：top 15 候选，按 model.max_context × 0.5 × 1.5（CJK 估算）
        //   分配总预算；单篇能塞下全文就塞全文，超出再用 smart window 截窗。
        //   预算用完即停。
        //
        // 60K token 模型 → 45000 字符预算可塞 ~5 篇全文或 30+ 条窗口
        // 200K token 模型 → 150000 字符预算几乎能塞完整个候选列表
        const RAG_BUDGET_RATIO: f64 = 0.5; // RAG 占 max_context 的 50%（留 50% 给系统提示+历史+输出）
        const CHARS_PER_TOKEN_CJK: f64 = 1.5; // CJK 1 token ≈ 1.5 字符（粗略估算）
        const SINGLE_NOTE_HARD_CAP: usize = 16000; // 单篇硬上限，防一篇撑爆预算
        const RAG_TOP_N: usize = 15; // 候选数（旧版固定 5；提高让长上下文模型用满预算）

        let mut rag_context = String::new();
        let mut ref_ids: Vec<i64> = Vec::new();
        if use_rag {
            // 文件夹范围会话（"对此文件夹问 AI"）：把 scope_folder_id 实时展开成
            // 该文件夹 + 所有子孙文件夹的 id，RAG 只在这些文件夹内检索。None = 全库。
            let scope_ids = match conv.scope_folder_id {
                Some(fid) => db.collect_descendant_folder_ids(fid).ok(),
                None => None,
            };
            let notes =
                db.search_notes_for_rag(user_message, RAG_TOP_N, scope_ids.as_deref())?;
            if !notes.is_empty() {
                let total_budget =
                    ((model.max_context as f64) * RAG_BUDGET_RATIO * CHARS_PER_TOKEN_CJK)
                        .max(8000.0) as usize;
                let mut used = 0usize;
                let mut included = 0usize;

                rag_context.push_str(
                    "以下是通过关键词检索到的笔记内容（可能相关，也可能无关），\
                     已按相关度排序：\n\n",
                );

                for (id, title, content) in &notes {
                    let remaining = total_budget.saturating_sub(used);
                    if remaining < 500 {
                        // 预算用完，剩余候选不再纳入
                        break;
                    }

                    let plain = strip_html(content);
                    let plain_chars = plain.chars().count();
                    let single_max = SINGLE_NOTE_HARD_CAP.min(remaining);

                    let snippet = if plain_chars <= single_max {
                        // 全文放得下：直接全文塞入（避免任何信息丢失）
                        plain
                    } else {
                        // 全文放不下：smart window 截窗（围绕命中关键词）
                        extract_window_for_rag(&plain, user_message, single_max)
                    };

                    used += snippet.chars().count();
                    rag_context.push_str(&format!("---\n标题: {}\n内容: {}\n\n", title, snippet,));
                    ref_ids.push(*id);
                    included += 1;
                }

                log::debug!(
                    "[RAG] candidates={} included={} chars_used={}/{} (model_ctx={} tokens)",
                    notes.len(),
                    included,
                    used,
                    total_budget,
                    model.max_context,
                );
            }
        }

        // 3. 保存用户消息到数据库
        let refs_json = if ref_ids.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&ref_ids).unwrap_or_default())
        };
        let user_msg =
            db.add_ai_message(conversation_id, "user", user_message, refs_json.as_deref())?;
        db.touch_ai_conversation(conversation_id)?;

        // 4. 构建历史消息并发送（支持自动重试递减历史）
        let history = db.list_ai_messages(conversation_id)?;

        // 尝试不同的历史长度：20 → 10 → 4 → 0（仅当前消息）
        let max_history_attempts = [20usize, 10, 4, 0];
        let mut last_error = None;

        for &max_hist in &max_history_attempts {
            let messages =
                Self::build_messages(&model, &history, &rag_context, &attached_context, max_hist);

            log::info!(
                "AI Request: model={}, messages={}, max_history={}",
                model.model_id,
                messages.len(),
                max_hist
            );

            let result = match model.provider.as_str() {
                "ollama" => {
                    Self::stream_ollama(&app, conversation_id, &model, &messages, cancel_rx.clone())
                        .await
                }
                // T-012: 默认走 OpenAI 兼容协议（OpenAI / Claude 代理 / DeepSeek / 智谱 /
                // Minimax / SiliconFlow / LM Studio / 用户自定义 baseUrl）
                _ => {
                    Self::stream_openai_compatible(
                        &app,
                        conversation_id,
                        &model,
                        &messages,
                        cancel_rx.clone(),
                    )
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
                        let _ = db.rename_ai_conversation_if_default(conversation_id, &auto_title);
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
                            max_hist,
                            err_str
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
        conversation_id: i64,
        model: &AiModel,
        messages: &[Value],
        mut cancel_rx: watch::Receiver<bool>,
    ) -> Result<String, AppError> {
        let url = format!("{}/api/chat", model.api_url.trim().trim_end_matches('/'));
        let client = build_ollama_client();
        log::info!(
            "[Ollama] POST {} (raw api_url={:?}) model={} msgs={}",
            url,
            model.api_url,
            model.model_id,
            messages.len()
        );

        let response = match client
            .post(&url)
            .json(&json!({
                "model": model.model_id,
                "messages": messages,
                "stream": true
            }))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                // Bug B: 请求没发出去（连接失败 / read_timeout）也要让前端收到 ai:error，
                // 否则只靠 command reject 不够显眼，用户只见 UI"一直停止"
                log::warn!("[Ollama] 请求发送失败: {}", ollama_send_error_diag(&e, &url));
                let msg = format_ollama_send_error(&e, &url);
                emit_ai_error(app, conversation_id, &msg);
                return Err(AppError::Custom(msg));
            }
        };

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            log::warn!(
                "[Ollama] 非 200 响应: {} body={:?}",
                status,
                body.chars().take(500).collect::<String>()
            );
            let msg = format!("Ollama 返回错误 {}: {}", status, body);
            emit_ai_error(app, conversation_id, &msg);
            return Err(AppError::Custom(msg));
        }

        let mut stream = response.bytes_stream();
        let mut full_response = String::new();
        let started = std::time::Instant::now();
        let mut first_chunk = true;

        loop {
            tokio::select! {
                chunk = stream.next() => {
                    match chunk {
                        Some(Ok(bytes)) => {
                            if std::mem::take(&mut first_chunk) {
                                log::info!("[Ollama] 首个响应字节到达，耗时 {:?}（Ollama 已开始返回）", started.elapsed());
                            }
                            let text = String::from_utf8_lossy(&bytes);
                            for line in text.lines() {
                                if line.is_empty() { continue; }
                                if let Ok(data) = serde_json::from_str::<Value>(line) {
                                    if let Some(content) = data["message"]["content"].as_str() {
                                        full_response.push_str(content);
                                        emit_ai_token(app, conversation_id, content);
                                    }
                                    if data["done"].as_bool() == Some(true) {
                                        return Ok(full_response);
                                    }
                                }
                            }
                        }
                        Some(Err(e)) => {
                            emit_ai_error(app, conversation_id, &e.to_string());
                            return Err(AppError::Custom(format!("流读取错误: {}", e)));
                        }
                        None => break,
                    }
                }
                _ = cancel_rx.changed() => {
                    if *cancel_rx.borrow() {
                        let _ = app.emit("ai:done", conversation_id);
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
        conversation_id: i64,
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

        let response = match request.send().await {
            Ok(r) => r,
            Err(e) => {
                let msg = format!("API 请求失败: {}", e);
                emit_ai_error(app, conversation_id, &msg);
                return Err(AppError::Custom(msg));
            }
        };

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            let msg = format_openai_api_error(status, &body);
            emit_ai_error(app, conversation_id, &msg);
            return Err(AppError::Custom(msg));
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
                                            emit_ai_token(app, conversation_id, content);
                                        }
                                    }
                                }
                            }
                        }
                        Some(Err(e)) => {
                            emit_ai_error(app, conversation_id, &e.to_string());
                            return Err(AppError::Custom(format!("流读取错误: {}", e)));
                        }
                        None => break,
                    }
                }
                _ = cancel_rx.changed() => {
                    if *cancel_rx.borrow() {
                        let _ = app.emit("ai:done", conversation_id);
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
    /// 支持两族协议：
    /// - OpenAI 兼容（openai / claude / deepseek / zhipu / lmstudio / 自定义）：走 `stream_openai_with_tools`
    /// - Ollama：走 `stream_ollama_with_tools`（Ollama 0.3+ 原生支持 OpenAI 风格 tools 数组，
    ///   但流协议是 NDJSON、tool_calls 一次性返回；需要单独的解析路径）
    ///
    /// Ollama 侧前提：模型本身具备 function calling 能力（qwen2.5 / llama3.1 / mistral-nemo 等）；
    /// 纯文本模型如 gemma2 / phi3 即使协议层通过也不会返回 tool_calls。
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

        // 1.2 文件夹范围会话（"对此文件夹问 AI"）：把 scope_folder_id 展开成
        // 「该文件夹 + 所有子孙文件夹」的 id 列表，传给工具 dispatch，让内置检索/读取类
        // 工具（search_notes / get_note / find_related / kb__* 笔记类）只在范围内作答。
        // None = 全库（未限定范围）。注意这是智能模式工具路径专属；RAG 路径在 chat_stream 里另算。
        let scope_ids: Option<Vec<i64>> = {
            let conv = db.get_ai_conversation(conversation_id)?;
            match conv.scope_folder_id {
                Some(fid) => db.collect_descendant_folder_ids(fid).ok(),
                None => None,
            }
        };

        // 1.5 Ollama 不走工具调用路径，改走原始 RAG（chat_stream）。
        //
        // 原因：智能模式会把几十个工具 schema（5 内置 + 所有 enabled MCP 工具）塞进 /api/chat
        // 请求，Ollama 上的本地小模型（如 qwen2.5:7b）光是 prompt-eval 这一大段就可能要好几分钟
        // （冷启动 + CPU 推理 + 远程网络），期间一个 token 都不吐 —— 用户体验等同卡死；而且小模型
        // 的 function-calling 本来就不可靠。所以 Ollama 一律退回到最初的"文档查询"实现：
        // chat_stream 会先用关键词检索相关笔记、把内容塞进 system prompt（RAG），再普通流式问模型，
        // 不发任何工具。文档查询照样能用，且快。
        //
        // （早返回，在保存用户消息 / 构建工具消息之前 —— chat_stream 内部会自己保存用户消息。）
        if model.provider == "ollama" {
            log::info!(
                "[skills] provider=ollama (model={}) → 不发工具，改走 RAG 路径 chat_stream",
                model.model_id
            );
            return Self::chat_stream(app, db, conversation_id, user_message, true, cancel_rx).await;
        }
        // 走到这里一定不是 ollama（上面已早返回）；保留这个变量给下方按 provider 分流用
        let is_ollama = model.provider == "ollama";

        // 2. 保存用户消息
        let user_msg = db.add_ai_message(conversation_id, "user", user_message, None)?;
        db.touch_ai_conversation(conversation_id)?;

        // 3. 构建消息数组（带 skills 指引的 system prompt + 历史）
        let history = db.list_ai_messages(conversation_id)?;
        let system_prompt = "你是一个知识库助手。你可以调用以下内置工具辅助回答：\n\
            - search_notes(query, limit?)：搜笔记\n\
            - get_note(id)：读单篇笔记全文\n\
            - list_tags()：列所有标签\n\
            - find_related(note_id)：找相关笔记（反向链接）\n\
            - get_today_tasks()：今日待办\n\
            \n此外可能有外部 MCP 工具可用（名字以 `mcp__` 开头，描述里有 `[MCP/server名]` 标签）。\
            这些工具来自用户在「设置 → MCP 服务器」加的第三方服务（如 GitHub / Filesystem / 高德地图 / kb-mcp 自身等）。\
            描述中 `[MCP/...]` 是工具来源标记，调用时仍按工具名（含 mcp__ 前缀）调用。\n\
            \n原则：\n\
            1. 回答涉及用户笔记内容时，先用 search_notes 搜索，再按需 get_note 读全文；不要凭空编造。\n\
            2. 涉及第三方系统（GitHub 仓库 / 文件系统 / 地图 等）时，优先用对应 MCP 工具。\n\
            3. 工具返回的内容可能有省略（标记 `…（已截断）`），必要时再次调用获取更多。\n\
            4. 最终给用户的回答用中文，简洁准确。";

        // 文件夹范围会话：在 system prompt 末尾追加硬约束说明，让模型明确知道检索面被限定，
        // 不要声称能看到范围外的笔记（工具层已做硬过滤，这里是给模型的认知对齐）。
        let system_prompt: std::borrow::Cow<'_, str> = if scope_ids.is_some() {
            std::borrow::Cow::Owned(format!(
                "{system_prompt}\n\n\
                 ⚠️ 重要：本次对话已被用户限定在某个文件夹（含其所有子文件夹）范围内。\
                 search_notes / get_note / find_related 等内置检索工具只会返回该范围内的笔记，\
                 范围外的笔记你无法访问、也读不到内容。请只基于范围内的笔记作答，\
                 不要声称看到了范围外的内容，也不要编造范围外笔记的存在。"
            ))
        } else {
            std::borrow::Cow::Borrowed(system_prompt)
        };

        let mut messages: Vec<Value> = vec![json!({
            "role": "system",
            "content": system_prompt.as_ref(),
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
        // M5-3：tool_schemas 现在融合内置 5 skills + 所有 enabled 外部 MCP server 的工具
        // 工具命名约定：MCP 工具加 mcp__<server_id>__ 前缀；dispatch 时按前缀路由
        let tool_schemas = skills::tool_schemas_with_mcp(&app).await;

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

            let tools_arg: &[Value] = if allow_tools { &tool_schemas } else { &[] };
            let (content, tool_calls) = if is_ollama {
                Self::stream_ollama_with_tools(
                    &app,
                    conversation_id,
                    &model,
                    req_messages.as_ref(),
                    tools_arg,
                    cancel_rx.clone(),
                )
                .await
            } else {
                Self::stream_openai_with_tools(
                    &app,
                    conversation_id,
                    &model,
                    req_messages.as_ref(),
                    tools_arg,
                    cancel_rx.clone(),
                )
                .await
            };

            let (content, mut tool_calls) = match content {
                Ok(c) => (c, tool_calls.unwrap_or_default()),
                Err(e) => {
                    log::warn!("[skills] round={} 失败: {}", round, e);
                    let _ = db.delete_ai_message(user_msg.id);
                    return Err(e);
                }
            };
            log::info!(
                "[skills] round={} allow_tools={} provider={} → content_len={} tool_calls={}",
                round,
                allow_tools,
                model.provider,
                content.chars().count(),
                tool_calls.len()
            );

            // 取消信号：上面 stream 函数已经 emit ai:done "cancelled"，直接返回
            if *cancel_rx.borrow() {
                // 不删用户消息（用户想保留这条），直接结束
                return Ok(());
            }

            // P0: finalization 轮即使模型仍返回 tool_calls 也强制忽略，避免循环退出后 final_content 为空
            if !allow_tools {
                tool_calls.clear();
            }

            // P0: id 兜底合成。部分 provider（LM Studio / glm-4 等）流式 tool_calls 不带 id，
            // 之前的 filter 会整条丢弃，导致 tool_calls 空 → 直接 break with empty content
            for (idx, tc) in tool_calls.iter_mut().enumerate() {
                if tc.id.trim().is_empty() {
                    tc.id = format!("call_auto_{}_{}", round, idx);
                }
            }

            if tool_calls.is_empty() {
                // 模型给出最终答复——剥掉伪工具调用残文（仅 finalization 轮容易触发，
                // 其他轮模型本就该走 tool_calls 通道；剥一下零成本，多一道兜底）
                let stripped = strip_pseudo_tool_calls(&content);
                // P0: 空答复兜底。strip 后为空 + 已经调过工具时给用户友好提示，
                // 否则保留原 content（避免 strip 误伤）
                final_content = if stripped.trim().is_empty() && !content.trim().is_empty() {
                    content
                } else if stripped.trim().is_empty() && !all_skill_calls.is_empty() {
                    format!(
                        "（AI 调用了 {} 次工具但未给出最终答复，可能是模型不支持当前协议或上下文不足，请稍后重试或换个模型）",
                        all_skill_calls.len()
                    )
                } else {
                    stripped
                };
                break;
            }

            // 有工具调用：追加 assistant tool_calls 消息 + 各 tool 结果
            // P0: content: null 改为空字符串。OpenAI spec 允许 null，但 deepseek/glm 等部分实现
            // 遇到 null content 直接返回 400
            messages.push(json!({
                "role": "assistant",
                "content": content,
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

                // 执行：dispatch_with_mcp 会按前缀路由（mcp__<id>__<name> → mcp_external，否则原 skills）
                // P1: tool 失败时把错误包装为友好提示，避免部分模型遇到 "ERROR: ..." 直接放弃
                let (result_text, status) =
                    match skills::dispatch_with_mcp(&app, db, &tc.name, &tc.args_json, scope_ids.as_deref()).await {
                        Ok(r) => (r, "ok"),
                        Err(e) => (
                            format!(
                                "工具 `{}` 调用失败: {}。请基于其他工具的结果或常识继续回答用户。",
                                tc.name, e
                            ),
                            "error",
                        ),
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
        log::info!(
            "[skills] 结束: final_content_len={} skill_calls={}",
            final_content.chars().count(),
            all_skill_calls.len()
        );
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
    /// 被取消时：发 `ai:done`（带会话 ID）并返回当前累积内容（tool_calls 清空）。
    async fn stream_openai_with_tools(
        app: &AppHandle,
        conversation_id: i64,
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
                let msg = format!("API 请求失败: {}", e);
                emit_ai_error(app, conversation_id, &msg);
                return (Err(AppError::Custom(msg)), None);
            }
        };
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            let msg = format_openai_api_error(status, &body);
            emit_ai_error(app, conversation_id, &msg);
            return (Err(AppError::Custom(msg)), None);
        }

        let mut stream = response.bytes_stream();
        let mut content = String::new();
        // P1: reasoning 模型（deepseek-r1 / qwq / o1）正文走 reasoning_content；
        // 流过程中独立发 ai:reasoning 事件，content 全空时再兜底拼到正文
        let mut reasoning_content = String::new();
        // BTreeMap 按 index 有序，保证 dispatch 时工具顺序稳定
        let mut tool_accum: std::collections::BTreeMap<u64, ToolCallAccum> =
            std::collections::BTreeMap::new();
        // P1: UTF-8 多字节字符可能跨 chunk 切分，String::from_utf8_lossy 在边界插入
        // U+FFFD 替换字符并损坏 SSE 解析；改用 Vec<u8> 累积，按 \n 字节切再解码
        let mut buffer: Vec<u8> = Vec::new();
        // P0: finish_reason 用来判断是否异常终止（length / content_filter）
        let mut finish_reason: Option<String> = None;

        loop {
            tokio::select! {
                chunk = stream.next() => {
                    match chunk {
                        Some(Ok(bytes)) => {
                            buffer.extend_from_slice(&bytes);
                            while let Some(pos) = buffer.iter().position(|b| *b == b'\n') {
                                let line_bytes: Vec<u8> = buffer.drain(..=pos).collect();
                                let line = String::from_utf8_lossy(&line_bytes);
                                let line = line.trim_end_matches(&['\r', '\n'][..]);
                                handle_openai_stream_line(
                                    app,
                                    conversation_id,
                                    line,
                                    &mut content,
                                    &mut reasoning_content,
                                    &mut tool_accum,
                                    &mut finish_reason,
                                );
                            }
                        }
                        Some(Err(e)) => {
                            emit_ai_error(app, conversation_id, &e.to_string());
                            return (Err(AppError::Custom(format!("流读取错误: {}", e))), None);
                        }
                        None => break,
                    }
                }
                _ = cancel_rx.changed() => {
                    if *cancel_rx.borrow() {
                        let _ = app.emit("ai:done", conversation_id);
                        return (Ok(content), Some(Vec::new()));
                    }
                }
            }
        }

        // P0: 流末尾未以 \n 结尾的 leftover 也要 flush，否则丢失最后一行 SSE
        if !buffer.is_empty() {
            let line = String::from_utf8_lossy(&buffer);
            let line = line.trim_end_matches(&['\r', '\n'][..]);
            handle_openai_stream_line(
                app,
                conversation_id,
                line,
                &mut content,
                &mut reasoning_content,
                &mut tool_accum,
                &mut finish_reason,
            );
        }

        // P1: content 全空但 reasoning 非空时，把累积的 reasoning 提升为正文
        // （前端流式过程中已经收到 ai:reasoning，这里只补一次 ai:token 让 UI 文本不为空）
        if content.trim().is_empty() && !reasoning_content.trim().is_empty() {
            content.push_str(&reasoning_content);
            emit_ai_token(app, conversation_id, &reasoning_content);
        }

        // finish_reason 异常处理：
        // - length：模型生成达 max_tokens 上限，**已有部分内容**，不当致命错误。
        //   追加一行提示让用户知道被截断，返回 Ok 保留已渲染的内容（前面 emit_ai_token
        //   已经流式发过）；用户可视情况调大 max_tokens 或缩短上下文重试。
        // - content_filter / 其他非 stop|tool_calls：当致命错误抛出（红色 toast）。
        if let Some(reason) = &finish_reason {
            match reason.as_str() {
                "stop" | "tool_calls" => {}
                "length" => {
                    let tip = "\n\n> ⚠️ 输出达到模型上限被截断。可在模型设置里调大 max_tokens 或缩短上下文后重试。";
                    content.push_str(tip);
                    emit_ai_token(app, conversation_id, tip);
                    log::warn!(
                        "[ai] conversation {} 输出截断 (finish_reason=length)",
                        conversation_id
                    );
                }
                _ => {
                    let msg = format!("AI 异常终止 (finish_reason={})", reason);
                    emit_ai_error(app, conversation_id, &msg);
                    return (Err(AppError::Custom(msg)), None);
                }
            }
        }

        // 收尾：id 在外层 chat_stream_with_skills 已做兜底合成，这里只丢 name 为空的
        let tool_calls: Vec<ToolCallAccum> = tool_accum
            .into_values()
            .filter(|t| !t.name.trim().is_empty())
            .collect();

        (Ok(content), Some(tool_calls))
    }

    /// Ollama `/api/chat` 流式请求 + tool_calls 支持
    ///
    /// 与 OpenAI 版本的协议差异：
    /// - 流格式：NDJSON（一行一个完整 JSON 对象），不是 SSE 的 `data: {...}`
    /// - tool_calls 字段：Ollama 在 `done` 那一行一次性返回**完整**数组（arguments 是 JSON object，
    ///   不是 string），无 `index`、无 `id`。OpenAI 则是分片 delta，arguments 是字符串拼接。
    /// - tool_choice：Ollama 不支持，模型自决；OpenAI 用 `"tool_choice": "auto"`
    ///
    /// 为复用外层调度，把 Ollama 的 arguments object 序列化成 string 塞进 `ToolCallAccum.args_json`，
    /// id 留空让外层 `chat_stream_with_skills` 兜底合成 `call_auto_X_Y`。
    ///
    /// 前提：模型本身要支持 function calling（qwen2.5 / llama3.1 / mistral-nemo 等；
    /// gemma2 / phi3 不支持）。Ollama 服务版本需 ≥ 0.3。
    async fn stream_ollama_with_tools(
        app: &AppHandle,
        conversation_id: i64,
        model: &AiModel,
        messages: &[Value],
        tools: &[Value],
        mut cancel_rx: watch::Receiver<bool>,
    ) -> (Result<String, AppError>, Option<Vec<ToolCallAccum>>) {
        let url = format!("{}/api/chat", model.api_url.trim().trim_end_matches('/'));
        let client = build_ollama_client();

        let mut request_body = json!({
            "model": model.model_id,
            "messages": messages,
            "stream": true,
        });
        if !tools.is_empty() {
            request_body["tools"] = json!(tools);
        }
        log::info!(
            "[Ollama/tools] POST {} (raw api_url={:?}) model={} tools={} msgs={}",
            url,
            model.api_url,
            model.model_id,
            tools.len(),
            messages.len()
        );

        // 发请求；遇到 Ollama "模型不支持 tools" 的 400 时去掉 tools 字段重试一次，
        // 让「智能模式 + 纯文本 Ollama 模型（llama3 / gemma2 / phi3 等不支持 function calling）」
        // 优雅降级成纯对话，而不是整条请求挂掉、前端一直转圈（Bug B）。
        // 失败的早返回路径都补发 ai:error，保证错误一定能冒到前端 UI。
        let response = loop {
            let resp = match client.post(&url).json(&request_body).send().await {
                Ok(r) => r,
                Err(e) => {
                    log::warn!("[Ollama/tools] 请求发送失败: {}", ollama_send_error_diag(&e, &url));
                    let msg = format_ollama_send_error(&e, &url);
                    emit_ai_error(app, conversation_id, &msg);
                    return (Err(AppError::Custom(msg)), None);
                }
            };
            if resp.status().is_success() {
                break resp;
            }
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            // 仅当 ① 状态 400 ② body 含 "does not support tools" ③ 本次请求确实带了 tools
            // 三者都满足才降级重试。去掉 tools 后即便再 400 也不会再命中条件 ③，不会死循环。
            let can_degrade = status == reqwest::StatusCode::BAD_REQUEST
                && body.contains("does not support tools")
                && request_body.get("tools").is_some();
            if can_degrade {
                log::warn!(
                    "Ollama 模型 {} 不支持 function calling，去掉 tools 降级为纯对话重试",
                    model.model_id
                );
                if let Some(obj) = request_body.as_object_mut() {
                    obj.remove("tools");
                }
                continue;
            }
            log::warn!(
                "[Ollama/tools] 非 200 响应: {} body={:?}",
                status,
                body.chars().take(500).collect::<String>()
            );
            let msg = format!("Ollama 返回错误 {}: {}", status, body);
            emit_ai_error(app, conversation_id, &msg);
            return (Err(AppError::Custom(msg)), None);
        };

        let mut stream = response.bytes_stream();
        let mut content = String::new();
        // Ollama 通常在 done 行一次给完整 tool_calls 数组，但留个累积容器
        // （某些版本可能跨多帧；后到的覆盖前到的，按出现顺序编 index）
        let mut tool_calls_final: Vec<ToolCallAccum> = Vec::new();
        // UTF-8 chunk 切分 + NDJSON 按 \n 切（同 OpenAI 的处理逻辑）
        let mut buffer: Vec<u8> = Vec::new();
        let started = std::time::Instant::now();
        let mut first_chunk = true;

        loop {
            tokio::select! {
                chunk = stream.next() => {
                    match chunk {
                        Some(Ok(bytes)) => {
                            if std::mem::take(&mut first_chunk) {
                                log::info!("[Ollama/tools] 首个响应字节到达，耗时 {:?}（含模型加载 + prompt-eval；之后才会逐 token 出）", started.elapsed());
                            }
                            buffer.extend_from_slice(&bytes);
                            while let Some(pos) = buffer.iter().position(|b| *b == b'\n') {
                                let line_bytes: Vec<u8> = buffer.drain(..=pos).collect();
                                let line = String::from_utf8_lossy(&line_bytes);
                                let line = line.trim_end_matches(&['\r', '\n'][..]);
                                handle_ollama_stream_line(
                                    app,
                                    conversation_id,
                                    line,
                                    &mut content,
                                    &mut tool_calls_final,
                                );
                            }
                        }
                        Some(Err(e)) => {
                            emit_ai_error(app, conversation_id, &e.to_string());
                            return (Err(AppError::Custom(format!("流读取错误: {}", e))), None);
                        }
                        None => break,
                    }
                }
                _ = cancel_rx.changed() => {
                    if *cancel_rx.borrow() {
                        let _ = app.emit("ai:done", conversation_id);
                        return (Ok(content), Some(Vec::new()));
                    }
                }
            }
        }

        // 末尾未以 \n 结尾的 leftover（Ollama 一般会用 \n 结束，但保险一下）
        if !buffer.is_empty() {
            let line = String::from_utf8_lossy(&buffer);
            let line = line.trim_end_matches(&['\r', '\n'][..]);
            handle_ollama_stream_line(app, conversation_id, line, &mut content, &mut tool_calls_final);
        }

        log::info!(
            "[Ollama/tools] 流结束: content_len={} tool_calls={} (tools_sent={})",
            content.chars().count(),
            tool_calls_final.len(),
            request_body.get("tools").is_some()
        );
        (Ok(content), Some(tool_calls_final))
    }
}

/// 解析单行 OpenAI SSE 流数据，累加内容并更新 tool_calls 状态。
///
/// 抽出 free function 是因为 stream_openai_with_tools 主循环 + 末尾 leftover flush
/// 两处都要调用，避免重复。
fn handle_openai_stream_line(
    app: &AppHandle,
    conversation_id: i64,
    line: &str,
    content: &mut String,
    reasoning_content: &mut String,
    tool_accum: &mut std::collections::BTreeMap<u64, ToolCallAccum>,
    finish_reason: &mut Option<String>,
) {
    if line.is_empty() || line == "data: [DONE]" {
        return;
    }
    let Some(json_str) = line.strip_prefix("data: ") else {
        return;
    };
    let data: Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => return,
    };

    let choice = &data["choices"][0];
    if let Some(reason) = choice["finish_reason"].as_str() {
        *finish_reason = Some(reason.to_string());
    }

    let delta = &choice["delta"];
    if let Some(c) = delta["content"].as_str() {
        content.push_str(c);
        emit_ai_token(app, conversation_id, c);
    }
    // reasoning 模型（deepseek-r1 / qwq / o1）的"思考过程"，独立事件让前端可选展示
    if let Some(r) = delta["reasoning_content"].as_str() {
        if !r.is_empty() {
            reasoning_content.push_str(r);
            let _ = app.emit("ai:reasoning", r);
        }
    }
    // tool_calls 分片
    if let Some(tcs) = delta["tool_calls"].as_array() {
        for tc in tcs {
            let idx = tc["index"].as_u64().unwrap_or(0);
            let entry = tool_accum.entry(idx).or_insert_with(ToolCallAccum::default);
            if let Some(id) = tc["id"].as_str() {
                if !id.is_empty() {
                    entry.id = id.to_string();
                }
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

/// 流式解析过程中累加的一次工具调用（OpenAI 分片返回格式）
#[derive(Default, Debug, Clone)]
struct ToolCallAccum {
    id: String,
    name: String,
    /// 累加后的 arguments JSON 字符串（尚未解析）
    args_json: String,
}

/// 解析单行 Ollama NDJSON 流数据，累加 content 并提取 tool_calls。
///
/// Ollama 协议：每行一个 JSON `{message:{content,tool_calls?}, done}`。
/// 与 OpenAI delta 的两个关键差异：
/// 1. tool_calls 通常在 `done:true` 的一行整体返回（不分片）
/// 2. arguments 是 JSON object 而非 string —— 这里序列化成字符串塞进 `ToolCallAccum.args_json`
///    以便和 OpenAI 分支共用外层 dispatch 逻辑（skills::dispatch_with_mcp 接收 &str）
fn handle_ollama_stream_line(
    app: &AppHandle,
    conversation_id: i64,
    line: &str,
    content: &mut String,
    tool_calls_final: &mut Vec<ToolCallAccum>,
) {
    if line.is_empty() {
        return;
    }
    let data: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            // 正常情况下 Ollama 每行都是完整 JSON；解析失败往往意味着上游（含代理）把
            // NDJSON 重新切了块、或返回了非 JSON 的错误页（如代理的 405/HTML）。打日志方便排查。
            log::warn!(
                "[Ollama] 跳过无法解析的流行: {} | line={:?}",
                e,
                line.chars().take(160).collect::<String>()
            );
            return;
        }
    };

    if let Some(c) = data["message"]["content"].as_str() {
        if !c.is_empty() {
            content.push_str(c);
            emit_ai_token(app, conversation_id, c);
        }
    }

    // 后到的 tool_calls 数组覆盖前一次（Ollama 几乎总是一次性给完整数组）。
    // 用 clear+push 而非追加，避免同一组调用被复制多次造成"重复执行"。
    if let Some(tcs) = data["message"]["tool_calls"].as_array() {
        if !tcs.is_empty() {
            tool_calls_final.clear();
            for tc in tcs {
                let name = tc["function"]["name"].as_str().unwrap_or("").to_string();
                if name.is_empty() {
                    continue;
                }
                // Ollama 返回 object，序列化成 string；同时兼容个别版本已返回 string 的情况
                let args_json = match &tc["function"]["arguments"] {
                    Value::String(s) => s.clone(),
                    other => serde_json::to_string(other).unwrap_or_else(|_| "{}".into()),
                };
                tool_calls_final.push(ToolCallAccum {
                    // id 留空，外层 chat_stream_with_skills 兜底为 call_auto_X_Y
                    id: tc["id"].as_str().unwrap_or("").to_string(),
                    name,
                    args_json,
                });
            }
        }
    }
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
        // Ollama 自 v0.1.24 起原生支持 OpenAI 兼容的 /v1/chat/completions 端点，
        // 此处一律走 build_openai_chat_url 即可；response_format 在下方按 provider 决定是否带。

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
        if let Some(goal) = req
            .goal
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
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

        let user_content = format!(
            "请为我规划今天（{}）的待办。\n\n{}",
            today,
            user_sections.join("\n\n")
        );

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
        // Claude 兼容代理 / Ollama OpenAI 兼容层都对 response_format 支持不一致，
        // 去掉该字段，完全靠 prompt 让模型输出 JSON（下方解析器已带剥 ``` 兜底）
        if model.provider == "claude" || model.provider == "ollama" {
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
                AppError::Custom("AI 返回格式异常：缺少 choices[0].message.content".to_string())
            })?;

        parse_plan_today_response(content).ok_or_else(|| {
            AppError::Custom(format!(
                "AI 返回的 JSON 无法解析。原始响应：\n{}",
                content.chars().take(400).collect::<String>()
            ))
        })
    }

    /// 把一句自然语言描述抽取成结构化任务建议（语音快速捕获用）。
    ///
    /// 输入是一段口语化的话，例如「明天下午三点开会，提前半小时提醒」；
    /// 输出 `TaskSuggestion`，包含解析后的 dueDate / remindBefore / priority / important。
    /// 仅作为建议返回，不落库——调用方拿到后可走标准 `taskApi.create`。
    ///
    /// 复用默认 AI 模型；非流式，典型耗时 2-6 秒。
    pub async fn extract_task_from_text(
        db: &Database,
        text: &str,
    ) -> Result<TaskSuggestion, AppError> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err(AppError::InvalidInput("文本为空".into()));
        }

        let model = db.get_default_ai_model()?;
        // Ollama 走 OpenAI 兼容端点（/v1/chat/completions），见 build_openai_chat_url

        let now = chrono::Local::now();
        let today = now.format("%Y-%m-%d").to_string();
        let now_full = now.format("%Y-%m-%d %H:%M:%S").to_string();

        let system_prompt = format!(
            "你是任务解析助手。把用户口语化的一句话转换成结构化的任务 JSON。\n\
             当前时间: {now_full}\n\
             今天日期: {today}\n\n\
             严格返回 JSON 对象（不要 markdown 代码块、不要任何额外文字），格式：\n\
             {{\n  \
             \"title\": \"任务标题（去掉时间/提醒等元信息，只留核心动作）\",\n  \
             \"dueDate\": \"YYYY-MM-DD HH:MM:SS\" 或 null,\n  \
             \"remindBefore\": null|0|15|30|60|180|1440|10080,\n  \
             \"priority\": 0|1|2,\n  \
             \"important\": true|false,\n  \
             \"reason\": \"简短说明你怎么解析的\"\n\
             }}\n\n\
             解析规则：\n\
             - title：必须可执行（『写周报』而非『关于周报』）；去掉口语连接词。\n\
             - dueDate：能解析就给完整 'YYYY-MM-DD HH:MM:SS'。\n\
                  · 「明天下午三点」 = today+1 15:00:00\n\
                  · 「30 分钟后」 = now + 30min\n\
                  · 「周五」 = 本周或下周最近的周五\n\
                  · 没明确时间 → null\n\
                  · 只有日期没有时间 → 当天 23:59:59\n\
             - remindBefore（提前几分钟提醒）：用户明说『提前 X 分钟/小时/天』就照填；否则按规则：\n\
                  · 紧急任务（priority=0） → 0 或 15\n\
                  · 重要任务（important=true） → 60 或 1440\n\
                  · 不重要不紧急 → null\n\
                  · 必须是固定值之一：null / 0 / 15 / 30 / 60 / 180 / 1440 / 10080\n\
             - priority：0=紧急（今/明天必做） / 1=一般（本周内） / 2=不急（无截止）\n\
             - important：true=对长期目标/健康/关键产出有显著贡献\n\
             - reason：一句中文，简短解释你怎么从原文推断时间和优先级\n\n\
             🔴 JSON 字符串字段（title / reason）严禁使用英文双引号 \"，需要引用时用中文「」或『』。"
        );

        let messages = vec![
            json!({ "role": "system", "content": system_prompt }),
            json!({ "role": "user", "content": trimmed }),
        ];

        let client = crate::services::http_client::shared();
        let url = build_openai_chat_url(&model.api_url);
        let mut req_body = json!({
            "model": model.model_id,
            "messages": messages,
            "stream": false,
            "response_format": { "type": "json_object" },
            "max_tokens": 600,
        });
        // Claude 兼容代理 / Ollama OpenAI 兼容层都对 response_format 支持不一致，
        // 去掉该字段，完全靠 prompt 让模型输出 JSON（下方解析器已带剥 ``` 兜底）
        if model.provider == "claude" || model.provider == "ollama" {
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
            .ok_or_else(|| AppError::Custom("AI 返回格式异常：缺少 content".into()))?;

        parse_task_suggestion_response(content).ok_or_else(|| {
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
    /// 2. 非流式 + `response_format: json_object`（Claude/Ollama 会自动去掉该字段，靠 prompt 引导 JSON）
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
        // Ollama 走 OpenAI 兼容端点（/v1/chat/completions）

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
        // Claude 兼容代理 / Ollama OpenAI 兼容层都对 response_format 支持不一致，
        // 去掉该字段，完全靠 prompt 让模型输出 JSON（下方解析器已带剥 ``` 兜底）
        if model.provider == "claude" || model.provider == "ollama" {
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
                AppError::Custom("AI 返回格式异常：缺少 choices[0].message.content".to_string())
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
        // Ollama 走 OpenAI 兼容端点

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
        // Claude 兼容代理 / Ollama OpenAI 兼容层都对 response_format 支持不一致，
        // 去掉该字段，完全靠 prompt 让模型输出 JSON（下方解析器已带剥 ``` 兜底）
        if model.provider == "claude" || model.provider == "ollama" {
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
                AppError::Custom("AI 返回格式异常：缺少 choices[0].message.content".to_string())
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
    #[cfg(desktop)]
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
        // Ollama 走 OpenAI 兼容端点

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
        // Claude 兼容代理 / Ollama OpenAI 兼容层都对 response_format 支持不一致，
        // 去掉该字段，完全靠 prompt 让模型输出 JSON（下方解析器已带剥 ``` 兜底）
        if model.provider == "claude" || model.provider == "ollama" {
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
                AppError::Custom("AI 返回格式异常：缺少 choices[0].message.content".to_string())
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

    // ══════════════════════════════════════════════════════════════════
    // 通用 AI 会话附件（路线 A）：把 Excel 解析为 markdown 给前端 chip 展示，
    // 发送时由 send_ai_message 拼到 user message 前。
    // 跟 plan_from_excel 区别：plan_from_excel 是"Excel→四象限计划"专用通路；
    // 这里只做解析，不绑定任何 prompt 模板，便于通用问答。
    // ══════════════════════════════════════════════════════════════════
    /// Excel 附件解析（仅桌面端：calamine 在 Android target 编译失败）
    #[cfg(desktop)]
    pub fn parse_excel_attachment(file_path: &str) -> Result<ExcelPreview, AppError> {
        let file_path = file_path.trim();
        if file_path.is_empty() {
            return Err(AppError::InvalidInput("Excel 文件路径不能为空".into()));
        }
        let path = std::path::Path::new(file_path);
        if !path.exists() {
            return Err(AppError::Custom(format!("文件不存在: {}", file_path)));
        }
        let display_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("Excel")
            .to_string();
        let summary = crate::services::excel_parser::read_workbook(file_path)?;
        let chars_estimated = summary.markdown.chars().count();
        Ok(ExcelPreview {
            file_path: file_path.to_string(),
            display_name,
            markdown: summary.markdown,
            total_rows: summary.total_rows,
            truncated_sheets: summary.truncated_sheet_names,
            chars_estimated,
        })
    }
    /// 移动端 stub：返回未支持错误
    #[cfg(mobile)]
    pub fn parse_excel_attachment(_file_path: &str) -> Result<ExcelPreview, AppError> {
        Err(AppError::Custom("移动端暂不支持 Excel 解析".into()))
    }

    /// 文本类附件解析（md / txt / json / 代码等）。复用 import 的编码嗅探，
    /// 单文件超 60k 字符时尾部硬截断（避免单个超大文件爆 token）。
    pub fn parse_text_attachment(file_path: &str) -> Result<TextPreview, AppError> {
        let file_path = file_path.trim();
        if file_path.is_empty() {
            return Err(AppError::InvalidInput("文件路径不能为空".into()));
        }
        let path = std::path::Path::new(file_path);
        if !path.exists() {
            return Err(AppError::Custom(format!("文件不存在: {}", file_path)));
        }
        let display_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("文件")
            .to_string();
        let raw = crate::services::import::read_text_auto_encoding(path)?;
        let (content, truncated) = truncate_for_attachment(&raw, SINGLE_ATTACHMENT_CHAR_LIMIT);
        let total_lines = content.lines().count();
        let chars_estimated = content.chars().count();
        Ok(TextPreview {
            file_path: file_path.to_string(),
            display_name,
            content,
            total_lines,
            chars_estimated,
            truncated,
        })
    }

    /// PDF 附件解析（仅文字层抽取，扫描件会报错）。同样有 60k 字符尾截断。
    pub fn parse_pdf_attachment(file_path: &str) -> Result<PdfPreview, AppError> {
        let file_path = file_path.trim();
        if file_path.is_empty() {
            return Err(AppError::InvalidInput("PDF 文件路径不能为空".into()));
        }
        let path = std::path::Path::new(file_path);
        if !path.exists() {
            return Err(AppError::Custom(format!("文件不存在: {}", file_path)));
        }
        let display_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("PDF")
            .to_string();
        let raw = crate::services::pdf::PdfService::extract_text_only(path)?;
        let (content, truncated) = truncate_for_attachment(&raw, SINGLE_ATTACHMENT_CHAR_LIMIT);
        let chars_estimated = content.chars().count();
        Ok(PdfPreview {
            file_path: file_path.to_string(),
            display_name,
            content,
            chars_estimated,
            truncated,
        })
    }

    /// 按扩展名自动分发到对应的解析器，返回统一的 AttachmentPreview。
    /// 不识别的扩展名当文本处理（够用大多数代码 / 配置文件场景）。
    pub fn parse_attachment_auto(file_path: &str) -> Result<AttachmentPreview, AppError> {
        let ext = std::path::Path::new(file_path)
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        match ext.as_str() {
            "xlsx" | "xls" | "xlsm" | "xlsb" | "ods" => Ok(AttachmentPreview::Excel(
                Self::parse_excel_attachment(file_path)?,
            )),
            "pdf" => Ok(AttachmentPreview::Pdf(Self::parse_pdf_attachment(
                file_path,
            )?)),
            _ => Ok(AttachmentPreview::Text(Self::parse_text_attachment(
                file_path,
            )?)),
        }
    }
}

/// 单个附件的字符上限。Excel 已在 excel_parser 内做更精细的多 sheet 截断；
/// 这里是给 text / pdf 用的简单尾部截断。
const SINGLE_ATTACHMENT_CHAR_LIMIT: usize = 60_000;

/// 简单尾部截断：超过 limit 字符就保留头部 + 末尾占位提示。
fn truncate_for_attachment(text: &str, limit: usize) -> (String, bool) {
    let count = text.chars().count();
    if count <= limit {
        return (text.to_string(), false);
    }
    let kept: String = text.chars().take(limit).collect();
    let tail = format!(
        "\n\n…（后续 {} 字符已省略，超出附件单文件 {} 字符限制）",
        count - limit,
        limit
    );
    (kept + &tail, true)
}

/// 把附件 markdown 拼到 user message 前面发给 AI。
///
/// 设计取舍：附件区跟随 user message 一并存进数据库（消息历史），
/// 这样多轮追问时 AI 仍能"看见"原始表格；代价是数据库里这条消息体积变大。
/// MVP 阶段不引入新表 / 不改 schema —— UI 端如果想折叠展示，靠头部前缀
/// `📎 附件` 做正则识别就够用。
pub fn build_message_with_attachments(text: &str, attachments: &[MessageAttachment]) -> String {
    if attachments.is_empty() {
        return text.to_string();
    }
    let mut out = String::new();
    out.push_str(&format!(
        "📎 用户附带了 {} 个附件，内容如下：\n\n",
        attachments.len()
    ));
    for (i, att) in attachments.iter().enumerate() {
        match att {
            MessageAttachment::Excel {
                display_name,
                markdown,
                total_rows,
                truncated_sheets,
                ..
            } => {
                let trunc_hint = if truncated_sheets.is_empty() {
                    String::new()
                } else {
                    format!("，已自动截断 sheet：{}", truncated_sheets.join("、"))
                };
                out.push_str(&format!(
                    "## 附件 {}: {} （Excel，共 {} 行{}）\n{}\n\n",
                    i + 1,
                    display_name,
                    total_rows,
                    trunc_hint,
                    markdown
                ));
            }
            MessageAttachment::Text {
                display_name,
                content,
                truncated,
                ..
            } => {
                let trunc_hint = if *truncated { "，尾部已截断" } else { "" };
                out.push_str(&format!(
                    "## 附件 {}: {} （文本{}）\n```\n{}\n```\n\n",
                    i + 1,
                    display_name,
                    trunc_hint,
                    content
                ));
            }
            MessageAttachment::Pdf {
                display_name,
                content,
                truncated,
                ..
            } => {
                let trunc_hint = if *truncated { "，尾部已截断" } else { "" };
                out.push_str(&format!(
                    "## 附件 {}: {} （PDF 文字层{}）\n{}\n\n",
                    i + 1,
                    display_name,
                    trunc_hint,
                    content
                ));
            }
        }
    }
    out.push_str("---\n\n");
    out.push_str(text);
    out
}

/// 根据 Excel 解析结果生成给前端的友好警告（仅桌面端：依赖 excel_parser）
#[cfg(desktop)]
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
        let raw =
            "```json\n{\"title\":\"x\",\"content\":\"c\",\"folderPath\":\"\",\"reason\":null}\n```";
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
                color: None,
            }],
            note_count: 0,
            color: None,
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
        let raw =
            r#"{"tasks":[{"title":"写周报","priority":1,"dueDate":"2026-04-24"}],"summary":"忙"}"#;
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

/// 解析 AI 返回的 TaskSuggestion JSON（三轮兜底，与 plan_today 同模式）
fn parse_task_suggestion_response(raw: &str) -> Option<TaskSuggestion> {
    if let Ok(r) = serde_json::from_str::<TaskSuggestion>(raw.trim()) {
        return Some(r);
    }
    let stripped = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    if let Ok(r) = serde_json::from_str::<TaskSuggestion>(stripped) {
        return Some(r);
    }
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str(&raw[start..=end]).ok()
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
