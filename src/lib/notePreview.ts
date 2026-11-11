import { dailyToPlainLines } from "./dailyTimeline";
import { stripMarkdownLine } from "./noteTitle";

/**
 * 笔记卡片 / 列表行的正文预览：去掉 HTML 与 Markdown 标记，压成一行。
 *
 * 原来手机首页「继续编辑」和笔记列表只去了 HTML，预览里露出 `# 标题`、`[[双链|12]]`、`- ` 这类标记；
 * 白板笔记的正文是 Excalidraw JSON，直接截断显示是一串花括号。
 *
 * @param content 笔记正文（HTML / Markdown 混写都可能）
 * @param opts.title 笔记标题：正文第一行就是标题时跳过，免得卡片上同一句话出现两遍
 * @param opts.max 最多保留多少字（默认 90）
 * @param opts.noteType 笔记类型；白板固定返回「白板」
 */
export function notePreviewText(
  content: string | null | undefined,
  opts: { title?: string; max?: number; noteType?: string } = {},
): string {
  if (opts.noteType === "whiteboard") return "白板";
  if (!content) return "";
  // 代码块围栏要在交给 dailyToPlainLines 之前删：它会先去掉反引号，```js 只剩孤零零的 js（分割线它自己会滤）
  const lines = dailyToPlainLines(content.replace(/^\s*`{3,}.*$/gm, ""))
    // 只剩标记的行：编辑器把空标题存成单独一个 `#`、空列表项存成 `-`，去标记的规则要求后面跟空格，漏网后预览里一串「# # # - -」（真机实测）
    .filter((l) => !/^\s*(#{1,6}|[-*+]|>|\d+[.)])\s*$/.test(l))
    .map((l) => stripMarkdownLine(l))
    .filter(Boolean);
  const title = opts.title?.trim();
  if (title && lines[0] === title) lines.shift();
  return lines.join(" ").replace(/\s+/g, " ").trim().slice(0, opts.max ?? 90);
}
