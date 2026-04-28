use serde::{Deserialize, Serialize};

/// 应用配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub key: String,
    pub value: String,
}

/// 全局快捷键绑定信息（返回给前端的视图模型）
///
/// - `accel = ""` 表示「禁用」（用户主动关掉这条热键）
/// - `is_custom`：用户改过键（与 `default_accel` 不同 / 已禁用）
/// - 注：仅 global scope 的热键经过 Rust 侧绑定；app/editor 内键不参与此模型
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutBinding {
    pub id: String,
    pub accel: String,
    pub default_accel: String,
    pub is_custom: bool,
    pub disabled: bool,
}

/// 系统信息
///
/// `instance_id` / `is_dev` 用于 UI 区分多开实例（默认实例 = None；多开 = Some(N)）。
/// `data_dir` 永远是当前实例的数据根目录（多开 = `app_data_dir/instance-N`），不是 app_data_dir。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub os: String,
    pub arch: String,
    pub app_version: String,
    pub data_dir: String,
    pub images_dir: String,
    /// 多开实例编号；None = 默认实例
    pub instance_id: Option<u32>,
    /// 是否运行在 debug build 下（前端徽章追加 [DEV] 标识）
    pub is_dev: bool,
}

// ─── 笔记 ─────────────────────────────────────

/// 笔记（返回给前端）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: i64,
    pub title: String,
    /// 明文 content。加密笔记这里是"🔒 已加密"占位符；真实内容需调 decrypt_note 拿
    pub content: String,
    pub folder_id: Option<i64>,
    pub is_daily: bool,
    pub daily_date: Option<String>,
    pub is_pinned: bool,
    /// T-003: 是否"隐藏"。默认视图全部过滤；wiki link 跳转仍可打开
    pub is_hidden: bool,
    /// T-007: 是否加密。前端据此决定是否显示"已加密"/"解锁查看"按钮
    pub is_encrypted: bool,
    pub word_count: i64,
    pub created_at: String,
    pub updated_at: String,
    /// 关联的原始文件相对路径（相对 app_data_dir），为 None 表示纯笔记
    pub source_file_path: Option<String>,
    /// 原始文件类型："pdf" / "docx" / "doc" / null
    pub source_file_type: Option<String>,
}

// ─── T-007 笔记加密保险库 ──────────────────────

/// Vault 整体状态
///
/// 三元状态机：
/// - `NotSet`：还没设置过主密码，首次使用前要走 setup
/// - `Locked`：已设置但未解锁（会话启动态 / 手动锁定后）
/// - `Unlocked`：会话内存里缓存了主密钥；可以加/解密
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VaultStatus {
    NotSet,
    Locked,
    Unlocked,
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
    /// true 时只返回 folder_id IS NULL 的笔记（"未分类"虚拟文件夹）。
    /// 与 folder_id 互斥（同时传 folder_id 优先生效）。
    pub uncategorized: Option<bool>,
    /// true 时点父文件夹连同所有子孙文件夹的笔记一起返回。
    /// 仅当传了 folder_id 时生效；未传时无意义。前端默认 true，符合用户直觉。
    pub include_descendants: Option<bool>,
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
    /// 模型支持的最大上下文 token 数（用户填，默认 32000）
    /// 用于在 send_message 拼附加笔记时动态算每篇截断阈值
    pub max_context: i64,
    pub created_at: String,
}

/// AI 模型连通性测试结果
///
/// 测试按钮专用：发一次极小请求（OpenAI 兼容 max_tokens=1，Ollama num_predict=1），
/// 失败原因走 `format_*_error` 中文化，前端 Modal.error 直接展示。
#[derive(Debug, Clone, Serialize)]
pub struct AiModelTestResult {
    /// 是否连通成功
    pub ok: bool,
    /// 端到端往返耗时（毫秒）
    pub latency_ms: u64,
    /// 服务端样本（成功时取首段回复前 N 字；失败时为空，错误走 Err 路径）
    pub sample: Option<String>,
}

