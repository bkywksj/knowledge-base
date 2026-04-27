import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Highlight from "@tiptap/extension-highlight";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import Code from "@tiptap/extension-code";
import { CodeBlockEnhanced } from "./CodeBlockEnhanced";
import { Mathematics } from "@tiptap/extension-mathematics";
import Typography from "@tiptap/extension-typography";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { Fragment } from "@tiptap/pm/model";
import { getHTMLFromFragment, mergeAttributes } from "@tiptap/core";
import { TextAlign } from "@tiptap/extension-text-align";
import { Color } from "@tiptap/extension-color";
import Superscript from "@tiptap/extension-superscript";
import Subscript from "@tiptap/extension-subscript";
import { FigureImage } from "./FigureExtension";
import { calcEditorStats } from "@/lib/textStats";
import { FontSize, LineHeight, Indent } from "./TextStyleExtras";
// tiptap-markdown 未提供 TS 声明，用 import 后以 any 访问
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { Markdown } from "tiptap-markdown";

/** 从编辑器读出 Markdown 字符串（tiptap-markdown 注入的 storage 无类型） */
function getEditorMarkdown(editor: { storage: unknown }): string {
  const storage = editor.storage as { markdown?: { getMarkdown: () => string } };
  return storage.markdown?.getMarkdown() ?? "";
}

/**
 * 表格是否含手动调过的列宽
 *
 * Tiptap Table 的 `tableCell` / `tableHeader` 在用户拖动列宽分隔条后会写入
 * `colwidth` 属性（数组，元素为 number 或 null）；只要任意单元格里有非 null
 * 的值就视为"自定义列宽"。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tableHasCustomColWidth(tableNode: any): boolean {
  let found = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tableNode.descendants((cell: any) => {
    if (found) return false;
    const name = cell.type.name;
    if (name === "tableCell" || name === "tableHeader") {
      const cw = cell.attrs.colwidth;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (Array.isArray(cw) && cw.some((w: any) => w != null)) {
        found = true;
        return false;
      }
    }
    return undefined;
  });
  return found;
}

/**
 * 复刻 tiptap-markdown/src/extensions/nodes/table.js 的同名判断：
 * 表格能否用 GFM 管道语法表达。出现 rowspan/colspan、首行非全表头、cell 含
 * 多段落等情况都不行 —— 这些情况下原版 tiptap-markdown 自己也会回退到 HTML。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isTableMarkdownSerializable(node: any): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  node.forEach((row: any) => rows.push(row));
  const firstRow = rows[0];
  if (!firstRow) return true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cellsOf = (row: any): any[] => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const arr: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    row.forEach((c: any) => arr.push(c));
    return arr;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasSpan = (c: any) => c.attrs.colspan > 1 || c.attrs.rowspan > 1;
  if (
    cellsOf(firstRow).some(
      (c) => c.type.name !== "tableHeader" || hasSpan(c) || c.childCount > 1,
    )
  ) {
    return false;
  }
  for (let i = 1; i < rows.length; i++) {
    if (
      cellsOf(rows[i]).some(
        (c) => c.type.name === "tableHeader" || hasSpan(c) || c.childCount > 1,
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * 自定义 Table：在 tiptap-markdown 默认 serializer 上叠加"含 colwidth → 退成 HTML"。
 *
 * 默认 tiptap-markdown 只检查"是否能用 GFM 管道语法表达"（spans/多段落/首行）；
 * 一旦发现自定义列宽我们也要走 HTML，否则 colwidth 在 markdown 表格里无法保存。
 *
 * tiptap-markdown 的 getMarkdownSpec() 是 `{ ...default, ...userOverride }`，
 * 我们 addStorage 后整段 serialize 会被替换 —— 所以不能"复用默认再补一刀"，
 * 这里把默认的管道语法逻辑原样抄一份。
 */
const TableWithMarkdown = Table.extend({
  addStorage() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parentStorage = ((this as any).parent?.() ?? {}) as Record<string, unknown>;
    return {
      ...parentStorage,
      markdown: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serialize(state: any, node: any, _parent: any) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const editor = (this as any).editor;
          const htmlAllowed = editor?.storage?.markdown?.options?.html;

          // 含自定义列宽 / 不能 markdown 表达 → 走 HTML（前提是 markdown 配 html: true）
          if (
            (tableHasCustomColWidth(node) || !isTableMarkdownSerializable(node)) &&
            htmlAllowed
          ) {
            const html = getHTMLFromFragment(Fragment.from(node), node.type.schema);
            state.write(html);
            state.closeBlock(node);
            return;
          }

          // 默认 GFM 管道语法（与 tiptap-markdown 内置实现一致）
          state.inTable = true;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node.forEach((row: any, _p: number, i: number) => {
            state.write("| ");
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            row.forEach((col: any, _p2: number, j: number) => {
              if (j) state.write(" | ");
              const cellContent = col.firstChild;
              if (cellContent && cellContent.textContent.trim()) {
                state.renderInline(cellContent);
              }
            });
            state.write(" |");
            state.ensureNewLine();
            if (!i) {
              const delimiterRow = Array.from({ length: row.childCount })
                .map(() => "---")
                .join(" | ");
              state.write(`| ${delimiterRow} |`);
              state.ensureNewLine();
            }
          });
          state.closeBlock(node);
          state.inTable = false;
        },
        parse: {
          // 解析端 tiptap-markdown 走 markdown-it；HTML 表格作为 raw HTML 块直接保留
        },
      },
    };
  },
});
import { common, createLowlight } from "lowlight";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useCallback, useState } from "react";
import { message } from "antd";
import { theme as antdTheme } from "antd";
import { attachmentApi, imageApi, videoApi } from "@/lib/api";
import { EditorToolbar } from "./EditorToolbar";
import { AiWriteMenu } from "./AiWriteMenu";
import { WikiLinkDecoration } from "./WikiLinkDecoration";
import { WikiLinkSuggestion } from "./WikiLinkSuggestion";
import { Video as VideoNode } from "./VideoNode";
import { VideoTimestamp } from "./VideoTimestamp";
import { AllowFileLink } from "./AllowFileLink";
import { Callout } from "./Callout";
import { Toggle, ToggleSummary, ToggleContent } from "./Toggle";
import "tippy.js/dist/tippy.css";

