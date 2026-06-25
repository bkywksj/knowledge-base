/**
 * R-005b 「所见即所得」打印 / 打印成 PDF。
 *
 * 背景：旧的「导出 PDF」(exportApi.renderHtmlForPdf) 走的是
 *   markdown 源码 → Rust pulldown-cmark 重新渲染 → 另一套极简 CSS 模板
 * 的第二条管线，结构和样式都跟编辑器里看到的不一样（callout / 分栏 / 自定义标题样式 /
 * 字体行距全变），所以「导出后排版没有可视的好看」。
 *
 * 本模块改走第一性路线：直接克隆编辑器**已经渲染好的真实 DOM**（ProseMirror 节点，
 * 含 callout / 分栏 / figure / mermaid SVG 等），再注入应用**同一份 CSS**，本地资源经
 * Rust 内嵌成 base64 —— 打印出来就是屏幕上看到的样子。CSS 只有一份来源（应用自身），
 * 不存在「导出模板 CSS」与「编辑器 CSS」两份要同步维护的问题。
 *
 * 流程：
 *   1. 克隆 editor.view.dom（真实渲染 DOM）
 *   2. 顶部插入笔记标题（标题是编辑器外的独立字段，打印文档需要它当大标题）
 *   3. 剥掉编辑态控件（节点视图工具栏 / 光标小部件等）
 *   4. 图片固化为 base64：实时 DOM 的 img.src 已是 http://asset.localhost/… 或 blob:…，
 *      在主文档 fetch → dataURL，保证打印 iframe 自包含（blob: 跨不进 iframe，必须固化）
 *   5. Rust inlineNoteHtmlAssets 兜底：内嵌残留的 kb-asset://（如附件 <a href>）
 *   6. 收集当前文档全部可读 CSS → 一段 <style>（应用唯一样式源），再叠打印专用 <style>：
 *      @page 页边距 + 强制浅色文字变量（深色主题也不白底白字）+ 隐藏编辑控件 +
 *      解除滚动容器固定高 + 分页避免截断
 *   7. 交给 printHtmlAsPdf → 系统打印对话框（可选真实打印机出纸，或「另存为 PDF」）
 */

import type { Editor } from "@tiptap/react";
import { exportApi } from "@/lib/api";
import { printHtmlAsPdf } from "@/lib/exportPdf";

/**
 * 打印（或打印成 PDF）当前编辑器内容，所见即所得。
 *
 * @param editor Tiptap 编辑器实例（来自 TiptapEditor 的 onEditorReady）
 * @param title  笔记标题，作为打印文档大标题 + 打印对话框默认文件名
 */
export async function printEditorContent(editor: Editor, title: string): Promise<void> {
  // 1. 克隆真实渲染 DOM（.tiptap.ProseMirror 节点）
  const sourceDom = editor.view.dom as HTMLElement;
  const clone = sourceDom.cloneNode(true) as HTMLElement;

  // 2. 顶部插入标题（用 .tiptap h1 同款样式：作为 .tiptap 的首个子节点即可命中）
  const safeTitle = escapeHtml(title.trim() || "未命名");
  clone.insertAdjacentHTML("afterbegin", `<h1 class="kb-print-title">${safeTitle}</h1>`);

  // 3. 剥掉编辑态专属、不参与排版的交互元素（CSS 兜底之外再做一层 DOM 清理）
  stripEditingArtifacts(clone);

  // 4. 图片固化为 base64。编辑器实时 DOM 的 <img src> 已被替换成**可显示 URL**：
  //    普通图 http://asset.localhost/…、加密图 blob:…。这些只在主文档上下文有效
  //    （blob: 尤其跨不进 iframe），打印 iframe 要自包含，必须在主文档里 fetch 固化。
  await inlineImages(clone);

  // 5. 包到 .editor-content-area 链下，命中应用里 `.editor-content-area .tiptap …` 的样式
  const wrapped =
    `<div class="editor-content-area">` +
    `<div class="tiptap-wrapper">` +
    `<div class="tiptap-content">${clone.outerHTML}</div>` +
    `</div></div>`;

  // 6. Rust 兜底：内嵌任何残留的 kb-asset:// 本地资源（如附件 <a href> —— DOM 里不会被
  //    前面的 img 固化覆盖到）。图片已是 data: URL，Rust 的 inline_images 会自动跳过不重复。
  let body = wrapped;
  try {
    body = await exportApi.inlineNoteHtmlAssets(wrapped);
  } catch {
    /* ignore：内嵌失败不阻断打印 */
  }

  // 7. 收集应用 CSS + 打印覆盖样式，拼成完整文档
  const appCss = collectDocumentCss();
  const html = buildPrintDocument(safeTitle, appCss, body);

  await printHtmlAsPdf(html, title.trim() || "未命名");
}