/// 创建/更新 AI 模型入参
#[derive(Debug, Clone, Deserialize)]
pub struct AiModelInput {
    pub name: String,
    pub provider: String,
    pub api_url: String,
    pub api_key: Option<String>,
    pub model_id: String,
    /// 可选：缺省时按 32000 入库（覆盖大多数中端模型）
    pub max_context: Option<i64>,
}

/// AI 对话
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConversation {
    pub id: i64,
    pub title: String,
    pub model_id: i64,
    /// 附加给本对话的笔记 ID 列表（JSON 数组反序列化后）
    /// 整个对话共享，类比 ChatGPT 项目里的 attached files
    pub attached_note_ids: Vec<i64>,
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
    /// 本条 assistant 消息里 AI 调用了哪些 skill（JSON 序列化的 SkillCall 数组）
    ///
    /// 前端拿到后反序列化成 SkillCall[] 渲染折叠卡片；为 None 表示没调用过工具。
    /// 只在 role="assistant" 且启用 skills 的对话里会写入。
    pub skill_calls: Option<String>,
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
///
/// match_kind + existing_note_id 在扫描阶段就告诉前端"该文件是否已经导入过"，
/// 用户可据此选择冲突策略（跳过/副本）。
#[derive(Debug, Clone, Serialize)]
pub struct ScannedFile {
    /// 文件绝对路径
    pub path: String,
    /// 相对扫描根的父目录，斜杠统一为 '/'；根层文件为空串
    /// 示例：扫描 "D:/foo/11"，文件 "D:/foo/11/子A/note.md" → "子A"
    pub relative_dir: String,
    /// 文件名（不含扩展名）
    pub name: String,
    /// 文件大小（字节）
    pub size: u64,
    /// 去重匹配结果：
    /// - "new"   全新文件，未找到任何已有笔记
    /// - "path"  按 canonical source_file_path 命中（最精确）
    /// - "fuzzy" 按 (title, content_hash) 兜底命中（用户可能搬动过源文件）
    pub match_kind: String,
    /// match_kind 非 "new" 时，指向已存在笔记的 id
    pub existing_note_id: Option<i64>,
}

/// 导入冲突策略：遇到已存在的文件怎么处理
///
/// 仅在 `import_selected_files` 批量导入场景生效；
/// 单文件 `open_markdown_file` 另有同步回写语义，不走这里。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportConflictPolicy {
    /// 跳过（默认，最安全）：扫描标记为 path/fuzzy 的文件不重新创建笔记
    Skip,
    /// 创建副本：标题加 " (2)" 后缀新建独立笔记，原笔记保持不变
    Duplicate,
}

impl Default for ImportConflictPolicy {
    fn default() -> Self {
        Self::Skip
    }
}

/// 导入结果
#[derive(Debug, Clone, Default, Serialize)]
pub struct ImportResult {
    /// 新建的笔记数
    pub imported: usize,
    /// 跳过的数量（空文件 / 去重时按 Skip 策略跳过）
    pub skipped: usize,
    /// 按 Duplicate 策略新建的副本数
    pub duplicated: usize,
    pub errors: Vec<String>,
    /// T-009: 从 frontmatter 解析并自动关联的标签条数（每个笔记 × 每个标签计 1）
    #[serde(default)]
    pub tags_attached: usize,
    /// T-009: 成功解析到 frontmatter 的笔记数
    #[serde(default)]
    pub frontmatter_parsed: usize,
    /// T-009 Commit 2: 复制到 kb_assets/images 的图片张数
    #[serde(default)]
    pub attachments_copied: usize,
    /// T-009 Commit 2: 缺失的图片清单（"笔记标题: 原始引用"格式，已去重）
    #[serde(default)]
    pub attachments_missing: Vec<String>,
    /// 本次新建的笔记 ID（按文件参数顺序，含 Duplicate 副本）。
    /// 前端用它做"导入后跳转"：1 篇直接打开编辑器，多篇跳列表。
    #[serde(default, rename = "noteIds")]
    pub note_ids: Vec<i64>,
    /// 命中已有笔记并按 Skip 策略跳过时记录的现有笔记 ID。
    /// 前端"重复命中也跳"逻辑用：用户拖个旧文件想打开它，能直达。
    #[serde(default, rename = "existingNoteIds")]
    pub existing_note_ids: Vec<i64>,
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

// ─── 附件 ─────────────────────────────────────

/// 附件信息（保存后回传给前端，用于插入 Tiptap 链接）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    /// 绝对路径（前端用来构造 file:// 链接给 opener 打开）
    pub path: String,
    /// 原始文件名（用户能看懂的文本，显示在链接里）
    pub file_name: String,
    /// 字节数（用于显示 "1.2 MB"）
    pub size: u64,
    /// MIME 类型（按扩展名映射；未知为 application/octet-stream）
    pub mime: String,
}

