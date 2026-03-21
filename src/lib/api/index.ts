import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import type {
  AppConfig,
  SystemInfo,
  DashboardStats,
  Note,
  NoteInput,
  NoteQuery,
  PageResult,
  Folder,
  Tag,
  SearchResult,
  NoteLink,
  GraphData,
  AiModel,
  AiModelInput,
  AiConversation,
  AiMessage,
  ImportResult,
  ScannedFile,
  ExportResult,
} from "@/types";

/** 系统相关 API */
export const systemApi = {
  greet: (name: string) => invoke<string>("greet", { name }),
  getSystemInfo: () => invoke<SystemInfo>("get_system_info"),
  getDashboardStats: () => invoke<DashboardStats>("get_dashboard_stats"),
};

/** 更新相关 API */
export const updaterApi = {
  checkUpdate: () => check(),
};

/** 配置管理 API */
export const configApi = {
  getAll: () => invoke<AppConfig[]>("get_all_config"),
  get: (key: string) => invoke<string>("get_config", { key }),
  set: (key: string, value: string) =>
    invoke<void>("set_config", { key, value }),
  delete: (key: string) => invoke<void>("delete_config", { key }),
};

/** 笔记 API */
export const noteApi = {
  create: (input: NoteInput) => invoke<Note>("create_note", { input }),
  update: (id: number, input: NoteInput) =>
    invoke<Note>("update_note", { id, input }),
  delete: (id: number) => invoke<void>("delete_note", { id }),
  deleteAll: () => invoke<number>("delete_all_notes"),
  get: (id: number) => invoke<Note>("get_note", { id }),
  list: (query: NoteQuery = {}) =>
    invoke<PageResult<Note>>("list_notes", { query }),
  togglePin: (id: number) => invoke<boolean>("toggle_pin", { id }),
  moveToFolder: (noteId: number, folderId?: number | null) =>
    invoke<void>("move_note_to_folder", { noteId, folderId }),
};

/** 文件夹 API */
export const folderApi = {
  create: (name: string, parentId?: number) =>
    invoke<Folder>("create_folder", { name, parentId }),
  rename: (id: number, name: string) =>
    invoke<void>("rename_folder", { id, name }),
  delete: (id: number) => invoke<void>("delete_folder", { id }),
  list: () => invoke<Folder[]>("list_folders"),
};

/** 搜索 API */
export const searchApi = {
  search: (query: string, limit?: number) =>
    invoke<SearchResult[]>("search_notes", { query, limit }),
};

/** 回收站 API */
export const trashApi = {
  softDelete: (id: number) => invoke<void>("soft_delete_note", { id }),
  restore: (id: number) => invoke<void>("restore_note", { id }),
  permanentDelete: (id: number) =>
    invoke<void>("permanent_delete_note", { id }),
  list: (page?: number, pageSize?: number) =>
    invoke<PageResult<Note>>("list_trash", { page, pageSize }),
  empty: () => invoke<number>("empty_trash"),
};

/** 每日笔记 API */
export const dailyApi = {
  getOrCreate: (date: string) =>
    invoke<Note>("get_or_create_daily", { date }),
  listDates: (year: number, month: number) =>
    invoke<string[]>("list_daily_dates", { year, month }),
};

/** 笔记链接 API */
export const linkApi = {
  syncLinks: (sourceId: number, targetIds: number[]) =>
    invoke<void>("sync_note_links", { sourceId, targetIds }),
  getBacklinks: (noteId: number) =>
    invoke<NoteLink[]>("get_backlinks", { noteId }),
  searchTargets: (keyword: string, limit?: number) =>
    invoke<[number, string][]>("search_link_targets", { keyword, limit }),
  getGraphData: () => invoke<GraphData>("get_graph_data"),
};

/** 标签 API */
export const tagApi = {
  create: (name: string, color?: string) =>
    invoke<Tag>("create_tag", { name, color }),
  list: () => invoke<Tag[]>("list_tags"),
  rename: (id: number, name: string) =>
    invoke<void>("rename_tag", { id, name }),
  delete: (id: number) => invoke<void>("delete_tag", { id }),
  addToNote: (noteId: number, tagId: number) =>
    invoke<void>("add_tag_to_note", { noteId, tagId }),
  removeFromNote: (noteId: number, tagId: number) =>
    invoke<void>("remove_tag_from_note", { noteId, tagId }),
  getNoteTags: (noteId: number) =>
    invoke<Tag[]>("get_note_tags", { noteId }),
  listNotesByTag: (tagId: number, page?: number, pageSize?: number) =>
    invoke<PageResult<Note>>("list_notes_by_tag", { tagId, page, pageSize }),
};

/** AI 模型 API */
export const aiModelApi = {
  list: () => invoke<AiModel[]>("list_ai_models"),
  create: (input: AiModelInput) =>
    invoke<AiModel>("create_ai_model", { input }),
  update: (id: number, input: AiModelInput) =>
    invoke<AiModel>("update_ai_model", { id, input }),
  delete: (id: number) => invoke<void>("delete_ai_model", { id }),
  setDefault: (id: number) => invoke<void>("set_default_ai_model", { id }),
};

/** AI 对话 API */
export const aiChatApi = {
  listConversations: () =>
    invoke<AiConversation[]>("list_ai_conversations"),
  createConversation: (title?: string, modelId?: number) =>
    invoke<AiConversation>("create_ai_conversation", { title, modelId }),
  deleteConversation: (id: number) =>
    invoke<void>("delete_ai_conversation", { id }),
  renameConversation: (id: number, title: string) =>
    invoke<void>("rename_ai_conversation", { id, title }),
  listMessages: (conversationId: number) =>
    invoke<AiMessage[]>("list_ai_messages", { conversationId }),
  sendMessage: (conversationId: number, message: string, useRag?: boolean) =>
    invoke<void>("send_ai_message", { conversationId, message, useRag }),
  cancelGeneration: (conversationId: number) =>
    invoke<void>("cancel_ai_generation", { conversationId }),
};

/** 导入 API */
export const importApi = {
  scan: (path: string) =>
    invoke<ScannedFile[]>("scan_markdown_folder", { path }),
  importSelected: (filePaths: string[], folderId?: number | null) =>
    invoke<ImportResult>("import_selected_files", { filePaths, folderId }),
};

/** 导出 API */
export const exportApi = {
  /** 批量导出笔记为 Markdown 文件 */
  exportNotes: (outputDir: string, folderId?: number | null) =>
    invoke<ExportResult>("export_notes", { outputDir, folderId }),
  /** 导出单篇笔记为 Markdown 文件 */
  exportSingle: (id: number, filePath: string) =>
    invoke<void>("export_single_note", { id, filePath }),
};

/** AI 写作辅助 API */
export const aiWriteApi = {
  /** 执行写作辅助操作（流式返回，通过 ai-write:token 事件接收） */
  assist: (action: string, selectedText: string, context?: string) =>
    invoke<void>("ai_write_assist", { action, selectedText, context }),
  /** 取消写作辅助 */
  cancel: () => invoke<void>("cancel_ai_write_assist"),
};