const lowlight = createLowlight(common);

/**
 * T-011 自定义 markdown → Math 节点迁移
 *
 * 官方 `migrateMathStrings` 只处理单行 `$..$` 行内公式，且 regex 会把 `$$expr$$`
 * 错误捕获成内层 `$expr$`。本项目要兼容 OB markdown，行内 + 多行块级都要支持，
 * 因此重写一遍：
 *   1. 整段（textblock 的 textContent）匹配 `$$\n*expr\n*$$` → 替换整个段落为 blockMath
 *   2. 否则扫文本节点，按 inline `$..$` 替换（避开 `$10` 货币、`$$` 双号边界）
 *
 * 倒序应用替换避免位置漂移；不写入 history（迁移不应被撤销到原始 markdown）。
 *
 * 安全保证：失败时不修改 doc（`tr.docChanged` 检查）；KaTeX 渲染若 throw，
 * extension 配的 `throwOnError: false`（默认）会显示错误提示而非崩溃编辑器。
 */
function migrateOpenMathStrings(editor: import("@tiptap/react").Editor): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema: any = editor.schema;
  const blockMath = schema.nodes.blockMath;
  const inlineMath = schema.nodes.inlineMath;
  if (!blockMath && !inlineMath) return;

  const tr = editor.state.tr;
  type Replace = { from: number; to: number; latex: string; kind: "block" | "inline" };
  const replaces: Replace[] = [];

  // ─── 规则 0：跨段落多行块级 — 顶层连续 paragraph 形如 $$ ... $$ ───
  // tiptap-markdown 把 `$$\nmatrix\n$$` 拆成多个 <p>，单段落 regex 抓不到，
  // 这里在 doc 顶层扫 children，找到 `^\s*$$` 起始段 → 直到下一个 `^$$\s*$` 段，
  // 把这一段范围整体替换为 blockMath
  if (blockMath) {
    const docNode = tr.doc;
    const topChildren: { node: import("@tiptap/pm/model").Node; from: number }[] = [];
    docNode.forEach((child, offset) => {
      topChildren.push({ node: child, from: offset });
    });
    const consumed = new Set<number>();
    for (let i = 0; i < topChildren.length; i++) {
      if (consumed.has(i)) continue;
      const c = topChildren[i];
      if (!c.node.isTextblock) continue;
      const t = c.node.textContent.trim();
      if (!t.startsWith("$$")) continue;

      // 单段就闭合（如 `$$expr$$`）
      const single = /^\$\$([\s\S]+?)\$\$$/.exec(t);
      if (single) {
        replaces.push({
          from: c.from,
          to: c.from + c.node.nodeSize,
          latex: single[1].trim(),
          kind: "block",
        });
        consumed.add(i);
        continue;
      }

      // 段首是 `$$`（可能仅 `$$`，也可能 `$$expr...`）但不闭合 → 找闭合段
      // 提取段首 `$$` 之后的内容（可能为空）
      const firstChunk = t.replace(/^\$\$/, "");
      const collected: string[] = [];
      if (firstChunk) collected.push(firstChunk);
      let endIdx = -1;
      let lastChunk = "";
      for (let j = i + 1; j < topChildren.length; j++) {
        const next = topChildren[j];
        if (!next.node.isTextblock) continue;
        const nt = next.node.textContent.trim();
        if (nt.endsWith("$$")) {
          // 闭合段
          const beforeClose = nt.replace(/\$\$$/, "");
          if (beforeClose) lastChunk = beforeClose;
          endIdx = j;
          break;
        }
        collected.push(nt);
        // 防止无限扫描：超过 50 段未闭合视为不是块级公式
        if (j - i > 50) break;
      }
      if (endIdx < 0) continue; // 没找到闭合，放弃

      if (lastChunk) collected.push(lastChunk);
      const latex = collected.join("\n").trim();
      if (!latex) continue;
      const endChild = topChildren[endIdx];
      replaces.push({
        from: c.from,
        to: endChild.from + endChild.node.nodeSize,
        latex,
        kind: "block",
      });
      for (let k = i; k <= endIdx; k++) consumed.add(k);
    }
  }

  // ─── 规则 1 + 2：单段落内的块级 / 行内（与上面跨段落不重叠的部分） ───
  // 用 set 记录跨段落规则吃掉的段范围，避免重复处理
  const blockedRanges = replaces
    .filter((r) => r.kind === "block")
    .map((r) => [r.from, r.to] as [number, number]);

  function isInBlockedRange(pos: number): boolean {
    return blockedRanges.some(([f, t]) => pos >= f && pos < t);
  }

  tr.doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    if (isInBlockedRange(pos)) return;
    const text = node.textContent;
    if (!text || !text.includes("$")) return;

    if (!inlineMath) return;

    // 规则 2：行内公式 — `$..$`，避开 `$N` 数字（货币）和 `$$` 双号
    const inlineRe = /(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)(?!\d)/g;
    const textStartInDoc = pos + 1;
    let m: RegExpExecArray | null;
    while ((m = inlineRe.exec(text)) !== null) {
      const matchedText = m[0];
      const latex = m[1];
      replaces.push({
        from: textStartInDoc + m.index,
        to: textStartInDoc + m.index + matchedText.length,
        latex,
        kind: "inline",
      });
    }
  });

  if (replaces.length === 0) return;

  // 倒序应用，避免前面的替换让后面的 from/to 错位
  const sorted = replaces.sort((a, b) => b.from - a.from);
  for (const r of sorted) {
    try {
      if (r.kind === "block") {
        tr.replaceWith(r.from, r.to, blockMath.create({ latex: r.latex }));
      } else {
        tr.replaceWith(r.from, r.to, inlineMath.create({ latex: r.latex }));
      }
    } catch (e) {
      console.warn("[math] migrate replace skipped:", r, e);
    }
  }

  if (tr.docChanged) {
    tr.setMeta("addToHistory", false);
    editor.view.dispatch(tr);
  }
}