// ─── 孤儿素材（统一）─────────────────────────────
//
// 五类素材：images / videos / attachments / pdfs / sources
// 每类独立扫描器；UI 用 Tabs 分组展示。

/// 单条孤儿素材
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanItem {
    /// 素材类型：image / video / attachment / pdf / source
    pub kind: String,
    /// 绝对路径
    pub path: String,
    /// 按 note_id 分目录的素材有；纯平铺的 images 没有
    pub note_id: Option<i64>,
    pub size: u64,
    /// 孤儿原因：notePurged / unreferenced
    pub reason: String,
}

/// 单类素材的孤儿组（用于 UI Tab 内）
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OrphanGroup {
    /// 实际孤儿数（不含截断）
    pub count: usize,
    pub total_bytes: u64,
    /// 孤儿明细（最多 500 条）
    pub items: Vec<OrphanItem>,
    /// items 是否被截断显示
    pub truncated: bool,
}

/// 全量孤儿扫描结果
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OrphanAssetScan {
    pub images: OrphanGroup,
    pub videos: OrphanGroup,
    pub attachments: OrphanGroup,
    pub pdfs: OrphanGroup,
    pub sources: OrphanGroup,
}

/// 孤儿素材清理结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanAssetClean {
    pub deleted: usize,
    pub freed_bytes: u64,
    pub failed: Vec<String>,
}

// ─── 导出 ─────────────────────────────────────

/// 导出结果
#[derive(Debug, Clone, Serialize)]
pub struct ExportResult {
    pub exported: usize,
    pub errors: Vec<String>,
    /// 用户选择的父目录（与入参一致，便于前端展示）
    pub output_dir: String,
    /// 实际创建的导出根目录（在 output_dir 下自动包一层时间戳目录）
    pub root_dir: String,
    /// 拷贝到 .assets/ 目录的资产文件总数（图片 + 附件，按物理文件去重）
    pub assets_copied: usize,
}

