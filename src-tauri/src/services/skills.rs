//! AI Skills 框架 v1 — 让 AI 在对话里调用本地只读工具
//!
//! 设计要点（详见 docs/tasks/bilibili-feedback-tasks.md T-004）：
//! - **只读**：v1 只暴露查询类接口（搜索/读笔记/列标签/查关联/看今日待办），
//!   避免 AI 误删/误改；写入类（创建/删除/移动）放 v2 + 二次确认
//! - **OpenAI function-calling 兼容**：`tool_schemas()` 返回符合 OpenAI `tools` 字段
//!   的 JSON，其他厂商（DeepSeek/智谱/Claude 代理）都能复用这套 schema
//! - **dispatch 集中执行**：`dispatch(db, name, args_json, scope_ids)` 按 skill name 路由到
//!   具体实现；返回的 result 字符串会经由 AI 流式通道回注到模型作为 tool role 消息
//! - **结果截断**：防 token 爆炸，笔记/列表类返回统一裁剪到 ~2000 字节
//!
//! 不在本模块做的事：
//! - 不做 tool_calls 流式解析（在 `services::ai::chat_stream_with_skills` 里）
//! - 不做持久化（在 `database::ai` 里）
//! - 不做前端渲染（在 `src/pages/ai` 里）

use serde::Deserialize;
use serde_json::{json, Value};

use crate::database::Database;
use crate::error::AppError;
use crate::models::TaskQuery;
use crate::state::AppState;
use rmcp::model::CallToolRequestParams;
use tauri::{AppHandle, Manager};

/// 结果字符串长度上限（按字符计），超过的部分被截断并用 "…（已截断）" 标记
const SKILL_RESULT_MAX_CHARS: usize = 2000;

/// 按 OpenAI tools 格式返回所有可用 skill 的 schema
///
/// 返回的 Value 可以直接塞到 chat/completions 请求的 `tools` 字段里，
/// 形如：`{"type":"function","function":{"name":"xxx","description":"...","parameters":{...}}}`
pub fn tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "function": {
                "name": "search_notes",
                "description": "搜索用户的本地笔记，返回匹配的标题和摘要。用于找与用户问题相关的笔记内容。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "搜索关键词，可中英文" },
                        "limit": { "type": "integer", "description": "最多返回几条，默认 5，最大 20", "default": 5 }
                    },
                    "required": ["query"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "get_note",
                "description": "按 ID 读取一篇笔记的完整内容。在 search_notes 找到目标后，用这个取全文。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "integer", "description": "笔记 ID" }
                    },
                    "required": ["id"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "list_tags",
                "description": "列出所有标签及每个标签关联的笔记数。用于了解知识库的主题分布。",
                "parameters": { "type": "object", "properties": {} }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "find_related",
                "description": "查找与指定笔记相关的笔记（反向链接 [[wiki-link]]）。用于顺藤摸瓜。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "note_id": { "type": "integer", "description": "起始笔记 ID" }
                    },
                    "required": ["note_id"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "get_today_tasks",
                "description": "获取用户今天的待办任务（未完成）。用于回答\"我今天要做什么\"。",
                "parameters": { "type": "object", "properties": {} }
            }
        }),
    ]
}

/// 所有已知 skill 的名字集合，用于拒绝未知工具调用
pub fn known_skill_names() -> &'static [&'static str] {
    &[
        "search_notes",
        "get_note",
        "list_tags",
        "find_related",
        "get_today_tasks",
    ]
}

// ─── dispatch 入口 ─────────────────────────────