/**
 * 给老文档里没有 id 的 video 节点 backfill 一个稳定 ID。
 *
 * Why: VideoTimestamp 节点通过 [data-video-id="<id>"] 选择器定位视频跳转。
 *      之前插入的 video 节点没有 id attr，老笔记打开后无法做时间戳关联。
 *      此处遍历 doc，对所有 video.attrs.id == null 的节点 setNodeAttribute 补齐。
 *
 * 不写入 history（迁移不应被撤销到原始状态）。
 */
function backfillVideoIds(editor: import("@tiptap/react").Editor): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema: any = editor.schema;
  const videoType = schema.nodes.video;
  if (!videoType) return;

  const tr = editor.state.tr;
  let changed = false;
  editor.state.doc.descendants((node, pos) => {
    if (node.type !== videoType) return true;
    if (node.attrs.id) return true;
    const newId = Math.random().toString(36).slice(2, 10);
    tr.setNodeAttribute(pos, "id", newId);
    changed = true;
    return true;
  });

  if (changed) {
    tr.setMeta("addToHistory", false);
    editor.view.dispatch(tr);
  }
}

/**
 * 从 Clipboard/DataTransfer 收集所有文件，按 predicate 筛选。
 * Why: 部分来源（浏览器、某些 IM 工具）`files` 只给第一个，但 `items[]` 里齐全；
 *      用 Set<File> 去重避免两边都给时重复插入。
 */
