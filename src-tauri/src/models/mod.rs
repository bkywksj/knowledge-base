use serde::{Deserialize, Serialize};

/// 应用配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub key: String,
    pub value: String,
}

/// 系统信息
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub os: String,
    pub arch: String,
    pub app_version: String,
    pub data_dir: String,
}

// ─── 笔记 ─────────────────────────────────────

/// 笔记（返回给前端）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: i64,
    pub title: String,
    pub content: String,
    pub folder_id: Option<i64>,
    pub is_daily: bool,
    pub daily_date: Option<String>,
    pub is_pinned: bool,
    pub word_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 创建/更新笔记的入参
#[derive(Debug, Clone, Deserialize)]
pub struct NoteInput {
    pub title: String,
    pub content: String,
    pub folder_id: Option<i64>,
}

/// 笔记列表查询参数
#[derive(Debug, Clone, Deserialize)]
pub struct NoteQuery {
    pub folder_id: Option<i64>,
    pub keyword: Option<String>,
    pub page: Option<usize>,
    pub page_size: Option<usize>,
}

// ─── 文件夹 ───────────────────────────────────

/// 文件夹（返回给前端，含子文件夹树）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    pub sort_order: i32,
    pub children: Vec<Folder>,
    pub note_count: usize,
}

// ─── 标签 ─────────────────────────────────────

/// 标签（返回给前端，含关联笔记数）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
    pub note_count: usize,
}

/// 创建/更新标签的入参
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct TagInput {
    pub name: String,
    pub color: Option<String>,
}

// ─── 搜索 ─────────────────────────────────────

/// 全文搜索结果
#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub id: i64,
    pub title: String,
    pub snippet: String,
    pub updated_at: String,
    pub folder_id: Option<i64>,
}

// ─── 回收站 ───────────────────────────────────

/// 回收站笔记查询参数
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct TrashQuery {
    pub page: Option<usize>,
    pub page_size: Option<usize>,
}

// ─── 笔记链接 ─────────────────────────────────

/// 笔记链接（反向链接信息）
#[derive(Debug, Clone, Serialize)]
pub struct NoteLink {
    pub source_id: i64,
    pub source_title: String,
    pub context: Option<String>,
    pub updated_at: String,
}

// ─── 知识图谱 ─────────────────────────────────

/// 图谱节点（笔记）
#[derive(Debug, Clone, Serialize)]
pub struct GraphNode {
    pub id: i64,
    pub title: String,
    pub is_daily: bool,
    pub is_pinned: bool,
    pub tag_count: usize,
    pub link_count: usize,
}

/// 图谱边（链接关系）
#[derive(Debug, Clone, Serialize)]
pub struct GraphEdge {
    pub source: i64,
    pub target: i64,
}

/// 知识图谱数据
#[derive(Debug, Clone, Serialize)]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

// ─── AI 知识问答 ─────────────────────────────

/// AI 模型配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiModel {
    pub id: i64,
    pub name: String,
    /// 模型提供商: openai / claude / ollama
    pub provider: String,
    /// API 基础 URL
    pub api_url: String,
    /// API Key（可为空，如 Ollama 本地模型）
    pub api_key: Option<String>,
    /// 模型标识 (如 gpt-4o-mini, claude-sonnet-4-20250514, llama3)
    pub model_id: String,
    /// 是否为默认模型
    pub is_default: bool,
    pub created_at: String,
}

/// 创建/更新 AI 模型入参
#[derive(Debug, Clone, Deserialize)]
pub struct AiModelInput {
    pub name: String,
    pub provider: String,
    pub api_url: String,
    pub api_key: Option<String>,
    pub model_id: String,
}

/// AI 对话
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConversation {
    pub id: i64,
    pub title: String,
    pub model_id: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// AI 消息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiMessage {
    pub id: i64,
    pub conversation_id: i64,
    /// 角色: user / assistant
    pub role: String,
    pub content: String,
    /// 引用的笔记 ID 列表 (JSON 数组)
    pub references: Option<String>,
    pub created_at: String,
}

/// AI 聊天请求
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct AiChatRequest {
    pub conversation_id: i64,
    pub message: String,
    /// 是否启用 RAG（检索笔记作为上下文）
    pub use_rag: Option<bool>,
}

// ─── 首页统计 ─────────────────────────────────

/// 首页统计数据
#[derive(Debug, Clone, Serialize)]
pub struct DashboardStats {
    pub total_notes: usize,
    pub total_folders: usize,
    pub total_tags: usize,
    pub total_links: usize,
    pub today_updated: usize,
    pub total_words: usize,
}

// ─── 导入 ─────────────────────────────────────

/// 扫描到的文件条目（供前端预览勾选）
#[derive(Debug, Clone, Serialize)]
pub struct ScannedFile {
    /// 文件绝对路径
    pub path: String,
    /// 文件名（不含扩展名）
    pub name: String,
    /// 文件大小（字节）
    pub size: u64,
}

/// 导入结果
#[derive(Debug, Clone, Serialize)]
pub struct ImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}

/// 导入进度（通过事件推送）
#[derive(Debug, Clone, Serialize)]
pub struct ImportProgress {
    pub current: usize,
    pub total: usize,
    pub file_name: String,
}

// ─── 导出 ─────────────────────────────────────

/// 导出结果
#[derive(Debug, Clone, Serialize)]
pub struct ExportResult {
    pub exported: usize,
    pub errors: Vec<String>,
    pub output_dir: String,
}

/// 导出进度（通过事件推送）
#[derive(Debug, Clone, Serialize)]
pub struct ExportProgress {
    pub current: usize,
    pub total: usize,
    pub file_name: String,
}

// ─── 通用 ─────────────────────────────────────

/// 分页响应
#[derive(Debug, Clone, Serialize)]
pub struct PageResult<T: Serialize> {
    pub items: Vec<T>,
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
}