/// 按 name 路由到具体实现，返回字符串化的结果（已截断）
///
/// 返回 `Err(AppError)` 代表执行失败（DB 错误 / 参数解析失败 / 未知 skill 等），
/// 调用方（`services::ai`）把错误消息当作 tool result 回注给 AI，让 AI 有机会自我修正。
///
/// `scope_ids`：文件夹范围会话（"对此文件夹问 AI"）展开后的「文件夹 + 所有子孙」id 列表。
/// `Some(&[..])` 时，笔记检索/读取类工具只在这些文件夹内作答，范围外硬性拒绝；`None` = 全库。
pub fn dispatch(
    db: &Database,
    name: &str,
    args_json: &str,
    scope_ids: Option<&[i64]>,
) -> Result<String, AppError> {
    let result = match name {
        "search_notes" => run_search_notes(db, args_json, scope_ids)?,
        "get_note" => run_get_note(db, args_json, scope_ids)?,
        "list_tags" => run_list_tags(db)?,
        "find_related" => run_find_related(db, args_json, scope_ids)?,
        "get_today_tasks" => run_get_today_tasks(db)?,
        other => {
            return Err(AppError::Custom(format!(
                "未知 skill: {}。可用：{}",
                other,
                known_skill_names().join(", ")
            )));
        }
    };
    Ok(truncate(&result, SKILL_RESULT_MAX_CHARS))
}

// ─── MCP 集成：把内置 kb-core 工具 + 外部 MCP server 的工具注入到 ai 对话 ─

/// 外部 MCP 子进程工具命名前缀。完整工具名 = `mcp__<server_id>__<tool_name>`。
/// 用 server_id 而非 name 是因为 OpenAI tool name 规范严格（`^[a-zA-Z0-9_-]{1,64}$`），
/// server name 可能含中文/空格，避免做 sanitize 转换。
const MCP_TOOL_PREFIX: &str = "mcp__";

/// 内置 kb-core 工具命名前缀。完整工具名 = `kb__<tool_name>`。
/// 加前缀是为了：
///   1) 与 5 个高层 skills（search_notes 等）做名字隔离，避免重名
///   2) dispatch 时一眼能看出走 in-memory MCP 路径而不是 5 skills 的 db 直连
const KB_TOOL_PREFIX: &str = "kb__";

