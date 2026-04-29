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
  AiModelTestResult,
  AiConversation,
  AiMessage,
  ImportConflictPolicy,
  ImportResult,
  OpenMarkdownResult,
  OrphanAssetScan,
  OrphanAssetClean,
  OrphanItem,
  AttachmentInfo,
  ScannedFile,
  ExportResult,
  SingleExportResult,
  WriteBackResult,
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
  RestoreBatchResult,
  Task,
  TaskLinkInput,
  CreateTaskInput,
  UpdateTaskInput,
  TaskQuery,
  TaskStats,
  TaskSearchHit,
  TaskCategory,
  CreateTaskCategoryInput,
  UpdateTaskCategoryInput,
  PromptTemplate,
  PromptTemplateInput,
  PlanTodayRequest,
  PlanTodayResponse,
  PlanFromGoalRequest,
  PlanFromGoalResponse,
  PlanFromExcelRequest,
  ExcelPreview,
  AttachmentPreview,
  MessageAttachment,
  DraftNoteRequest,
  DraftNoteResponse,
  VaultStatus,
  SyncBackend,
  SyncBackendInput,
  SyncManifestV1,
  SyncPushResult,
  SyncPullResult,
  ResolvedDataDir,
  MigrationMarker,
  WordExportResult,
  HtmlExportResult,
  ShortcutBinding,
} from "@/types";

/** 系统相关 API */
export const systemApi = {
  greet: (name: string) => invoke<string>("greet", { name }),
  getSystemInfo: () => invoke<SystemInfo>("get_system_info"),
  getDashboardStats: () => invoke<DashboardStats>("get_dashboard_stats"),
  getWritingTrend: (days?: number) =>
    invoke<DailyWritingStat[]>("get_writing_trend", { days }),
  /** 是否允许多开实例（默认 false：第二个进程会唤起已有窗口并退出） */
  getMultiInstanceEnabled: () =>
    invoke<boolean>("get_multi_instance_enabled"),
  /** 把笔记 content 里的 `kb-asset://...` 后那段相对路径还原成 OS 绝对路径。
   * 用于附件链接点击 → opener 打开（opener 必须传绝对路径）。 */
  resolveAssetAbsolute: (rel: string) =>
    invoke<string>("resolve_asset_absolute_path", { rel }),
  /** 切换"允许多开"开关，下次启动生效 */
  setMultiInstanceEnabled: (enabled: boolean) =>
    invoke<void>("set_multi_instance_enabled", { enabled }),
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
/** 全局快捷键管理 API（系统级热键，由 Rust 侧 global-shortcut 插件管理） */
export const shortcutsApi = {
  list: () => invoke<ShortcutBinding[]>("list_shortcut_bindings"),
  set: (id: string, accel: string) =>
    invoke<void>("set_shortcut_binding", { id, accel }),
  reset: (id: string) => invoke<void>("reset_shortcut_binding", { id }),
  disable: (id: string) => invoke<void>("disable_shortcut_binding", { id }),
};

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
  /** 批量移动笔记到指定文件夹（folderId=null 表示根目录）；返回实际移动的条数 */
  moveBatch: (ids: number[], folderId: number | null) =>
    invoke<number>("move_notes_batch", { ids, folderId }),
  /** 批量软删除（移入回收站）；返回实际删除的条数 */
  trashBatch: (ids: number[]) =>
    invoke<number>("trash_notes_batch", { ids }),
  /** 批量给笔记追加标签（不清除原有）；返回新增的关联条数 */
  addTagsBatch: (noteIds: number[], tagIds: number[]) =>
    invoke<number>("add_tags_to_notes_batch", { noteIds, tagIds }),
  /** T-003: 切换"隐藏"状态；返回切换后的新状态 */
  setHidden: (id: number, hidden: boolean) =>
    invoke<boolean>("set_note_hidden", { id, hidden }),
  /** T-014: 网页剪藏 — 把 URL 抓成 markdown 笔记；返回新建笔记 */
  clipUrl: (url: string, folderId?: number | null) =>
    invoke<Note>("clip_url_to_note", { url, folderId: folderId ?? null }),
};

