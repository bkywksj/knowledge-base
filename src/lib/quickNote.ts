/**
 * 首页「随手记」的文本处理（纯函数，有单测）。
 */

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 随手记存成新笔记：第一行作标题（过长截断，截断时正文保留全文），其余每行一段 */
export function quickTextToNote(text: string): { title: string; content: string } {
  const lines = text.trim().split("\n");
  const first = lines[0].trim();
  const title = first.length > 60 ? `${first.slice(0, 60)}…` : first || "随手记";
  const bodyLines = first.length > 60 ? lines : lines.slice(1);
  const content = bodyLines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `<p>${escapeHtml(l)}</p>`)
    .join("");
  return { title, content };
}
