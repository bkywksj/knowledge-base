/** 应用配置 */
export interface AppConfig {
  key: string;
  value: string;
}

/** 全局快捷键绑定（仅 global scope，由 Rust 侧 global-shortcut 插件管理） */
export interface ShortcutBinding {
  /** 内部唯一 ID（如 'global.quickCapture'） */
  id: string;
  /** 当前生效的 accelerator；空字符串 = 已禁用 */
  accel: string;
  /** 默认 accelerator */
  defaultAccel: string;
  /** 用户已改键 / 已禁用 */
  isCustom: boolean;
  /** 是否被禁用（accel 为空） */
  disabled: boolean;
}

/** 系统信息 */
export interface SystemInfo {
  os: string;
  arch: string;
  appVersion: string;
  /** 当前实例的数据根目录（多开实例 = app_data_dir/instance-N，不是公共 app_data_dir） */
  dataDir: string;
  imagesDir: string;
  /** 多开实例编号；null = 默认实例 */
  instanceId: number | null;
  /** 是否运行在 dev build 下（前端徽章追加 [DEV] 标识） */
  isDev: boolean;
}

// ─── 笔记 ─────────────────────────────────────

/** 笔记 */
export interface Note {
  id: number;
  title: string;
  content: string;
  folder_id: number | null;
  is_daily: boolean;
  daily_date: string | null;
  is_pinned: boolean;
  /** T-003: 是否"隐藏"（主列表/搜索/反链/图谱/RAG 全部过滤；wiki 跳转仍可访问）*/
  is_hidden: boolean;
  /** T-007: 是否加密。content 字段会是占位符，真实内容需调 decryptNote */
  is_encrypted: boolean;
  word_count: number;
  created_at: string;
  updated_at: string;
  /** 关联的原始文件相对路径（相对 app_data_dir），纯笔记为 null */
  source_file_path: string | null;
  /** 原始文件类型："pdf" / "docx" / "doc" / null */
  source_file_type: string | null;
}

/** PDF 导入结果（单个文件） */
export interface PdfImportResult {
  sourcePath: string;
  noteId: number | null;
  title: string | null;
  error: string | null;
}

/** .doc 转换器探测结果（serde kebab-case） */
export type DocConverter = "libre-office" | "windows-com" | "none";

/** 单个 ProgId 的实测结果 */
export interface ComProgIdAttempt {
  progid: string;
  ok: boolean;
  error: string | null;
}

/** 转换器完整诊断报告 */
export interface ConverterDiagnostic {
  libreOfficePath: string | null;
  comAttempts: ComProgIdAttempt[];
  active: DocConverter;
}

/** 创建/更新笔记入参 */
export interface NoteInput {
  title: string;
  content: string;
  folder_id?: number | null;
}

/** 笔记列表查询参数 */
export interface NoteQuery {
  folder_id?: number | null;
  keyword?: string | null;
  page?: number;
  page_size?: number;
  /** true 时只返回 folder_id IS NULL 的笔记（"未分类"虚拟文件夹） */
  uncategorized?: boolean;
  /** true 时点父文件夹连同所有子孙文件夹的笔记一起返回（默认 true，符合"文件夹=容器"直觉） */
  include_descendants?: boolean;
}

// ─── 文件夹 ───────────────────────────────────

/** 文件夹（树形结构） */
export interface Folder {
  id: number;
  name: string;
  parent_id: number | null;
  sort_order: number;
  children: Folder[];
  note_count: number;
}

// ─── 标签 ─────────────────────────────────────

/** 标签 */
export interface Tag {
  id: number;
  name: string;
  color: string | null;
  note_count: number;
}

/** 创建/更新标签入参 */
export interface TagInput {
  name: string;
  color?: string | null;
}

// ─── 搜索 ─────────────────────────────────────

/** 全文搜索结果 */
export interface SearchResult {
  id: number;
  title: string;
  snippet: string;
  updated_at: string;
  folder_id: number | null;
}