/** T-003 隐藏笔记专用 API（/hidden 页面） */
export const hiddenApi = {
  list: (opts?: {
    page?: number;
    pageSize?: number;
    /** 只看某个目录；与 uncategorized 二选一，uncategorized 优先 */
    folderId?: number | null;
    /** true = 只看未分类（folder_id IS NULL） */
    uncategorized?: boolean;
  }) =>
    invoke<PageResult<Note>>("list_hidden_notes", {
      page: opts?.page,
      pageSize: opts?.pageSize,
      folderId: opts?.folderId ?? null,
      uncategorized: opts?.uncategorized ?? false,
    }),
  /** 返回有隐藏笔记的 folder_id 列表；含 null 表示有"未分类"的隐藏笔记 */
  listFolderIds: () =>
    invoke<(number | null)[]>("list_hidden_folder_ids"),
};

/**
 * 隐藏笔记 PIN —— UX 门禁（不是数据加密）
 *
 * 与 vaultApi 完全独立：vault 是真加密笔记内容；这里只挡"打开 /hidden 路由"。
 * 忘记 PIN 时数据无损（隐藏笔记本身仍是明文，可走重置流程）。
 */
export const hiddenPinApi = {
  /** 查询是否已设置 PIN —— 决定 ActivityBar 点"隐藏笔记"是否要弹解锁框 */
  isSet: () => invoke<boolean>("is_hidden_pin_set"),
  /**
   * 设置或修改 PIN（已设过时必须传 oldPin）
   * - hint = null 表示不动现有提示；hint = "" 表示清空提示
   * - 后端会校验 hint 不能包含 PIN 本身，否则报错
   */
  set: (oldPin: string | null, newPin: string, hint: string | null = null) =>
    invoke<void>("set_hidden_pin", { oldPin, newPin, hint }),
  /** 校验 PIN —— 失败次数限制由后端管 */
  verify: (pin: string) => invoke<void>("verify_hidden_pin", { pin }),
  /** 清除 PIN（需当前 PIN 校验通过） */
  clear: (currentPin: string) => invoke<void>("clear_hidden_pin", { currentPin }),
  /** 获取 PIN 提示（无则 null）—— 解锁框可展示给用户 */
  getHint: () => invoke<string | null>("get_hidden_pin_hint"),
};

/**
 * T-007 笔记加密 / Vault API
 *
 * - 首次使用先 `setup(主密码)`
 * - 会话启动 / 空闲锁定后要 `unlock(主密码)` 才能加/解密
 * - `encryptNote(id)` 把一篇笔记切换到加密态；`decryptNote(id)` 读出明文（不落盘）
 * - `disableEncrypt(id)` 取消加密，明文写回 content
 *
 * **忘记主密码 = 数据永久不可读**。首次 setup 前 UI 要强提示 + 建议导出 Markdown 备份。
 */
export const vaultApi = {
  status: () => invoke<VaultStatus>("vault_status"),
  setup: (password: string) => invoke<void>("vault_setup", { password }),
  unlock: (password: string) => invoke<void>("vault_unlock", { password }),
  lock: () => invoke<void>("vault_lock"),
  encryptNote: (id: number) => invoke<void>("encrypt_note", { id }),
  decryptNote: (id: number) => invoke<string>("decrypt_note", { id }),
  disableEncrypt: (id: number) =>
    invoke<void>("disable_note_encrypt", { id }),
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
  /** T-006: 按 "工作/周报" 这样的路径字符串递归确保存在，返回最深一级 folder id */
  ensurePath: (path: string) =>
    invoke<number | null>("ensure_folder_path", { path }),
};

/** 搜索 API */
export const searchApi = {
  search: (query: string, limit?: number) =>
    invoke<SearchResult[]>("search_notes", { query, limit }),
};

