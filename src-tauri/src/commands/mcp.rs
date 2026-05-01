//! MCP Commands：把同进程内的 in-memory MCP server 暴露给前端
//!
//! 这一组 IPC 走"双层"路径：
//!   前端 invoke("mcp_internal_call_tool", ...)
//!     → commands::mcp::* (本文件)
//!     → state.mcp_internal (rmcp client)
//!     → kb_core::KbServer (in-process MCP server，通过 tokio::io::duplex 通信)
//!     → SQL on shared db
//!
//! 看似绕了一圈，但好处：
//!   1) 自家 AI 对话页和外部 Claude Desktop 用完全同一份工具实现（kb-core 12 工具）
//!   2) 后续接外部 MCP server 时（GitHub / Filesystem / 高德地图…）可以走同样的 client API
//!   3) 协议统一，UI 不需要区分"原生工具"和"外部工具"

use std::path::PathBuf;

use rmcp::model::CallToolRequestParams;
use serde::Serialize;
use serde_json::Value as JsonValue;

use crate::models::{McpServer, McpServerInput};
use crate::state::AppState;

/// 主应用编译时被 tauri-build 注入的 target triple，
/// 用来构造 sidecar binary 名字（与 scripts/build-mcp.mjs 的命名一致）
const TARGET_TRIPLE: &str = env!("TAURI_ENV_TARGET_TRIPLE");

/// 设置页 "MCP 服务器" 卡片的运行时信息
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRuntimeInfo {
    /// in-memory MCP server 是否就绪
    pub internal_ready: bool,
    /// kb-mcp sidecar binary 在本机的绝对路径（None 表示找不到，提示用户先 pnpm build:mcp）
    pub sidecar_binary_path: Option<String>,
    /// 知识库 db 绝对路径，给 Claude Desktop config JSON 用
    pub db_path: String,
    /// Host target triple（如 x86_64-pc-windows-msvc）
    pub target_triple: String,
    /// 当前操作系统（"windows" / "macos" / "linux"），方便前端选择对应的配置示例
    pub os: String,
}

/// 设置页用：拿 sidecar 路径 + db 路径，生成客户端配置 JSON
#[tauri::command]
pub fn mcp_runtime_info(state: tauri::State<'_, AppState>) -> Result<McpRuntimeInfo, String> {
    // db 路径：与 lib.rs setup 里 Database::init 用的同一逻辑
    let prefix = if cfg!(debug_assertions) { "dev-" } else { "" };
    let db_path = state.data_dir.join(format!("{}app.db", prefix));

    Ok(McpRuntimeInfo {
        internal_ready: state.mcp_internal.is_some(),
        sidecar_binary_path: locate_sidecar_binary().map(|p| p.to_string_lossy().into_owned()),
        db_path: db_path.to_string_lossy().into_owned(),
        target_triple: TARGET_TRIPLE.to_string(),
        os: std::env::consts::OS.to_string(),
    })
}

/// 设置页 「Claude Code (CLI)」Tab 用：返回拼好的 CLAUDE.md 模板 + settings.json 片段
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeTemplate {
    /// CLAUDE.md 完整内容（行为指引），用户复制到项目根或 ~/.claude/CLAUDE.md
    pub claude_md: String,
    /// ~/.claude/settings.json 的 mcpServers 片段（只读模式），用户合并到自己的 settings.json
    pub settings_snippet_readonly: String,
    /// 同上但 args 加了 --writable，让 LLM 能改笔记
    pub settings_snippet_writable: String,
}

/// 拼 Claude Code 集成需要的两份文本，sidecar 路径 / db 路径都填好
#[tauri::command]
pub fn mcp_get_claude_md_template(
    state: tauri::State<'_, AppState>,
) -> Result<ClaudeCodeTemplate, String> {
    let prefix = if cfg!(debug_assertions) { "dev-" } else { "" };
    let db_path = state.data_dir.join(format!("{}app.db", prefix));
    let db_path_str = db_path.to_string_lossy().to_string();
    let sidecar = locate_sidecar_binary()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "<请先 pnpm build:mcp 编译 sidecar>".to_string());

    let claude_md = build_claude_md_template();
    let settings_snippet_readonly = build_settings_snippet(&sidecar, &db_path_str, false);
    let settings_snippet_writable = build_settings_snippet(&sidecar, &db_path_str, true);

    Ok(ClaudeCodeTemplate {
        claude_md,
        settings_snippet_readonly,
        settings_snippet_writable,
    })
}

