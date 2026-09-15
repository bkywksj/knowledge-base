import { save, open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Modal, message } from "antd";

import { exportApi } from "@/lib/api";
import type { MergeFormat } from "@/types";

/**
 * 导出动作的公共实现（选路径 → 调后端 → 成功提示 → 打开所在文件夹）。
 *
 * 背景：单篇导出逻辑原先在 `pages/notes/index.tsx` 与 `pages/notes/editor.tsx` 各有一份，
 * 侧边栏再抄一遍就是第三份。**新增的导出入口一律走这里**；那两处待后续单独收敛，
 * 本次不动它们（控制改动面，避免与并行会话撞车）。
 */

/** Windows/macOS 都不接受的文件名字符，统一换成下划线 */
function safeFileName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "_").trim() || "未命名";
}

/** 统一的成功弹窗：一句话摘要 + 等宽字体的完整路径 + 「打开所在文件夹」 */
function showSuccess(title: string, summary: string, filePath: string) {
  Modal.success({
    title,
    content: (
      <div>
        <p style={{ marginBottom: 4 }}>{summary}</p>
        <p style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
          {filePath}
        </p>
      </div>
    ),
    okText: "打开所在文件夹",
    onOk: () => revealItemInDir(filePath).catch(() => {}),
    closable: true,
  });
}

// ─── 单篇笔记 ──────────────────────────────────────────────

/** 导出单篇为单文件 .md（图片/附件 base64 内嵌，不生成文件夹） */
export async function exportNoteAsMarkdown(id: number) {
  const parentDir = await openDialog({ directory: true, title: "选择导出目录" });
  if (!parentDir || Array.isArray(parentDir)) return;
  try {
    const r = await exportApi.exportSingle(id, parentDir, true);
    showSuccess(
      "导出成功",
      r.assets_copied > 0
        ? `已导出单文件 .md（含 ${r.assets_copied} 个内嵌图片/附件），文件：`
        : "已导出单文件 .md，文件：",
      r.file_path,
    );
  } catch (e) {
    message.error(`导出失败: ${e}`);
  }
}

/**
 * 导出单篇为 Word (.docx)
 *
 * `bodyHtml`：编辑器实时 DOM。只有编辑器里能拿到 —— 标题自动编号是 ProseMirror 的
 * widget decoration，不写进 .md，后端重渲看不到它。侧边栏/列表页没有实时 DOM，省略即可。
 */
export async function exportNoteAsWord(id: number, title: string, bodyHtml?: string) {
  const filePath = await save({
    defaultPath: `${safeFileName(title)}.docx`,
    filters: [{ name: "Word", extensions: ["docx"] }],
  });
  if (!filePath) return;
  try {
    const r = await exportApi.exportSingleToWord(id, filePath, bodyHtml);
    const parts = [`嵌入图片 ${r.imagesEmbedded} 张`];
    if (r.imagesMissing > 0) parts.push(`${r.imagesMissing} 张缺失，已用占位符替代`);
    if (r.attachmentsCopied > 0) {
      parts.push(`附件 ${r.attachmentsCopied} 个（已放到同名 .attachments 文件夹）`);
    }
    showSuccess("导出 Word 成功", `${parts.join("，")}，文件：`, r.filePath);
  } catch (e) {
    message.error(`导出 Word 失败: ${e}`);
  }
}

/** 导出单篇为单文件 HTML（图片内嵌 base64，可独立分享） */
export async function exportNoteAsHtml(id: number, title: string, bodyHtml?: string) {
  const filePath = await save({
    defaultPath: `${safeFileName(title)}.html`,
    filters: [{ name: "HTML", extensions: ["html", "htm"] }],
  });
  if (!filePath) return;
  try {
    const r = await exportApi.exportSingleToHtml(id, filePath, bodyHtml);
    const parts = [`内嵌图片 ${r.imagesInlined} 张`];
    if (r.imagesMissing > 0) parts.push(`${r.imagesMissing} 张缺失`);
    if (r.attachmentsInlined > 0) parts.push(`内嵌附件 ${r.attachmentsInlined} 个`);
    showSuccess("导出 HTML 成功", `${parts.join("，")}，文件：`, r.filePath);
  } catch (e) {
    message.error(`导出 HTML 失败: ${e}`);
  }
}