/** 回收站 API */
export const trashApi = {
  softDelete: (id: number) => invoke<void>("soft_delete_note", { id }),
  /** 单条恢复；返回 true=回到原文件夹，false=原文件夹已不存在落到根目录 */
  restore: (id: number) => invoke<boolean>("restore_note", { id }),
  permanentDelete: (id: number) =>
    invoke<void>("permanent_delete_note", { id }),
  list: (page?: number, pageSize?: number) =>
    invoke<PageResult<Note>>("list_trash", { page, pageSize }),
  empty: () => invoke<number>("empty_trash"),
  /** 批量恢复；返回 {restored, toRoot} */
  restoreBatch: (ids: number[]) =>
    invoke<RestoreBatchResult>("restore_notes_batch", { ids }),
  /** 批量永久删除；返回实际删除条数 */
  permanentDeleteBatch: (ids: number[]) =>
    invoke<number>("permanent_delete_notes_batch", { ids }),
};

/** 每日笔记 API */
export const dailyApi = {
  get: (date: string) =>
    invoke<Note | null>("get_daily", { date }),
  getOrCreate: (date: string) =>
    invoke<Note>("get_or_create_daily", { date }),
  listDates: (year: number, month: number) =>
    invoke<string[]>("list_daily_dates", { year, month }),
  /** 找当前日期相邻的真实存在的日记，返回 [prev, next]；按真实日记跳，跳过空白日 */
  getNeighbors: (date: string) =>
    invoke<[string | null, string | null]>("get_daily_neighbors", { date }),
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
  /** 测试模型连通性。入参用未保存的 AiModelInput，方便 Modal 表单里直接试。 */
  test: (input: AiModelInput) =>
    invoke<AiModelTestResult>("test_ai_model", { input }),
};

/** AI 对话 API */
export const aiChatApi = {
  listConversations: () =>
    invoke<AiConversation[]>("list_ai_conversations"),
  createConversation: (title?: string, modelId?: number) =>
    invoke<AiConversation>("create_ai_conversation", { title, modelId }),
  deleteConversation: (id: number) =>
    invoke<void>("delete_ai_conversation", { id }),
  /** 批量清理：olderThanDays 不传 = 全清；传 N = 删除 N 天前未活动的对话；返回删除条数 */
  deleteConversationsBefore: (olderThanDays?: number) =>
    invoke<number>("delete_ai_conversations_before", { olderThanDays }),
  renameConversation: (id: number, title: string) =>
    invoke<void>("rename_ai_conversation", { id, title }),
  updateConversationModel: (id: number, modelId: number) =>
    invoke<void>("update_ai_conversation_model", { id, modelId }),
  listMessages: (conversationId: number) =>
    invoke<AiMessage[]>("list_ai_messages", { conversationId }),
  /**
   * 发送消息并流式接收回复。
   * - `useRag`: 是否启用 RAG（默认 true）。`useSkills=true` 时自动失效（AI 自行调 search_notes）
   * - `useSkills`: T-004 Skills 框架。AI 可调 search_notes / get_note / list_tags 等工具
   *    监听 `ai:tool_call` 事件可实时拿到每次工具调用（含 running/ok/error 状态）
   * - `attachments`: 路线 A 会话附件（当前支持 Excel）。后端把每个附件的 markdown
   *   拼到 user message 前再发给 AI；附件区会随 user message 一起入库。
   */
  sendMessage: (
    conversationId: number,
    message: string,
    useRag?: boolean,
    useSkills?: boolean,
    attachments?: MessageAttachment[],
  ) =>
    invoke<void>("send_ai_message", {
      conversationId,
      message,
      useRag,
      useSkills,
      attachments,
    }),
  cancelGeneration: (conversationId: number) =>
    invoke<void>("cancel_ai_generation", { conversationId }),
  /**
   * 设置对话挂载的笔记列表（A 方向）。整对话共享，全量覆盖；
   * 后续每次 sendMessage 时，后端按这个列表拉笔记拼成 system prompt 前缀。
   */
  setAttachedNotes: (conversationId: number, noteIds: number[]) =>
    invoke<void>("set_ai_conversation_attached_notes", {
      conversationId,
      noteIds,
    }),
  /**
   * B 方向：把整个对话归档成笔记。title 为空时取对话当前标题；
   * folder_id 为空时落到根。返回新建的 Note。
   */
  archiveToNote: (
    conversationId: number,
    title?: string,
    folderId?: number,
  ) =>
    invoke<Note>("archive_ai_conversation_to_note", {
      conversationId,
      title,
      folderId,
    }),
  /**
   * 取得 / 懒建笔记的伴生 AI 对话（给编辑器右侧抽屉用）。
   * 每篇笔记一条专属对话，自动挂当前笔记为附加上下文；对话被删后重新调会重建。
   */
  getOrCreateCompanionConversation: (noteId: number) =>
    invoke<AiConversation>("get_or_create_companion_conversation", { noteId }),
};