fn build_claude_md_template() -> String {
    // 这里硬编码模板，避免读盘 / 拼接复杂度。后续如果需要可填变量再扩展
    r#"# 知识库助手 (kb-mcp)

本环境已接入用户的本地知识库（MCP server `knowledge-base`，由 [zhuawashi/knowledge_base] 桌面应用提供）。
处理用户问题时遵循以下准则。

## 可用工具

**读工具（默认可用）**：
- `search_notes(query, limit?)` — 全文搜索笔记
- `get_note(id)` — 按 id 读笔记全文
- `list_tags` — 所有标签 + 笔记数
- `search_by_tag(tag, limit?)` — 按标签筛选
- `get_backlinks(id)` — 反向链接（哪些笔记引用了它）
- `list_daily_notes(days?, limit?)` — 最近 N 天日记
- `list_tasks(status?, keyword?, limit?)` — 主任务列表
- `get_prompt(id?, builtin_code?)` — Prompt 模板

**写工具（需 `--writable` 启动开关，需用户授权）**：
- `create_note(title, content, folder_id?)` — 创建新笔记
- `update_note(id, title?, content?, folder_id?)` — 修改笔记
- `add_tag_to_note(note_id, tag)` — 给笔记加标签

## 行为准则

1. **任何关于"我的笔记 / 想法 / 任务"的问题，先调 `search_notes` 搜索**，不要凭印象编造。
2. `search_notes` 返回 snippet 后，按需调 `get_note(id)` 读全文。
3. 用户说"帮我记下…"时，先确认 `--writable` 已启用，再调 `create_note`。
4. 加密笔记的 content 自动脱敏（占位符），不要追问内容。
5. 反链查询用 `get_backlinks(id)`，不是 `search_notes`。
6. 创建新笔记前，先 `list_tags` 看现有标签，优先复用而不是制造新标签。
7. 回答用中文，简洁准确。

## 个人偏好

- 默认回复语言：中文
- 新笔记默认 `folder_id`：null（未分类）
- 时间格式：`YYYY-MM-DD`

> 上面的偏好可以按你的实际习惯改。
"#.to_string()
}

fn build_settings_snippet(sidecar: &str, db: &str, writable: bool) -> String {
    let mut args = vec!["--db-path".to_string(), db.to_string()];
    if writable {
        args.push("--writable".to_string());
    }
    let cfg = serde_json::json!({
        "mcpServers": {
            "knowledge-base": {
                "command": sidecar,
                "args": args,
            }
        }
    });
    serde_json::to_string_pretty(&cfg).unwrap_or_else(|_| "{}".to_string())
}

/// 找 kb-mcp binary：优先主 exe 同目录（externalBin 打包后位置 = cargo workspace target/<profile>/）
/// dev 期主 exe 与 sidecar 都在 target/debug/，安装后 externalBin 也在主 exe 旁边
fn locate_sidecar_binary() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;

    let exe_suffix = if cfg!(target_os = "windows") { ".exe" } else { "" };
    // 候选 1：dev 期 cargo build -p kb-mcp 出来的产物（无 triple 后缀）
    let dev_path = dir.join(format!("kb-mcp{}", exe_suffix));
    if dev_path.exists() {
        return Some(dev_path);
    }
    // 候选 2：Tauri externalBin 打包后通常去掉 triple 直接放主 exe 旁边
    // 但少数版本会保留带 triple 的名字，加 fallback
    let triple_path = dir.join(format!("kb-mcp-{}{}", TARGET_TRIPLE, exe_suffix));
    if triple_path.exists() {
        return Some(triple_path);
    }
    None
}

/// tools/list 返回的单条工具描述（裁剪过，前端只需要必要字段）
#[derive(Debug, Serialize)]
pub struct McpToolInfo {
    /// 工具名（如 "search_notes"）
    pub name: String,
    /// 描述（喂给 LLM 用的自然语言说明）
    pub description: Option<String>,
    /// 入参 JSON Schema（前端可用 react-jsonschema-form 自动生成表单）
    pub input_schema: JsonValue,
}

