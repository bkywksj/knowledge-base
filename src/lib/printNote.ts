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
 *   5. 附件链接内嵌：把本地 <a href> 的 URL 清单交给 Rust，换回 data: URL 后本地回填
 *   6. 收集当前文档全部可读 CSS → 一段 <style>（应用唯一样式源），再叠打印专用 <style>：
 *      @page 页边距 + 强制浅色文字变量（深色主题也不白底白字）+ 隐藏编辑控件 +
 *      解除滚动容器固定高 + 分页避免截断
 *   7. 交给 printHtmlAsPdf → 系统打印对话框（可选真实打印机出纸，或「另存为 PDF」）
 *
 * ⚠️ 大文档性能（这里每一条都是踩过的坑，改动前先读）：
 *   · 第 5 步曾经是"把整篇 HTML 送去 Rust 再整篇拿回来"（inlineNoteHtmlAssets）。
 *     此时图片已在第 4 步内嵌成 base64，20 张 2MB 图就是 ~53MB 字符串——一趟 IPC
 *     等于两次巨型 JSON 序列化 + Rust 全文正则扫两遍，而真正要做的只是替换几个附件
 *     链接。现已改为只传 URL 清单（见 inlineAttachmentLinks）。
 *   · 第 4 步的图片固化必须限并发：Promise.all 一把梭会让 N 份 Blob + N 份膨胀 33%
 *     的 base64 同时驻留内存。
 *   · 内嵌总量有上限：超过 MAX_INLINE_TOTAL_BYTES 后剩余图片保留原 URL 不再内嵌
 *     （应用内 asset:// 仍能显示，导出物可能缺图，但不会把内存顶爆）。
 */

import type { Editor } from "@tiptap/react";
import { exportApi } from "@/lib/api";
import { printHtmlAsPdf } from "@/lib/exportPdf";

/** 图片固化的并发上限：太大则内存峰值失控，太小则串行等待久 */
const IMAGE_CONCURRENCY = 4;
/** 单张图片内嵌上限，超过则保留原 URL（12 MiB 已远超正常截图/照片） */
const MAX_SINGLE_IMAGE_BYTES = 12 * 1024 * 1024;
/** 本次内嵌的总量上限，超过后剩余资源一律不再内嵌（base64 后约 1.33 倍） */
const MAX_INLINE_TOTAL_BYTES = 48 * 1024 * 1024;

/** 自包含化过程的进度回报，供调用方更新 loading 文案 */
export interface SelfContainedProgress {
  phase: "images" | "attachments" | "done";
  /** 当前处理到第几个（phase=done 时为已内嵌总数） */
  current: number;
  /** 总数 */
  total: number;
  /** 因体积上限被跳过、保留原 URL 的资源数（phase=done 时有效） */
  skipped?: number;
}

/**
 * 把编辑器当前渲染结果转成**自包含 HTML 片段**（图片/附件已内嵌 base64）。
 *
 * 打印、复制为 Word、导出 HTML / Word 四条路都走这里 —— 它们要的东西是同一个：
 * 「屏幕上看到的样子，且脱离本应用也能正常显示」。
 *
 * 关键在于取的是**编辑器真实 DOM**而不是 markdown 源码：标题自动编号是
 * ProseMirror 的 widget decoration，只活在 DOM 里、不写进 doc / .md —— 后端拿
 * markdown 重渲染永远看不到它（用户反馈"导出 html、word 时无编号"就是这么来的）。
 *
 * @param editor     Tiptap 编辑器实例
 * @param title      笔记标题；作为文档大标题插到最前
 * @param titleClass 大标题的 class（打印要 kb-print-title 压掉顶部空白，其它场景不需要）
 * @param onProgress 可选进度回调；大笔记内嵌资源要几秒到几十秒，调用方据此更新提示，
 *                   免得用户以为卡死
 */