/**
 * 把 DOM 里的 `<img>` 逐个固化成 base64 data URL。
 *
 * 编辑器实时 DOM 的 `img.src` 已是可显示 URL（http://asset.localhost/… 或 blob:…），
 * 在主文档上下文里 `fetch` 取字节再转 dataURL —— blob: 在同文档 fetch 有效，
 * asset 协议若允许跨域 fetch 也能取到。任一失败就保留原 src：http://asset.localhost
 * 这类在同一 WebView 的 iframe 里通常仍能作为 `<img>` 直接加载，graceful 降级。
 */
async function inlineImages(root: HTMLElement): Promise<void> {
  const imgs = Array.from(root.querySelectorAll("img"));
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute("src") || "";
      if (!src || src.startsWith("data:")) return;
      try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const dataUrl = await blobToDataUrl(blob);
        img.setAttribute("src", dataUrl);
      } catch {
        /* 保留原 src */
      }
    }),
  );
}

/** Blob → data: URL（FileReader.readAsDataURL） */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** 移除编辑态专属元素：节点视图工具栏、ProseMirror 占位/光标小部件等 */
function stripEditingArtifacts(root: HTMLElement): void {
  const selectors = [
    ".tiptap-toolbar", // 格式工具栏（理论上不在 view.dom 内，保险起见）
    ".kb-ai-bar", // 划词 AI 浮条
    ".tiptap-video-toolbar", // 视频节点的播放/加时间戳控制条
    ".ProseMirror-gapcursor", // 块间空隙光标
    ".ProseMirror-separator", // 零宽分隔符
    "[data-node-view-toolbar]", // 通用节点视图工具栏约定
  ];
  root.querySelectorAll(selectors.join(",")).forEach((el) => el.remove());
  // 去掉 contenteditable 标记，避免某些内核在打印时渲染编辑边框
  root.querySelectorAll("[contenteditable]").forEach((el) => {
    el.removeAttribute("contenteditable");
  });
}

/**
 * 收集当前文档全部**可读**的 CSS 规则，拼成一段 cssText。
 *
 * 直接读 document.styleSheets 覆盖 <style>（含 antd cssinjs 注入、Tailwind、应用 global.css）
 * 与同源 <link>。跨域样式表（如 CDN 字体）读 cssRules 会抛 SecurityError，跳过即可。
 */
function collectDocumentCss(): string {
  let css = "";
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // 跨域样式表，读不到，跳过
    }
    if (!rules) continue;
    for (const rule of Array.from(rules)) {
      css += rule.cssText + "\n";
    }
  }
  return css;
}

/** 拼装完整打印文档 */
function buildPrintDocument(safeTitle: string, appCss: string, body: string): string {
  return (
    `<!DOCTYPE html>\n` +
    `<html lang="zh-CN">\n` +
    `<head>\n` +
    `<meta charset="utf-8" />\n` +
    `<title>${safeTitle}</title>\n` +
    `<style>${appCss}</style>\n` +
    `<style>${PRINT_OVERRIDE_CSS}</style>\n` +
    `</head>\n` +
    `<body>\n${body}\n</body>\n` +
    `</html>`
  );
}

