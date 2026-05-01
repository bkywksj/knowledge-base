//! kb-core · Knowledge Base MCP Server 共享库
//!
//! 抽离自 src-tauri/mcp/src/main.rs，让两个消费方共用同一份工具实现：
//! - **kb-mcp** binary：跑 stdio MCP server，给 Claude Desktop / Cursor 等外部客户端用
//! - **主应用 (knowledge_base)**：在 Tauri 进程内 spawn in-memory MCP server，
//!   让自家 AI 对话页通过 MCP 协议消费同一套工具
//!
//! 核心导出：
//! - [`KbDb`] — 包装 rusqlite Connection（只读 / 读写两种模式）
//! - [`KbServer`] — rmcp ServerHandler，挂载 12 个工具
//!
//! ## 简单用法
//! ```ignore
//! use kb_core::{KbDb, KbServer};
//! use rmcp::{ServiceExt, transport::stdio};
//!
//! let db = KbDb::open(&db_path, /*writable*/ false)?;
//! let server = KbServer::new(db, false);
//! server.serve(stdio()).await?.waiting().await?;
//! ```
//!
//! ## In-memory 用法（主应用集成）
//! ```ignore
//! use tokio::io::duplex;
//! let (server_io, client_io) = duplex(64 * 1024);
//! tokio::spawn(async move {
//!     server.serve(server_io).await.unwrap().waiting().await
//! });
//! // client_io 给 rmcp client 当 transport 用
//! ```

use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use rmcp::{
    ErrorData as McpError, ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{
        CallToolResult, Content, Implementation, ProtocolVersion, ServerCapabilities, ServerInfo,
    },
    schemars, tool, tool_handler, tool_router,
};
use rusqlite::{Connection, OpenFlags, params};
use serde::Serialize;

// ─── 数据库连接（只读 + WAL 兼容） ─────────────────────────────────

/// 包装一份 rusqlite 连接。`Mutex` 因为 rusqlite::Connection 不是 Sync。
pub struct KbDb {
    conn: Mutex<Connection>,
}