export async function editorDomToSelfContainedHtml(
  editor: Editor,
  title: string,
  titleClass = "",
  onProgress?: (p: SelfContainedProgress) => void,
): Promise<string> {
  // 1. 克隆真实渲染 DOM（.tiptap.ProseMirror 节点，含 callout / 分栏 / 编号 widget）
  const clone = (editor.view.dom as HTMLElement).cloneNode(true) as HTMLElement;

  // 2. 顶部插入标题（作为 .tiptap 的首个子节点，命中 .tiptap h1 同款样式）
  const safeTitle = escapeHtml(title.trim() || "未命名");
  const cls = titleClass ? ` class="${titleClass}"` : "";
  clone.insertAdjacentHTML("afterbegin", `<h1${cls}>${safeTitle}</h1>`);

  // 3. 剥掉编辑态专属、不参与排版的交互元素（含末尾的 ProseMirror 空段落）
  stripEditingArtifacts(clone);

  // 3.5 标记首/末块，让导出模板把它们的外边距归零。
  //     Word / WPS 会把 CSS margin 翻译成段落「段前/段后间距」，首个 h1 的
  //     margin-top 就成了正文上方一段消不掉的空白（用户反馈的首行/末行空白）。
  markFirstLastBlocks(clone);

  // 4. 图片固化为 base64。实时 DOM 的 <img src> 是 http://asset.localhost/… 或 blob:…，
  //    只在主文档上下文有效（blob: 尤其跨不进 iframe），必须在主文档里 fetch 固化。
  const imgStat = await inlineImages(clone, onProgress);

  // 5. 附件链接内嵌：<a href="kb-asset://…"> 这类本地资源 img 固化覆盖不到，
  //    交给 Rust 解析成 data: URL —— 只传 URL 清单，不再把整篇文档搬去搬回。
  const attStat = await inlineAttachmentLinks(
    clone,
    MAX_INLINE_TOTAL_BYTES - imgStat.bytes,
    onProgress,
  );

  onProgress?.({
    phase: "done",
    current: imgStat.inlined + attStat.inlined,
    total: imgStat.total + attStat.total,
    skipped: imgStat.skipped + attStat.skipped,
  });

  // 6. 包到 .editor-content-area 链下，命中 `.editor-content-area .tiptap …` 的样式
  return (
    `<div class="editor-content-area">` +
    `<div class="tiptap-wrapper">` +
    `<div class="tiptap-content">${clone.outerHTML}</div>` +
    `</div></div>`
  );
}

/**
 * 打印（或打印成 PDF）当前编辑器内容，所见即所得。
 *
 * @param editor     Tiptap 编辑器实例（来自 TiptapEditor 的 onEditorReady）
 * @param title      笔记标题，作为打印文档大标题 + 打印对话框默认文件名
 * @param onProgress 可选进度回调，图多的笔记内嵌阶段会走几秒到几十秒
 */
export async function printEditorContent(
  editor: Editor,
  title: string,
  onProgress?: (p: SelfContainedProgress) => void,
): Promise<void> {
  // kb-print-title 让顶部标题不留多余空白
  const body = await editorDomToSelfContainedHtml(
    editor,
    title,
    "kb-print-title",
    onProgress,
  );

  // 收集应用 CSS + 打印覆盖样式，拼成完整文档
  const appCss = collectDocumentCss();
  const html = buildPrintDocument(escapeHtml(title.trim() || "未命名"), appCss, body);

  await printHtmlAsPdf(html, title.trim() || "未命名");
}

/**
 * #12「复制为 Word」：把编辑器当前内容复制成**富文本**写入剪贴板，
 * 直接粘进 Word / WPS / 邮件等富文本编辑器即所见即所得，不再出现“大量空行 / 排版乱”
 *（旧的 Ctrl+C 走 Markdown 文本，块间 \n\n 被 Word 当成一个个空段落）。
 *
 * 复用打印同款管线：克隆编辑器真实 DOM → 剥编辑态控件 → 图片固化 base64
 * → Rust 内嵌残留本地资源 → 作为 text/html 写剪贴板（同时附 text/plain 兜底）。
 */
export async function copyEditorContentForWord(
  editor: Editor,
  title: string,
): Promise<void> {
  const html = await editorDomToSelfContainedHtml(editor, title);

  // text/plain 用单换行分隔块，避免 Word 把 Markdown 的 \n\n 当成空段落
  const plain = editor.getText({ blockSeparator: "\n" });
  await writeRichTextToClipboard(html, plain);
}