/// 按 OpenAI tools 格式返回所有可用工具：
///   - 5 个高层内置 skills（直接 db 调用，最快）
///   - 内置 kb-core 工具（in-memory MCP，前缀 `kb__`，含 11 个写工具）
///   - 所有 enabled 外部 MCP server 的工具（仅桌面端，前缀 `mcp__<id>__`）
///
/// 写工具拦截在 dispatch 入口做，list 阶段全量暴露 schema —— 模型能"看到"自己有能力，
/// 关掉「AI 写权限」开关时调用才会被拒；这样模型才会主动尝试写操作并把拦截信息反馈给用户。
///
/// 失败的 server（spawn 失败 / 握手失败 / list_tools 失败）只 log warn，
/// 不阻塞 ai 对话流；用户在设置页应该会看到 server 状态。
pub async fn tool_schemas_with_mcp(app: &AppHandle) -> Vec<Value> {
    let mut schemas = tool_schemas(); // 5 个高层内置 skills

    let state = match app.try_state::<AppState>() {
        Some(s) => s,
        None => {
            log::warn!("[ai-mcp] AppState not ready, skipping MCP tools");
            return schemas;
        }
    };

    // ─── 内置 kb-core 工具（桌面 + 移动都暴露） ─────────
    // 5 个高层 skills 已有的名字直接跳过（search_notes / get_note / list_tags 等），
    // 避免 LLM 看到两套近似工具时来回纠结
    if let Some(client) = state.mcp_internal.as_ref().cloned() {
        match client.list_all_tools().await {
            Ok(tools) => {
                let builtin_names: std::collections::HashSet<&str> =
                    known_skill_names().iter().copied().collect();
                for t in tools {
                    let raw_name: &str = t.name.as_ref();
                    if builtin_names.contains(raw_name) {
                        continue;
                    }
                    let prefixed_name = format!("{}{}", KB_TOOL_PREFIX, raw_name);
                    let safe_name = if prefixed_name.len() > 64 {
                        prefixed_name.chars().take(64).collect::<String>()
                    } else {
                        prefixed_name
                    };
                    let desc = t
                        .description
                        .as_deref()
                        .unwrap_or("(无说明)")
                        .to_string();
                    schemas.push(json!({
                        "type": "function",
                        "function": {
                            "name": safe_name,
                            "description": desc,
                            "parameters": *t.input_schema,
                        }
                    }));
                }
            }
            Err(e) => {
                log::warn!("[ai-mcp] list kb-core tools 失败: {e}; skip kb__* schemas");
            }
        }
    } else {
        log::warn!("[ai-mcp] state.mcp_internal 未就绪，跳过 kb__* schemas");
    }

    // ─── 外部 MCP server 工具（仅桌面端） ─────────
    #[cfg(desktop)]
    {
        let servers = match state.db.list_mcp_servers() {
            Ok(list) => list.into_iter().filter(|s| s.enabled).collect::<Vec<_>>(),
            Err(e) => {
                log::warn!("[ai-mcp] list_mcp_servers 失败: {e}");
                return schemas;
            }
        };

        for server in servers {
            let client = match state.mcp_external.get_or_spawn(&server).await {
                Ok(c) => c,
                Err(e) => {
                    log::warn!(
                        "[ai-mcp] spawn server '{}' (id={}) 失败: {}; skip",
                        server.name,
                        server.id,
                        e
                    );
                    continue;
                }
            };
            let tools = match client.list_all_tools().await {
                Ok(t) => t,
                Err(e) => {
                    log::warn!(
                        "[ai-mcp] list_tools '{}' (id={}) 失败: {}; skip",
                        server.name,
                        server.id,
                        e
                    );
                    continue;
                }
            };

            for t in tools {
                let prefixed_name =
                    format!("{}{}__{}", MCP_TOOL_PREFIX, server.id, t.name.as_ref());
                // OpenAI tool name 规范：64 字符 + 限定字符。截断保险一下
                let safe_name = if prefixed_name.len() > 64 {
                    prefixed_name.chars().take(64).collect::<String>()
                } else {
                    prefixed_name
                };
                let desc = format!(
                    "[MCP/{}] {}",
                    server.name,
                    t.description.as_deref().unwrap_or("(无说明)")
                );
                schemas.push(json!({
                    "type": "function",
                    "function": {
                        "name": safe_name,
                        "description": desc,
                        "parameters": *t.input_schema,
                    }
                }));
            }
        }
    }

    schemas
}

/// dispatch 增强版：按工具名前缀路由
/// - `kb__<name>` 走 in-memory MCP client（kb-core 工具，桌面+移动都支持）
/// - `mcp__<id>__<name>` 走 mcp_external client（外部 MCP 子进程，仅桌面端）
/// - 其他名字走原 dispatch（5 个高层内置 skills）
pub async fn dispatch_with_mcp(
    app: &AppHandle,
    db: &Database,
    name: &str,
    args_json: &str,
    scope_ids: Option<&[i64]>,
) -> Result<String, AppError> {
    // kb__ 前缀（内置 kb-core 工具）—— 写权限在 dispatch_kb_internal 里拦截；
    // 文件夹范围会话下，kb-core 返回的笔记类结果在 dispatch_kb_internal 里按 scope 硬过滤
    if let Some(suffix) = name.strip_prefix(KB_TOOL_PREFIX) {
        return dispatch_kb_internal(app, suffix, args_json, scope_ids).await;
    }

    // mcp__<id>__<name> 前缀（外部 MCP 子进程）—— 仅桌面端
    #[cfg(desktop)]
    if let Some(suffix) = name.strip_prefix(MCP_TOOL_PREFIX) {
        let (id_str, tool_name) = suffix.split_once("__").ok_or_else(|| {
            AppError::Custom(format!(
                "MCP 工具名格式错误: {}（应为 mcp__<id>__<name>）",
                name
            ))
        })?;
        let server_id: i64 = id_str
            .parse()
            .map_err(|_| AppError::Custom(format!("MCP 工具 server_id 解析失败: {}", id_str)))?;
        return dispatch_mcp(app, server_id, tool_name, args_json).await;
    }
    #[cfg(mobile)]
    let _ = app; // 移动端避免未使用警告（仅当也不走 kb__ 分支时）

    // 5 个高层内置 skills（无前缀）
    dispatch(db, name, args_json, scope_ids)
}