/** AI 会话附件 API（路线 A：导入文件给 AI 会话用） */
export const aiAttachmentApi = {
  /**
   * 通用附件解析：后端按扩展名自动分发 Excel / PDF / 文本解析器，
   * 返回 tagged AttachmentPreview。前端按 kind 渲染不同 chip。
   */
  parseAttachment: (filePath: string) =>
    invoke<AttachmentPreview>("ai_parse_attachment", { filePath }),
  /** @deprecated 用 parseAttachment；保留兼容旧调用方 */
  parseExcel: (filePath: string) =>
    invoke<ExcelPreview>("ai_parse_excel", { filePath }),
};

/** 导入 API */
export const importApi = {
  /**
   * 扫描文件夹，返回每个 .md 文件的分桶结果（new / path / fuzzy）。
   * 前端据此展示"全新/已导入过/可能重复"预览弹窗。
   */
  scan: (path: string) =>
    invoke<ScannedFile[]>("scan_markdown_folder", { path }),
  /**
   * 导入选中的 md 文件。
   * - `rootPath` / `preserveRoot` 来自"扫描文件夹"入口：传了后端会按相对目录重建文件夹树；
   *   "单选 md 文件"入口无源根，不传即可（全部平铺到 folderId 下）
   * - `policy` 控制遇到已存在文件的处理：
   *   · "skip"（默认）已存在则跳过
   *   · "duplicate" 标题加 " (2)" 新建副本
   */
  importSelected: (
    filePaths: string[],
    folderId?: number | null,
    rootPath?: string | null,
    preserveRoot?: boolean,
    policy?: ImportConflictPolicy,
  ) =>
    invoke<ImportResult>("import_selected_files", {
      filePaths,
      folderId,
      rootPath: rootPath ?? null,
      preserveRoot: preserveRoot ?? false,
      policy: policy ?? "skip",
    }),
  /** 打开单个 md 文件；返回 note id 与是否已同步 */
  openMarkdownFile: (filePath: string) =>
    invoke<OpenMarkdownResult>("open_markdown_file", { filePath }),
};

/** 孤儿素材维护 API（图片/视频/附件/PDF/源文件统一扫描清理） */
export const orphanAssetApi = {
  scanAll: () => invoke<OrphanAssetScan>("scan_orphan_assets"),
  clean: (items: OrphanItem[]) =>
    invoke<OrphanAssetClean>("clean_orphan_assets", { items }),
};

/** 外部 .md 双向同步 API（保存即写回原文件） */
export const sourceWritebackApi = {
  /** 把笔记当前内容写回原 .md 文件。
   *
   *  - `force=false`（默认）：mtime 不一致会返回 `kind: "conflict"`，前端据此弹冲突 Modal
   *  - `force=true`：忽略冲突强制覆盖（冲突 Modal 选"覆盖外部"后调用） */
  writeBack: (noteId: number, force = false) =>
    invoke<WriteBackResult>("write_back_source_md", { noteId, force }),
};