// ─── 回收站 ───────────────────────────────────

/** 回收站笔记查询参数 */
export interface TrashQuery {
  page?: number;
  page_size?: number;
}

// ─── 笔记链接 ─────────────────────────────────

/** 反向链接 */
export interface NoteLink {
  source_id: number;
  source_title: string;
  context: string | null;
  updated_at: string;
}

// ─── 知识图谱 ─────────────────────────────────

/** 图谱节点 */
export interface GraphNode {
  id: number;
  title: string;
  is_daily: boolean;
  is_pinned: boolean;
  tag_count: number;
  link_count: number;
}

/** 图谱边 */
export interface GraphEdge {
  source: number;
  target: number;
}

/** 知识图谱数据 */
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ─── AI 知识问答 ─────────────────────────────

/** AI 模型配置 */
export interface AiModel {
  id: number;
  name: string;
  /** 模型提供商: openai / claude / ollama */
  provider: string;
  api_url: string;
  api_key: string | null;
  /** 模型标识 (如 gpt-4o-mini, claude-sonnet-4-20250514, llama3) */
  model_id: string;
  is_default: boolean;
  /** 模型支持的最大上下文 token 数（默认 32000，AI 页拼附加笔记按这个算预算） */
  max_context: number;
  created_at: string;
}

/** 创建/更新 AI 模型入参 */
export interface AiModelInput {
  name: string;
  provider: string;
  api_url: string;
  api_key?: string | null;
  model_id: string;
  /** 可选：缺省时后端按 32000 入库 */
  max_context?: number;
}

/** AI 模型连通性测试结果 */
export interface AiModelTestResult {
  ok: boolean;
  /** 端到端往返耗时（毫秒） */
  latency_ms: number;
  /** 服务端样本：成功时为模型回复前 40 字 */
  sample: string | null;
}

/** AI 对话 */
export interface AiConversation {
  id: number;
  title: string;
  model_id: number;
  /** 附加给本对话的笔记 ID 列表，整个对话共享 */
  attached_note_ids: number[];
  created_at: string;
  updated_at: string;
}

/** AI 消息 */
export interface AiMessage {
  id: number;
  conversation_id: number;
  /** 角色: user / assistant */
  role: string;
  content: string;
  /** 引用的笔记 ID 列表 (JSON 字符串) */
  references: string | null;
  /** T-004: Skills 框架下 AI 调用的工具记录（JSON 字符串，反序列化后是 SkillCall[]）*/
  skill_calls: string | null;
  created_at: string;
}

/** AI Skill 调用记录（T-004）*/
export interface SkillCall {
  id: string;
  name: string;
  /** 参数 JSON 字符串（展示给用户看） */
  argsJson: string;
  /** Skill 执行结果文本（可能是 JSON 或截断的文本） */
  result: string;
  /** 'running' | 'ok' | 'error' */
  status: "running" | "ok" | "error";
}

// ─── AI 规划今日待办（T-005） ────────────

export interface PlanTodayRequest {
  /** 用户输入的"今日目标"，可留空 */
  goal?: string | null;
  /** 是否把昨日未完成/过期任务一起带进 AI 的上下文；默认 true */
  includeYesterdayUnfinished?: boolean;
}

/** AI 对一条待办的建议；尚未写入 DB */
export interface TaskSuggestion {
  title: string;
  /** 0=紧急 / 1=普通 / 2=低 */
  priority?: number | null;
  important?: boolean | null;
  /** 'YYYY-MM-DD' 或 'YYYY-MM-DD HH:MM:SS' */
  dueDate?: string | null;
  /** AI 自动判断的提醒时间（分钟）：null=不提醒；0=准时；正数=提前 N 分钟。
   *  推荐值：null / 0 / 15 / 30 / 60 / 180 / 1440 / 10080 */
  remindBefore?: number | null;
  /** AI 给出的推荐理由，UI 折叠展示 */
  reason?: string | null;
}

