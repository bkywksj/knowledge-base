import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import {
  enable as autostartEnable,
  disable as autostartDisable,
  isEnabled as autostartIsEnabled,
} from "@tauri-apps/plugin-autostart";
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
  OpenMarkdownResult,
  OrphanImageScan,
  OrphanImageClean,
  ScannedFile,
  ExportResult,
  NoteTemplate,
  NoteTemplateInput,
  DailyWritingStat,
  PdfImportResult,
  DocConverter,
  ConverterDiagnostic,
  SyncScope,
  SyncImportMode,
  WebDavConfig,
  SyncManifest,
  SyncResult,
  SyncHistoryItem,
  RemoteSnapshot,
  Task,
  TaskLinkInput,
  CreateTaskInput,
  UpdateTaskInput,
  TaskQuery,
  TaskStats,
} from "@/types";

/** 系统相关 API */
export const systemApi = {
  greet: (name: string) => invoke<string>("greet", { name }),
  getSystemInfo: () => invoke<SystemInfo>("get_system_info"),
  getDashboardStats: () => invoke<DashboardStats>("get_dashboard_stats"),
  getWritingTrend: (days?: number) =>
    invoke<DailyWritingStat[]>("get_writing_trend", { days }),
};

/** 更新相关 API */
export const updaterApi = {
  checkUpdate: () => check(),
};

/** 开机启动 API
 *
 * 依赖 tauri-plugin-autostart：启用后系统启动时会以
 * `--start-minimized` 参数唤起本应用，Rust 侧据此决定是否隐藏窗口。
 */
export const autostartApi = {
  isEnabled: () => autostartIsEnabled(),
  enable: () => autostartEnable(),
  disable: () => autostartDisable(),
};

/** PDF 导入与预览 API */
export const pdfApi = {
  /** 批量导入 PDF 为笔记，返回每条结果（含错误） */
  importPdfs: (paths: string[], folderId?: number | null) =>
    invoke<PdfImportResult[]>("import_pdfs", { paths, folderId }),
  /** 获取笔记关联 PDF 的绝对路径（无则返回 null） */
  getAbsolutePath: (noteId: number) =>
    invoke<string | null>("get_pdf_absolute_path", { noteId }),
};

/** 通用源文件 API（Word / 任意附件） */
export const sourceFileApi = {
  /** 探测系统可用的 .doc 转换器（启动时检测一次） */
  getConverterStatus: () =>
    invoke<DocConverter>("get_converter_status"),
  /** 详细诊断：每个 Word ProgId 的实测结果（含 PowerShell 错误） */
  diagnoseDocConverter: () =>
    invoke<ConverterDiagnostic>("diagnose_doc_converter"),
  /** 把 .doc 转 .docx，返回 .docx 字节的 base64 */
  convertDocToDocxBase64: (path: string) =>
    invoke<string>("convert_doc_to_docx_base64", { path }),
  /** 把任意路径的文件读为 base64（路径来自 dialog） */
  readFileAsBase64: (path: string) =>
    invoke<string>("read_file_as_base64", { path }),
  /** 把源文件挂到笔记上（拷贝原文件 + 更新 source_file_path/type） */
  attach: (noteId: number, sourcePath: string, fileType: string) =>
    invoke<string>("attach_source_file", {
      noteId,
      sourcePath,
      fileType,
    }),
  /** 通用：获取笔记关联源文件的绝对路径 */
  getAbsolutePath: (noteId: number) =>
    invoke<string | null>("get_source_file_absolute_path", { noteId }),
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
  trashAll: () => invoke<number>("trash_all_notes"),
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
  move: (id: number, newParentId: number | null) =>
    invoke<void>("move_folder", { id, newParentId }),
  reorder: (orderedIds: number[]) =>
    invoke<void>("reorder_folders", { orderedIds }),
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
  get: (date: string) =>
    invoke<Note | null>("get_daily", { date }),
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
  /** 规范化精确匹配：trim + 空白折叠 + 大小写不敏感 */
  findIdByTitle: (title: string) =>
    invoke<number | null>("find_note_id_by_title_loose", { title }),
  getGraphData: () => invoke<GraphData>("get_graph_data"),
};

/** 标签 API */
export const tagApi = {
  create: (name: string, color?: string) =>
    invoke<Tag>("create_tag", { name, color }),
  list: () => invoke<Tag[]>("list_tags"),
  rename: (id: number, name: string) =>
    invoke<void>("rename_tag", { id, name }),
  /** 修改标签颜色；传 null 清除自定义颜色走默认样式 */
  setColor: (id: number, color: string | null) =>
    invoke<void>("set_tag_color", { id, color }),
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
  updateConversationModel: (id: number, modelId: number) =>
    invoke<void>("update_ai_conversation_model", { id, modelId }),
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
  /**
   * 导入选中的 md 文件。
   * - `rootPath` / `preserveRoot` 来自"扫描文件夹"入口：传了后端会按相对目录重建文件夹树；
   *   "单选 md 文件"入口无源根，不传即可（全部平铺到 folderId 下）
   */
  importSelected: (
    filePaths: string[],
    folderId?: number | null,
    rootPath?: string | null,
    preserveRoot?: boolean,
  ) =>
    invoke<ImportResult>("import_selected_files", {
      filePaths,
      folderId,
      rootPath: rootPath ?? null,
      preserveRoot: preserveRoot ?? false,
    }),
  /** 打开单个 md 文件；返回 note id 与是否已同步 */
  openMarkdownFile: (filePath: string) =>
    invoke<OpenMarkdownResult>("open_markdown_file", { filePath }),
};

