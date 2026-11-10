/**
 * 把日记正文拆成「时间线条目 + 其余文字」，给手机端日记页的当天卡片用。
 *
 * 日记里的时间戳有三种来源，写法不同，都要认：
 * - 首页「记一笔」（PC / 手机同一写法）：`<p><strong>[09:12]</strong> 内容</p>`
 * - 上面那段经编辑器保存后变成 Markdown：`**[09:12]** 内容`（方括号可能被转义成 `\[09:12\]`）
 * - 闪念捕获（后端 append_quick_capture）：`<div data-callout="info"><p>🕐 09:12</p><p>第一行</p>…</div>`，
 *   时间单独一行，正文在后面几行
 *
 * 只做展示用的粗略纯文本化，不追求还原排版；看全文进编辑器。
 */

export interface DailyTimelineEntry {
  /** HH:mm */
  time: string;
  text: string;
}

export interface DailyTimeline {
  entries: DailyTimelineEntry[];
  /** 不属于任何时间戳的文字行（已去掉标记），按原顺序 */
  rest: string[];
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

/** 正文（HTML / Markdown 混写）→ 纯文本行 */
export function dailyToPlainLines(content: string): string[] {
  const text = content
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)>/gi, "\n")
    .replace(/<img[^>]*>/gi, "[图片]")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s*(>\s*)+/, "") // 引用 / callout
        .replace(/^\s*\[!\w+\][+-]?\s*/, "") // callout 头 [!info]
        .replace(/^\s*#{1,6}\s+/, "") // 标题
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "") // 列表 / 任务
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "[图片]")
        .replace(/(?<!\[)\[([^\][]+)\]\([^)]*\)/g, "$1") // [文字](链接)，不碰 [[双链]]
        .replace(/\\([[\]*_#>`~=-])/g, "$1") // Markdown 转义
        .replace(/(\*\*|__|~~|==|`)/g, "")
        .trim(),
    )
    .filter((line) => line && !/^[-*_]{3,}$/.test(line));
}

const STAMP_BRACKET = /^\*{0,2}\[(\d{1,2}:\d{2})\]\*{0,2}\s*([\s\S]*)$/;
const STAMP_CLOCK = /^🕐\s*(\d{1,2}:\d{2})\s*([\s\S]*)$/;
/** 把一个 callout 的多行压成一行时用的分隔符（行内不会出现），解析完再换回换行 */
const JOIN = " ";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * 闪念捕获的时间单独一行、正文在后面几行，边界是 callout 本身：
 * 先把每个带 🕐 的 callout（HTML 的 <div data-callout> 或编辑器存回的 `>` 引用块）整块压成一行，
 * 后面就能和另外两种写法一样「一行一条」地认。
 */
function collapseCallouts(content: string): string {
  const html = content.replace(/<div[^>]*data-callout[^>]*>([\s\S]*?)<\/div>/gi, (_, inner: string) => {
    return `<p>${escapeHtml(dailyToPlainLines(inner).join(JOIN))}</p>`;
  });
  const out: string[] = [];
  let quote: string[] = [];
  const flush = () => {
    if (quote.length === 0) return;
    const plain = dailyToPlainLines(quote.join("\n"));
    if (plain.some((l) => STAMP_CLOCK.test(l))) out.push(plain.join(JOIN));
    else out.push(...quote);
    quote = [];
  };
  for (const line of html.split(/\r?\n/)) {
    if (/^\s*>/.test(line)) {
      quote.push(line);
    } else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.join("\n");
}

export function parseDailyTimeline(content: string | null | undefined): DailyTimeline {
  const out: DailyTimeline = { entries: [], rest: [] };
  if (!content) return out;
  for (const line of dailyToPlainLines(collapseCallouts(content))) {
    const m = line.match(STAMP_BRACKET) ?? line.match(STAMP_CLOCK);
    if (m) {
      const text = m[2].split(JOIN).map((s) => s.trim()).filter(Boolean).join("\n");
      // 只有时间没有内容的条目没有展示价值
      if (text) out.entries.push({ time: m[1].padStart(5, "0"), text });
      continue;
    }
    out.rest.push(...line.split(JOIN).filter(Boolean));
  }
  return out;
}