export interface PlanTodayResponse {
  tasks: TaskSuggestion[];
  summary?: string | null;
}

// ─── AI 智能规划（目标驱动）────────────

export interface PlanFromGoalRequest {
  /** 用户描述的目标，例如"180 天减肥到 55 公斤" */
  goal: string;
  /** 计划周期天数，默认 30，最大 365 */
  horizonDays?: number;
  /** 起始日期 'YYYY-MM-DD'；缺省=今天 */
  startDate?: string | null;
  /** 用户额外补充信息（作息/兴趣/约束） */
  profileHint?: string | null;
}

export interface MilestoneDraft {
  title: string;
  /** 自然语言日期范围，如 "5月1日-5月31日" */
  dateRange?: string | null;
  description?: string | null;
}

export interface PlanFromGoalResponse {
  tasks: TaskSuggestion[];
  milestones: MilestoneDraft[];
  summary?: string | null;
  /** 服务端生成的批次 ID，前端落库时每条任务都要透传到 source_batch_id */
  batchId: string;
  /** 服务端友好警告（如 Excel 体积大被截断）；UI 在预览页顶部展示 */
  warnings?: string[];
}

export interface PlanFromExcelRequest {
  /** Excel/ODS 文件绝对路径（来自 Tauri dialog） */
  filePath: string;
  /** 计划周期天数，默认 30，最大 365 */
  horizonDays?: number;
  /** 起始日期 'YYYY-MM-DD'；缺省=今天 */
  startDate?: string | null;
  /** 用户对 Excel 内容的额外说明（可选），如"重点关注健身部分" */
  extraGoal?: string | null;
}

// ─── AI 写笔记并归档（T-006） ────────────

export type TargetLength = "short" | "medium" | "long";

export interface DraftNoteRequest {
  topic: string;
  reference?: string | null;
  /** short=100~300 / medium=300~800 / long=800~2000 */
  targetLength?: TargetLength;
}

/** AI 生成的笔记草稿（未落库，Modal 里用户确认后才写入）*/
export interface DraftNoteResponse {
  title: string;
  /** Markdown 正文 */
  content: string;
  /** 建议目录路径，如 "工作/周报"；空串 = 根目录 */
  folderPath: string;
  reason?: string | null;
}

// ─── T-007 笔记加密 / Vault ─────────────────────

/** Vault 整体状态（三态机）*/
export type VaultStatus = "notset" | "locked" | "unlocked";

// ─── 导入 ─────────────────────────────────────

/** 扫描到的文件在库中的匹配类型（后端扫描时判定） */
export type ImportMatchKind = "new" | "path" | "fuzzy";

/** 扫描到的文件条目 */
export interface ScannedFile {
  path: string;
  /** 相对扫描根的父目录，斜杠统一；根层文件为空串 */
  relative_dir: string;
  name: string;
  size: number;
  /**
   * 去重匹配结果：
   * - "new"   全新文件
   * - "path"  按 source_file_path 精确命中（已导入过）
   * - "fuzzy" 按 (title, content_hash) 兜底命中（用户可能搬动过源文件）
   */
  match_kind: ImportMatchKind;
  /** match_kind 非 "new" 时，指向已存在笔记的 id */
  existing_note_id: number | null;
}

/**
 * 导入冲突策略：遇到已存在的文件怎么处理
 * - "skip"      跳过（默认，最安全）
 * - "duplicate" 创建副本（标题加 " (2)"）
 */
export type ImportConflictPolicy = "skip" | "duplicate";

