/** 应用配置 */
export interface AppConfig {
  key: string;
  value: string;
}

/** 系统信息 */
export interface SystemInfo {
  os: string;
  arch: string;
  appVersion: string;
  dataDir: string;
  imagesDir: string;
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
  created_at: string;
}

/** 创建/更新 AI 模型入参 */
export interface AiModelInput {
  name: string;
  provider: string;
  api_url: string;
  api_key?: string | null;
  model_id: string;
}

/** AI 对话 */
export interface AiConversation {
  id: number;
  title: string;
  model_id: number;
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
  created_at: string;
}

// ─── 导入 ─────────────────────────────────────

/** 扫描到的文件条目 */
export interface ScannedFile {
  path: string;
  name: string;
  size: number;
}

/** 导入结果 */
export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
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

/** 孤儿图片扫描结果 */
export interface OrphanImageScan {
  count: number;
  totalBytes: number;
  paths: string[];
  /** paths 是否因数量过多被截断（真正孤儿数仍在 count 中） */
  truncated: boolean;
}

/** 孤儿图片清理结果 */
export interface OrphanImageClean {
  deleted: number;
  freedBytes: number;
  failed: string[];
}

// ─── 导出 ─────────────────────────────────────

/** 导出结果 */
export interface ExportResult {
  exported: number;
  errors: string[];
  output_dir: string;
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
}

export interface TaskQuery {
  status?: TaskStatus;
  keyword?: string;
  priority?: TaskPriority;
}

export interface TaskStats {
  totalTodo: number;
  totalDone: number;
  urgentTodo: number;
  overdue: number;
  dueToday: number;
}