/// 单篇导出结果
#[derive(Debug, Clone, Serialize)]
pub struct SingleExportResult {
    /// 实际创建的笔记根目录（含 .md 和 assets/）
    pub root_dir: String,
    /// .md 文件绝对路径
    pub file_path: String,
    /// 拷贝到 assets/ 的资产文件数
    pub assets_copied: usize,
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

/// 批量恢复笔记的结果
///
/// `to_root` = 其中有多少条因原文件夹已不存在而落到了根目录。
/// 用于前端在 message 里给"X 条恢复到根目录"的提示。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreBatchResult {
    pub restored: usize,
    pub to_root: usize,
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
    /// 导出端是否为 dev build。
    /// import 端会用此字段强校验：dev 包不能导入 prod 实例反之亦然
    /// （否则资产路径前缀不一致会变孤儿数据）。
    /// `Option`：None = 老版本导出（在引入校验之前），按宽容模式放行 + 日志告警。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_dev: Option<bool>,
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
    /// 'YYYY-MM-DD' 或 'YYYY-MM-DD HH:MM:SS'；前者视作当天 23:59:59
    pub due_date: Option<String>,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// 提前 N 分钟提醒；None=不提醒；需要 due_date 带时分才精确
    pub remind_before_minutes: Option<i32>,
    /// 上次触发提醒的时刻（ISO 'YYYY-MM-DD HH:MM:SS'），去重用
    pub reminded_at: Option<String>,
    /// 循环规则: "none" / "daily" / "weekly" / "monthly"
    pub repeat_kind: String,
    /// 每 N 个单位，默认 1
    pub repeat_interval: i32,
    /// 每周的哪几天，ISO 1=Mon..7=Sun，逗号分隔；仅 weekly 有效
    pub repeat_weekdays: Option<String>,
    /// 循环终止日期 'YYYY-MM-DD'
    pub repeat_until: Option<String>,
    /// 总触发次数上限（含首次）
    pub repeat_count: Option<i32>,
    /// 已触发次数
    pub repeat_done_count: i32,
    /// 批次来源标识（AI 批量导入用，同次生成共享同一个 UUID）；手动创建为 NULL
    pub source_batch_id: Option<String>,
    /// 一级分类 ID；None = 未分类
    pub category_id: Option<i64>,
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
    pub remind_before_minutes: Option<i32>,
    pub links: Option<Vec<TaskLinkInput>>,
    /// 循环规则: "none"/"daily"/"weekly"/"monthly"，缺省按 "none"
    pub repeat_kind: Option<String>,
    pub repeat_interval: Option<i32>,
    pub repeat_weekdays: Option<String>,
    pub repeat_until: Option<String>,
    pub repeat_count: Option<i32>,
    /// AI 批量导入时同批次共享一个 UUID，用于一键撤销整批
    pub source_batch_id: Option<String>,
    /// 一级分类 ID；None = 未分类
    pub category_id: Option<i64>,
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
    pub remind_before_minutes: Option<i32>,
    /// 传 true 显式清空 remind_before_minutes
    pub clear_remind_before_minutes: Option<bool>,
    /// 循环规则；传 "none" 或传 clear_repeat=true 表示关闭循环
    pub repeat_kind: Option<String>,
    pub repeat_interval: Option<i32>,
    pub repeat_weekdays: Option<String>,
    pub clear_repeat_weekdays: Option<bool>,
    pub repeat_until: Option<String>,
    pub clear_repeat_until: Option<bool>,
    pub repeat_count: Option<i32>,
    pub clear_repeat_count: Option<bool>,
    /// 一级分类 ID（None 不动；传 Some(id) 改）
    pub category_id: Option<i64>,
    /// 传 true 显式清空 category_id（落到"未分类"）
    pub clear_category_id: Option<bool>,
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
    /// 某个分类（与 uncategorized 互斥，同时传 category_id 优先生效）
    pub category_id: Option<i64>,
    /// true 时只返回 category_id IS NULL 的任务（"未分类"虚拟分类）
    pub uncategorized: Option<bool>,
}

/// 顶栏 Ctrl+K 搜索的任务命中（轻量）
///
/// 不复用 Task 是为了少传字段，搜索面板只展示这几条，结构更扁平
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSearchHit {
    pub id: i64,
    pub title: String,
    /// 简短上下文片段：description 截断后；description 为空时回退用 due_date 描述
    pub snippet: String,
    /// 0=todo / 1=done（前端可据此显示已完成置灰）
    pub status: i32,
    /// 0=urgent / 1=normal / 2=low
    pub priority: i32,
    pub due_date: Option<String>,
}

/// 待办分类（一级，扁平）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskCategory {
    pub id: i64,
    pub name: String,
    /// 圆点颜色，如 "#1677ff"
    pub color: String,
    /// 可选 emoji 或 lucide 图标名
    pub icon: Option<String>,
    pub sort_order: i32,
    pub created_at: String,
}

/// 创建分类入参
#[derive(Debug, Clone, Deserialize)]
pub struct CreateTaskCategoryInput {
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub sort_order: Option<i32>,
}