/** 导入结果 */
export interface ImportResult {
  imported: number;
  skipped: number;
  duplicated: number;
  errors: string[];
  /** T-009: 自动关联的 frontmatter tag 条数（笔记 × 标签 笛卡尔次数） */
  tags_attached?: number;
  /** T-009: 解析到 frontmatter 的笔记数 */
  frontmatter_parsed?: number;
  /** T-009 Commit 2: 复制到 kb_assets/images 的图片张数 */
  attachments_copied?: number;
  /** T-009 Commit 2: 缺失的图片清单（"笔记标题: 原始引用"，已去重） */
  attachments_missing?: string[];
  /** 本次新建的笔记 ID（按文件参数顺序，含 Duplicate 副本） */
  noteIds?: number[];
  /** 命中已有笔记并按 Skip 策略跳过时记录的现有笔记 ID */
  existingNoteIds?: number[];
}

/** 导入进度 */
export interface ImportProgress {
  current: number;
  total: number;
  file_name: string;
}

/** "打开单个 md 文件"返回结果 */
export interface OpenMarkdownResult {
  noteId: number;
  /** 检测到源文件有变化并已同步回笔记 */
  wasSynced: boolean;
}

/** 孤儿素材类型 */
export type OrphanKind = "image" | "video" | "attachment" | "pdf" | "source";

/** 孤儿原因 */
export type OrphanReason = "notePurged" | "unreferenced";

/** 单条孤儿素材 */
export interface OrphanItem {
  kind: OrphanKind;
  /** 绝对路径 */
  path: string;
  /** 按 note_id 分目录的素材有；纯平铺的 images 没有 */
  noteId: number | null;
  size: number;
  reason: OrphanReason;
}

/** 单类素材的孤儿组（UI Tab 内） */
export interface OrphanGroup {
  count: number;
  totalBytes: number;
  /** 实际明细（最多 500 条）*/
  items: OrphanItem[];
  truncated: boolean;
}

/** 全量孤儿扫描结果 */
export interface OrphanAssetScan {
  images: OrphanGroup;
  videos: OrphanGroup;
  attachments: OrphanGroup;
  pdfs: OrphanGroup;
  sources: OrphanGroup;
}

/** 孤儿素材清理结果 */
export interface OrphanAssetClean {
  deleted: number;
  freedBytes: number;
  failed: string[];
}

/** 附件信息（save_note_attachment 返回） */
export interface AttachmentInfo {
  /** 绝对路径（前端用来构造 file:// 链接给 opener 打开） */
  path: string;
  /** 原始文件名（展示用） */
  fileName: string;
  /** 字节数（用于显示 "1.2 MB"） */
  size: number;
  /** MIME 类型 */
  mime: string;
}

// ─── 外部 .md 双向同步（写回原文件） ─────────────

/**
 * 笔记保存后写回原 .md 文件的结果。
 *
 * - `ok`：写回成功；`assets_copied` = 用户在编辑器里新插入的图被复制到 `<basename>.assets/` 的张数
 * - `skipped`：笔记不是从外部 .md 打开的，没什么可写回（默认情况）
 * - `conflict`：原文件 mtime 与上次写回时不一致 = 外部编辑器（VSCode 等）改过文件，
 *   前端应弹 Modal 让用户选「覆盖外部 / 取消」（"覆盖外部" 后端再调一次 `force=true`）
 * - `missing`：原文件被删/移走/挂网盘断开
 */
export type WriteBackResult =
  | { kind: "ok"; assets_copied: number; file_path: string }
  | { kind: "skipped"; reason: string }
  | { kind: "conflict"; external_mtime: number; last_known_mtime: number | null; file_path: string }
  | { kind: "missing"; file_path: string };

// ─── 导出 ─────────────────────────────────────

/** 导出结果 */
export interface ExportResult {
  exported: number;
  errors: string[];
  /** 用户选择的父目录 */
  output_dir: string;
  /** 实际创建的导出根目录（在 output_dir 下自动包一层 知识库导出_YYYYMMDD_HHmmss） */
  root_dir: string;
  /** 拷贝到 .assets/ 的资产文件总数（图片+附件，按物理文件去重） */
  assets_copied: number;
}

/** 单篇导出结果 */
export interface SingleExportResult {
  /** 实际创建的笔记根目录（含 .md 与 assets/） */
  root_dir: string;
  /** .md 文件绝对路径 */
  file_path: string;
  /** 拷贝到 assets/ 的资产文件数 */
  assets_copied: number;
}