/// 走 in-memory MCP client 调用 kb-core 工具，写工具走相同拦截门
async fn dispatch_kb_internal(
    app: &AppHandle,
    tool_name: &str,
    args_json: &str,
    scope_ids: Option<&[i64]>,
) -> Result<String, AppError> {
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| AppError::Custom("AppState 未就绪".into()))?;

    // 写工具拦截：与 commands::mcp::mcp_internal_call_tool 共享同一份名单 + 同一份开关
    // —— AI 对话路径绕过了那个 Command，所以在这儿要单独再拦一次
    if crate::commands::mcp::is_kb_write_tool(tool_name)
        && !crate::commands::mcp::read_ai_writable(&state)
    {
        return Err(AppError::Custom(format!(
            "AI 写权限已关闭。要让 AI 修改你的知识库，请到 设置 → MCP 服务器 \
             或 AI 问答页顶部 打开「AI 写权限」开关。被拦截的工具：{tool_name}"
        )));
    }

    let client = state
        .mcp_internal
        .as_ref()
        .ok_or_else(|| AppError::Custom("in-memory MCP server 未就绪".into()))?
        .clone();

    // 解析 args_json 为 JsonObject（rmcp call_tool 要求 Map<String, Value>）
    let args_value: Value = serde_json::from_str(args_json).unwrap_or(Value::Null);
    let args_object = match args_value {
        Value::Object(m) => Some(m),
        Value::Null => None,
        other => {
            return Err(AppError::Custom(format!(
                "kb__ 工具参数应为 JSON object，收到: {}",
                other
            )));
        }
    };

    let mut req = CallToolRequestParams::new(tool_name.to_string());
    if let Some(obj) = args_object {
        req = req.with_arguments(obj);
    }

    let result = client
        .call_tool(req)
        .await
        .map_err(|e| AppError::Custom(format!("call_tool({tool_name}) 失败: {e}")))?;

    let mut out = String::new();
    for c in &result.content {
        if let Some(text) = c.as_text() {
            out.push_str(&text.text);
        }
    }
    if result.is_error.unwrap_or(false) {
        return Err(AppError::Custom(format!("MCP 工具返回错误: {out}")));
    }
    // 文件夹范围会话：对 kb-core 返回的笔记类结果按 scope 硬过滤（范围外的笔记剔除）
    let out = match scope_ids {
        Some(scope) => filter_kb_result_by_scope(&out, scope),
        None => out,
    };
    Ok(truncate(&out, SKILL_RESULT_MAX_CHARS))
}

