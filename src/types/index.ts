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