/** T-020 Word 导出结果 */
export interface WordExportResult {
  filePath: string;
  imagesEmbedded: number;
  imagesMissing: number;
}

/** T-020 HTML 导出结果（单文件，图片内嵌） */
export interface HtmlExportResult {
  filePath: string;
  imagesInlined: number;
  imagesMissing: number;
}

/** 导出进度 */
export interface ExportProgress {
  current: number;
  total: number;
  file_name: string;
}

// ─── 首页统计 ─────────────────────────────────

/** 首页统计数据 */
export interface DashboardStats {
  total_notes: number;
  total_folders: number;
  total_tags: number;
  total_links: number;
  today_updated: number;
  total_words: number;
}

// ─── 写作趋势 ─────────────────────────────────

/** 每日写作统计 */
export interface DailyWritingStat {
  date: string;
  note_count: number;
  word_count: number;
}

// ─── 笔记模板 ─────────────────────────────────

/** 笔记模板 */
export interface NoteTemplate {
  id: number;
  name: string;
  description: string;
  content: string;
  created_at: string;
}

/** 创建/更新模板入参 */
export interface NoteTemplateInput {
  name: string;
  description: string;
  content: string;
}

// ─── 通用 ─────────────────────────────────────

/** 分页响应 */
export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

/**
 * 批量恢复笔记的结果（与后端 RestoreBatchResult 对齐，serde camelCase）
 *
 * `toRoot` = 其中因原文件夹已被删除而落到根目录的条数
 */
export interface RestoreBatchResult {
  restored: number;
  toRoot: number;
}

// ─── 同步 ─────────────────────────────────────

/** 同步范围：控制本次同步包含哪些数据 */
export interface SyncScope {
  notes: boolean;
  images: boolean;
  pdfs: boolean;
  sources: boolean;
  settings: boolean;
}

export const DEFAULT_SYNC_SCOPE: SyncScope = {
  notes: true,
  images: true,
  pdfs: true,
  sources: true,
  settings: true,
};

/** 导入模式 */
export type SyncImportMode = "merge" | "overwrite";

/** WebDAV 配置 */
export interface WebDavConfig {
  url: string;
  username: string;
  /** 前端传入时使用；后端读取时从 keyring 取 */
  password?: string;
}

/** 同步数据统计 */
export interface SyncStats {
  notesCount: number;
  foldersCount: number;
  tagsCount: number;
  imagesCount: number;
  pdfsCount: number;
  sourcesCount: number;
  /** 资产总大小（字节）*/
  assetsSize: number;
}

/** 云端快照条目（多设备场景，一台一个 kb-sync-<device>.zip） */
export interface RemoteSnapshot {
  filename: string;
  device: string;
}

/** 云端 manifest（快照元信息） */
export interface SyncManifest {
  schemaVersion: number;
  device: string;
  exportedAt: string;
  appVersion: string;
  scope: SyncScope;
  stats: SyncStats;
}

/** 同步操作结果 */
export interface SyncResult {
  stats: SyncStats;
  finishedAt: string;
}

/** 同步历史记录 */
export interface SyncHistoryItem {
  id: number;
  direction: string;
  startedAt: string;
  finishedAt: string | null;
  success: boolean;
  error: string | null;
  statsJson: string;
}

// ─── 待办任务 ───────────────────────────────────

export type TaskPriority = 0 | 1 | 2; // 0=urgent / 1=normal / 2=low
export type TaskStatus = 0 | 1;       // 0=todo / 1=done
export type TaskLinkKind = "note" | "path" | "url";
/** 循环规则：不循环 / 每天 / 每周 / 每月 */
export type TaskRepeatKind = "none" | "daily" | "weekly" | "monthly";

export interface TaskLink {
  id: number;
  task_id: number;
  kind: TaskLinkKind;
  target: string;
  label: string | null;
}