function collectFiles(
  dt: DataTransfer | null | undefined,
  predicate: (f: File) => boolean,
): File[] {
  if (!dt) return [];
  const seen = new Set<File>();
  const out: File[] = [];
  const push = (f: File | null) => {
    if (f && predicate(f) && !seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  };
  if (dt.items) {
    for (let i = 0; i < dt.items.length; i++) {
      const item = dt.items[i];
      if (item.kind === "file") push(item.getAsFile());
    }
  }
  if (dt.files) {
    for (let i = 0; i < dt.files.length; i++) push(dt.files[i]);
  }
  return out;
}

function collectImageFiles(dt: DataTransfer | null | undefined): File[] {
  return collectFiles(dt, (f) => f.type.startsWith("image/"));
}

/** 视频识别：MIME 或扩展名命中即视为视频 */
const VIDEO_FILE_EXTS = new Set(["mp4", "webm", "mkv", "mov", "avi", "m4v", "ogv"]);
function isVideoFile(f: File): boolean {
  if (f.type.startsWith("video/")) return true;
  const dot = f.name.lastIndexOf(".");
  if (dot < 0) return false;
  return VIDEO_FILE_EXTS.has(f.name.slice(dot + 1).toLowerCase());
}
function collectVideoFiles(dt: DataTransfer | null | undefined): File[] {
  return collectFiles(dt, isVideoFile);
}

/** 单个视频体积上限（字节）—— 与后端 MAX_BYTES 协同：
 *  - 粘贴：50MB（剪贴板视频极少见，主要给截屏录像用）
 *  - 拖入：100MB（IPC binary 通道传 100MB 体感 1~2s 可接受）
 *  - 超过 → 提示用文件选择器走 saveFromPath（零拷贝） */
const VIDEO_MAX_PASTE_BYTES = 50 * 1024 * 1024;
const VIDEO_MAX_DROP_BYTES = 100 * 1024 * 1024;

/** 文本类拖入：.md/.markdown/.txt（按 MIME 或扩展名识别） */
const TEXT_FILE_EXTS = new Set(["md", "markdown", "txt"]);
function collectTextFiles(dt: DataTransfer | null | undefined): File[] {
  return collectFiles(dt, (f) => {
    if (f.type === "text/plain" || f.type === "text/markdown") return true;
    const dot = f.name.lastIndexOf(".");
    if (dot < 0) return false;
    return TEXT_FILE_EXTS.has(f.name.slice(dot + 1).toLowerCase());
  });
}

/**
 * 通用附件拖入：所有非图片、非文本、非"可执行黑名单"的文件。
 *
 * 黑名单与 Rust 侧 `services/attachment.rs::BLOCKED_EXTS` 保持同步，前端提前拦截
 * 给出友好提示；服务端仍会二次校验（纵深防御）。
 */
const ATTACHMENT_BLOCKED_EXTS = new Set([
  "exe", "msi", "bat", "cmd", "ps1", "vbs", "vbe", "js", "jse", "wsf", "wsh",
  "sh", "app", "dmg", "scr", "com", "pif", "dll", "sys", "drv", "cpl", "hta",
  "jar", "apk", "ipa", "deb", "rpm",
]);

function getExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function collectAttachmentFiles(dt: DataTransfer | null | undefined): {
  files: File[];
  blocked: string[];
} {
  const blocked: string[] = [];
  const files = collectFiles(dt, (f) => {
    if (f.type.startsWith("image/")) return false; // 图片走图片分支
    if (isVideoFile(f)) return false; // 视频走视频分支（内联 <video> 节点）
    const ext = getExt(f.name);
    if (TEXT_FILE_EXTS.has(ext)) return false; // 文本走文本分支
    if (ATTACHMENT_BLOCKED_EXTS.has(ext)) {
      blocked.push(f.name);
      return false;
    }
    return true;
  });
  return { files, blocked };
}

/** 人类可读的字节数（1234 → "1.2 KB"）；纯展示用，不参与持久化 */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** 把绝对路径转成 file:// URL，路径里的 `\\` 替换为 `/`，各段做 URI 编码 */
function pathToFileUrl(absPath: string): string {
  const normalized = absPath.replace(/\\/g, "/");
  // 保留 `/` 作分隔符，逐段 encodeURIComponent 避免空格/中文/括号破坏链接
  const encoded = normalized
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return normalized.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`;
}

/** 反解 file:// URL 拿回绝对路径，供 opener 使用 */
function fileUrlToPath(url: string): string {
  const trimmed = url.replace(/^file:\/\/\/?/, "");
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

/** 将 File 对象转为 base64（不含 data URL 前缀） */
/**
 * 判断 HTML 是否只是包裹图片（浏览器复制图片场景）。
 *
 * 浏览器复制图片时 HTML 通常长这样：`<meta charset='utf-8'><img src='https://...'>`，
 * 所有可见内容只是 img；而 Excel/Word 复制表格 HTML 含 <table>/文本/样式。
 *
 * 启发式：strip 掉所有 <img> 后看 body 是否还有实质内容（非空白文本 / 表格 / 列表等）。
 * 任何 strip 后仍有 textContent 或 <table>/<ul>/<ol>/<pre> 节点 → 视为富文本。
 */
function isImageOnlyHtml(html: string): boolean {
  if (!html.trim()) return false;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const body = doc.body;
    if (!body) return false;
    const imgs = body.querySelectorAll("img");
    if (imgs.length === 0) return false;
    imgs.forEach((img) => img.remove());
    // 富文本结构标签存在 → 不是纯图片粘贴
    if (body.querySelector("table, ul, ol, pre, blockquote, h1, h2, h3, h4, h5, h6")) {
      return false;
    }
    // 剩余可见文本去空白后非空 → 富文本
    const text = (body.textContent ?? "").replace(/\s+/g, "");
    return text.length === 0;
  } catch {
    return false;
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // 去掉 "data:image/png;base64," 前缀
      const base64 = result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

interface TiptapEditorProps {
  /** 笔记内容（Markdown 字符串） */
  content: string;
  /** 保存回调，参数为 Markdown 字符串 */
  onChange: (markdown: string) => void;
  placeholder?: string;
  /** 当前笔记 ID，用于图片保存 */
  noteId?: number;
  /**
   * 当 noteId 缺失时，图片插入前调用此回调拉出一个 noteId（例如每日笔记
   * 首次写内容前还未 getOrCreate）。返回 Promise<number>；调用方负责
   * 同步自己的 noteId 状态。
   */
  ensureNoteId?: () => Promise<number>;
  /** Ctrl/Cmd + 点击 [[标题]] 时触发（编辑器内 wiki 链接跳转） */
  onWikiLinkClick?: (title: string) => void;
  /**
   * 选中文本后浮起的「问 AI」按钮回调。
   * 传入选中的纯文本，调用方负责弹抽屉 / 预填问题。
   * 不传则不显示该按钮。
   */
  onAskAi?: (selectedText: string) => void;
  /**
   * 编辑器实例就绪时回调（含 destroy 时传 null）。
   * 用于父组件订阅 doc 变化，例如外挂大纲面板根据 heading 节点渲染。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onEditorReady?: (editor: any | null) => void;
}

export function TiptapEditor({
  content,
  onChange,
  placeholder = "开始写点什么...",
  noteId,
  ensureNoteId,
  onWikiLinkClick,
  onAskAi,
  onEditorReady,
}: TiptapEditorProps) {
  const isExternalUpdate = useRef(false);

  // 用 ref 保持 onWikiLinkClick 最新引用，避免 Tiptap 扩展闭包过期
  const wikiClickRef = useRef(onWikiLinkClick);
  // ensureNoteId 同样用 ref：它常是组件每次渲染新建的闭包，不能进依赖数组
  const ensureNoteIdRef = useRef(ensureNoteId);
  ensureNoteIdRef.current = ensureNoteId;
  useEffect(() => {
    wikiClickRef.current = onWikiLinkClick;
  }, [onWikiLinkClick]);

  // onUpdate 防抖：每次按键都序列化整篇文档（O(doc size)）代价不低，长笔记在 WKWebView 上肉眼可感。
  // 用 ref 承载最新 onChange，避免依赖变化重建 editor；用 timer ref 做 300ms 尾触发，
  // unmount / editor blur 时强制 flush，保证保存按钮永远能拿到最新 markdown。
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingEditorRef = useRef<{ storage: unknown } | null>(null);
  const flushNow = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const pending = pendingEditorRef.current;
    if (pending) {
      pendingEditorRef.current = null;
      onChangeRef.current(getEditorMarkdown(pending));
    }
  }, []);

  /** 处理图片文件：并发保存后一次性批量插入编辑器 */
  const handleImageFiles = useCallback(
    async (files: File[], editor: ReturnType<typeof useEditor>) => {
      if (!editor) return;

      // 优先用显式 noteId；不存在时尝试 ensureNoteId（例如每日笔记自动建档）
      let effectiveNoteId = noteId;
      if (!effectiveNoteId && ensureNoteIdRef.current) {
        try {
          effectiveNoteId = await ensureNoteIdRef.current();
        } catch (e) {
          message.error(`图片插入失败: ${e}`);
          return;
        }
      }
      if (!effectiveNoteId) {
        message.warning("请先保存笔记后再插入图片");
        return;
      }

      const images = files.filter((f) => f.type.startsWith("image/"));
      console.log("[image-drop] received files:", images.length, images.map((f) => f.name));

      // Why: 原版在 for-await 里每次 insertContent，会让 onUpdate 连环触发、debounce 反复刷新；
      //      且 Tiptap 在同一批次中对同一 src 的 node 行为不稳定。改成全部保存完后一次性插入。
      const results = await Promise.all(
        images.map(async (file) => {
          try {
            const base64 = await fileToBase64(file);
            const filePath = await imageApi.save(effectiveNoteId!, file.name, base64);
            return { ok: true as const, filePath, name: file.name };
          } catch (e) {
            return { ok: false as const, err: String(e), name: file.name };
          }
        }),
      );

      const nodes: { type: string; attrs: { src: string } }[] = [];
      for (const r of results) {
        if (r.ok) {
          console.log("[image-drop] saved:", r.name, "=>", r.filePath);
          nodes.push({
            type: "imageResize",
            attrs: { src: convertFileSrc(r.filePath) },
          });
        } else {
          message.error(`图片插入失败(${r.name}): ${r.err}`);
        }
      }
      if (nodes.length === 0) return;

      // 去重：若 Rust 侧仍返回了相同 filePath（比如旧二进制没重编），至少提示用户
      const uniqueSrc = new Set(nodes.map((n) => n.attrs.src));
      if (uniqueSrc.size !== nodes.length) {
        console.warn(
          "[image-drop] 后端返回了重复路径（旧二进制？）",
          nodes.map((n) => n.attrs.src),
        );
      }

      editor.chain().focus().insertContent(nodes).run();
    },
    [noteId],
  );

  /**
   * 处理粘贴/拖入的视频：Uint8Array 走 binary IPC 直传后端落盘，
   * 返回 asset URL 后插入自定义 Video 节点（内联 <video controls preload="metadata">）。
   *
   * `maxBytesEach` 控制单文件上限（粘贴 50MB / 拖入 100MB），超限提示用工具栏。
   */
  const handleVideoFiles = useCallback(
    async (files: File[], editor: ReturnType<typeof useEditor>, maxBytesEach: number) => {
      if (!editor || files.length === 0) return;

      let effectiveNoteId = noteId;
      if (!effectiveNoteId && ensureNoteIdRef.current) {
        try {
          effectiveNoteId = await ensureNoteIdRef.current();
        } catch (e) {
          message.error(`视频插入失败: ${e}`);
          return;
        }
      }
      if (!effectiveNoteId) {
        message.warning("请先保存笔记后再插入视频");
        return;
      }

      // 单独筛超大文件 → 一次性提示
      const ok: File[] = [];
      const oversized: string[] = [];
      for (const f of files) {
        if (f.size > maxBytesEach) {
          oversized.push(`${f.name} (${humanSize(f.size)})`);
        } else {
          ok.push(f);
        }
      }
      if (oversized.length > 0) {
        message.warning(
          `${oversized.length} 个视频超过单文件 ${maxBytesEach / 1024 / 1024} MB 上限，请用工具栏的「插入视频」按钮选择文件：${oversized.join("、")}`,
          6,
        );
      }
      if (ok.length === 0) return;

      const results = await Promise.all(
        ok.map(async (file) => {
          try {
            const buf = await file.arrayBuffer();
            const filePath = await videoApi.save(
              effectiveNoteId!,
              file.name,
              new Uint8Array(buf),
            );
            return { ok: true as const, filePath, name: file.name };
          } catch (e) {
            return { ok: false as const, err: String(e), name: file.name };
          }
        }),
      );

      const nodes: { type: string; attrs: { src: string; id: string } }[] = [];
      for (const r of results) {
        if (r.ok) {
          nodes.push({
            type: "video",
            // 给每个视频生成稳定 id，VideoTimestamp 通过此 id 锚定跳转
            attrs: { src: convertFileSrc(r.filePath), id: Math.random().toString(36).slice(2, 10) },
          });
        } else {
          message.error(`视频插入失败(${r.name}): ${r.err}`);
        }
      }
      if (nodes.length === 0) return;
      editor.chain().focus().insertContent(nodes).run();
    },
    [noteId],
  );

  /**
   * 处理拖入的通用附件：上传到 kb_assets/attachments/<note_id>/ 后，
   * 以普通 markdown 链接插入到光标处 —— 链接文本形如 "📎 filename.pdf (1.2 MB)"，
   * href 是 file:// 绝对路径；点击时由 DOM 级 click handler 拦截并调 opener。
   *
   * Why 不用自定义 Tiptap 节点：保持 markdown 序列化零改造（依赖现有 Link 扩展），
   *      将来需要卡片化 UI 时，可升级为自定义 node + nodeView，不影响存储格式。
   */
  const handleAttachmentFiles = useCallback(
    async (files: File[], editor: ReturnType<typeof useEditor>) => {
      if (!editor || files.length === 0) return;

      // 与图片同一套 noteId 获取流程（daily note 首次写入时自动建档）
      let effectiveNoteId = noteId;
      if (!effectiveNoteId && ensureNoteIdRef.current) {
        try {
          effectiveNoteId = await ensureNoteIdRef.current();
        } catch (e) {
          message.error(`附件保存失败: ${e}`);
          return;
        }
      }
      if (!effectiveNoteId) {
        message.warning("请先保存笔记后再拖入附件");
        return;
      }

      const results = await Promise.all(
        files.map(async (file) => {
          try {
            const base64 = await fileToBase64(file);
            const info = await attachmentApi.save(
              effectiveNoteId!,
              file.name,
              base64,
            );
            return { ok: true as const, info };
          } catch (e) {
            return { ok: false as const, name: file.name, err: String(e) };
          }
        }),
      );

      // 批量构造要插入的 link nodes，最后一次性 insert（避免多次 onUpdate 连环刷新）
      const nodes: Array<{
        type: "text";
        text: string;
        marks: Array<{ type: "link"; attrs: { href: string } }>;
      }> = [];
      for (const r of results) {
        if (r.ok) {
          const label = `📎 ${r.info.fileName} (${humanSize(r.info.size)})`;
          const href = pathToFileUrl(r.info.path);
          nodes.push({
            type: "text",
            text: label,
            marks: [{ type: "link", attrs: { href } }],
          });
          // 在相邻附件之间加换行，避免挤在一起
          nodes.push({ type: "text", text: "\n" } as unknown as (typeof nodes)[number]);
        } else {
          message.error(`附件保存失败(${r.name}): ${r.err}`);
        }
      }
      if (nodes.length === 0) return;

      editor.chain().focus().insertContent(nodes).run();
    },
    [noteId],
  );

  /**
   * 处理拖入的 .md/.txt：读文本后附加到文末，走 setContent 经 tiptap-markdown 解析渲染。
   * Why: ProseMirror 的 insertContent 不走 markdown 解析管线；replace 整篇才能让 md 语法正确渲染。
   *      代价是光标会跳到末尾，但"拖入新文件 = 追加内容"的心智模型下可接受。
   */
  const handleTextFiles = useCallback(
    async (files: File[], editor: ReturnType<typeof useEditor>) => {
      if (!editor || files.length === 0) return;
      try {
        const texts = await Promise.all(files.map((f) => f.text()));
        const currentMd = getEditorMarkdown(editor);
        const separator = currentMd.trim() ? "\n\n" : "";
        const appendMd = texts.join("\n\n");
        editor.commands.setContent(currentMd + separator + appendMd);
        editor.commands.focus("end");
        message.success(`已插入 ${files.length} 个文本文件`);
      } catch (e) {
        message.error(`文件读取失败: ${e}`);
      }
    },
    [],
  );

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false, // 用 CodeBlockLowlight 替代
        // Tiptap 3.x StarterKit 自带 link/underline，这里禁用以避免和下方
        // 手动 Link.configure / Underline 重复（控制台会打印 Duplicate extension names）
        link: false,
        underline: false,
        // 行内 code 默认 excludes:"_" 会排斥所有其他 mark（包括 textStyle/fontSize），
        // 导致选中行内代码后改字号失败。这里禁用 starter-kit 自带的 code，
        // 下方手动引入 Code 并清空 excludes，让 fontSize/color/highlight 等可与
        // code mark 同时存在
        code: false,
      }),
      Code.configure({
        HTMLAttributes: {},
      }).extend({
        // 清空 excludes 让 textStyle / highlight / link 等其他 mark 可与 code 共存
        excludes: "",
      }),
      Placeholder.configure({ placeholder }),
      Highlight.configure({ multicolor: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      // SafeLink：渲染成 <span data-href="..." role="link"> 而非 <a href>，
      // 彻底避开 Tauri WebView 对 anchor 的 navigation 旁路（preventDefault 拦不住）。
      // markdown 序列化由 prosemirror-markdown 直接读 mark.attrs.href，不读 DOM，
      // 所以输出仍是 [label](url) 标准 markdown link，往返不丢失。
      //
      // ⚠ 必须同时改 parseHTML：从 DOM 反向解析时（复制粘贴/HMR 重挂载等路径）
      //   要识别 span[data-href]，否则 label 会被当纯文本入 doc，下次保存就会
      //   出现 "label[label](url)" 的双重 bug（已踩过坑）。
      Link.extend({
        parseHTML() {
          return [
            // 兼容外部 markdown 导入的标准 anchor
            { tag: "a[href]:not([href *= 'javascript:' i])" },
            // SafeLink 自己渲染的 span
            {
              tag: "span[data-href]",
              getAttrs: (el) => ({
                href: (el as HTMLElement).getAttribute("data-href"),
              }),
            },
          ];
        },
        renderHTML({ HTMLAttributes }) {
          const realHref = (HTMLAttributes as { href?: string }).href ?? "";
          const { href: _ignored, target: _t, rel: _r, ...rest } =
            HTMLAttributes as Record<string, unknown>;
          void _ignored; void _t; void _r;
          return [
            "span",
            mergeAttributes(this.options.HTMLAttributes, rest, {
              "data-href": realHref,
              role: "link",
              tabindex: "0",
            }),
            0,
          ];
        },
      }).configure({
        openOnClick: false,
        HTMLAttributes: { class: "tiptap-link" },
      }),
      Underline,
      Superscript,
      Subscript,
      // FontSize 直接继承 TextStyle，复用 textStyle mark name；Color 扩展默认就用这个
      FontSize,
      Color,
      LineHeight,
      Indent,
      CodeBlockEnhanced.configure({ lowlight }),
      // T-011: LaTeX 公式渲染（行内 $...$、块级 $$...$$，KaTeX 后端）
      Mathematics,
      Typography,
      TableWithMarkdown.configure({
        resizable: true,
        HTMLAttributes: { class: "tiptap-table" },
      }),
      TableRow,
      TableCell,
      TableHeader,
      TextAlign.configure({
        types: ["heading", "paragraph"],
      }),
      FigureImage.configure({
        inline: false,
        minWidth: 50,
        maxWidth: 1200,
      }),
      VideoNode,
      VideoTimestamp,
      Callout,
      Toggle,
      ToggleSummary,
      ToggleContent,
      WikiLinkDecoration.configure({
        onClick: (title: string) => wikiClickRef.current?.(title),
      }),
      WikiLinkSuggestion,
      // Markdown 序列化/反序列化：setContent 吃 Markdown，editor.storage.markdown.getMarkdown() 吐 Markdown
      Markdown.configure({
        html: true,               // 允许内联 HTML 片段（表格等复杂结构）
        tightLists: true,         // 紧凑列表
        bulletListMarker: "-",
        linkify: true,
        breaks: false,
        transformPastedText: true,
        transformCopiedText: false,
      }),
      // 必须放在 Markdown 之后：onBeforeCreate 时依赖 markdown.parser 已初始化
      AllowFileLink,
    ],
    content,
    onCreate: ({ editor }) => {
      // T-011: 初始内容里如果含 $..$ / $$..$$ 字面量，编辑器创建后立即升级为 math 节点
      // 用自定义 migrate 而非官方 `migrateMathStrings`：官方只处理单行 $..$ 且会
      // 错误捕获 $$..$$，参见 migrateOpenMathStrings 文档
      try {
        migrateOpenMathStrings(editor);
      } catch (e) {
        console.warn("[math] initial migrate failed:", e);
      }
      // 给老的没有 id 的 video 节点补 ID（时间戳跳转依赖此 ID 定位视频）
      try {
        backfillVideoIds(editor);
      } catch (e) {
        console.warn("[video] backfill ids failed:", e);
      }
    },
    onUpdate: ({ editor }) => {
      if (isExternalUpdate.current) return;
      pendingEditorRef.current = editor;
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        const pending = pendingEditorRef.current;
        if (pending) {
          pendingEditorRef.current = null;
          onChangeRef.current(getEditorMarkdown(pending));
        }
      }, 300);
    },
    onBlur: () => {
      // 失焦立即 flush，避免用户切走 / 点击保存后读到 300ms 之内的旧内容
      flushNow();
    },
    editorProps: {
      handlePaste: (_view, event) => {
        // 三种主要场景：
        //   A. 浏览器复制图片：剪贴板同时有 text/html (<meta><img src=https://...>)
        //      和 image/png bytes。直接走默认 HTML 路径会渲染远程 src（Tauri WebView
        //      加载失败 → 破图）；要优先保存 bytes 到本地。
        //   B. Excel/Word/WPS 复制单元格：剪贴板同时有 HTML（<table>...）和 image/png
        //      （表格位图截图）。要保留 HTML 让 Tiptap Table 接住，不能走图片分支。
        //   C. 系统截图工具（如 Snipaste）：纯 image/png 无文本。直接图片分支。
        //
        // 区分 A vs B 的启发式：HTML strip 掉所有 <img> 后剩余文本/标签是否仍有"实质"内容
        const dt = event.clipboardData;
        const types = Array.from(dt?.types ?? []);
        const hasText = types.includes("text/html") || types.includes("text/plain");
        const html = dt?.getData("text/html") ?? "";

        // 视频永远优先（视频文件不会和富文本混合）
        const videos = collectVideoFiles(dt);
        if (videos.length > 0) {
          handleVideoFiles(videos, editor, VIDEO_MAX_PASTE_BYTES);
          return true;
        }

        const images = collectImageFiles(dt);
        if (images.length > 0) {
          // 场景 C：纯图片
          if (!hasText) {
            handleImageFiles(images, editor);
            return true;
          }
          // 场景 A：HTML 实际只是包裹一个/多个 img（浏览器复制图片）
          if (isImageOnlyHtml(html)) {
            handleImageFiles(images, editor);
            return true;
          }
          // 场景 B：富文本 + 图片（Excel 表格等）→ 让 ProseMirror 走 HTML 路径
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const videos = collectVideoFiles(event.dataTransfer);
        if (videos.length > 0) {
          event.preventDefault();
          handleVideoFiles(videos, editor, VIDEO_MAX_DROP_BYTES);
          return true;
        }
        const images = collectImageFiles(event.dataTransfer);
        if (images.length > 0) {
          event.preventDefault();
          handleImageFiles(images, editor);
          return true;
        }
        const texts = collectTextFiles(event.dataTransfer);
        if (texts.length > 0) {
          event.preventDefault();
          handleTextFiles(texts, editor);
          return true;
        }
        const { files: attachments, blocked } = collectAttachmentFiles(
          event.dataTransfer,
        );
        if (blocked.length > 0) {
          message.warning(
            `已拦截 ${blocked.length} 个可执行/脚本文件（禁止作为附件）`,
          );
        }
        if (attachments.length > 0) {
          event.preventDefault();
          handleAttachmentFiles(attachments, editor);
          return true;
        }
        return false;
      },
    },
  });

  // 加密笔记图片渲染拦截：editor 里 <img> 的 src 形如 asset://.../xxx.png.enc，
  // 浏览器直接走 asset 协议拿到的是密文，img 显示 broken。这里用 MutationObserver
  // 监视 editor DOM，发现 src 路径以 .enc 结尾的就 invoke get_image_blob 拿明文 bytes，
  // 转 blob URL 替换 img.src。attrs.src 不动（保持 markdown 序列化稳定）。
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom as HTMLElement;
    // 单 editor 实例内复用 blob URL，避免重复 invoke + 重复创建
    const blobCache = new Map<string, string>();

    /** 从 asset URL（含 URL 编码）中还原出 .enc 文件的本地路径；非 .enc 返回 null */
    const extractEncPath = (src: string): string | null => {
      if (!src) return null;
      // 去掉 asset 协议前缀，剩下的是 URL 编码的路径
      let encoded = src;
      if (encoded.startsWith("http://asset.localhost/")) {
        encoded = encoded.slice("http://asset.localhost/".length);
      } else if (encoded.startsWith("asset://localhost/")) {
        encoded = encoded.slice("asset://localhost/".length);
      } else if (encoded.startsWith("blob:")) {
        return null; // 已经是 blob URL，跳过
      } else {
        return null; // 非 asset 协议（外链 / data: 等）
      }
      let decoded: string;
      try {
        decoded = decodeURIComponent(encoded);
      } catch {
        return null;
      }
      return decoded.endsWith(".enc") ? decoded : null;
    };

    const processImg = async (img: HTMLImageElement) => {
      const path = extractEncPath(img.getAttribute("src") ?? "");
      if (!path) return;
      const cached = blobCache.get(path);
      if (cached) {
        if (img.src !== cached) img.src = cached;
        return;
      }
      try {
        const bytes = await imageApi.getBlob(path);
        const blob = new Blob([bytes as BlobPart]);
        const url = URL.createObjectURL(blob);
        blobCache.set(path, url);
        img.src = url;
      } catch (e) {
        // vault 锁定 / 文件丢失 → 静默；用户在 UI 上能看到 broken img + 锁图标提示
        console.warn("[encrypted-image] 解密失败:", path, e);
      }
    };

    // 初始化：先扫一遍现有 img
    dom.querySelectorAll("img").forEach((img) => {
      void processImg(img as HTMLImageElement);
    });

    // 持续观察：粘贴 / 拖放新图后 DOM 节点插入会触发
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "childList") {
          m.addedNodes.forEach((node) => {
            if (node instanceof HTMLImageElement) {
              void processImg(node);
            } else if (node instanceof HTMLElement) {
              node.querySelectorAll("img").forEach((img) => {
                void processImg(img as HTMLImageElement);
              });
            }
          });
        } else if (
          m.type === "attributes" &&
          m.attributeName === "src" &&
          m.target instanceof HTMLImageElement
        ) {
          void processImg(m.target);
        }
      }
    });
    observer.observe(dom, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });

    return () => {
      observer.disconnect();
      // 释放 blob URL 防内存泄漏
      blobCache.forEach((url) => URL.revokeObjectURL(url));
      blobCache.clear();
    };
  }, [editor]);

  // 拦截编辑器内链接点击 → 分发给系统对应程序：
  //   file:// / 本地绝对路径 → openPath（系统默认程序打开 PDF/DOC/视频等）
  //   http(s) / mailto      → openUrl（系统默认浏览器/邮箱）
  //
  // SafeLink 把 link mark 渲染成 <span data-href="..." role="link"> 而非 <a>，
  // 完全避开 Tauri WebView 对 anchor 的 navigation 旁路（tauri-apps/tauri#2791）。
  // 这里通过 [data-href] 选择器拿到真实 URL 再分发。
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom as HTMLElement;
    const handler = (ev: MouseEvent) => {
      if (ev.type === "auxclick" && ev.button !== 1) return;
      const target = ev.target as HTMLElement | null;
      // 优先 SafeLink 渲染的 [data-href]；兜底 anchor[href]（兼容旧节点 / wikilink）
      const linkEl = target?.closest("[data-href], a[href]") as HTMLElement | null;
      if (!linkEl) return;
      const href =
        linkEl.getAttribute("data-href") || linkEl.getAttribute("href") || "";
      if (!href || href.startsWith("#") || href === "javascript:void(0)") return;

      ev.preventDefault();
      ev.stopPropagation();

      if (href.startsWith("file://")) {
        const path = fileUrlToPath(href);
        void openPath(path).catch((e) => {
          message.error(`打开附件失败: ${e}`);
        });
      } else if (/^https?:\/\//i.test(href) || href.startsWith("mailto:") || href.startsWith("tel:")) {
        void openUrl(href).catch((e) => {
          message.error(`打开链接失败: ${e}`);
        });
      } else {
        void openPath(href).catch((e) => {
          message.error(`打开失败: ${e}`);
        });
      }
    };
    dom.addEventListener("click", handler, true);
    dom.addEventListener("auxclick", handler, true);
    return () => {
      dom.removeEventListener("click", handler, true);
      dom.removeEventListener("auxclick", handler, true);
    };
  }, [editor]);

  // 外部 content 变化时同步（如初次加载）
  useEffect(() => {
    if (!editor) return;
    const current = getEditorMarkdown(editor);
    if (content !== current) {
      isExternalUpdate.current = true;
      editor.commands.setContent(content, { emitUpdate: false });
      // T-011: 把刚 setContent 进来的 markdown 里的 $..$ / $$..$$ 升级成 math 节点
      // tiptap-markdown 解析后是普通文本，自定义 migrate 同时处理行内 + 多行块级
      try {
        migrateOpenMathStrings(editor);
      } catch (e) {
        console.warn("[math] migrate failed:", e);
      }
      isExternalUpdate.current = false;
    }
  }, [content, editor]);

  // unmount 时强制 flush 防抖中的最后一次编辑，避免切 tab / 跳转时丢失末尾未传给父组件的内容
  useEffect(() => {
    return () => {
      flushNow();
    };
  }, [flushNow]);

  const { token } = antdTheme.useToken();

  // 编辑器统计信息：打字时不实时算，停顿 300ms 后再遍历整篇。
  // 算法与右上角 EditorStats 共用 src/lib/textStats.ts，确保两处数字永远一致。
  const [stats, setStats] = useState({ chars: 0, words: 0, readingTime: "< 1 min" });
  useEffect(() => {
    if (!editor) {
      setStats({ chars: 0, words: 0, readingTime: "< 1 min" });
      return;
    }
    const timer = setTimeout(() => {
      const s = calcEditorStats(editor);
      setStats({
        chars: s.chars,
        words: s.words,
        readingTime: `${s.readMinutes} min`,
      });
    }, 300);
    return () => clearTimeout(timer);
    // 依赖 content prop：父组件在 onChange 后会更新 content，
    // 这反过来表示编辑器内容刚刚变过，此时触发一次 debounced 重算即可。
  }, [editor, content]);

  // 上抛 editor 实例给父组件（外挂大纲面板、调试用），unmount 时传 null 让父侧能解绑
  useEffect(() => {
    if (!onEditorReady) return;
    onEditorReady(editor);
    return () => onEditorReady(null);
  }, [editor, onEditorReady]);

  if (!editor) return null;

  return (
    <div className="tiptap-wrapper" style={{ position: "relative" }}>
      <EditorToolbar editor={editor} noteId={noteId} ensureNoteId={ensureNoteId} />
      <EditorContent editor={editor} className="tiptap-content" />
      {/* 「问 AI 这段」与续写/总结/改写等工具按钮共享同一个浮动菜单：
          AiWriteMenu 接 onAskAi prop 后会在按钮行最前面渲染蓝色 CTA，
          整个菜单跟随鼠标位置出现，零重叠，无需独立定位逻辑 */}
      <AiWriteMenu editor={editor} onAskAi={onAskAi} />
      <div
        className="flex items-center gap-4 px-3 pt-4 pb-3 text-xs"
        style={{ color: token.colorTextTertiary }}
      >
        <span>{stats.words} 字</span>
        <span>{stats.chars} 字符</span>
        <span>{stats.readingTime} 阅读</span>
      </div>
    </div>
  );
}
