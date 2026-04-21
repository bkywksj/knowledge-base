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
    pub images_dir: String,
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
    /// 关联的原始文件相对路径（相对 app_data_dir），为 None 表示纯笔记
    pub source_file_path: Option<String>,
    /// 原始文件类型："pdf" / "docx" / "doc" / null
    pub source_file_type: Option<String>,
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

/// "打开单个 md 文件"返回结果：含新建/复用的 note id + 是否触发了内容同步
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenMarkdownResult {
    pub note_id: i64,
    /// true = 检测到源文件内容有变化，已覆盖回笔记（前端可据此提示）
    pub was_synced: bool,
}

/// 孤儿图片扫描结果（只扫不删）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanImageScan {
    /// 孤儿数量
    pub count: usize,
    /// 总字节数
    pub total_bytes: u64,
    /// 孤儿文件绝对路径列表（上限 500 条避免过大）
    pub paths: Vec<String>,
    /// 实际发现的孤儿是否被截断显示
    pub truncated: bool,
}

/// 孤儿图片清理结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanImageClean {
    /// 成功删除数量
    pub deleted: usize,
    /// 释放字节数
    pub freed_bytes: u64,
    /// 删除失败的文件（路径 + 错误消息）
    pub failed: Vec<String>,
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

// ─── 写作趋势 ─────────────────────────────────

/// 每日写作统计
#[derive(Debug, Clone, Serialize)]
pub struct DailyWritingStat {
    /// 日期 (YYYY-MM-DD)
    pub date: String,
    /// 当日更新的笔记数
    pub note_count: usize,
    /// 当日总字数（更新过的笔记的字数之和）
    pub word_count: usize,
}

// ─── 笔记模板 ─────────────────────────────────

/// 笔记模板
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteTemplate {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub content: String,
    pub created_at: String,
}

/// 创建/更新模板入参
#[derive(Debug, Clone, Deserialize)]
pub struct NoteTemplateInput {
    pub name: String,
    pub description: String,
    pub content: String,
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

// ─── 同步 ─────────────────────────────────────

/// 同步范围：控制本次同步包含哪些数据
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncScope {
    /// 笔记元数据（app.db 的 notes 及关联表）
    pub notes: bool,
    /// 图片资产（kb_assets/images/）
    pub images: bool,
    /// PDF 原文件（pdfs/）
    pub pdfs: bool,
    /// Word 源文件（sources/）
    pub sources: bool,
    /// 应用设置（settings.json）
    pub settings: bool,
}

impl Default for SyncScope {
    fn default() -> Self {
        // V1/V2 默认全部勾选（资产也勾，符合用户预期）
        Self {
            notes: true,
            images: true,
            pdfs: true,
            sources: true,
            settings: true,
        }
    }
}

/// 导入模式：合并 or 覆盖
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncImportMode {
    /// 合并：已有的保留，新增的导入
    Merge,
    /// 覆盖：先清空本地 DB/资产，再用同步包替换
    Overwrite,
}

/// WebDAV 配置（不含密码——密码走 keyring）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConfig {
    pub url: String,
    pub username: String,
    /// 仅在前端传入时使用；后端读取时从 keyring 取
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

/// 云端同步文件的清单信息（用于 preview）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncManifest {
    /// manifest 版本号（格式升级用）
    pub schema_version: u32,
    /// 设备名
    pub device: String,
    /// 导出时间（ISO 8601 本地时间）
    pub exported_at: String,
    /// 应用版本
    pub app_version: String,
    /// 本次同步包含的范围
    pub scope: SyncScope,
    /// 元数据统计（仅用于预览展示）
    pub stats: SyncStats,
}

/// 同步数据统计
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStats {
    pub notes_count: usize,
    pub folders_count: usize,
    pub tags_count: usize,
    pub images_count: usize,
    pub pdfs_count: usize,
    pub sources_count: usize,
    /// 资产总大小（字节）
    pub assets_size: u64,
}

/// 同步操作结果
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    /// 实际同步的条数/文件数（视具体范围而定）
    pub stats: SyncStats,
    /// 完成时间
    pub finished_at: String,
}

/// 同步历史记录
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncHistoryItem {
    pub id: i64,
    /// "export" / "import" / "push" / "pull"
    pub direction: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub success: bool,
    pub error: Option<String>,
    pub stats_json: String,
}

// ─── 待办任务 ───────────────────────────────────

/// 任务关联：挂到笔记 / 本地路径 / URL
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskLink {
    pub id: i64,
    pub task_id: i64,
    /// "note" / "path" / "url"
    pub kind: String,
    /// note → note_id 字符串；path → 绝对路径；url → 完整 URL
    pub target: String,
    /// 显示文案（如笔记标题）
    pub label: Option<String>,
}

/// 任务（含关联列表）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: i64,
    pub title: String,
    pub description: Option<String>,
    /// 0=urgent / 1=normal / 2=low
    pub priority: i32,
    pub important: bool,
    /// 0=todo / 1=done
    pub status: i32,
    /// 'YYYY-MM-DD'
    pub due_date: Option<String>,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub links: Vec<TaskLink>,
}

/// 创建任务入参
#[derive(Debug, Clone, Deserialize)]
pub struct CreateTaskInput {
    pub title: String,
    pub description: Option<String>,
    pub priority: Option<i32>,
    pub important: Option<bool>,
    pub due_date: Option<String>,
    pub links: Option<Vec<TaskLinkInput>>,
}

/// 更新任务入参（字段缺省表示不改动）
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateTaskInput {
    pub title: Option<String>,
    pub description: Option<String>,
    pub priority: Option<i32>,
    pub important: Option<bool>,
    pub due_date: Option<String>,
    /// 传 true 显式清空 due_date
    pub clear_due_date: Option<bool>,
}

/// 任务关联入参（新建任务时一起传）
#[derive(Debug, Clone, Deserialize)]
pub struct TaskLinkInput {
    pub kind: String,
    pub target: String,
    pub label: Option<String>,
}

/// 任务查询筛选条件
#[derive(Debug, Clone, Deserialize, Default)]
pub struct TaskQuery {
    /// Some(0) = 只看未完成, Some(1) = 只看已完成, None = 全部
    pub status: Option<i32>,
    /// 关键词（标题 / 描述 LIKE）
    pub keyword: Option<String>,
    /// 某个优先级
    pub priority: Option<i32>,
}

/// 任务统计（首页卡片 / 侧边栏徽章）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStats {
    pub total_todo: usize,
    pub total_done: usize,
    pub urgent_todo: usize,
    pub overdue: usize,
    pub due_today: usize,
}