export interface Task {
  id: number;
  title: string;
  description: string | null;
  priority: TaskPriority;
  important: boolean;
  status: TaskStatus;
  /** 'YYYY-MM-DD' 或 'YYYY-MM-DD HH:MM:SS'；前者视作当天 23:59:59 */
  due_date: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  /** 提前 N 分钟提醒；null=不提醒 */
  remind_before_minutes: number | null;
  /** 上次已触发提醒的时刻，去重用 */
  reminded_at: string | null;
  /** 循环规则 */
  repeat_kind: TaskRepeatKind;
  /** 每 N 个单位 */
  repeat_interval: number;
  /** ISO 1..7（Mon..Sun）逗号分隔；仅 weekly 有意义 */
  repeat_weekdays: string | null;
  /** 循环截止日期 'YYYY-MM-DD' */
  repeat_until: string | null;
  /** 总触发次数上限（含首次） */
  repeat_count: number | null;
  /** 已触发次数 */
  repeat_done_count: number;
  /** AI 智能规划批次 ID（手动创建为 null） */
  source_batch_id: string | null;
  /** 一级分类 ID；null = 未分类 */
  category_id: number | null;
  links: TaskLink[];
}

export interface TaskLinkInput {
  kind: TaskLinkKind;
  target: string;
  label?: string | null;
}

export interface CreateTaskInput {
  title: string;
  description?: string | null;
  priority?: TaskPriority;
  important?: boolean;
  due_date?: string | null;
  remind_before_minutes?: number | null;
  links?: TaskLinkInput[];
  repeat_kind?: TaskRepeatKind;
  repeat_interval?: number;
  repeat_weekdays?: string | null;
  repeat_until?: string | null;
  repeat_count?: number | null;
  /** AI 智能规划批次 ID（同次生成共享一个 UUID，可一键撤销整批） */
  source_batch_id?: string | null;
  /** 一级分类 ID；不传或 null = 未分类 */
  category_id?: number | null;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  priority?: TaskPriority;
  important?: boolean;
  due_date?: string | null;
  clear_due_date?: boolean;
  remind_before_minutes?: number | null;
  clear_remind_before_minutes?: boolean;
  repeat_kind?: TaskRepeatKind;
  repeat_interval?: number;
  repeat_weekdays?: string | null;
  clear_repeat_weekdays?: boolean;
  repeat_until?: string | null;
  clear_repeat_until?: boolean;
  repeat_count?: number | null;
  clear_repeat_count?: boolean;
  /** 改分类；不传 = 不动 */
  category_id?: number | null;
  /** 传 true 显式清空，落到"未分类" */
  clear_category_id?: boolean;
}

export interface TaskQuery {
  status?: TaskStatus;
  keyword?: string;
  priority?: TaskPriority;
  /** 某个分类（与 uncategorized 互斥，category_id 优先） */
  category_id?: number | null;
  /** true 时只看 category_id IS NULL 的任务 */
  uncategorized?: boolean;
}

// ─── 待办分类 ─────────────────────────────────

export interface TaskCategory {
  id: number;
  name: string;
  /** 圆点颜色，如 "#1677ff" */
  color: string;
  /** 可选 emoji 或 lucide 图标名 */
  icon: string | null;
  sort_order: number;
  created_at: string;
}

export interface CreateTaskCategoryInput {
  name: string;
  color?: string | null;
  icon?: string | null;
  sort_order?: number | null;
}

export interface UpdateTaskCategoryInput {
  name?: string;
  color?: string;
  icon?: string | null;
  clear_icon?: boolean;
  sort_order?: number;
}

export interface TaskStats {
  totalTodo: number;
  totalDone: number;
  urgentTodo: number;
  overdue: number;
  dueToday: number;
}