/// 文件夹范围会话下，对内置 kb-core 工具返回的 JSON 结果做"硬过滤"。
///
/// 规则（只针对"笔记"类结果，不误伤标签/文件夹/任务/模板等非笔记结果）：
/// - 结果是数组：逐个元素判断——对象若含 `folder_id` 字段，folder_id 必须 ∈ scope 才保留
///   （`null` 即未分类笔记，不属于任何具体文件夹子树，剔除）；不含 `folder_id` 字段的对象
///   （TagInfo / FolderInfo / TaskRow 等）一律保留；非对象元素保留。
/// - 结果是单对象（如 get_note 的 NoteDetail）：含 `folder_id` 且越界 → 替换为越界提示。
/// - 非 JSON（纯文本）或其它形状：原样返回。
///
/// 已知小缺口：get_backlinks（BacklinkRef 无 folder_id）/ list_trash（回收站项无 folder_id）
/// 这类不含 folder_id 的笔记类结果无法在此层过滤，保持原样；高层 find_related 已单独按 scope 过滤。
fn filter_kb_result_by_scope(raw: &str, scope_ids: &[i64]) -> String {
    let parsed: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return raw.to_string(),
    };
    // 对象是否命中范围：有 folder_id 字段且为范围内数字才算命中
    let obj_in_scope = |obj: &Value| -> bool {
        match obj.get("folder_id") {
            Some(Value::Number(n)) => n.as_i64().map_or(false, |f| scope_ids.contains(&f)),
            Some(_) => false, // null 或异常类型：未分类/越界，剔除
            None => true,     // 非笔记类结果（无 folder_id 字段），保留
        }
    };
    match parsed {
        Value::Array(items) => {
            let kept: Vec<Value> = items
                .into_iter()
                .filter(|it| !it.is_object() || obj_in_scope(it))
                .collect();
            serde_json::to_string(&kept).unwrap_or_else(|_| "[]".to_string())
        }
        Value::Object(ref map) => {
            if map.contains_key("folder_id") && !obj_in_scope(&parsed) {
                json!({ "error": "该笔记不在当前对话限定的文件夹范围内，无法访问。" }).to_string()
            } else {
                raw.to_string()
            }
        }
        _ => raw.to_string(),
    }
}

#[cfg(desktop)]
async fn dispatch_mcp(
    app: &AppHandle,
    server_id: i64,
    tool_name: &str,
    args_json: &str,
) -> Result<String, AppError> {
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| AppError::Custom("AppState 未就绪".into()))?;

    let server = state
        .db
        .get_mcp_server(server_id)?
        .ok_or_else(|| AppError::Custom(format!("MCP server {} 不存在", server_id)))?;

    let client = state
        .mcp_external
        .get_or_spawn(&server)
        .await
        .map_err(|e| AppError::Custom(format!("spawn MCP server 失败: {e}")))?;

    // 解析 args_json 为 JsonObject（rmcp call_tool 要求 Map<String, Value>）
    let args_value: Value = serde_json::from_str(args_json).unwrap_or(Value::Null);
    let args_object = match args_value {
        Value::Object(m) => Some(m),
        Value::Null => None,
        other => {
            return Err(AppError::Custom(format!(
                "MCP 工具参数应为 JSON object，收到: {}",
                other
            )));
        }
    };

    let mut req = CallToolRequestParams::new(tool_name.to_string());
    if let Some(obj) = args_object {
        req = req.with_arguments(obj);
    }

    let result = client
        .call_tool(req)
        .await
        .map_err(|e| AppError::Custom(format!("call_tool({tool_name}) 失败: {e}")))?;

    let mut out = String::new();
    for c in &result.content {
        if let Some(text) = c.as_text() {
            out.push_str(&text.text);
        }
    }
    if result.is_error.unwrap_or(false) {
        return Err(AppError::Custom(format!("MCP 工具返回错误: {out}")));
    }
    Ok(truncate(&out, SKILL_RESULT_MAX_CHARS))
}

// ─── 各 skill 实现 ────────────────────────────

#[derive(Debug, Deserialize)]
struct SearchNotesArgs {
    query: String,
    #[serde(default)]
    limit: Option<u32>,
}

fn run_search_notes(
    db: &Database,
    args: &str,
    scope_ids: Option<&[i64]>,
) -> Result<String, AppError> {
    let a: SearchNotesArgs = serde_json::from_str(args)
        .map_err(|e| AppError::Custom(format!("search_notes 参数非法: {}", e)))?;
    let limit = a.limit.unwrap_or(5).clamp(1, 20) as usize;
    // 文件夹范围会话：scope_ids 限定只在该文件夹（含子孙）内检索；None = 全库。
    let notes = db.search_notes_for_rag(&a.query, limit, scope_ids)?;
    if notes.is_empty() {
        return Ok("未找到相关笔记".to_string());
    }
    let hits: Vec<Value> = notes
        .into_iter()
        .map(|(id, title, content)| {
            // 给 AI 一个 250 字摘要足够判断是否相关，再决定要不要 get_note 读全文
            let snippet = summarize_content(&content, 250);
            json!({ "id": id, "title": title, "snippet": snippet })
        })
        .collect();
    Ok(serde_json::to_string(&json!({ "hits": hits })).unwrap_or_else(|_| "[]".to_string()))
}