/** 图片维护 API（孤儿图片扫描/清理） */
export const imageMaintApi = {
  scanOrphans: () => invoke<OrphanImageScan>("scan_orphan_images"),
  cleanOrphans: (paths: string[]) =>
    invoke<OrphanImageClean>("clean_orphan_images", { paths }),
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

/** 图片 API */
export const imageApi = {
  /** 保存图片（base64 数据，用于粘贴/拖放） */
  save: (noteId: number, fileName: string, base64Data: string) =>
    invoke<string>("save_note_image", { noteId, fileName, base64Data }),
  /** 从本地文件路径保存图片（用于工具栏文件选择） */
  saveFromPath: (noteId: number, sourcePath: string) =>
    invoke<string>("save_note_image_from_path", { noteId, sourcePath }),
  /** 删除笔记的所有图片 */
  deleteNoteImages: (noteId: number) =>
    invoke<void>("delete_note_images", { noteId }),
  /** 获取图片存储目录路径 */
  getImagesDir: () => invoke<string>("get_images_dir"),
};

/** 模板 API */
export const templateApi = {
  list: () => invoke<NoteTemplate[]>("list_templates"),
  get: (id: number) => invoke<NoteTemplate>("get_template", { id }),
  create: (input: NoteTemplateInput) =>
    invoke<NoteTemplate>("create_template", { input }),
  update: (id: number, input: NoteTemplateInput) =>
    invoke<NoteTemplate>("update_template", { id, input }),
  delete: (id: number) => invoke<void>("delete_template", { id }),
};

/** AI 写作辅助 API */
export const aiWriteApi = {
  /** 执行写作辅助操作（流式返回，通过 ai-write:token 事件接收） */
  assist: (action: string, selectedText: string, context?: string) =>
    invoke<void>("ai_write_assist", { action, selectedText, context }),
  /** 取消写作辅助 */
  cancel: () => invoke<void>("cancel_ai_write_assist"),
};

/** 同步 API（V1 本地 ZIP + V2 WebDAV 全量快照） */
export const syncApi = {
  /** 导出为本地 ZIP 文件 */
  exportToFile: (scope: SyncScope, targetPath: string) =>
    invoke<SyncResult>("sync_export_to_file", { scope, targetPath }),
  /** 从本地 ZIP 文件导入 */
  importFromFile: (sourcePath: string, mode: SyncImportMode) =>
    invoke<SyncManifest>("sync_import_from_file", { sourcePath, mode }),
  /** 测试 WebDAV 连接 */
  webdavTest: (url: string, username: string, password: string) =>
    invoke<void>("sync_webdav_test", { url, username, password }),
  /** 推送到 WebDAV */
  webdavPush: (scope: SyncScope, config: WebDavConfig) =>
    invoke<SyncResult>("sync_webdav_push", { scope, config }),
  /** 从 WebDAV 拉取 */
  webdavPull: (mode: SyncImportMode, config: WebDavConfig, filename?: string) =>
    invoke<SyncManifest>("sync_webdav_pull", { mode, config, filename }),
  /** 预览云端 manifest */
  webdavPreview: (config: WebDavConfig, filename?: string) =>
    invoke<SyncManifest>("sync_webdav_preview", { config, filename }),
  /** 列出云端所有 kb-sync-*.zip 快照（多设备场景） */
  webdavListSnapshots: (config: WebDavConfig) =>
    invoke<RemoteSnapshot[]>("sync_webdav_list_snapshots", { config }),
  /** 保存 WebDAV 密码到 OS keyring */
  savePassword: (username: string, password: string) =>
    invoke<void>("sync_save_webdav_password", { username, password }),
  /** 检查 keyring 中是否有该用户的密码 */
  hasPassword: (username: string) =>
    invoke<boolean>("sync_has_webdav_password", { username }),
  /** 删除 keyring 中的密码 */
  deletePassword: (username: string) =>
    invoke<void>("sync_delete_webdav_password", { username }),
  /** 列出同步历史 */
  listHistory: (limit?: number) =>
    invoke<SyncHistoryItem[]>("sync_list_history", { limit }),
  /** 唤醒自动同步调度器（配置变更后调用）*/
  schedulerReload: () => invoke<void>("sync_scheduler_reload"),
};

/** 待办任务 API */
export const taskApi = {
  list: (query?: TaskQuery) => invoke<Task[]>("list_tasks", { query }),
  get: (id: number) => invoke<Task>("get_task", { id }),
  create: (input: CreateTaskInput) => invoke<number>("create_task", { input }),
  update: (id: number, input: UpdateTaskInput) =>
    invoke<boolean>("update_task", { id, input }),
  toggleStatus: (id: number) => invoke<number>("toggle_task_status", { id }),
  delete: (id: number) => invoke<boolean>("delete_task", { id }),
  addLink: (taskId: number, input: TaskLinkInput) =>
    invoke<number>("add_task_link", { taskId, input }),
  removeLink: (linkId: number) =>
    invoke<boolean>("remove_task_link", { linkId }),
  stats: () => invoke<TaskStats>("get_task_stats"),
  /** 稍后提醒：向后推 minutes 分钟 + 重置已提醒标记 */
  snooze: (id: number, minutes: number) =>
    invoke<boolean>("snooze_task_reminder", { id, minutes }),
  /** 完成本次：循环任务推进到下一次；非循环任务等同于 toggleStatus */
  completeOccurrence: (id: number) =>
    invoke<void>("complete_task_occurrence", { id }),
};
