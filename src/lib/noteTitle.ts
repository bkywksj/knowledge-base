/**
 * 笔记标题兜底：用户没填标题时，保存不该被拒（之前「标题不能为空」直接 return，
 * 自动保存也静默跳过 → 只写正文的笔记关 app 就丢）。
 *
 * 规则：取正文第一行有字的内容（去掉 markdown 标记、截 30 字）；正文也空则用
 * 「未命名笔记 YYYY-MM-DD HH:mm」。
 */

const MAX_LEN = 30;

/** 去掉一行 markdown 里只影响排版的标记，留下给人看的文字 */
export function stripMarkdownLine(line: string): string {
  return line
    .replace(/^\s{0,3}(#{1,6}\s+|>\s*|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // 图片取 alt
    .replace(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, "$1") // wiki 链接
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 普通链接取文字
    .replace(/<[^>]+>/g, "") // 行内 HTML
    .replace(/(\*\*|__|~~|==|`)/g, "")
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, "$1$2")
    .trim();
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function fallbackNoteTitle(now: Date = new Date()): string {
  return `未命名笔记 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
    now.getDate(),
  )} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** 从正文推一个标题；正文里没有可用文字返回 null */
export function titleFromContent(content: string): string | null {
  let inFence = false;
  for (const raw of content.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // 表格分隔行 / 分隔线 / front matter 分隔这类纯符号行跳过
    if (/^\s*[|:\-\s*_=]+\s*$/.test(raw)) continue;
    const text = stripMarkdownLine(raw.replace(/^\s*\|/, "").replace(/\|\s*$/, ""))
      .replace(/\s*\|\s*/g, " ")
      .trim();
    if (!text) continue;
    const chars = Array.from(text);
    return chars.length > MAX_LEN ? chars.slice(0, MAX_LEN).join("") : text;
  }
  return null;
}

/** 保存时实际用的标题：用户填了就用用户的，否则按正文 / 时间兜底 */
export function resolveNoteTitle(
  title: string,
  content: string,
  now: Date = new Date(),
): string {
  const t = title.trim();
  if (t) return t;
  return titleFromContent(content) ?? fallbackNoteTitle(now);
}
