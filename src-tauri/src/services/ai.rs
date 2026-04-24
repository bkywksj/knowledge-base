use futures::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

use crate::database::Database;
use crate::error::AppError;
use crate::models::{AiMessage, AiModel, SkillCall};
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

/// 围绕用户问题关键词命中点，从笔记正文中截取窗口片段供 RAG 上下文使用。
///
/// 旧实现 `chars().take(500)` 只取开头 500 字，命中段在文档后半部时 AI 完全看不到。
/// 改为：复用 `Database::extract_keywords` 得到和检索一致的关键词集合，取**最早命中位置**
/// 居中的 `window` 字符窗口；未命中则降级为从头取 `window` 字符；首尾被裁剪用 `…` 标记，
/// 提示 AI 这是片段而非整篇。
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
            // OpenAI 兼容协议族：OpenAI / Claude 兼容代理 / DeepSeek / 智谱 GLM
            "openai" | "claude" | "deepseek" | "zhipu" => {
                Self::stream_openai_generic(&write_app, &model, &messages, cancel_rx).await?
            }
            _ => {
                return Err(AppError::Custom(format!(
                    "不支持的模型提供商: {}",
                    model.provider
                )));
            }
        };

        let _ = app.emit("ai-write:done", "");
        Ok(())
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
        // 1. 获取对话使用的模型
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

        // 2. RAG: 检索相关笔记
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
            let messages = Self::build_messages(&model, &history, &rag_context, max_hist);

            log::info!("AI Request: model={}, messages={}, max_history={}",
                model.model_id, messages.len(), max_hist);

            let result = match model.provider.as_str() {
                "ollama" => {
                    Self::stream_ollama(&app, &model, &messages, cancel_rx.clone()).await
                }
                // OpenAI 兼容协议族：OpenAI / Claude 兼容代理 / DeepSeek / 智谱 GLM
                "openai" | "claude" | "deepseek" | "zhipu" => {
                    Self::stream_openai_compatible(&app, &model, &messages, cancel_rx.clone())
                        .await
                }
                _ => {
                    return Err(AppError::Custom(format!(
                        "不支持的模型提供商: {}",
                        model.provider
                    )));
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

        if !matches!(model.provider.as_str(), "openai" | "claude" | "deepseek" | "zhipu") {
            return Err(AppError::Custom(format!(
                "Skills 功能暂不支持 {} 协议，请切换到 OpenAI / DeepSeek / 智谱 / Claude 兼容模型。",
                model.provider
            )));
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

            let (content, tool_calls) = Self::stream_openai_with_tools(
                &app,
                &model,
                &messages,
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
                // 模型给出最终答复
                final_content = content;
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
