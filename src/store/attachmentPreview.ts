import { create } from "zustand";

/**
 * 附件预览全局 store。
 *
 * 设计：单例 Modal 挂在 AppLayout 根部，任何地方（编辑器点击 / 笔记列表悬浮卡片等）
 * 都可以通过 `useAttachmentPreviewStore.getState().open(...)` 调出预览。
 *
 * 为什么不混进主 useAppStore：
 * - 这是临时 UI 状态（关掉 Modal 即清），不需要持久化也不会被其它视图复用
 * - 主 store 已经 1000+ 行，再塞反而难维护
 */

/**
 * 附件预览输入参数。
 *
 * `rel` 是相对 data_dir 的 POSIX 路径（笔记 content 里 kb-asset:// 后那段），
 * 同时也是 Excel/Text 后端 Command 的入参。`fileName` 仅用于 Modal 标题与导出文件名。
 */
export interface AttachmentPreviewTarget {
  rel: string;
  fileName: string;
}

interface AttachmentPreviewStore {
  /** 当前正在预览的附件；null 表示 Modal 关闭 */
  target: AttachmentPreviewTarget | null;
  open: (target: AttachmentPreviewTarget) => void;
  close: () => void;
}

export const useAttachmentPreviewStore = create<AttachmentPreviewStore>(
  (set) => ({
    target: null,
    open: (target) => set({ target }),
    close: () => set({ target: null }),
  }),
);

/** Office 文档（走 DocxPreview / XlsxPreview） */
export const OFFICE_ATTACHMENT_EXTS = [
  "docx",
  "doc",
  "xlsx",
  "xls",
  "xlsm",
  "xlsb",
  "ods",
];

/**
 * 纯文本类扩展名（走 TextPreview，后端按 UTF-8 读）。
 *
 * 单独列出来是因为 TextPreview 曾经是"兜底分支"——任何没匹配上 PDF/Office 的
 * 类型都丢给它，于是改过名的 PDF（链接文本不带 .pdf）会被当文本读，
 * 报 "stream did not contain valid UTF-8"。现在改成白名单：不在这张表里的
 * 一律提示用系统应用打开，不再拿 UTF-8 去啃二进制。
 */
export const TEXT_ATTACHMENT_EXTS = [
  "txt",
  "md",
  "markdown",
  "json",
  "csv",
  "tsv",
  "log",
  "yaml",
  "yml",
  "xml",
  "html",
  "htm",
  "ini",
  "toml",
  // 常见代码
  "js",
  "ts",
  "tsx",
  "jsx",
  "py",
  "rs",
  "go",
  "java",
  "c",
  "cpp",
  "h",
  "css",
  "scss",
  "sh",
  "bat",
  "ps1",
  "sql",
];

/** 已支持应用内预览的扩展名（小写、不含点）= Office + PDF + 文本 */
export const PREVIEWABLE_ATTACHMENT_EXTS = [
  ...OFFICE_ATTACHMENT_EXTS,
  "pdf",
  ...TEXT_ATTACHMENT_EXTS,
];

/** 该扩展名是否走文本预览（后端 UTF-8 读取） */
export function isTextAttachmentExt(ext: string): boolean {
  return TEXT_ATTACHMENT_EXTS.includes(ext.toLowerCase());
}

/** 判断给定路径是否可被应用内预览 */
export function isPreviewableAttachment(pathOrName: string): boolean {
  const idx = pathOrName.lastIndexOf(".");
  if (idx < 0) return false;
  const ext = pathOrName.slice(idx + 1).toLowerCase();
  return PREVIEWABLE_ATTACHMENT_EXTS.includes(ext);
}
