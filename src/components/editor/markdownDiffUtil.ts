/**
 * 对比/合并视图里取笔记 markdown 的工具。
 *
 * tiptap-markdown 把连续空段落序列化成 HTML 兜底（`<p><br></p>` / `<p></p>`）——纯 markdown 没法
 * 表达"多个连续空行"。这在 diff 视图里又丑又容易被误以为是坏的，所以统一 tidy 掉再展示。
 */
import type { Editor } from "@tiptap/react";

/**
 * 把 tiptap-markdown 序列化里"空段落的 HTML 兜底"（`<p></p>` / `<p><br></p>`）替换成**空行本身**——
 * 让空行就显示成空行，而不是一行 `<p><br></p>` 文本。
 *
 * 注意：**不**压缩连续空行、**不** trim 首尾——用户需要在 diff 里看到这些空行。
 */
export function tidyNoteMarkdown(md: string): string {
  return md
    .replace(/\r\n/g, "\n")
    .replace(/<p>\s*(?:<br\s*\/?>\s*)?<\/p>/gi, "") // <p><br></p> → 这一行变空行（外围的 \n\n 还在）
    .replace(/[ \t]+\n/g, "\n"); // 顺手去掉行尾空白
}

/** 取当前编辑器内容的 markdown（已 tidy）；无 markdown storage 时退回纯文本 */
export function getNoteMarkdown(editor: Editor): string {
  const storage = editor.storage as { markdown?: { getMarkdown: () => string } };
  const raw = storage.markdown?.getMarkdown() ?? editor.getText({ blockSeparator: "\n\n" });
  return tidyNoteMarkdown(raw);
}