/** 顶栏 Ctrl+K 搜索的待办命中（轻量结果，与 SearchResult 对齐风格） */
export interface TaskSearchHit {
  id: number;
  title: string;
  /** description 截断 */
  snippet: string;
  /** 0=todo / 1=done */
  status: TaskStatus;
  /** 0=urgent / 1=normal / 2=low */
  priority: TaskPriority;
  dueDate: string | null;
}

// ─── AI 提示词库 ───────────────────────────────

/**
 * AI 写作结果插入模式
 * - `replace`：用结果替换选中的文本（默认；改写/扩展/翻译等）
 * - `append`：在选区末尾追加（续写场景）
 * - `popup`：只展示给用户看，不自动插入（总结场景）
 */
export type PromptOutputMode = "replace" | "append" | "popup";

export interface PromptTemplate {
  id: number;
  title: string;
  description: string;
  prompt: string;
  outputMode: PromptOutputMode;
  icon: string | null;
  isBuiltin: boolean;
  builtinCode: string | null;
  sortOrder: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PromptTemplateInput {
  title: string;
  description?: string | null;
  prompt: string;
  outputMode?: PromptOutputMode;
  icon?: string | null;
  sortOrder?: number | null;
  enabled?: boolean | null;
}

// ─── T-024 同步 V1 ─────────────────────────────

export type SyncBackendKind = "local" | "webdav" | "s3";

export interface SyncBackend {
  id: number;
  kind: SyncBackendKind;
  name: string;
  configJson: string;
  enabled: boolean;
  autoSync: boolean;
  syncIntervalMin: number;
  lastPushTs: string | null;
  lastPullTs: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SyncBackendInput {
  kind: SyncBackendKind;
  name: string;
  configJson: string;
  enabled?: boolean | null;
  autoSync?: boolean | null;
  syncIntervalMin?: number | null;
}

export interface ManifestEntry {
  stableId: string;
  title: string;
  contentHash: string;
  updatedAt: string;
  remotePath: string;
  tombstone: boolean;
  folderPath: string;
}

export interface SyncManifestV1 {
  manifestVersion: number;
  appVersion: string;
  device: string;
  generatedAt: string;
  entries: ManifestEntry[];
}

export interface SyncPushResult {
  uploaded: number;
  deletedRemote: number;
  skipped: number;
  errors: string[];
}

export interface SyncPullResult {
  downloaded: number;
  deletedLocal: number;
  conflicts: number;
  errors: string[];
}

export interface SyncV1ProgressEvent {
  backendId: number;
  /** "compute" | "diff" | "upload" | "download" | "manifest" | "apply" | "done" */
  phase: string;
  current: number;
  total: number;
  message: string;
}

// ─── T-013 自定义数据目录 ──────────────────────

/** 数据目录来源 */
export type DataDirSource = "env" | "pointer" | "default";

/** 当前数据目录解析结果 */
export interface ResolvedDataDir {
  /** 框架默认 app_data_dir（OS 给的固定位置）*/
  defaultDir: string;
  /** 当前生效的数据根目录 */
  currentDir: string;
  /** 来源（env / pointer / default）*/
  source: DataDirSource;
  /** 指针文件里写的路径（可能与 current 不一致：env 临时覆盖时；为 null 表示无指针） */
  pendingDir: string | null;
}

/** 迁移 marker 状态 */
export type MigrationStatus = "pending" | "in_progress" | "crashed" | "done";

/** 迁移 marker（启动期检测） */
export interface MigrationMarker {
  from: string;
  to: string;
  status: MigrationStatus;
  /** rust 是 snake_case，serde 默认序列化保持 snake；这里用相同字段名 */
  started_at: string;
  updated_at: string;
  completed_items: string[];
}

/** 迁移进度事件（splash 窗口监听用）*/
export interface MigrationProgress {
  /** "scan" | "copy_file" | "copy_dir" | "verify" | "done" | "error" */
  phase: string;
  currentFile: string;
  itemIndex: number;
  itemTotal: number;
  bytesDone: number;
  bytesTotal: number;
  message: string;
}