/** 导出 API */
export const exportApi = {
  /** 批量导出笔记。`outputDir` 是用户选择的父目录，
   *  实际会在其下创建一层 `知识库导出_YYYYMMDD_HHmmss/` 作为导出根（见返回值 root_dir） */
  exportNotes: (outputDir: string, folderId?: number | null) =>
    invoke<ExportResult>("export_notes", { outputDir, folderId }),
  /** 导出单篇笔记。`parentDir` 是用户选择的父目录，
   *  实际会在其下创建一层 `{标题}/`，里面放 `{标题}.md` 与 `assets/` */
  exportSingle: (id: number, parentDir: string) =>
    invoke<SingleExportResult>("export_single_note", { id, parentDir }),
  /** T-020 导出单条笔记为 Word（.docx）；targetPath 是用户在 save dialog 选定的最终路径 */
  exportSingleToWord: (id: number, targetPath: string) =>
    invoke<WordExportResult>("export_single_note_to_word", { id, targetPath }),
  /** T-020 导出单条笔记为 HTML（单文件，图片内嵌 base64） */
  exportSingleToHtml: (id: number, targetPath: string) =>
    invoke<HtmlExportResult>("export_single_note_to_html", { id, targetPath }),
};

/** 附件 API（PDF/Office/ZIP/音视频等非图片非文本文件）
 *
 * AttachmentInfo.path 是**相对 data_dir 的 POSIX 路径**；笔记 content 里写
 * `kb-asset://<path>`，需要调用 OS opener 时通过 `systemApi.resolveAssetAbsolute(path)` 还原。
 */
export const attachmentApi = {
  /** 保存附件（base64 数据，给前端拖放/粘贴用） */
  save: (noteId: number, fileName: string, base64Data: string) =>
    invoke<AttachmentInfo>("save_note_attachment", { noteId, fileName, base64Data }),
  /** 从本地路径零拷贝保存（工具栏"插入附件"用，避免大文件 base64 OOM） */
  saveFromPath: (noteId: number, sourcePath: string) =>
    invoke<AttachmentInfo>("save_note_attachment_from_path", { noteId, sourcePath }),
  /** 删除笔记的所有附件 */
  deleteNoteAttachments: (noteId: number) =>
    invoke<void>("delete_note_attachments", { noteId }),
  /** 获取附件存储目录（设置页"打开目录"入口） */
  getAttachmentsDir: () => invoke<string>("get_attachments_dir"),
};

/** 图片 API
 *
 * save / saveFromPath 返回**相对 data_dir 的 POSIX 路径**（如 `kb_assets/images/1/x.png`）。
 * 调用方要拼 `kb-asset://<rel>` 写入笔记 content；用 `lib/assetUrl.ts` 的 `toKbAsset()`。
 */
export const imageApi = {
  /** 保存图片（base64 数据，用于粘贴/拖放）；返回相对路径 */
  save: (noteId: number, fileName: string, base64Data: string) =>
    invoke<string>("save_note_image", { noteId, fileName, base64Data }),
  /** 从本地文件路径保存图片（用于工具栏文件选择）；返回相对路径 */
  saveFromPath: (noteId: number, sourcePath: string) =>
    invoke<string>("save_note_image_from_path", { noteId, sourcePath }),
  /** 删除笔记的所有图片 */
  deleteNoteImages: (noteId: number) =>
    invoke<void>("delete_note_images", { noteId }),
  /** 获取图片存储目录路径（绝对路径，用于"打开目录"入口） */
  getImagesDir: () => invoke<string>("get_images_dir"),
  /** 读取图片字节流：路径以 `.enc` 结尾时由后端自动解密。
   * 接收**相对路径**（kb-asset:// 后那段），加密笔记 observer 用此还原明文 bytes
   * 转 blob URL 喂给 <img>。vault 锁定时此调用会失败。 */
  getBlob: async (path: string): Promise<Uint8Array> => {
    const v = await invoke<number[]>("get_image_blob", { path });
    return new Uint8Array(v);
  },
};