/// 列出 in-memory MCP server 暴露的所有工具（kb-core 的 12 个）
#[tauri::command]
pub async fn mcp_internal_list_tools(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<McpToolInfo>, String> {
    let client = state
        .mcp_internal
        .as_ref()
        .ok_or_else(|| "in-memory MCP server 未就绪（启动初始化失败，详见 log）".to_string())?
        .clone();

    let tools = client
        .list_all_tools()
        .await
        .map_err(|e| format!("list_tools 失败: {e}"))?;

    let infos = tools
        .into_iter()
        .map(|t| McpToolInfo {
            name: t.name.into(),
            description: t.description.map(|d| d.into()),
            // input_schema 是 Arc<JsonObject>，转成 JsonValue 给前端
            input_schema: JsonValue::Object((*t.input_schema).clone()),
        })
        .collect();

    Ok(infos)
}

/// 调用 in-memory MCP server 的工具，返回 LLM 拿到的原始 JSON 字符串
///
/// 前端传 arguments 用 JSON object（serde_json::Value::Object）；
/// 返回 content 列表里的第一个 text block（kb-core 12 工具都返回单段 text）
#[tauri::command]
pub async fn mcp_internal_call_tool(
    state: tauri::State<'_, AppState>,
    name: String,
    arguments: Option<JsonValue>,
) -> Result<String, String> {
    let client = state
        .mcp_internal
        .as_ref()
        .ok_or_else(|| "in-memory MCP server 未就绪".to_string())?
        .clone();

    // arguments 必须是 JsonObject；前端传 null 或 undefined 都映射为 None
    let args_object = match arguments {
        Some(JsonValue::Object(m)) => Some(m),
        Some(JsonValue::Null) | None => None,
        Some(other) => {
            return Err(format!(
                "arguments 必须是 JSON object 或 null，收到: {}",
                other
            ));
        }
    };

    // CallToolRequestParams 是 #[non_exhaustive]，必须用 builder
    let mut req = CallToolRequestParams::new(name.clone());
    if let Some(obj) = args_object {
        req = req.with_arguments(obj);
    }

    let result = client
        .call_tool(req)
        .await
        .map_err(|e| format!("call_tool({name}) 失败: {e}"))?;

    // 把 content 列表里的 text block 拼起来返回（12 工具都是单段 text）
    let mut out = String::new();
    for c in &result.content {
        if let Some(text) = c.as_text() {
            out.push_str(&text.text);
        }
    }
    if result.is_error.unwrap_or(false) {
        return Err(format!("工具返回错误: {out}"));
    }
    Ok(out)
}

// ─── M5-2: 外部 MCP server CRUD + 调用代理 ─────────────────────

/// 列出所有用户加的外部 MCP server
#[tauri::command]
pub fn mcp_list_servers(state: tauri::State<'_, AppState>) -> Result<Vec<McpServer>, String> {
    state.db.list_mcp_servers().map_err(|e| e.to_string())
}

/// 创建一个新的 MCP server
#[tauri::command]
pub fn mcp_create_server(
    state: tauri::State<'_, AppState>,
    input: McpServerInput,
) -> Result<McpServer, String> {
    state
        .db
        .create_mcp_server(&input)
        .map_err(|e| e.to_string())
}

/// 更新已有 server 配置；同时让正在运行的 client 失效（下次访问会用新配置 spawn）
#[tauri::command]
pub async fn mcp_update_server(
    state: tauri::State<'_, AppState>,
    id: i64,
    input: McpServerInput,
) -> Result<McpServer, String> {
    let server = state
        .db
        .update_mcp_server(id, &input)
        .map_err(|e| e.to_string())?;
    state.mcp_external.disconnect(id).await;
    Ok(server)
}

/// 删除 server，同时清掉 client 缓存（子进程会被回收）
#[tauri::command]
pub async fn mcp_delete_server(
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<bool, String> {
    state.mcp_external.disconnect(id).await;
    state.db.delete_mcp_server(id).map_err(|e| e.to_string())
}

/// 启用/禁用 server。禁用时清掉 client 缓存，确保下次访问会拒掉
#[tauri::command]
pub async fn mcp_set_server_enabled(
    state: tauri::State<'_, AppState>,
    id: i64,
    enabled: bool,
) -> Result<(), String> {
    state
        .db
        .set_mcp_server_enabled(id, enabled)
        .map_err(|e| e.to_string())?;
    if !enabled {
        state.mcp_external.disconnect(id).await;
    }
    Ok(())
}

/// 列出指定外部 server 暴露的工具（首次会触发 spawn + 握手）
#[tauri::command]
pub async fn mcp_external_list_tools(
    state: tauri::State<'_, AppState>,
    server_id: i64,
) -> Result<Vec<McpToolInfo>, String> {
    let server = state
        .db
        .get_mcp_server(server_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("MCP server {} 不存在", server_id))?;

    let client = state
        .mcp_external
        .get_or_spawn(&server)
        .await
        .map_err(|e| e.to_string())?;

    let tools = client
        .list_all_tools()
        .await
        .map_err(|e| format!("list_tools 失败: {e}"))?;

    let infos = tools
        .into_iter()
        .map(|t| McpToolInfo {
            name: t.name.into(),
            description: t.description.map(|d| d.into()),
            input_schema: JsonValue::Object((*t.input_schema).clone()),
        })
        .collect();

    Ok(infos)
}

/// 调用指定外部 server 的工具
#[tauri::command]
pub async fn mcp_external_call_tool(
    state: tauri::State<'_, AppState>,
    server_id: i64,
    name: String,
    arguments: Option<JsonValue>,
) -> Result<String, String> {
    let server = state
        .db
        .get_mcp_server(server_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("MCP server {} 不存在", server_id))?;

    let client = state
        .mcp_external
        .get_or_spawn(&server)
        .await
        .map_err(|e| e.to_string())?;

    let args_object = match arguments {
        Some(JsonValue::Object(m)) => Some(m),
        Some(JsonValue::Null) | None => None,
        Some(other) => {
            return Err(format!(
                "arguments 必须是 JSON object 或 null，收到: {}",
                other
            ));
        }
    };

    let mut req = CallToolRequestParams::new(name.clone());
    if let Some(obj) = args_object {
        req = req.with_arguments(obj);
    }

    let result = client
        .call_tool(req)
        .await
        .map_err(|e| format!("call_tool({name}) 失败: {e}"))?;

    let mut out = String::new();
    for c in &result.content {
        if let Some(text) = c.as_text() {
            out.push_str(&text.text);
        }
    }
    if result.is_error.unwrap_or(false) {
        return Err(format!("工具返回错误: {out}"));
    }
    Ok(out)
}