#[derive(Debug, Deserialize)]
struct GetNoteArgs {
    id: i64,
}

fn run_get_note(
    db: &Database,
    args: &str,
    scope_ids: Option<&[i64]>,
) -> Result<String, AppError> {
    let a: GetNoteArgs = serde_json::from_str(args)
        .map_err(|e| AppError::Custom(format!("get_note 参数非法: {}", e)))?;
    let note = db
        .get_note(a.id)?
        .ok_or_else(|| AppError::Custom(format!("笔记 #{} 不存在", a.id)))?;
    // 文件夹范围会话：拒绝读取范围外的笔记（即使模型猜到了 id）。
    if let Some(scope) = scope_ids {
        let in_scope = note.folder_id.map_or(false, |f| scope.contains(&f));
        if !in_scope {
            return Err(AppError::Custom(format!(
                "笔记 #{} 不在当前对话限定的文件夹范围内，无法读取。",
                a.id
            )));
        }
    }
    // content 是 markdown，直接回给 AI；截断在 dispatch 尾部统一做
    Ok(serde_json::to_string(&json!({
        "id": note.id,
        "title": note.title,
        "content": note.content,
        "folder_id": note.folder_id,
        "updated_at": note.updated_at,
    }))
    .unwrap_or_else(|_| "{}".to_string()))
}

fn run_list_tags(db: &Database) -> Result<String, AppError> {
    let tags = db.list_tags()?;
    let arr: Vec<Value> = tags
        .into_iter()
        .map(|t| json!({ "id": t.id, "name": t.name, "note_count": t.note_count }))
        .collect();
    Ok(serde_json::to_string(&arr).unwrap_or_else(|_| "[]".to_string()))
}

#[derive(Debug, Deserialize)]
struct FindRelatedArgs {
    note_id: i64,
}