/** 视频 API
 *
 * 与图片 API 对称，但走 Tauri 2.x binary IPC（参数 Uint8Array → Rust Vec<u8>），
 * 比 base64 省 33% 体积 + 零编解码，100MB 视频也能秒传。
 *
 * save / saveFromPath 返回**相对 data_dir 的 POSIX 路径**，调用方拼 `kb-asset://<rel>`。
 *
 * v1 不支持加密笔记的视频；后端遇到加密笔记会拒绝。
 */
export const videoApi = {
  /** 保存视频字节（Uint8Array 直传，用于粘贴/拖入）；返回相对路径 */
  save: (noteId: number, fileName: string, data: Uint8Array) =>
    invoke<string>("save_video", { noteId, fileName, data }),
  /** 从本地文件路径保存（工具栏文件选择器 / 大文件回退路径，零拷贝）；返回相对路径 */
  saveFromPath: (noteId: number, sourcePath: string) =>
    invoke<string>("save_video_from_path", { noteId, sourcePath }),
  /** 删除笔记的所有视频 */
  deleteNoteVideos: (noteId: number) =>
    invoke<void>("delete_note_videos", { noteId }),
  /** 获取视频存储目录（设置页"打开目录"用） */
  getVideosDir: () => invoke<string>("get_videos_dir"),
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
  /**
   * 根据选区 + 上下文，向 AI 拿一条"最有用"的处理指令建议（一次性，不走流式）。
   * 失败时调用方应静默忽略（例如未配置默认模型 / 离线 / 限流）。
   */
  suggestPrompt: (selectedText: string, context?: string) =>
    invoke<string>("ai_suggest_prompt", { selectedText, context }),
};

/**
 * T-005 AI 规划今日待办
 *
 * 非流式：典型耗时 5~15 秒。调用前 UI 要给骨架屏/加载态。
 * 仅 OpenAI 兼容模型可用；Ollama 会返回错误字符串。
 */
export const aiPlanApi = {
  planToday: (request: PlanTodayRequest) =>
    invoke<PlanTodayResponse>("ai_plan_today", { request }),
  /** T-006: AI 生成笔记草稿 + 归档目录建议（未落库）*/
  draftNote: (request: DraftNoteRequest) =>
    invoke<DraftNoteResponse>("ai_draft_note", { request }),
  /** 目标驱动 AI 智能规划：生成 10~30 条结构化待办 + 阶段里程碑（未落库） */
  planFromGoal: (request: PlanFromGoalRequest) =>
    invoke<PlanFromGoalResponse>("ai_plan_from_goal", { request }),
  /** Excel/ODS 文件 → AI 智能规划：解析 Excel 内容后让 AI 拆四象限任务 */
  planFromExcel: (request: PlanFromExcelRequest) =>
    invoke<PlanFromGoalResponse>("ai_plan_from_excel", { request }),
  /** 一键撤销某次 AI 智能规划生成的所有任务，返回删除条数 */
  undoBatch: (batchId: string) =>
    invoke<number>("undo_task_batch", { batchId }),
};

/**
 * AI 提示词库 API
 *
 * 内置模板在数据库迁移 v19 时写入（见 schema.rs），用户可修改文案/排序/启用状态，
 * 但 `isBuiltin` / `builtinCode` 字段由后端保护不可修改。
 */
export const promptApi = {
  /** 列出提示词；onlyEnabled=true 时过滤禁用项（编辑器菜单用） */
  list: (onlyEnabled?: boolean) =>
    invoke<PromptTemplate[]>("list_prompts", { onlyEnabled }),
  get: (id: number) => invoke<PromptTemplate>("get_prompt", { id }),
  create: (input: PromptTemplateInput) =>
    invoke<PromptTemplate>("create_prompt", { input }),
  update: (id: number, input: PromptTemplateInput) =>
    invoke<PromptTemplate>("update_prompt", { id, input }),
  delete: (id: number) => invoke<boolean>("delete_prompt", { id }),
  setEnabled: (id: number, enabled: boolean) =>
    invoke<void>("set_prompt_enabled", { id, enabled }),
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
  /** 取出已加密的密码明文（仅供"复用配置"等本地内部流程用） */
  getPassword: (username: string) =>
    invoke<string | null>("sync_get_webdav_password", { username }),
  /** 删除 keyring 中的密码 */
  deletePassword: (username: string) =>
    invoke<void>("sync_delete_webdav_password", { username }),
  /** 列出同步历史 */
  listHistory: (limit?: number) =>
    invoke<SyncHistoryItem[]>("sync_list_history", { limit }),
  /** 唤醒自动同步调度器（配置变更后调用）*/
  schedulerReload: () => invoke<void>("sync_scheduler_reload"),
};