/** 富文本写剪贴板：优先 ClipboardItem(text/html + text/plain)，不支持则降级写纯文本。 */
async function writeRichTextToClipboard(
  html: string,
  plain: string,
): Promise<void> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plain], { type: "text/plain" }),
      }),
    ]);
    return;
  }
  // 极端降级：非安全上下文下 navigator.clipboard 可能整体缺失，判空避免 TypeError
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(plain);
  } else {
    throw new Error("当前环境不支持剪贴板写入");
  }
}

/** 一轮内嵌的统计 */
interface InlineStat {
  /** 需要处理的总数 */
  total: number;
  /** 成功内嵌数 */
  inlined: number;
  /** 因体积上限 / 失败而保留原 URL 的数量 */
  skipped: number;
  /** 已内嵌的原始字节数（未计 base64 膨胀） */
  bytes: number;
}

/**
 * 把 DOM 里的 `<img>` 固化成 base64 data URL。
 *
 * 编辑器实时 DOM 的 `img.src` 已是可显示 URL（http://asset.localhost/… 或 blob:…），
 * 在主文档上下文里 `fetch` 取字节再转 dataURL —— blob: 在同文档 fetch 有效，
 * asset 协议若允许跨域 fetch 也能取到。任一失败就保留原 src：http://asset.localhost
 * 这类在同一 WebView 的 iframe 里通常仍能作为 `<img>` 直接加载，graceful 降级。
 *
 * **限并发 + 限总量**：原实现 `Promise.all` 一把梭，N 张图同时 fetch，内存里同时
 * 驻留 N 份 Blob 和 N 份膨胀 33% 的 base64 —— 20 张 2MB 图瞬时就能顶到 100MB+。
 * 现在按 IMAGE_CONCURRENCY 分批，并在累计超过 budget 后停止内嵌剩余图片。
 */
async function inlineImages(
  root: HTMLElement,
  onProgress?: (p: SelfContainedProgress) => void,
): Promise<InlineStat> {
  const imgs = Array.from(root.querySelectorAll("img")).filter((img) => {
    const src = img.getAttribute("src") || "";
    return !!src && !src.startsWith("data:");
  });
  const stat: InlineStat = { total: imgs.length, inlined: 0, skipped: 0, bytes: 0 };
  if (imgs.length === 0) return stat;

  let done = 0;
  await mapWithConcurrency(imgs, IMAGE_CONCURRENCY, async (img) => {
    // 预算已用尽：剩下的一律保留原 src（应用内仍能显示）
    if (stat.bytes >= MAX_INLINE_TOTAL_BYTES) {
      stat.skipped++;
    } else {
      try {
        const resp = await fetch(img.getAttribute("src") || "");
        const blob = await resp.blob();
        if (blob.size > MAX_SINGLE_IMAGE_BYTES) {
          stat.skipped++;
        } else {
          img.setAttribute("src", await blobToDataUrl(blob));
          stat.inlined++;
          stat.bytes += blob.size;
        }
      } catch {
        stat.skipped++; // 保留原 src
      }
    }
    done++;
    onProgress?.({ phase: "images", current: done, total: imgs.length });
  });
  return stat;
}

/**
 * 把本地附件链接 `<a href>` 换成 data: URL。
 *
 * 只把 **URL 清单**交给 Rust，拿回 data: URL 后在本地 DOM 上回填 —— 而不是把整篇
 * （图片已内嵌、动辄几十 MB 的）HTML 送过去再拿回来。后者一趟 IPC 就是两次巨型
 * JSON 序列化加 Rust 全文正则，是大笔记打印卡死的头号原因。
 *
 * `budget` 是本次还能内嵌多少字节（图片已经吃掉一部分）；≤0 时直接跳过，全部保留原链接。
 */