fn run_find_related(
    db: &Database,
    args: &str,
    scope_ids: Option<&[i64]>,
) -> Result<String, AppError> {
    let a: FindRelatedArgs = serde_json::from_str(args)
        .map_err(|e| AppError::Custom(format!("find_related 参数非法: {}", e)))?;
    let links = db.get_backlinks(a.note_id)?;
    // 文件夹范围会话：只保留来源笔记在范围内的反链（BacklinkRef 自身无 folder_id，按 source_id 批量查）。
    let links = match scope_ids {
        Some(scope) => {
            let ids: Vec<i64> = links.iter().map(|l| l.source_id).collect();
            let fmap = db.note_folder_map(&ids)?;
            links
                .into_iter()
                .filter(|l| {
                    fmap.get(&l.source_id)
                        .and_then(|f| *f)
                        .map_or(false, |f| scope.contains(&f))
                })
                .collect::<Vec<_>>()
        }
        None => links,
    };
    if links.is_empty() {
        return Ok(r#"{"backlinks":[]}"#.to_string());
    }
    let arr: Vec<Value> = links
        .into_iter()
        .map(|l| {
            json!({
                "source_id": l.source_id,
                "source_title": l.source_title,
                "context": l.context,
            })
        })
        .collect();
    Ok(serde_json::to_string(&json!({ "backlinks": arr })).unwrap_or_else(|_| "{}".to_string()))
}

fn run_get_today_tasks(db: &Database) -> Result<String, AppError> {
    // TaskQuery.status = Some(0) 表示只看未完成
    let query = TaskQuery {
        status: Some(0),
        keyword: None,
        priority: None,
        category_id: None,
        uncategorized: None,
    };
    let tasks = db.list_tasks(query)?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    // 过滤：due_date 是今天 或 过期的（视为今天要处理）；没截止也算今日需关注
    let filtered: Vec<Value> = tasks
        .into_iter()
        .filter(|t| match &t.due_date {
            Some(d) => d.starts_with(&today) || d.as_str() < today.as_str(),
            None => true,
        })
        .map(|t| {
            json!({
                "id": t.id,
                "title": t.title,
                "priority": t.priority,
                "due_date": t.due_date,
                "important": t.important,
            })
        })
        .collect();
    Ok(serde_json::to_string(&json!({
        "date": today,
        "tasks": filtered,
    }))
    .unwrap_or_else(|_| "{}".to_string()))
}

// ─── 工具函数 ─────────────────────────────────

/// 按字符截断，超长时追加省略提示（避免 AI 以为得到了完整内容）
fn truncate(s: &str, max_chars: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max_chars {
        return s.to_string();
    }
    let head: String = chars.iter().take(max_chars).collect();
    format!("{}…（已截断，共 {} 字符）", head, chars.len())
}

/// 去 HTML/多余空白后取前 N 字符，给 AI 当"摘要"看
fn summarize_content(content: &str, max_chars: usize) -> String {
    let mut s = String::with_capacity(content.len());
    let mut in_tag = false;
    for ch in content.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => s.push(ch),
            _ => {}
        }
    }
    let collapsed: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate(&collapsed, max_chars)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_preserves_short_strings() {
        assert_eq!(truncate("hello", 10), "hello");
    }

    #[test]
    fn truncate_adds_suffix_when_over_limit() {
        let out = truncate("abcdefghij", 3);
        assert!(out.starts_with("abc…"));
        assert!(out.contains("共 10"));
    }

    #[test]
    fn summarize_strips_html_and_whitespace() {
        let raw = "<p>hello   <b>world</b></p>  foo";
        assert_eq!(summarize_content(raw, 100), "hello world foo");
    }

    #[test]
    fn scope_filter_array_drops_out_of_folder_notes() {
        // 笔记数组：folder_id ∈ scope 保留；越界 / null（未分类）剔除
        let raw = r#"[
            {"id":1,"title":"in","folder_id":10},
            {"id":2,"title":"out","folder_id":99},
            {"id":3,"title":"uncat","folder_id":null}
        ]"#;
        let out = filter_kb_result_by_scope(raw, &[10, 11]);
        let v: Value = serde_json::from_str(&out).unwrap();
        let arr = v.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["id"], 1);
    }

    #[test]
    fn scope_filter_keeps_non_note_results() {
        // 标签 / 文件夹等无 folder_id 字段的结果不被误伤
        let raw = r#"[{"id":1,"name":"标签A","note_count":3}]"#;
        let out = filter_kb_result_by_scope(raw, &[10]);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v.as_array().unwrap().len(), 1);
    }

    #[test]
    fn scope_filter_single_note_out_of_scope_becomes_error() {
        let raw = r#"{"id":5,"title":"x","content":"...","folder_id":99}"#;
        let out = filter_kb_result_by_scope(raw, &[10]);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("error").is_some());
    }

    #[test]
    fn scope_filter_passthrough_non_json() {
        // 纯文本（如 ping 的 "pong"）原样返回
        assert_eq!(filter_kb_result_by_scope("pong", &[10]), "pong");
    }

    #[test]
    fn tool_schemas_contain_all_known_skills() {
        let schemas = tool_schemas();
        let names: Vec<String> = schemas
            .iter()
            .filter_map(|v| v["function"]["name"].as_str().map(String::from))
            .collect();
        for &k in known_skill_names() {
            assert!(names.contains(&k.to_string()), "missing schema for {}", k);
        }
    }
}