/**
 * T-024 同步 V1 API（多端真同步：单笔记粒度 + 多 backend）
 *
 * 与 syncApi（V0 ZIP 备份）并存；用户可同时配置两套
 */
export const syncV1Api = {
  listBackends: () => invoke<SyncBackend[]>("sync_v1_list_backends"),
  getBackend: (id: number) =>
    invoke<SyncBackend | null>("sync_v1_get_backend", { id }),
  createBackend: (input: SyncBackendInput) =>
    invoke<number>("sync_v1_create_backend", { input }),
  updateBackend: (id: number, input: SyncBackendInput) =>
    invoke<void>("sync_v1_update_backend", { id, input }),
  deleteBackend: (id: number) =>
    invoke<boolean>("sync_v1_delete_backend", { id }),
  testConnection: (id: number) =>
    invoke<void>("sync_v1_test_connection", { id }),
  readRemoteManifest: (id: number) =>
    invoke<SyncManifestV1 | null>("sync_v1_read_remote_manifest", { id }),
  push: (id: number) => invoke<SyncPushResult>("sync_v1_push", { id }),
  pull: (id: number) => invoke<SyncPullResult>("sync_v1_pull", { id }),
  getLocalManifest: () =>
    invoke<SyncManifestV1>("sync_v1_get_local_manifest"),
};

/**
 * T-013 自定义数据目录 API
 *
 * 修改路径只写指针文件，**重启生效**。当前进程的 db / 资产路径不会变。
 * 不会自动迁移老数据；UI 强提示用户手动复制旧 `app.db + kb_assets/` 到新目录。
 */
export const dataDirApi = {
  getInfo: () => invoke<ResolvedDataDir>("get_data_dir_info"),
  setPending: (newPath: string) =>
    invoke<void>("set_pending_data_dir", { newPath }),
  clearPending: () => invoke<void>("clear_pending_data_dir"),
  /** T-013 完整版：写指针 + 写迁移 marker */
  setPendingWithMigration: (newPath: string) =>
    invoke<void>("set_pending_data_dir_with_migration", { newPath }),
  /** 取消未执行的迁移 */
  cancelPendingMigration: () => invoke<void>("cancel_pending_migration"),
  /** 读迁移 marker（splash 窗口启动时查初始状态用）*/
  getMigrationMarker: () =>
    invoke<MigrationMarker | null>("get_migration_marker"),
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
  /** 批量删除任务（多选模式用），返回实际删除条数 */
  deleteBatch: (ids: number[]) =>
    invoke<number>("delete_tasks_batch", { ids }),
  /** 批量标记完成（多选模式用），返回实际更新条数 */
  completeBatch: (ids: number[]) =>
    invoke<number>("complete_tasks_batch", { ids }),
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
  /** 顶栏 Ctrl+K 搜索：按关键词查待办（LIKE title/description） */
  search: (query: string, limit?: number) =>
    invoke<TaskSearchHit[]>("search_tasks", { query, limit }),
};

/** 待办分类 API（一级扁平分类） */
export const taskCategoryApi = {
  list: () => invoke<TaskCategory[]>("list_task_categories"),
  create: (input: CreateTaskCategoryInput) =>
    invoke<number>("create_task_category", { input }),
  update: (id: number, input: UpdateTaskCategoryInput) =>
    invoke<boolean>("update_task_category", { id, input }),
  /** 删除分类。任务的 category_id 会因 ON DELETE SET NULL 自动落到未分类 */
  delete: (id: number) => invoke<boolean>("delete_task_category", { id }),
};