/// 更新分类入参（字段缺省 = 不改）
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateTaskCategoryInput {
    pub name: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub clear_icon: Option<bool>,
    pub sort_order: Option<i32>,
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

// ─── AI 提示词库 ─────────────────────────────

/// AI 提示词模板（返回给前端）
///
/// - 内置模板 `is_builtin=1`，`builtin_code` 是旧硬编码 action（continue/summarize…）的别名，便于兼容。
/// - 用户自定义模板 `is_builtin=0`，`builtin_code=None`。
/// - `output_mode` 决定前端 AI 菜单拿到结果后默认怎么插入：
///     · `replace` 替换选区
///     · `append`  追加到选区末尾（续写场景）
///     · `popup`   只展示，不自动插入（总结场景）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplate {
    pub id: i64,
    pub title: String,
    pub description: String,
    pub prompt: String,
    /// 'replace' | 'append' | 'popup'
    pub output_mode: String,
    /// Lucide 图标名，如 "ArrowRight"
    pub icon: Option<String>,
    pub is_builtin: bool,
    pub builtin_code: Option<String>,
    pub sort_order: i32,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

// ─── AI Skills（T-004） ────────────────────

/// AI 调用的一次 Skill（工具）记录
///
/// 从模型流里解析出 tool_calls 后 dispatch 执行，得到结果一起打包给前端展示/持久化。
/// 字段设计模仿 OpenAI tool_calls 的结构但做了扁平化：
///   · `args_json` / `result` 都是字符串，便于直接渲染
///   · `status` 统一用 "ok" / "error" / "running"，前端状态机好画
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCall {
    /// OpenAI 返回的 tool_call_id（同一次请求里唯一）
    pub id: String,
    pub name: String,
    /// 反序列化后的参数（JSON 字符串，供前端 pretty-print 展示）
    pub args_json: String,
    /// Skill 执行结果，一般是 JSON 或截断后的文本
    pub result: String,
    /// "ok" / "error" / "running"（服务器侧持久化时只会写 ok/error）
    pub status: String,
}

// ─── AI 规划今日待办（T-005） ──────────────

/// 前端发起"AI 规划今日"的入参
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanTodayRequest {
    /// 用户输入的"今日目标"（可选），AI 会据此定向推荐
    pub goal: Option<String>,
    /// 是否把"昨日未完成 + 过期未完成"顺延进来；默认 true
    #[serde(default = "default_true")]
    pub include_yesterday_unfinished: bool,
}

fn default_true() -> bool {
    true
}

/// AI 对一条待办的建议（未真正写入数据库）
///
/// 前端把这些建议展示在 Modal 表格，用户可编辑/勾选后调用现有 `taskApi.create`
/// 批量写入 tasks 表。与 `CreateTaskInput` 刻意保持字段兼容，方便前端直接映射。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSuggestion {
    pub title: String,
    /// 0=紧急重要，1=普通，2=低；默认 1
    #[serde(default)]
    pub priority: Option<i32>,
    /// 艾森豪威尔重要性维度
    #[serde(default)]
    pub important: Option<bool>,
    /// 截止日期 'YYYY-MM-DD' 或 'YYYY-MM-DD HH:MM:SS'，一般是今天
    pub due_date: Option<String>,
    /// 提前提醒时间（分钟）。null = 不提醒；0 = 准时提醒；正整数 = 提前 N 分钟。
    /// AI 根据四象限自动判断：Q1 紧急多用 0/15；Q2 重要多用 60/1440；Q4 多用 null。
    #[serde(default)]
    pub remind_before_minutes: Option<i32>,
    /// AI 给出的推荐理由（可选，用于 UI 折叠展示）
    pub reason: Option<String>,
}

/// AI 规划今日的返回结构
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanTodayResponse {
    pub tasks: Vec<TaskSuggestion>,
    /// 一句总结 AI 对今日安排的思路；可选
    pub summary: Option<String>,
}

// ─── AI 智能规划（目标驱动）─────────────────

/// "目标驱动 AI 规划"入参：用户给一个长期目标，AI 自己拆成多条待办 + 阶段里程碑
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanFromGoalRequest {
    /// 用户描述的目标，例如"180 天减肥到 55 公斤"
    pub goal: String,
    /// 计划周期总天数；默认 30
    #[serde(default = "default_horizon_days")]
    pub horizon_days: i32,
    /// 起始日期 'YYYY-MM-DD'；缺省取今天
    pub start_date: Option<String>,
    /// 用户额外补充信息（可选），例如作息/兴趣/约束
    pub profile_hint: Option<String>,
}