// ─── 多篇 / 文件夹 ────────────────────────────────────────

/** 批量导出为 Markdown：选一次父目录，每篇产出 `{标题}/{标题}.md` + `assets/` */
export async function exportNotesBatchAsMarkdown(ids: number[]) {
  if (ids.length === 0) return;
  const parentDir = await openDialog({
    directory: true,
    title: `选择导出目录（共 ${ids.length} 篇）`,
  });
  if (!parentDir || Array.isArray(parentDir)) return;

  const hide = message.loading(`正在导出 ${ids.length} 篇…`, 0);
  let success = 0;
  let totalAssets = 0;
  const failed: number[] = [];
  for (const id of ids) {
    try {
      const r = await exportApi.exportSingle(id, parentDir);
      success += 1;
      totalAssets += r.assets_copied;
    } catch (e) {
      failed.push(id);
      console.warn(`[export] 笔记 ${id} 导出失败:`, e);
    }
  }
  hide();

  showSuccess(
    failed.length === 0 ? "导出完成" : "导出完成（部分失败）",
    `成功 ${success} 篇${failed.length > 0 ? `，失败 ${failed.length} 篇` : ""}；` +
      `共复制资产 ${totalAssets} 个。父目录：`,
    parentDir,
  );
}

/** 按文件夹结构导出（多个 .md + assets/），用户选父目录，后端自动包一层时间戳目录 */
export async function exportFolderAsTree(
  folderId: number | null,
  folderName: string,
  recursive: boolean,
) {
  const parentDir = await openDialog({
    directory: true,
    title: `选择导出目录 —— ${folderName}`,
  });
  if (!parentDir || Array.isArray(parentDir)) return;

  const hide = message.loading("正在导出…", 0);
  try {
    const r = await exportApi.exportNotes(parentDir, folderId, recursive);
    hide();
    if (r.exported === 0) {
      message.info("该范围下没有可导出的笔记");
      return;
    }
    showSuccess(
      r.errors.length === 0 ? "导出完成" : "导出完成（部分失败）",
      `成功 ${r.exported} 篇${r.errors.length > 0 ? `，失败 ${r.errors.length} 篇` : ""}；` +
        `附带 ${r.assets_copied} 个资产文件。导出目录：`,
      r.root_dir,
    );
  } catch (e) {
    hide();
    message.error(`导出失败: ${e}`);
  }
}

const MERGE_FILTERS: Record<MergeFormat, { name: string; extensions: string[] }> = {
  markdown: { name: "Markdown", extensions: ["md"] },
  html: { name: "HTML", extensions: ["html", "htm"] },
  word: { name: "Word", extensions: ["docx"] },
};
const MERGE_EXT: Record<MergeFormat, string> = {
  markdown: "md",
  html: "html",
  word: "docx",
};

/** 合并导出：整个文件夹合成**一个**带目录和章节层级的文件 */
export async function exportFolderMerged(
  folderId: number | null,
  folderName: string,
  recursive: boolean,
  format: MergeFormat,
) {
  const filePath = await save({
    defaultPath: `${safeFileName(folderName)}.${MERGE_EXT[format]}`,
    filters: [MERGE_FILTERS[format]],
  });
  if (!filePath) return;

  // 合并大文件夹时要渲染 + 内嵌全部图片，可能几秒到几十秒，必须给等待反馈
  const hide = message.loading("正在合并导出…", 0);
  try {
    const r = await exportApi.exportFolderMerged({
      folderId,
      recursive,
      rootTitle: folderName,
      targetPath: filePath,
      format,
    });
    hide();
    const parts = [`已合并 ${r.notesMerged} 篇笔记`];
    if (r.imagesInlined > 0) parts.push(`内嵌图片 ${r.imagesInlined} 张`);
    if (r.imagesMissing > 0) parts.push(`${r.imagesMissing} 张缺失`);
    showSuccess("合并导出成功", `${parts.join("，")}，文件：`, r.filePath);
  } catch (e) {
    hide();
    message.error(`合并导出失败: ${e}`);
  }
}