/**
 * 打印专用覆盖样式（放在应用 CSS 之后，同特异性后者胜）。
 *
 * 关键点：
 * - 用 :root 重定义 antd 文字 / 边框变量为浅色。编辑器正文色都是 `var(--ant-color-text, …)`，
 *   深色主题下该变量是浅色 → 白底打印会「白底白字」。这里强制浅色，且**不加 !important**，
 *   所以用户给文字设的行内颜色（textStyle color 标记）仍然优先，不被覆盖。
 * - 不设置 data-theme / data-editor-rule 等属性 → 深色主题背景、纸张横线纹理等自动不生效，打印干净。
 * - 解除编辑器的 flex / 固定高 / 滚动容器，让长文在打印时自然跨页流动。
 */
const PRINT_OVERRIDE_CSS = `
:root {
  --ant-color-text: rgba(0, 0, 0, 0.88);
  --ant-color-text-secondary: rgba(0, 0, 0, 0.65);
  --ant-color-text-tertiary: rgba(0, 0, 0, 0.45);
  --ant-color-text-quaternary: rgba(0, 0, 0, 0.25);
  --ant-color-bg-container: #ffffff;
  --ant-color-bg-layout: #ffffff;
  --ant-color-border: #d9d9d9;
  --ant-color-border-secondary: #f0f0f0;
}

@page { margin: 16mm 14mm; }

/* ⚠ 打印只出一页的真正根因修复：collectDocumentCss() 会把应用壳层的
   \`html, body, #root { height:100%; overflow:hidden }\`（global.css）原样注入打印文档，
   把打印 body 锁成一屏高 + 溢出隐藏 → 超出第一页的内容全被裁掉。这里强制解除，
   让打印文档按内容自然全高展开，分页才能跨页。*/
html, body, #root {
  width: auto !important;
  height: auto !important;
  min-height: 0 !important;
  max-height: none !important;
  margin: 0;
  padding: 0;
  overflow: visible !important;
  background: #ffffff;
}

/* 解除编辑器在屏幕上的 flex 撑满 / 滚动容器 / 边框，改为自然块流，便于跨页 */
.editor-content-area,
.editor-content-area .tiptap-wrapper,
.editor-content-area .tiptap-content,
.editor-content-area .tiptap-content .tiptap,
.tiptap {
  display: block !important;
  height: auto !important;
  max-height: none !important;
  min-height: 0 !important;
  overflow: visible !important;
  border: none !important;
  background: transparent !important;
}

.tiptap { padding: 0 !important; caret-color: transparent !important; }

/* 顶部插入的笔记标题：与正文 h1 一致，并强制顶部不留多余空白 */
.tiptap .kb-print-title { margin-top: 0 !important; }

/* 隐藏一切编辑态控件 */
.tiptap-toolbar,
.kb-ai-bar,
.tiptap-video-toolbar,
.ProseMirror-gapcursor,
.ProseMirror-separator,
[data-node-view-toolbar] {
  display: none !important;
}

img { max-width: 100% !important; height: auto !important; }

@media print {
  /* 打印态再兜一层：确保 html/body/#root 全高展开、不裁溢出（防内核在 print 阶段重套媒体规则） */
  html, body, #root {
    height: auto !important;
    max-height: none !important;
    overflow: visible !important;
  }
  /* 标题不与紧随其后的正文分页割裂；图片 / 表格 / 代码块 / 引用 / callout 尽量不被截断 */
  h1, h2, h3, h4, h5, h6 { break-after: avoid; page-break-after: avoid; }
  img, table, pre, blockquote, figure,
  .tiptap-callout, .tiptap-figure, .tiptap-columns {
    break-inside: avoid;
    page-break-inside: avoid;
  }
  /* 打印时链接去掉蓝色 + 下划线，跟随正文色更像正式文档 */
  a { color: inherit !important; text-decoration: none !important; }
}
`;

/** 转义 HTML 特殊字符（标题来自用户输入） */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