fn default_horizon_days() -> i32 {
    30
}

/// 阶段里程碑（项目级节点，例如「第 1 月：身体激活」）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneDraft {
    pub title: String,
    /// 日期范围文本（如 "5月1日-5月31日"），AI 自由格式
    pub date_range: Option<String>,
    /// 该阶段的核心任务/目标描述
    pub description: Option<String>,
}

/// "目标驱动 AI 规划"返回结构：批次内一次性生成所有产出，由前端在预览页勾选后落库
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanFromGoalResponse {
    /// AI 拆出的待办（带四象限标注）
    pub tasks: Vec<TaskSuggestion>,
    /// AI 拆出的阶段里程碑（用户可参考但不强制落库）
    #[serde(default)]
    pub milestones: Vec<MilestoneDraft>,
    /// 整体规划思路（一段话）
    pub summary: Option<String>,
    /// 此次生成的批次 ID（服务端生成），前端落库时每条任务都要带上，
    /// 后续可用 undo_task_batch(batch_id) 一键撤销整批。
    /// AI 输出 JSON 时不包含此字段，由 service 层填充，因此反序列化时缺省为空。
    #[serde(default)]
    pub batch_id: String,
    /// 服务端给前端的友好警告（如"Excel 太大，已截断 X 个 Sheet"）；可空
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// "Excel 文件 → AI 规划"入参：用户选一个 Excel/ODS 文件，AI 据此拆任务
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanFromExcelRequest {
    /// 用户选择的 Excel 文件绝对路径（来自 Tauri dialog）
    pub file_path: String,
    /// 计划周期天数；默认 30
    #[serde(default = "default_horizon_days")]
    pub horizon_days: i32,
    /// 起始日期 'YYYY-MM-DD'；缺省取今天
    pub start_date: Option<String>,
    /// 用户对 Excel 内容的额外说明（可选），例如"重点关注健身部分"
    pub extra_goal: Option<String>,
}

// ─── AI 写笔记并归档（T-006） ──────────────

/// 笔记目标长度
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetLength {
    Short,  // 短，100~300 字
    Medium, // 中等，300~800 字（默认）
    Long,   // 长篇，800~2000 字
}

impl Default for TargetLength {
    fn default() -> Self {
        Self::Medium
    }
}

impl TargetLength {
    /// 给模型看的字数要求提示
    pub fn word_hint(&self) -> &'static str {
        match self {
            Self::Short => "100~300 字",
            Self::Medium => "300~800 字",
            Self::Long => "800~2000 字",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftNoteRequest {
    /// 笔记主题（必填）
    pub topic: String,
    /// 参考材料（可选；用户提供的背景/要点/链接等）
    pub reference: Option<String>,
    /// 目标长度；缺省用 Medium
    #[serde(default)]
    pub target_length: TargetLength,
}

/// AI 生成的笔记草稿（未写入 DB；前端 Modal 展示后用户确认才真正保存）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftNoteResponse {
    pub title: String,
    /// Markdown 正文
    pub content: String,
    /// AI 建议的目录路径，如 "工作/周报"；空串 = 根目录
    pub folder_path: String,
    /// AI 给出的"为什么归到这个目录"的理由；前端折叠展示
    pub reason: Option<String>,
}

/// 创建提示词模板的入参
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplateInput {
    pub title: String,
    pub description: Option<String>,
    pub prompt: String,
    /// 'replace' | 'append' | 'popup'，省略则用 'replace'
    pub output_mode: Option<String>,
    pub icon: Option<String>,
    /// 省略视为末尾（会取 max(sort_order)+10）
    pub sort_order: Option<i32>,
    /// 省略视为启用
    pub enabled: Option<bool>,
}

// ─── T-024 同步架构 V1 ─────────────────────────

/// 同步后端类型
///
/// `local` 写到用户磁盘上的某个目录（最简单、零网络风险，常用作"挂同步盘"路径）；
/// `webdav` 走现有 WebDAV 客户端；`s3` / `git` 后续阶段实现
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SyncBackendKind {
    Local,
    Webdav,
    S3,
}

/// 同步后端配置（DB 行）
///
/// `config_json` 内的字段随 `kind` 不同：
/// - `Local`：`{"path": "..."}`
/// - `Webdav`：`{"url": "...", "username": "...", "password_encrypted": "..."}`
/// - `S3`：`{"endpoint": "...", "region": "...", "bucket": "...", "access_key": "...", "secret_key_encrypted": "..."}`
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBackend {
    pub id: i64,
    pub kind: SyncBackendKind,
    pub name: String,
    pub config_json: String,
    pub enabled: bool,
    pub auto_sync: bool,
    pub sync_interval_min: i64,
    pub last_push_ts: Option<String>,
    pub last_pull_ts: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// 创建/更新同步后端配置入参
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBackendInput {
    pub kind: SyncBackendKind,
    pub name: String,
    pub config_json: String,
    pub enabled: Option<bool>,
    pub auto_sync: Option<bool>,
    pub sync_interval_min: Option<i64>,
}

/// 远端同步状态（DB 行，per-backend per-note）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRemoteState {
    pub backend_id: i64,
    pub note_id: i64,
    pub remote_path: String,
    pub last_synced_hash: String,
    pub last_synced_ts: String,
    pub tombstone: bool,
}

/// V1 同步 manifest 中的单条记录
///
/// 序列化为 manifest.json 上传到远端。设计要点：
/// 1. **note_id 不直接用本地自增 id**：用 stable_uuid（笔记表加列存）防止多端 id 冲突
///    - **本会话先用本地 id 当 stable_uuid**，T-024 后续阶段再加 uuid 列做严格去重
/// 2. **content_hash 是 SHA-256(title + "\n" + body)**：标题改动也算变更
/// 3. **tombstone**：删除的笔记保留一条 manifest 项让其他端知道要删
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    /// 稳定 ID（v1 临时 = 本地笔记 id 的字符串形式）
    pub stable_id: String,
    pub title: String,
    /// SHA-256(title + "\n" + content)，hex 小写
    pub content_hash: String,
    /// ISO-8601 / 本地时间字符串（来自 notes.updated_at）
    pub updated_at: String,
    /// 远端 .md 文件路径（相对 vault 根，正斜杠分隔）
    pub remote_path: String,
    /// 是否已删除（tombstone）
    #[serde(default)]
    pub tombstone: bool,
    /// 文件夹路径（如 "工作/周报"）；根层为空串。导入时用来重建文件夹树
    #[serde(default)]
    pub folder_path: String,
}

/// V1 同步 manifest（远端 manifest.json 全文）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncManifestV1 {
    /// manifest schema 版本（恒为 1）
    pub manifest_version: u32,
    /// 应用版本（生成 manifest 的客户端，仅供调试）
    pub app_version: String,
    /// 设备名（hostname；多端冲突排查用）
    pub device: String,
    /// 生成时间
    pub generated_at: String,
    /// 全部笔记条目（含 tombstone）
    pub entries: Vec<ManifestEntry>,
}

impl SyncManifestV1 {
    pub const VERSION: u32 = 1;
}

/// 推送结果
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncPushResult {
    /// 上传新增 / 修改的笔记数
    pub uploaded: usize,
    /// 推送删除（tombstone）笔记数
    pub deleted_remote: usize,
    /// 跳过（无变更）数
    pub skipped: usize,
    /// 错误清单
    pub errors: Vec<String>,
}

/// 拉取结果
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncPullResult {
    /// 拉取新增 / 更新的笔记数
    pub downloaded: usize,
    /// 应用远端删除标记到本地的笔记数
    pub deleted_local: usize,
    /// 冲突数（远端有变更 + 本地也有变更 → 走 last-write-wins，落败方进 .conflicts/）
    pub conflicts: usize,
    /// 错误清单
    pub errors: Vec<String>,
}