impl KbDb {
    /// 打开 SQLite。`writable=false` 时强制只读（推荐默认）。
    /// - 只读：用 `SQLITE_OPEN_READ_ONLY`，从内核层面拦截写入
    /// - 可写：用 `SQLITE_OPEN_READ_WRITE`，依赖主应用已建好库（不创建新库）
    /// - 不调 PRAGMA journal_mode：WAL 由主应用维持，sidecar 自动跟随
    pub fn open(path: &Path, writable: bool) -> Result<Self> {
        let mode = if writable {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        } else {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        };
        let conn = Connection::open_with_flags(path, mode | OpenFlags::SQLITE_OPEN_NO_MUTEX)
            .with_context(|| format!("打开 SQLite 失败: {}", path.display()))?;

        // busy_timeout：与主应用写事务并发时，等 5 秒再报 SQLITE_BUSY
        conn.busy_timeout(std::time::Duration::from_secs(5))?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}

// ─── 工具入参 / 出参 schema ───────────────────────────────────────

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct SearchNotesArgs {
    /// 搜索关键词，支持中英文混合；空格分隔多个词（AND 逻辑）。
    /// FTS5 优先，无结果自动降级到 LIKE 模糊匹配。
    query: String,
    /// 返回结果数上限，默认 20，最大 100
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct GetNoteArgs {
    /// 笔记 id，从 search_notes 的结果中取
    id: i64,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct SearchByTagArgs {
    /// 标签名（精确匹配，区分大小写）
    tag: String,
    /// 返回结果数上限，默认 30，最大 100
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct GetBacklinksArgs {
    /// 目标笔记 id（要查"哪些笔记链接到了我"）
    id: i64,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ListDailyArgs {
    /// 最近多少天，默认 7
    #[serde(default)]
    days: Option<i64>,
    /// 上限条数，默认 30
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ListTasksArgs {
    /// 任务状态过滤：0=todo / 1=done。不传则全部
    #[serde(default)]
    status: Option<i64>,
    /// 关键词模糊匹配 title / description
    #[serde(default)]
    keyword: Option<String>,
    /// 返回数上限，默认 50，最大 200
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CreateNoteArgs {
    /// 笔记标题（必填，不能为空字符串）
    title: String,
    /// 笔记正文（HTML 或 Markdown 都行，主应用前端用 TipTap 渲染）
    content: String,
    /// 可选：归属文件夹 id。不传则进"未分类"
    #[serde(default)]
    folder_id: Option<i64>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct UpdateNoteArgs {
    /// 笔记 id
    id: i64,
    /// 新标题（不传则保持不变）
    #[serde(default)]
    title: Option<String>,
    /// 新内容（不传则保持不变）
    #[serde(default)]
    content: Option<String>,
    /// 新文件夹 id（不传则保持不变）。
    /// 限制：暂不支持把笔记"移回未分类"，需要的话请在主应用 UI 操作
    #[serde(default)]
    folder_id: Option<i64>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct AddTagArgs {
    /// 笔记 id
    note_id: i64,
    /// 标签名（不存在会自动创建）
    tag: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CreateFolderArgs {
    /// 文件夹名称（必填，前后空白会被 trim）
    name: String,
    /// 父文件夹 id；不传或 null 表示创建顶级文件夹
    #[serde(default)]
    parent_id: Option<i64>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CreateNoteFromTemplateArgs {
    /// 模板 id（从 list_templates 取）
    template_id: i64,
    /// 新笔记标题（不传则用模板 name + 当前日期）
    #[serde(default)]
    title: Option<String>,
    /// 目标文件夹 id；不传则进未分类
    #[serde(default)]
    folder_id: Option<i64>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ListTrashArgs {
    /// 上限条数，默认 30，最大 100
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct RestoreNoteArgs {
    /// 回收站里笔记的 id
    id: i64,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct DeleteNoteArgs {
    /// 笔记 id
    id: i64,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct RemoveTagArgs {
    /// 笔记 id
    note_id: i64,
    /// 标签名
    tag: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ListRecentArgs {
    /// 上限条数，默认 20，最大 100
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CreateTaskArgs {
    /// 任务标题（必填）
    title: String,
    /// 描述（可选）
    #[serde(default)]
    description: Option<String>,
    /// 优先级：0=紧急 / 1=普通(默认) / 2=低
    #[serde(default)]
    priority: Option<i64>,
    /// 是否重要（艾森豪威尔矩阵的"重要性"维度），默认 false
    #[serde(default)]
    important: Option<bool>,
    /// 截止日期，格式 YYYY-MM-DD
    #[serde(default)]
    due_date: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct UpdateTaskArgs {
    /// 任务 id
    id: i64,
    /// 新标题（不传则不变）
    #[serde(default)]
    title: Option<String>,
    /// 新描述
    #[serde(default)]
    description: Option<String>,
    /// 新优先级
    #[serde(default)]
    priority: Option<i64>,
    /// 新重要性
    #[serde(default)]
    important: Option<bool>,
    /// 新截止日期，格式 YYYY-MM-DD；显式传 null 不支持，要清空请去主应用 UI
    #[serde(default)]
    due_date: Option<String>,
    /// 是否标记完成。true → status=1 + completed_at=now；false → status=0 + completed_at=null
    #[serde(default)]
    mark_done: Option<bool>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ListNotesByFolderArgs {
    /// 文件夹 id；不传或 null 表示「未分类」（folder_id IS NULL）
    #[serde(default)]
    folder_id: Option<i64>,
    /// 是否包含子文件夹下的笔记，默认 false（只取直接子项）
    #[serde(default)]
    include_descendants: Option<bool>,
    /// 上限条数，默认 50，最大 200
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct MoveNotesBatchArgs {
    /// 要移动的笔记 id 列表
    ids: Vec<i64>,
    /// 目标文件夹 id；不传或 null 表示移到「未分类」
    #[serde(default)]
    folder_id: Option<i64>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct GetPromptArgs {
    /// 提示词模板 id（与 builtin_code 二选一）
    #[serde(default)]
    id: Option<i64>,
    /// 内置模板代码（与 id 二选一），如 "summarize" / "translate" 等
    #[serde(default)]
    builtin_code: Option<String>,
}

#[derive(Debug, Serialize)]
struct SearchHit {
    id: i64,
    title: String,
    /// 命中片段（去 HTML 标签的纯文本，长度约 140）
    snippet: String,
    /// 笔记最近更新时间（本地时区字符串）
    updated_at: String,
    folder_id: Option<i64>,
}

#[derive(Debug, Serialize)]
struct NoteDetail {
    id: i64,
    title: String,
    /// 笔记正文（如果是加密笔记则返回占位，不泄露密文）
    content: String,
    folder_id: Option<i64>,
    is_daily: bool,
    daily_date: Option<String>,
    is_pinned: bool,
    word_count: i64,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
struct TagInfo {
    id: i64,
    name: String,
    color: Option<String>,
    /// 该标签下未删除笔记的数量
    note_count: i64,
}

#[derive(Debug, Serialize)]
struct BacklinkRef {
    /// 反链来源笔记 id
    source_id: i64,
    source_title: String,
    /// 链接出现处的上下文片段（可能为 null）
    context: Option<String>,
    updated_at: String,
}

#[derive(Debug, Serialize)]
struct TaskRow {
    id: i64,
    title: String,
    description: Option<String>,
    /// 0=urgent / 1=normal / 2=low
    priority: i64,
    important: bool,
    /// 0=todo / 1=done
    status: i64,
    due_date: Option<String>,
    completed_at: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
struct TemplateInfo {
    id: i64,
    name: String,
    description: String,
    /// 内容预览（前 140 字符，纯文本剥 HTML）
    preview: String,
    created_at: String,
}

#[derive(Debug, Serialize)]
struct TrashItem {
    id: i64,
    title: String,
    /// 摘要（去 HTML 标签后前 140 字符）
    snippet: String,
    /// 当初被软删的时间（updated_at 在 delete_note 时刷新过）
    deleted_at: String,
}

#[derive(Debug, Serialize)]
struct FolderInfo {
    id: i64,
    name: String,
    /// 父文件夹 id；null = 顶级
    parent_id: Option<i64>,
    /// 该文件夹（不递归）下未删除笔记数
    note_count: i64,
}

#[derive(Debug, Serialize)]
struct PromptDetail {
    id: i64,
    title: String,
    description: String,
    prompt: String,
    output_mode: String,
    icon: Option<String>,
    is_builtin: bool,
    builtin_code: Option<String>,
    enabled: bool,
}

// ─── MCP Server 实现 ─────────────────────────────────────────────

/// MCP Server，挂载 12 个工具。`Clone` 因为 rmcp router 内部要 clone。
#[derive(Clone)]
pub struct KbServer {
    db: Arc<KbDb>,
    /// 写工具是否可用（由 CLI / 主应用配置控制）。
    /// 即使关，写工具仍在 tools/list 里可见，但调用时立即返回错误。
    /// 这样客户端能感知到能力存在，又不会意外修改 db。
    writable: bool,
    // tool_router 由 #[tool_router] / #[tool_handler] 宏读取，编译器看不出来用法
    #[allow(dead_code)]
    tool_router: ToolRouter<Self>,
}

#[tool_router]
impl KbServer {
    /// 构造。`writable=false` 时所有写工具调用都会被 ensure_writable 拒掉。
    pub fn new(db: KbDb, writable: bool) -> Self {
        Self {
            db: Arc::new(db),
            writable,
            tool_router: Self::tool_router(),
        }
    }

    /// 写工具入口的统一守卫
    fn ensure_writable(&self) -> Result<(), McpError> {
        if !self.writable {
            return Err(McpError::invalid_params(
                "kb-mcp 当前是只读模式，无法写入。\
                 启动时加 --writable 开关后再调用写工具。"
                    .to_string(),
                None,
            ));
        }
        Ok(())
    }

    // ─── ping：健康检查 ────────────────────────────────────────
    #[tool(description = "健康检查。返回 'pong' + sidecar 版本。用于客户端验证 MCP server 已就绪。")]
    fn ping(&self) -> Result<CallToolResult, McpError> {
        let msg = format!("pong (kb-core v{})", env!("CARGO_PKG_VERSION"));
        Ok(CallToolResult::success(vec![Content::text(msg)]))
    }

    // ─── search_notes：全文搜索 ───────────────────────────────
    #[tool(description = "全文搜索本地知识库笔记（FTS5 + LIKE 兜底）。\
                          自动过滤回收站 / 隐藏 / 加密笔记。\
                          返回命中列表（id / title / snippet / updated_at）的 JSON。")]
    fn search_notes(
        &self,
        Parameters(args): Parameters<SearchNotesArgs>,
    ) -> Result<CallToolResult, McpError> {
        let limit = args.limit.unwrap_or(20).clamp(1, 100);
        let query = args.query.trim();
        if query.is_empty() {
            return Ok(CallToolResult::success(vec![Content::text("[]")]));
        }

        let conn = self
            .db
            .conn
            .lock()
            .map_err(|e| McpError::internal_error(format!("db lock: {e}"), None))?;

        // 1) FTS5 路径（前缀匹配，复用主应用的 sanitize_fts_query 逻辑）
        let fts_q = sanitize_fts_query(query);
        let hits = if !fts_q.is_empty() {
            let r = search_fts(&conn, &fts_q, limit)
                .map_err(|e| McpError::internal_error(format!("fts: {e}"), None))?;
            if !r.is_empty() {
                r
            } else {
                search_like(&conn, query, limit)
                    .map_err(|e| McpError::internal_error(format!("like: {e}"), None))?
            }
        } else {
            search_like(&conn, query, limit)
                .map_err(|e| McpError::internal_error(format!("like: {e}"), None))?
        };

        let json = serde_json::to_string(&hits)
            .map_err(|e| McpError::internal_error(format!("serialize: {e}"), None))?;
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    // ─── get_note：按 id 取全文 ───────────────────────────────
    #[tool(description = "按 id 读取单条笔记的完整内容（返回 JSON）。\
                          加密笔记的 content 会被替换为占位符（不泄露密文）。\
                          隐藏笔记拒绝访问，返回错误。")]
    fn get_note(
        &self,
        Parameters(args): Parameters<GetNoteArgs>,
    ) -> Result<CallToolResult, McpError> {
        let conn = self
            .db
            .conn
            .lock()
            .map_err(|e| McpError::internal_error(format!("db lock: {e}"), None))?;

        let detail = fetch_note(&conn, args.id)
            .map_err(|e| McpError::internal_error(format!("fetch_note: {e}"), None))?
            .ok_or_else(|| McpError::invalid_params(format!("笔记 {} 不存在", args.id), None))?;

        let json = serde_json::to_string(&detail)
            .map_err(|e| McpError::internal_error(format!("serialize: {e}"), None))?;
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    // ─── list_tags：所有标签 + 笔记数 ─────────────────────────
    #[tool(description = "列出所有标签，附带每个标签下的笔记数（按笔记数降序）。\
                          已删除笔记不计入 count。")]
    fn list_tags(&self) -> Result<CallToolResult, McpError> {
        let conn = self
            .db
            .conn
            .lock()
            .map_err(|e| McpError::internal_error(format!("db lock: {e}"), None))?;
        let tags = list_tags(&conn)
            .map_err(|e| McpError::internal_error(format!("list_tags: {e}"), None))?;
        let json = serde_json::to_string(&tags)
            .map_err(|e| McpError::internal_error(format!("serialize: {e}"), None))?;
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    // ─── search_by_tag：按标签筛选笔记 ────────────────────────
    #[tool(description = "按标签名筛选笔记列表，按更新时间降序。\
                          自动过滤回收站 / 隐藏 / 加密笔记。")]
    fn search_by_tag(
        &self,
        Parameters(args): Parameters<SearchByTagArgs>,
    ) -> Result<CallToolResult, McpError> {
        let limit = args.limit.unwrap_or(30).clamp(1, 100);
        let tag = args.tag.trim();
        if tag.is_empty() {
            return Ok(CallToolResult::success(vec![Content::text("[]")]));
        }
        let conn = self
            .db
            .conn
            .lock()
            .map_err(|e| McpError::internal_error(format!("db lock: {e}"), None))?;
        let hits = search_by_tag(&conn, tag, limit)
            .map_err(|e| McpError::internal_error(format!("search_by_tag: {e}"), None))?;
        let json = serde_json::to_string(&hits)
            .map_err(|e| McpError::internal_error(format!("serialize: {e}"), None))?;
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    // ─── get_backlinks：反向链接 ─────────────────────────────
    #[tool(description = "获取目标笔记的所有反向链接（哪些笔记 [[链接]] 到了它）。\
                          隐藏 / 已删除的源笔记不计入。")]
    fn get_backlinks(
        &self,
        Parameters(args): Parameters<GetBacklinksArgs>,
    ) -> Result<CallToolResult, McpError> {
        let conn = self
            .db
            .conn
            .lock()
            .map_err(|e| McpError::internal_error(format!("db lock: {e}"), None))?;
        let links = get_backlinks(&conn, args.id)
            .map_err(|e| McpError::internal_error(format!("get_backlinks: {e}"), None))?;
        let json = serde_json::to_string(&links)
            .map_err(|e| McpError::internal_error(format!("serialize: {e}"), None))?;
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    // ─── list_daily_notes：日记列表 ──────────────────────────
    #[tool(description = "列出最近 N 天的日记（is_daily=1 的笔记），按 daily_date 降序。\
                          默认最近 7 天、最多 30 条。")]
    fn list_daily_notes(
        &self,
        Parameters(args): Parameters<ListDailyArgs>,
    ) -> Result<CallToolResult, McpError> {
        let days = args.days.unwrap_or(7).clamp(1, 365);
        let limit = args.limit.unwrap_or(30).clamp(1, 100);
        let conn = self
            .db
            .conn
            .lock()
            .map_err(|e| McpError::internal_error(format!("db lock: {e}"), None))?;
        let hits = list_daily_notes(&conn, days, limit)
            .map_err(|e| McpError::internal_error(format!("list_daily: {e}"), None))?;
        let json = serde_json::to_string(&hits)
            .map_err(|e| McpError::internal_error(format!("serialize: {e}"), None))?;
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    // ─── list_tasks：任务列表 ─────────────────────────────────
    #[tool(description = "列出主任务（不含子任务），可按 status / keyword 过滤。\
                          排序：priority ASC → due_date NULLS LAST → updated_at DESC。\
                          status: 0=todo, 1=done。")]
    fn list_tasks(
        &self,
        Parameters(args): Parameters<ListTasksArgs>,
    ) -> Result<CallToolResult, McpError> {
        let limit = args.limit.unwrap_or(50).clamp(1, 200);
        let conn = self
            .db
            .conn
            .lock()
            .map_err(|e| McpError::internal_error(format!("db lock: {e}"), None))?;
        let rows = list_tasks(&conn, args.status, args.keyword.as_deref(), limit)
            .map_err(|e| McpError::internal_error(format!("list_tasks: {e}"), None))?;
        let json = serde_json::to_string(&rows)
            .map_err(|e| McpError::internal_error(format!("serialize: {e}"), None))?;
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    // ─── get_prompt：取单条提示词 ─────────────────────────────
    #[tool(description = "按 id 或 builtin_code 取一条提示词模板（Prompt Library）。\
                          二选一传参，至少一个；同时传以 id 优先。")]
    fn get_prompt(
        &self,
        Parameters(args): Parameters<GetPromptArgs>,
    ) -> Result<CallToolResult, McpError> {
        if args.id.is_none() && args.builtin_code.is_none() {
            return Err(McpError::invalid_params(
                "必须传 id 或 builtin_code 之一".to_string(),
                None,
            ));
        }
        let conn = self
            .db
            .conn
            .lock()
            .map_err(|e| McpError::internal_error(format!("db lock: {e}"), None))?;
        let detail = get_prompt(&conn, args.id, args.builtin_code.as_deref())
            .map_err(|e| McpError::internal_error(format!("get_prompt: {e}"), None))?
            .ok_or_else(|| McpError::invalid_params("提示词模板不存在".to_string(), None))?;
        let json = serde_json::to_string(&detail)
            .map_err(|e| McpError::internal_error(format!("serialize: {e}"), None))?;
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    // ─── list_templates：笔记模板库 ───────────────────────────
    #[tool(description = "列出所有笔记模板（会议记录 / 读书笔记 / 周报 等内置 + 用户自建）。\
                          配合 create_note_from_template 用来按模板建笔记。")]
    fn list_templates(&self) -> Result<CallToolResult, McpError> {
        let conn = self
            .db
            .conn
            .lock()
            .map_err(|e| McpError::internal_error(format!("db lock: {e}"), None))?;
        let templates = list_templates(&conn)
            .map_err(|e| McpError::internal_error(format!("list_templates: {e}"), None))?;
        let json = serde_json::to_string(&templates)
            .map_err(|e| McpError::internal_error(format!("serialize: {e}"), None))?;
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    // ─── list_trash：回收站列表 ────────────────────────────────
    #[tool(description = "列出回收站里的笔记（is_deleted=1，按删除时间倒序）。\
                          配合 restore_note_from_trash 还原。\
                          隐藏 / 加密笔记不暴露。")]
    fn list_trash(
        &self,
        Parameters(args): Parameters<ListTrashArgs>,
    ) -> Result<CallToolResult, McpError> {
        let limit = args.limit.unwrap_or(30).clamp(1, 100);
        let conn = self
            .db
            .conn
            .lock()
            .map_err(|e| McpError::internal_error(format!("db lock: {e}"), None))?;
        let items = list_trash(&conn, limit)
            .map_err(|e| McpError::internal_error(format!("list_trash: {e}"), None))?;
        let json = serde_json::to_string(&items)
            .map_err(|e| McpError::internal_error(format!("serialize: {e}"), None))?;
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    // ─── list_recent_notes：按更新时间最近的笔记 ──────────────
    #[tool(description = "列出最近更新的笔记（按 updated_at 降序），不限文件夹和标签。\
                          用于「我最近写了啥」这类无关键词查询。\
                          自动过滤回收站 / 隐藏 / 加密。")]
    fn list_recent_notes(
        &self,
        Parameters(args): Parameters<ListRecentArgs>,
    ) -> Result<CallToolResult, McpError> {
        let limit = args.limit.unwrap_or(20).clamp(1, 100);
        let conn = self
            .db
            .conn
            .lock()
            .map_err(|e| McpError::internal_error(format!("db lock: {e}"), None))?;
        let hits = list_recent_notes(&conn, limit)
            .map_err(|e| McpError::internal_error(format!("list_recent: {e}"), None))?;
        let json = serde_json::to_string(&hits)
            .map_err(|e| McpError::internal_error(format!("serialize: {e}"), None))?;
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    // ─── list_folders：文件夹结构 ──────────────────────────────
    #[tool(description = "列出所有文件夹（含层级 parent_id 和未删除笔记数）。\
                          按 sort_order 排序。LLM 决定把笔记放哪个文件夹前先看这个。")]
    fn list_folders(&self) -> Result<CallToolResult, McpError> {
        let conn = self
            .db
            .conn
            .lock()
            .map_err(|e| McpError::internal_error(format!("db lock: {e}"), None))?;
        let folders = list_folders(&conn)
            .map_err(|e| McpError::internal_error(format!("list_folders: {e}"), None))?;
        let json = serde_json::to_string(&folders)
            .map_err(|e| McpError::internal_error(format!("serialize: {e}"), None))?;
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    // ─── list_notes_by_folder：按文件夹列笔记 ──────────────────
    #[tool(description = "按文件夹 id 列笔记（folder_id=null 表示未分类）。\
                          可选 include_descendants 递归子文件夹。\
                          自动过滤回收站 / 隐藏 / 加密笔记。")]
    fn list_notes_by_folder(
        &self,
        Parameters(args): Parameters<ListNotesByFolderArgs>,
    ) -> Result<CallToolResult, McpError> {
        let limit = args.limit.unwrap_or(50).clamp(1, 200);
        let recurse = args.include_descendants.unwrap_or(false);
        let conn = self
            .db
            .conn
            .lock()
            .map_err(|e| McpError::internal_error(format!("db lock: {e}"), None))?;
        let hits = list_notes_by_folder(&conn, args.folder_id, recurse, limit)
            .map_err(|e| McpError::internal_error(format!("list_notes_by_folder: {e}"), None))?;
        let json = serde_json::to_string(&hits)
            .map_err(|e| McpError::internal_error(format!("serialize: {e}"), None))?;
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    // ─── ✏️ 写工具：move_notes_batch ───────────────────────────
    #[tool(description = "批量把多条笔记移动到目标文件夹（folder_id=null 移到未分类）。\
                          只改 folder_id，不动 updated_at（避免大量笔记被冒泡到最近更新）。\
                          仅 --writable 模式可用。返回受影响行数。")]
    fn move_notes_batch(
        &self,
        Parameters(args): Parameters<MoveNotesBatchArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_writable()?;
        if args.ids.is_empty() {
            return Err(McpError::invalid_params(
                "ids 不能为空".to_string(),
                None,
            ));
        }
        if args.ids.len() > 500 {
            return Err(McpError::invalid_params(
                "单次最多移动 500 条".to_string(),
                None,
            ));
        }
        let conn = self
            .db
            .conn
            .lock()
            .map_err(|e| McpError::internal_error(format!("db lock: {e}"), None))?;
        let affected = move_notes_batch(&conn, &args.ids, args.folder_id)
            .map_err(|e| McpError::internal_error(format!("move_notes_batch: {e}"), None))?;
        let json = serde_json::to_string(&serde_json::json!({
            "affected": affected,
            "target_folder_id": args.folder_id,
        }))
        .map_err(|e| McpError::internal_error(format!("serialize: {e}"), None))?;
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    // ─── ✏️ 写工具：create_folder ────────────────────────────────
    #[tool(description = "创建新文件夹。parent_id=null 表示顶级。\
                          仅 --writable 模式可用。返回 {id, name}。")]
    fn create_folder(
        &self,
        Parameters(args): Parameters<CreateFolderArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_writable()?;
        let name = args.name.trim();
        if name.is_empty() {
            return Err(McpError::invalid_params(
                "name 不能为空".to_string(),
                None,
            ));
        }
        let conn = self
            .db
            .conn
            .lock()
            .map_err(|e| McpError::internal_error(format!("db lock: {e}"), None))?;
        let id = create_folder(&conn, name, args.parent_id)
            .map_err(|e| McpError::internal_error(format!("create_folder: {e}"), None))?;
        let json = serde_json::to_string(&serde_json::json!({
            "id": id,
            "name": name,
            "parent_id": args.parent_id,
        }))
        .map_err(|e| McpError::internal_error(format!("serialize: {e}"), None))?;
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    // ─── ✏️ 写工具：create_note_from_template ───────────────────
    #[tool(description = "按模板建笔记。title 不传则自动用「模板名 · YYYY-MM-DD」。\
                          仅 --writable 模式可用。返回 {id, title}。")]
    fn create_note_from_template(
        &self,
        Parameters(args): Parameters<CreateNoteFromTemplateArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_writable()?;
        let conn = self
            .db
            .conn
            .lock()
            .map_err(|e| McpError::internal_error(format!("db lock: {e}"), None))?;
        let (id, title) = create_note_from_template(
            &conn,
            args.template_id,
            args.title.as_deref(),
            args.folder_id,
        )
        .map_err(|e| McpError::internal_error(format!("create_note_from_template: {e}"), None))?;
        let json = serde_json::to_string(&serde_json::json!({
            "id": id,
            "title": title,
        }))
        .map_err(|e| McpError::internal_error(format!("serialize: {e}"), None))?;
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    // ─── ✏️ 写工具：restore_note_from_trash ────────────────────
    #[tool(description = "把回收站里的笔记还原（is_deleted: 1 → 0）。\
                          仅 --writable 模式可用。")]
    fn restore_note_from_trash(
        &self,
        Parameters(args): Parameters<RestoreNoteArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_writable()?;
        let conn = self
            .db
            .conn
            .lock()
            .map_err(|e| McpError::internal_error(format!("db lock: {e}"), None))?;
        let affected = restore_note_from_trash(&conn, args.id)
            .map_err(|e| McpError::internal_error(format!("restore: {e}"), None))?;
        if affected == 0 {
            return Err(McpError::invalid_params(
                format!("笔记 {} 不在回收站", args.id),
                None,
            ));
        }
        Ok(CallToolResult::success(vec![Content::text(
            format!("{{\"id\":{},\"restored\":true}}", args.id),
        )]))
    }

    // ─── ✏️ 写工具：delete_note（软删到回收站） ─────────────────
    #[tool(description = "把笔记软删到回收站（is_deleted=1）。原数据仍在，可在主应用 UI 回收站恢复。\
                          拒绝删除加密笔记。仅 --writable 模式可用。\
                          这是 LLM 处理「创建错了」/「不要这条了」的标准撤销方式。")]
    fn delete_note(
        &self,
        Parameters(args): Parameters<DeleteNoteArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_writable()?;
        let conn = self
            .db
            .conn
            .lock()
            .map_err(|e| McpError::internal_error(format!("db lock: {e}"), None))?;
        let affected = soft_delete_note(&conn, args.id)
            .map_err(|e| McpError::internal_error(format!("delete_note: {e}"), None))?;
        if affected == 0 {
            return Err(McpError::invalid_params(
                format!("笔记 {} 不存在或是加密笔记", args.id),
                None,
            ));
        }
        Ok(CallToolResult::success(vec![Content::text(
            format!("{{\"id\":{},\"deleted\":true}}", args.id),
        )]))
    }

    // ─── ✏️ 写工具：remove_tag_from_note ─────────────────────────
    #[tool(description = "撤回笔记的某个标签（仅删 note_tags 关联，不删 tags 表里的标签本身）。\
                          仅 --writable 模式可用。LLM 处理「加错标签」时用。")]
    fn remove_tag_from_note(
        &self,
        Parameters(args): Parameters<RemoveTagArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_writable()?;
        let tag = args.tag.trim();
        if tag.is_empty() {
            return Err(McpError::invalid_params(
                "tag 不能为空".to_string(),
                None,
            ));
        }
        let conn = self
            .db
            .conn
            .lock()
            .map_err(|e| McpError::internal_error(format!("db lock: {e}"), None))?;
        let removed = remove_tag_from_note(&conn, args.note_id, tag)
            .map_err(|e| McpError::internal_error(format!("remove_tag: {e}"), None))?;
        Ok(CallToolResult::success(vec![Content::text(
            format!(
                "{{\"note_id\":{},\"tag\":\"{}\",\"removed\":{}}}",
                args.note_id,
                tag.replace('"', "\\\""),
                removed
            ),
        )]))
    }

    // ─── ✏️ 写工具：create_task ──────────────────────────────────
    #[tool(description = "创建一个新任务（主任务，不带子任务）。\
                          priority: 0=紧急/1=普通(默认)/2=低；status 自动 0=todo。\
                          仅 --writable 模式可用。返回 {id, title}。")]
    fn create_task(
        &self,
        Parameters(args): Parameters<CreateTaskArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_writable()?;
        let title = args.title.trim();
        if title.is_empty() {
            return Err(McpError::invalid_params(
                "title 不能为空".to_string(),
                None,
            ));
        }
        let conn = self
            .db
            .conn
            .lock()
            .map_err(|e| McpError::internal_error(format!("db lock: {e}"), None))?;
        let id = create_task(
            &conn,
            title,
            args.description.as_deref(),
            args.priority.unwrap_or(1),
            args.important.unwrap_or(false),
            args.due_date.as_deref(),
        )
        .map_err(|e| McpError::internal_error(format!("create_task: {e}"), None))?;
        let json = serde_json::to_string(&serde_json::json!({
            "id": id,
            "title": title,
        }))
        .map_err(|e| McpError::internal_error(format!("serialize: {e}"), None))?;
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    // ─── ✏️ 写工具：update_task ──────────────────────────────────
    #[tool(description = "更新任务字段或标记完成。所有字段都可选，只更新传入的。\
                          mark_done=true → 同时设 status=1 + completed_at=now；\
                          mark_done=false → 重置为未完成。\
                          仅 --writable 模式可用。")]
    fn update_task(
        &self,
        Parameters(args): Parameters<UpdateTaskArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_writable()?;
        if args.title.is_none()
            && args.description.is_none()
            && args.priority.is_none()
            && args.important.is_none()
            && args.due_date.is_none()
            && args.mark_done.is_none()
        {
            return Err(McpError::invalid_params(
                "至少要传一个字段".to_string(),
                None,
            ));
        }
        let conn = self
            .db
            .conn
            .lock()
            .map_err(|e| McpError::internal_error(format!("db lock: {e}"), None))?;
        let affected = update_task(
            &conn,
            args.id,
            args.title.as_deref(),
            args.description.as_deref(),
            args.priority,
            args.important,
            args.due_date.as_deref(),
            args.mark_done,
        )
        .map_err(|e| McpError::internal_error(format!("update_task: {e}"), None))?;
        if affected == 0 {
            return Err(McpError::invalid_params(
                format!("任务 {} 不存在", args.id),
                None,
            ));
        }
        Ok(CallToolResult::success(vec![Content::text(
            format!("{{\"id\":{},\"updated\":true}}", args.id),
        )]))
    }

    // ─── ✏️ 写工具：create_note ─────────────────────────────────
    #[tool(description = "创建一条新笔记（仅 --writable 模式可用）。\
                          自动同步 title_normalized / content_hash / FTS5 索引。\
                          返回 {id, title} JSON。")]
    fn create_note(
        &self,
        Parameters(args): Parameters<CreateNoteArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_writable()?;
        let title = args.title.trim();
        if title.is_empty() {
            return Err(McpError::invalid_params(
                "title 不能为空".to_string(),
                None,
            ));
        }
        let conn = self
            .db
            .conn
            .lock()
            .map_err(|e| McpError::internal_error(format!("db lock: {e}"), None))?;
        let id = create_note(&conn, title, &args.content, args.folder_id)
            .map_err(|e| McpError::internal_error(format!("create_note: {e}"), None))?;
        let json = serde_json::to_string(&serde_json::json!({
            "id": id,
            "title": title,
        }))
        .map_err(|e| McpError::internal_error(format!("serialize: {e}"), None))?;
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    // ─── ✏️ 写工具：update_note ─────────────────────────────────
    #[tool(description = "按 id 更新笔记。title / content / folder_id 都是可选，\
                          只更新传入的字段。会拒绝改加密笔记。仅 --writable 模式可用。")]
    fn update_note(
        &self,
        Parameters(args): Parameters<UpdateNoteArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_writable()?;
        if args.title.is_none() && args.content.is_none() && args.folder_id.is_none() {
            return Err(McpError::invalid_params(
                "至少要传 title / content / folder_id 之一".to_string(),
                None,
            ));
        }
        let conn = self
            .db
            .conn
            .lock()
            .map_err(|e| McpError::internal_error(format!("db lock: {e}"), None))?;
        let affected = update_note(
            &conn,
            args.id,
            args.title.as_deref(),
            args.content.as_deref(),
            args.folder_id,
        )
        .map_err(|e| McpError::internal_error(format!("update_note: {e}"), None))?;
        if affected == 0 {
            return Err(McpError::invalid_params(
                format!("笔记 {} 不存在或是加密笔记/已删除", args.id),
                None,
            ));
        }
        Ok(CallToolResult::success(vec![Content::text(
            format!("{{\"id\":{},\"updated\":true}}", args.id),
        )]))
    }

    // ─── ✏️ 写工具：add_tag_to_note ─────────────────────────────
    #[tool(description = "给笔记加标签（标签不存在自动创建）。仅 --writable 模式可用。\
                          返回 {tag_id, note_id, created_tag} JSON。")]
    fn add_tag_to_note(
        &self,
        Parameters(args): Parameters<AddTagArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_writable()?;
        let tag = args.tag.trim();
        if tag.is_empty() {
            return Err(McpError::invalid_params(
                "tag 不能为空".to_string(),
                None,
            ));
        }
        let conn = self
            .db
            .conn
            .lock()
            .map_err(|e| McpError::internal_error(format!("db lock: {e}"), None))?;
        let (tag_id, created_tag) = add_tag_to_note(&conn, args.note_id, tag)
            .map_err(|e| McpError::internal_error(format!("add_tag: {e}"), None))?;
        let json = serde_json::to_string(&serde_json::json!({
            "tag_id": tag_id,
            "note_id": args.note_id,
            "created_tag": created_tag,
        }))
        .map_err(|e| McpError::internal_error(format!("serialize: {e}"), None))?;
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }
}

#[tool_handler]
impl ServerHandler for KbServer {
    fn get_info(&self) -> ServerInfo {
        // 注意：Implementation::from_build_env() 会读 rmcp 自己的 cargo env，必须手动 new
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("kb-mcp", env!("CARGO_PKG_VERSION")))
            .with_protocol_version(ProtocolVersion::V_2024_11_05)
            .with_instructions(format!(
                "本 MCP server 暴露本地知识库（笔记 / 标签 / 双链 / 任务 / 日记 / Prompt / 文件夹）。\
                 读工具：search_notes / get_note / list_recent_notes / list_tags / search_by_tag / \
                 get_backlinks / list_daily_notes / list_tasks / get_prompt / \
                 list_folders / list_notes_by_folder / list_templates / list_trash。\
                 写工具：create_note / update_note / delete_note / move_notes_batch / \
                 add_tag_to_note / remove_tag_from_note / create_task / update_task / \
                 create_folder / create_note_from_template / restore_note_from_trash（{}）。\
                 默认过滤回收站、隐藏、加密笔记，保护隐私。",
                if self.writable { "已启用" } else { "当前禁用，启动加 --writable 开启" }
            ))
    }
}

// ─── SQL 实现（独立函数，不复用主应用代码避免循环依赖） ─────────────

/// FTS5 搜索（与主应用 src-tauri/src/database/search.rs::search_fts 保持一致）
///
/// 排序：bm25(notes_fts, 5.0, 1.0) — title 列权重 5，content 权重 1。
/// 过滤：is_deleted=0 AND is_hidden=0 AND is_encrypted=0（比主应用多过滤加密）
fn search_fts(
    conn: &Connection,
    fts_query: &str,
    limit: usize,
) -> Result<Vec<SearchHit>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT n.id, n.title,
                snippet(notes_fts, 1, '', '', '...', 32) as snippet,
                n.updated_at, n.folder_id
         FROM notes_fts fts
         JOIN notes n ON fts.rowid = n.id
         WHERE notes_fts MATCH ?1
           AND n.is_deleted = 0
           AND n.is_hidden = 0
           AND n.is_encrypted = 0
         ORDER BY bm25(notes_fts, 5.0, 1.0)
         LIMIT ?2",
    )?;

    let rows = stmt
        .query_map(params![fts_query, limit as i64], |row| {
            Ok(SearchHit {
                id: row.get(0)?,
                title: row.get(1)?,
                snippet: row.get(2)?,
                updated_at: row.get(3)?,
                folder_id: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(rows)
}

/// LIKE 模糊搜索兜底
fn search_like(
    conn: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<SearchHit>, rusqlite::Error> {
    let pattern = format!("%{}%", query);
    let mut stmt = conn.prepare(
        "SELECT n.id, n.title, substr(n.content, 1, 140), n.updated_at, n.folder_id
         FROM notes n
         WHERE n.is_deleted = 0 AND n.is_hidden = 0 AND n.is_encrypted = 0
           AND (n.title LIKE ?1 OR n.content LIKE ?1)
         ORDER BY n.updated_at DESC
         LIMIT ?2",
    )?;

    let rows = stmt
        .query_map(params![pattern, limit as i64], |row| {
            let raw_snippet: String = row.get(2)?;
            Ok(SearchHit {
                id: row.get(0)?,
                title: row.get(1)?,
                snippet: strip_tags(&raw_snippet),
                updated_at: row.get(3)?,
                folder_id: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(rows)
}

/// 取单条笔记的明文。加密笔记返回占位符。隐藏笔记返回 None。
fn fetch_note(conn: &Connection, id: i64) -> Result<Option<NoteDetail>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, title, content, folder_id, is_daily, daily_date,
                is_pinned, is_hidden, is_encrypted, word_count,
                created_at, updated_at
         FROM notes WHERE id = ?1 AND is_deleted = 0",
    )?;

    let r = stmt
        .query_row(params![id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, i32>(4)? != 0,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, i32>(6)? != 0,
                row.get::<_, i32>(7)? != 0,
                row.get::<_, i32>(8)? != 0,
                row.get::<_, i64>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, String>(11)?,
            ))
        })
        .ok();

    let Some((
        id,
        title,
        content,
        folder_id,
        is_daily,
        daily_date,
        is_pinned,
        is_hidden,
        is_encrypted,
        word_count,
        created_at,
        updated_at,
    )) = r
    else {
        return Ok(None);
    };

    if is_hidden {
        return Ok(None);
    }

    let safe_content = if is_encrypted {
        "🔒 已加密笔记（kb-mcp 不暴露密文，请在主应用内解锁查看）".to_string()
    } else {
        content
    };

    Ok(Some(NoteDetail {
        id,
        title,
        content: safe_content,
        folder_id,
        is_daily,
        daily_date,
        is_pinned,
        word_count,
        created_at,
        updated_at,
    }))
}

/// 列出所有标签 + 笔记数（已删除笔记不计入）
fn list_tags(conn: &Connection) -> Result<Vec<TagInfo>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.color, COUNT(nt.note_id) as note_count
         FROM tags t
         LEFT JOIN note_tags nt ON t.id = nt.tag_id
         LEFT JOIN notes n ON nt.note_id = n.id AND n.is_deleted = 0
         GROUP BY t.id
         ORDER BY note_count DESC, t.name",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(TagInfo {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                note_count: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 按标签名筛选笔记（精确匹配 tag.name）
fn search_by_tag(
    conn: &Connection,
    tag: &str,
    limit: usize,
) -> Result<Vec<SearchHit>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT n.id, n.title, substr(n.content, 1, 140), n.updated_at, n.folder_id
         FROM notes n
         JOIN note_tags nt ON nt.note_id = n.id
         JOIN tags t ON t.id = nt.tag_id
         WHERE t.name = ?1
           AND n.is_deleted = 0 AND n.is_hidden = 0 AND n.is_encrypted = 0
         ORDER BY n.updated_at DESC
         LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![tag, limit as i64], |row| {
            let raw: String = row.get(2)?;
            Ok(SearchHit {
                id: row.get(0)?,
                title: row.get(1)?,
                snippet: strip_tags(&raw),
                updated_at: row.get(3)?,
                folder_id: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 反向链接：哪些笔记 [[链接]] 到了 target_id
/// 与主应用 database/links.rs::get_backlinks 保持一致逻辑（过滤 is_hidden / is_deleted）
fn get_backlinks(
    conn: &Connection,
    target_id: i64,
) -> Result<Vec<BacklinkRef>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT nl.source_id, n.title, nl.context, n.updated_at
         FROM note_links nl
         JOIN notes n ON n.id = nl.source_id
         WHERE nl.target_id = ?1 AND n.is_deleted = 0 AND n.is_hidden = 0
         ORDER BY n.updated_at DESC",
    )?;
    let rows = stmt
        .query_map(params![target_id], |row| {
            Ok(BacklinkRef {
                source_id: row.get(0)?,
                source_title: row.get(1)?,
                context: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 最近 N 天的日记（is_daily=1，按 daily_date 降序）
fn list_daily_notes(
    conn: &Connection,
    days: i64,
    limit: usize,
) -> Result<Vec<SearchHit>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT n.id, n.title, substr(n.content, 1, 140), n.updated_at, n.folder_id
         FROM notes n
         WHERE n.is_daily = 1
           AND n.is_deleted = 0 AND n.is_hidden = 0 AND n.is_encrypted = 0
           AND n.daily_date IS NOT NULL
           AND date(n.daily_date) >= date('now', 'localtime', ?1)
         ORDER BY n.daily_date DESC
         LIMIT ?2",
    )?;
    let offset = format!("-{} days", days);
    let rows = stmt
        .query_map(params![offset, limit as i64], |row| {
            let raw: String = row.get(2)?;
            Ok(SearchHit {
                id: row.get(0)?,
                title: row.get(1)?,
                snippet: strip_tags(&raw),
                updated_at: row.get(3)?,
                folder_id: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 任务列表（只主任务，可按 status / keyword 过滤）
fn list_tasks(
    conn: &Connection,
    status: Option<i64>,
    keyword: Option<&str>,
    limit: usize,
) -> Result<Vec<TaskRow>, rusqlite::Error> {
    let mut where_parts: Vec<&str> = vec!["t.parent_task_id IS NULL"];
    let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(s) = status {
        where_parts.push("t.status = ?");
        binds.push(Box::new(s));
    }
    let kw_pattern = keyword.and_then(|k| {
        let t = k.trim();
        (!t.is_empty()).then(|| format!("%{}%", t))
    });
    if kw_pattern.is_some() {
        where_parts.push("(t.title LIKE ? OR IFNULL(t.description, '') LIKE ?)");
    }
    let where_sql = where_parts.join(" AND ");
    let sql = format!(
        "SELECT t.id, t.title, t.description, t.priority, t.important, t.status,
                t.due_date, t.completed_at, t.created_at, t.updated_at
         FROM tasks t
         WHERE {}
         ORDER BY t.priority ASC,
                  CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END,
                  t.due_date ASC,
                  t.updated_at DESC
         LIMIT ?",
        where_sql
    );

    if let Some(ref kw) = kw_pattern {
        binds.push(Box::new(kw.clone()));
        binds.push(Box::new(kw.clone()));
    }
    binds.push(Box::new(limit as i64));

    let mut stmt = conn.prepare(&sql)?;
    let bind_refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b.as_ref()).collect();
    let rows = stmt
        .query_map(&*bind_refs, |row| {
            Ok(TaskRow {
                id: row.get(0)?,
                title: row.get(1)?,
                description: row.get(2)?,
                priority: row.get(3)?,
                important: row.get::<_, i32>(4)? != 0,
                status: row.get(5)?,
                due_date: row.get(6)?,
                completed_at: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 取单条 prompt（按 id 优先，否则 builtin_code）
fn get_prompt(
    conn: &Connection,
    id: Option<i64>,
    builtin_code: Option<&str>,
) -> Result<Option<PromptDetail>, rusqlite::Error> {
    let cols = "id, title, description, prompt, output_mode, icon,
                is_builtin, builtin_code, enabled";
    let (sql, key): (String, Box<dyn rusqlite::ToSql>) = if let Some(id) = id {
        (
            format!("SELECT {} FROM prompt_templates WHERE id = ?1", cols),
            Box::new(id),
        )
    } else if let Some(code) = builtin_code {
        (
            format!(
                "SELECT {} FROM prompt_templates WHERE builtin_code = ?1",
                cols
            ),
            Box::new(code.to_string()),
        )
    } else {
        return Ok(None);
    };

    let mut stmt = conn.prepare(&sql)?;
    let r = stmt
        .query_row([key.as_ref()], |row| {
            Ok(PromptDetail {
                id: row.get(0)?,
                title: row.get(1)?,
                description: row.get(2)?,
                prompt: row.get(3)?,
                output_mode: row.get(4)?,
                icon: row.get(5)?,
                is_builtin: row.get::<_, i32>(6)? != 0,
                builtin_code: row.get(7)?,
                enabled: row.get::<_, i32>(8)? != 0,
            })
        })
        .ok();
    Ok(r)
}

/// 列出所有 note_templates（按 id 升序，内置在前）
fn list_templates(conn: &Connection) -> Result<Vec<TemplateInfo>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, name, description, content, created_at
         FROM note_templates ORDER BY id",
    )?;
    let rows = stmt
        .query_map([], |row| {
            let raw_content: String = row.get(3)?;
            Ok(TemplateInfo {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                preview: {
                    let plain = strip_tags(&raw_content);
                    plain.chars().take(140).collect()
                },
                created_at: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 列出回收站笔记（is_deleted=1，过滤加密/隐藏）
fn list_trash(
    conn: &Connection,
    limit: usize,
) -> Result<Vec<TrashItem>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, title, substr(content, 1, 140), updated_at
         FROM notes
         WHERE is_deleted = 1
           AND is_hidden = 0
           AND is_encrypted = 0
         ORDER BY updated_at DESC
         LIMIT ?1",
    )?;
    let rows = stmt
        .query_map(params![limit as i64], |row| {
            let raw: String = row.get(2)?;
            Ok(TrashItem {
                id: row.get(0)?,
                title: row.get(1)?,
                snippet: strip_tags(&raw),
                deleted_at: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 按 updated_at 降序列最近笔记（不限文件夹/标签）
fn list_recent_notes(
    conn: &Connection,
    limit: usize,
) -> Result<Vec<SearchHit>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT n.id, n.title, substr(n.content, 1, 140), n.updated_at, n.folder_id
         FROM notes n
         WHERE n.is_deleted = 0 AND n.is_hidden = 0 AND n.is_encrypted = 0
         ORDER BY n.updated_at DESC
         LIMIT ?1",
    )?;
    let rows = stmt
        .query_map(params![limit as i64], map_note_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 列所有文件夹 + 直接子项笔记数（不递归）
fn list_folders(conn: &Connection) -> Result<Vec<FolderInfo>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT f.id, f.name, f.parent_id,
                (SELECT COUNT(*) FROM notes n
                 WHERE n.folder_id = f.id
                   AND n.is_deleted = 0
                   AND n.is_hidden = 0
                   AND n.is_encrypted = 0) AS note_count
         FROM folders f
         ORDER BY f.sort_order ASC, f.name ASC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(FolderInfo {
                id: row.get(0)?,
                name: row.get(1)?,
                parent_id: row.get(2)?,
                note_count: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 按 folder_id 列笔记
/// - folder_id=None → folder_id IS NULL（未分类）
/// - folder_id=Some(x) + recurse=false → 直接子项
/// - folder_id=Some(x) + recurse=true → 递归收集子文件夹的所有笔记
fn list_notes_by_folder(
    conn: &Connection,
    folder_id: Option<i64>,
    recurse: bool,
    limit: usize,
) -> Result<Vec<SearchHit>, rusqlite::Error> {
    // 计算目标 folder id 集合
    let folder_ids: Vec<i64> = match (folder_id, recurse) {
        (None, _) => Vec::new(), // 走 folder_id IS NULL 分支
        (Some(root), false) => vec![root],
        (Some(root), true) => collect_descendant_folder_ids(conn, root)?,
    };

    let (sql, hits) = if folder_ids.is_empty() {
        // 未分类
        let sql = "SELECT n.id, n.title, substr(n.content, 1, 140), n.updated_at, n.folder_id
                   FROM notes n
                   WHERE n.folder_id IS NULL
                     AND n.is_deleted = 0 AND n.is_hidden = 0 AND n.is_encrypted = 0
                   ORDER BY n.updated_at DESC
                   LIMIT ?1";
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt
            .query_map(params![limit as i64], map_note_row)?
            .collect::<Result<Vec<_>, _>>()?;
        (sql, rows)
    } else {
        // 指定 folder_id 集合
        let placeholders = folder_ids
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT n.id, n.title, substr(n.content, 1, 140), n.updated_at, n.folder_id
             FROM notes n
             WHERE n.folder_id IN ({})
               AND n.is_deleted = 0 AND n.is_hidden = 0 AND n.is_encrypted = 0
             ORDER BY n.updated_at DESC
             LIMIT ?",
            placeholders
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut binds: Vec<Box<dyn rusqlite::ToSql>> = folder_ids
            .iter()
            .map(|id| Box::new(*id) as Box<dyn rusqlite::ToSql>)
            .collect();
        binds.push(Box::new(limit as i64));
        let bind_refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b.as_ref()).collect();
        let rows = stmt
            .query_map(&*bind_refs, map_note_row)?
            .collect::<Result<Vec<_>, _>>()?;
        ("(dynamic)", rows)
    };

    let _ = sql; // suppress unused
    Ok(hits)
}

fn map_note_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SearchHit> {
    let raw: String = row.get(2)?;
    Ok(SearchHit {
        id: row.get(0)?,
        title: row.get(1)?,
        snippet: strip_tags(&raw),
        updated_at: row.get(3)?,
        folder_id: row.get(4)?,
    })
}

/// 收集 root + 所有递归子文件夹 id（BFS）
fn collect_descendant_folder_ids(
    conn: &Connection,
    root: i64,
) -> Result<Vec<i64>, rusqlite::Error> {
    let mut all = vec![root];
    let mut frontier = vec![root];
    while !frontier.is_empty() {
        let placeholders = frontier.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT id FROM folders WHERE parent_id IN ({})",
            placeholders
        );
        let mut stmt = conn.prepare(&sql)?;
        let binds: Vec<Box<dyn rusqlite::ToSql>> = frontier
            .iter()
            .map(|id| Box::new(*id) as Box<dyn rusqlite::ToSql>)
            .collect();
        let bind_refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b.as_ref()).collect();
        let next: Vec<i64> = stmt
            .query_map(&*bind_refs, |row| row.get::<_, i64>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        frontier = next.clone();
        all.extend(next);
        // 防御性截断，避免环（理论上 SQL 约束阻止环，但谨慎一些）
        if all.len() > 10_000 {
            break;
        }
    }
    Ok(all)
}

// ─── 写操作（仅 writable 模式调用） ─────────────────────────────

/// 创建笔记。同步维护 title_normalized + content_hash（FTS5 / word_count 由触发器自动）
/// 与主应用 database/notes.rs::create_note 保持字段一致性
fn create_note(
    conn: &Connection,
    title: &str,
    content: &str,
    folder_id: Option<i64>,
) -> Result<i64, rusqlite::Error> {
    let normalized = normalize_title(title);
    let hash = sha256_hex(content);
    conn.execute(
        "INSERT INTO notes (title, content, folder_id, title_normalized, content_hash)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![title, content, folder_id, normalized, hash],
    )?;
    Ok(conn.last_insert_rowid())
}

/// 更新笔记。任意字段为 None 表示不变。
/// 拒绝改加密笔记 / 已删除笔记（WHERE 条件自动过滤）。
/// 返回受影响行数。
fn update_note(
    conn: &Connection,
    id: i64,
    title: Option<&str>,
    content: Option<&str>,
    folder_id: Option<i64>,
) -> Result<usize, rusqlite::Error> {
    let mut set_parts: Vec<String> = Vec::new();
    let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(t) = title {
        set_parts.push("title = ?".into());
        set_parts.push("title_normalized = ?".into());
        binds.push(Box::new(t.to_string()));
        binds.push(Box::new(normalize_title(t)));
    }
    if let Some(c) = content {
        set_parts.push("content = ?".into());
        set_parts.push("content_hash = ?".into());
        binds.push(Box::new(c.to_string()));
        binds.push(Box::new(sha256_hex(c)));
    }
    if let Some(fid) = folder_id {
        set_parts.push("folder_id = ?".into());
        binds.push(Box::new(fid));
    }
    set_parts.push("updated_at = datetime('now', 'localtime')".into());

    let sql = format!(
        "UPDATE notes SET {} WHERE id = ? AND is_deleted = 0 AND is_encrypted = 0",
        set_parts.join(", ")
    );
    binds.push(Box::new(id));

    let bind_refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b.as_ref()).collect();
    conn.execute(&sql, &*bind_refs)
}

/// 批量移动笔记到目标文件夹。只改 folder_id，**不刷新 updated_at**
/// （避免大量笔记被冒泡到"最近更新"列表前面，与主应用 database/notes.rs 行为一致）。
/// folder_id = None 表示移到未分类。
fn move_notes_batch(
    conn: &Connection,
    ids: &[i64],
    folder_id: Option<i64>,
) -> Result<usize, rusqlite::Error> {
    if ids.is_empty() {
        return Ok(0);
    }
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "UPDATE notes SET folder_id = ?
         WHERE id IN ({})
           AND is_deleted = 0
           AND is_encrypted = 0",
        placeholders
    );
    let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::with_capacity(ids.len() + 1);
    binds.push(Box::new(folder_id));
    for id in ids {
        binds.push(Box::new(*id));
    }
    let bind_refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b.as_ref()).collect();
    conn.execute(&sql, &*bind_refs)
}

/// 创建文件夹。返回新 id。sort_order 默认 0（按 name 排）。
fn create_folder(
    conn: &Connection,
    name: &str,
    parent_id: Option<i64>,
) -> Result<i64, rusqlite::Error> {
    conn.execute(
        "INSERT INTO folders (name, parent_id, sort_order) VALUES (?1, ?2, 0)",
        params![name, parent_id],
    )?;
    Ok(conn.last_insert_rowid())
}

/// 按模板创建笔记。title 不传则用「模板名 · YYYY-MM-DD」。
/// 内部复用 create_note 的字段维护（title_normalized + content_hash）
fn create_note_from_template(
    conn: &Connection,
    template_id: i64,
    title: Option<&str>,
    folder_id: Option<i64>,
) -> Result<(i64, String), rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT name, content FROM note_templates WHERE id = ?1",
    )?;
    let (template_name, template_content): (String, String) =
        stmt.query_row(params![template_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;

    let final_title = match title {
        Some(t) if !t.trim().is_empty() => t.trim().to_string(),
        _ => {
            let today = chrono::Local::now().format("%Y-%m-%d").to_string();
            format!("{} · {}", template_name, today)
        }
    };

    let id = create_note(conn, &final_title, &template_content, folder_id)?;
    Ok((id, final_title))
}

/// 把回收站里的笔记还原（is_deleted: 1 → 0）。
fn restore_note_from_trash(conn: &Connection, id: i64) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "UPDATE notes
         SET is_deleted = 0,
             updated_at = datetime('now', 'localtime')
         WHERE id = ?1 AND is_deleted = 1",
        params![id],
    )
}

/// 软删笔记（is_deleted=1，原数据保留，可在主应用回收站恢复）。
/// 拒绝改加密笔记。返回受影响行数。
fn soft_delete_note(conn: &Connection, id: i64) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "UPDATE notes
         SET is_deleted = 1,
             updated_at = datetime('now', 'localtime')
         WHERE id = ?1
           AND is_deleted = 0
           AND is_encrypted = 0",
        params![id],
    )
}

/// 撤回笔记的某个标签关联（不删 tags 表，只清 note_tags 关联）。
/// 返回是否真删除了一行。
fn remove_tag_from_note(
    conn: &Connection,
    note_id: i64,
    tag: &str,
) -> Result<bool, rusqlite::Error> {
    let affected = conn.execute(
        "DELETE FROM note_tags
         WHERE note_id = ?1
           AND tag_id = (SELECT id FROM tags WHERE name = ?2)",
        params![note_id, tag],
    )?;
    Ok(affected > 0)
}

/// 创建任务（主任务，parent_task_id=NULL）。返回新 id。
fn create_task(
    conn: &Connection,
    title: &str,
    description: Option<&str>,
    priority: i64,
    important: bool,
    due_date: Option<&str>,
) -> Result<i64, rusqlite::Error> {
    conn.execute(
        "INSERT INTO tasks (title, description, priority, important, status, due_date)
         VALUES (?1, ?2, ?3, ?4, 0, ?5)",
        params![title, description, priority, important as i32, due_date],
    )?;
    Ok(conn.last_insert_rowid())
}

/// 更新任务字段。任意字段为 None 表示不变。
/// `mark_done = Some(true)` → status=1 + completed_at=now；
/// `mark_done = Some(false)` → status=0 + completed_at=null。
fn update_task(
    conn: &Connection,
    id: i64,
    title: Option<&str>,
    description: Option<&str>,
    priority: Option<i64>,
    important: Option<bool>,
    due_date: Option<&str>,
    mark_done: Option<bool>,
) -> Result<usize, rusqlite::Error> {
    let mut set_parts: Vec<String> = Vec::new();
    let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(t) = title {
        set_parts.push("title = ?".into());
        binds.push(Box::new(t.to_string()));
    }
    if let Some(d) = description {
        set_parts.push("description = ?".into());
        binds.push(Box::new(d.to_string()));
    }
    if let Some(p) = priority {
        set_parts.push("priority = ?".into());
        binds.push(Box::new(p));
    }
    if let Some(imp) = important {
        set_parts.push("important = ?".into());
        binds.push(Box::new(imp as i32));
    }
    if let Some(dd) = due_date {
        set_parts.push("due_date = ?".into());
        binds.push(Box::new(dd.to_string()));
    }
    if let Some(done) = mark_done {
        if done {
            set_parts.push("status = 1".into());
            set_parts.push("completed_at = datetime('now', 'localtime')".into());
        } else {
            set_parts.push("status = 0".into());
            set_parts.push("completed_at = NULL".into());
        }
    }
    set_parts.push("updated_at = datetime('now', 'localtime')".into());

    let sql = format!(
        "UPDATE tasks SET {} WHERE id = ?",
        set_parts.join(", ")
    );
    binds.push(Box::new(id));

    let bind_refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b.as_ref()).collect();
    conn.execute(&sql, &*bind_refs)
}

/// 给笔记加标签。tag 不存在则创建。返回 (tag_id, created_tag)。
fn add_tag_to_note(
    conn: &Connection,
    note_id: i64,
    tag: &str,
) -> Result<(i64, bool), rusqlite::Error> {
    let existing: Option<i64> = conn
        .query_row("SELECT id FROM tags WHERE name = ?1", params![tag], |r| {
            r.get(0)
        })
        .ok();
    let (tag_id, created_tag) = if let Some(id) = existing {
        (id, false)
    } else {
        conn.execute("INSERT INTO tags (name) VALUES (?1)", params![tag])?;
        (conn.last_insert_rowid(), true)
    };
    conn.execute(
        "INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?1, ?2)",
        params![note_id, tag_id],
    )?;
    Ok((tag_id, created_tag))
}

// ─── 与主应用一致的工具函数（避免循环依赖，独立复刻） ─────────────

/// 复刻 src-tauri/src/database/links.rs::normalize_title
fn normalize_title(s: &str) -> String {
    unescape_md(s)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn unescape_md(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(&next) = chars.peek() {
                if !next.is_alphanumeric() {
                    chars.next();
                    out.push(next);
                    continue;
                }
            }
        }
        out.push(c);
    }
    out
}

/// 复刻 src-tauri/src/services/hash.rs::sha256_hex
fn sha256_hex(content: &str) -> String {
    use sha2::{Digest, Sha256};
    use std::fmt::Write;
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let out = hasher.finalize();
    let mut s = String::with_capacity(out.len() * 2);
    for b in out {
        let _ = write!(&mut s, "{:02x}", b);
    }
    s
}

/// 把用户查询转 FTS5 前缀匹配语法。
/// 与主应用 src-tauri/src/database/search.rs::sanitize_fts_query 保持完全一致行为。
fn sanitize_fts_query(query: &str) -> String {
    query
        .split_whitespace()
        .map(|word| {
            let clean: String = word
                .chars()
                .filter(|c| !matches!(c, '"' | '*' | '(' | ')' | ':' | '^' | '{' | '}'))
                .collect();
            if clean.is_empty() {
                String::new()
            } else {
                format!("{}*", clean)
            }
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// 去掉 HTML 标签，给 snippet 用
fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}
