/**
 * 粘贴内容拆解：文字归文字，图片归附件（待办附件条用）。
 *
 * 纯函数、不依赖 DOM，方便单测（vitest 跑在 node 环境）。
 */

/** 一次粘贴最多收多少张 HTML 里的图（复制整篇网页时防止一口气下几百张） */
export const MAX_HTML_IMAGES = 20;

/** 剪贴板的最小接口：浏览器 DataTransfer 满足，单测可直接传对象 */
export interface ClipboardLike {
  getData(format: string): string;
  files?: ArrayLike<File> | null;
}

/** 粘贴内容的拆解结果 */
export interface ClipboardPlan {
  text: string;
  /** 截图 / 复制的文件 / HTML 里 data: 内嵌图 */
  files: File[];
  /** HTML 里的外链图片，交后端下载 */
  urls: string[];
  /** HTML 里的 file:/// 图片（微信 / QQ 把图放在本地临时目录），交后端复制 */
  paths: string[];
  /** HTML 里的图超过上限被丢掉的张数 */
  skipped: number;
}

/** HTML 属性值里常见的实体；src 一般只会出现这几个 */
function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** 取 HTML 里所有 <img> 的 src（去重、保持出现顺序） */
export function extractImgSrcs(html: string): string[] {
  const out: string[] = [];
  const re = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const src = decodeEntities((m[1] ?? m[2] ?? m[3] ?? "").trim());
    if (src && !out.includes(src)) out.push(src);
  }
  return out;
}

export function dataUrlToFile(src: string, idx: number): File | null {
  const m = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(src);
  if (!m) return null;
  try {
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ext = (m[1].split("/")[1] || "png")
      .replace("jpeg", "jpg")
      .replace("svg+xml", "svg");
    return new File([bytes], `pasted-${Date.now()}-${idx}.${ext}`, {
      type: m[1],
    });
  } catch {
    return null;
  }
}

/** file:///C:/a%20b/x.png → C:/a b/x.png；file:///home/x.png → /home/x.png */
export function fileUrlToPath(src: string): string | null {
  try {
    const p = decodeURIComponent(new URL(src).pathname);
    return /^\/[A-Za-z]:\//.test(p) ? p.slice(1) : p;
  } catch {
    return null;
  }
}

/**
 * 拆解剪贴板。
 *
 * 判定规则（按各来源的剪贴板形态）：
 * - 截图 / 资源管理器复制文件：只有 files → 全部当附件
 * - 浏览器「复制图片」：files + HTML 里一个同图 <img> → 只取 files，避免同图存两份
 * - 网页 / 微信 / QQ 复制图文：text + HTML 里若干 <img>，files 为空 → 文字照常粘贴，
 *   <img> 按 src 分流：data: 解码、http(s) 交后端下载、file:/// 交后端复制
 * - Word / Excel 复制：text + HTML（无 <img>）+ 一张整段内容的快照图 → 只要文字，
 *   丢掉快照图（用户要的是表格文字，不是一张截图）
 */
export function parseClipboard(dt: ClipboardLike | null): ClipboardPlan {
  const plan: ClipboardPlan = {
    text: "",
    files: [],
    urls: [],
    paths: [],
    skipped: 0,
  };
  if (!dt) return plan;
  plan.text = dt.getData("text/plain") ?? "";
  const html = dt.getData("text/html") ?? "";
  const files = Array.from(dt.files ?? []);
  const srcs = html ? extractImgSrcs(html) : [];

  if (files.length > 0) {
    const officeSnapshot = plan.text.trim() !== "" && srcs.length === 0;
    if (!officeSnapshot) plan.files = files;
    return plan;
  }

  plan.skipped = Math.max(0, srcs.length - MAX_HTML_IMAGES);
  srcs.slice(0, MAX_HTML_IMAGES).forEach((src, idx) => {
    if (src.startsWith("data:")) {
      const f = dataUrlToFile(src, idx);
      if (f) plan.files.push(f);
    } else if (/^https?:\/\//i.test(src)) {
      plan.urls.push(src);
    } else if (src.startsWith("file:")) {
      const p = fileUrlToPath(src);
      if (p) plan.paths.push(p);
    }
  });
  return plan;
}