async function inlineAttachmentLinks(
  root: HTMLElement,
  budget: number,
  onProgress?: (p: SelfContainedProgress) => void,
): Promise<InlineStat> {
  const anchors = Array.from(root.querySelectorAll("a[href]")).filter((a) =>
    isLocalAssetUrl(a.getAttribute("href") || ""),
  );
  const stat: InlineStat = { total: anchors.length, inlined: 0, skipped: 0, bytes: 0 };
  if (anchors.length === 0) return stat;
  if (budget <= 0) {
    stat.skipped = anchors.length;
    return stat;
  }

  // 同一个附件可能被链接多次，去重后只解析一遍
  const urls = Array.from(
    new Set(anchors.map((a) => a.getAttribute("href") || "")),
  );
  onProgress?.({ phase: "attachments", current: 0, total: urls.length });

  try {
    const resolved = await exportApi.resolveAssetDataUrls(
      urls,
      Math.min(budget, MAX_SINGLE_IMAGE_BYTES * 4),
    );
    const map = new Map(resolved.map((r) => [r.url, r]));
    for (const a of anchors) {
      const hit = map.get(a.getAttribute("href") || "");
      if (hit?.dataUrl) {
        a.setAttribute("href", hit.dataUrl);
        if (hit.fileName) a.setAttribute("download", hit.fileName);
        stat.inlined++;
      } else {
        stat.skipped++; // 保留原链接：应用内可点，导出物里失效
      }
    }
    onProgress?.({ phase: "attachments", current: urls.length, total: urls.length });
  } catch {
    // 内嵌失败不阻断打印：结构和文字都正常，只是附件链接指向本地
    stat.skipped = anchors.length;
  }
  return stat;
}

/**
 * 这个 URL 是否指向本应用的本地资源（需要内嵌）。
 *
 * 判定与 Rust 侧 `asset_path::resolve_content_url` 对齐：注意
 * `http://asset.localhost/…` 虽然是 http 开头，却是**本地资源**，不能按外链排除。
 *
 * 导出仅为单测覆盖这条判定（漏判会把外链也送去 Rust，误判会让附件内嵌不上）。
 */
export function isLocalAssetUrl(href: string): boolean {
  const u = href.trim();
  if (!u) return false;
  if (
    u.startsWith("data:") ||
    u.startsWith("blob:") ||
    u.startsWith("#") ||
    u.startsWith("mailto:") ||
    u.startsWith("tel:")
  ) {
    return false;
  }
  if (/^https?:\/\//i.test(u)) return /^https?:\/\/asset\.localhost\//i.test(u);
  return true; // kb-asset:// / asset:// / file:// / 裸路径
}

/**
 * 按固定并发跑一批异步任务。
 * 不引第三方库：就一个取号循环，N 个 worker 各自领任务，天然限流。
 *
 * 导出仅为单测验证"并发确实被限住、且每个任务都跑到了"。
 */
export async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
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
  stripTrailingEmptyBlocks(root);
}

/**
 * 剥掉正文末尾的空块。
 *
 * ProseMirror 为了让光标能停在文档最后，总在末尾留一个空段落
 *（内容只有 `<br class="ProseMirror-trailingBreak">`），用户按回车留下的空行也一样。
 * 编辑时它是必要的落点，导出后就是纯粹的多余空白 —— Word 里表现为末行下方
 * 一段删不掉的留白（文档最后一个段落标记本来就删不掉，用户只能改字号硬藏）。
 *
 * 只清「完全没有可见内容」的块：带 img / 表格 / 分隔线 / 自定义节点的一律保留，
 * 免得把用户真正的空布局块（如占位分栏）误删。
 */
function stripTrailingEmptyBlocks(root: HTMLElement): void {
  const isBlank = (el: Element): boolean => {
    // 有实体内容（图片、分隔线、表格、mermaid、附件卡片等）就不算空
    if (el.querySelector("img,svg,video,iframe,table,hr,input,[data-type]")) {
      return false;
    }
    return el.textContent?.trim() === "";
  };
  // 从后往前逐个剥，直到遇上有内容的块
  while (root.lastElementChild && isBlank(root.lastElementChild)) {
    root.lastElementChild.remove();
  }
}

/**
 * 给正文首/末块打上 `kb-doc-first` / `kb-doc-last`，导出模板据此把外边距归零。
 *
 * 为什么要前端来标：只有这里知道剥完编辑态元素之后「首/末块」到底是哪个。
 * 为什么用 class 而不是 `:first-child`：实测 Word / WPS 的 HTML 导入器**不认伪类**
 *（写了等于没写），但认 class 选择器 —— 这是空白消不掉的直接原因。
 */
function markFirstLastBlocks(root: HTMLElement): void {
  root.firstElementChild?.classList.add("kb-doc-first");
  root.lastElementChild?.classList.add("kb-doc-last");
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
