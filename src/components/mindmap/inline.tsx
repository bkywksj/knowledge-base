import type { ReactNode } from "react";

/**
 * 节点文字的行内 Markdown 显示：只认导图里常见的几种（粗体 / 斜体 / 删除线 / 高亮 / 行内代码 / 链接），
 * 让不熟悉 Markdown 的用户看到的是格式而不是星号。改文字时仍编辑原文。
 *
 * 刻意不用完整 Markdown 渲染器：节点文字很短，这几种覆盖绝大多数；也避免把 HTML 注入节点。
 */
const TOKEN_RE =
  /(\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|==[^=]+==|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;

export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const t = m[0];
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    last = at + t.length;
    const k = key++;
    if (t.startsWith("**") || t.startsWith("__")) out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("~~")) out.push(<del key={k}>{t.slice(2, -2)}</del>);
    else if (t.startsWith("==")) out.push(<mark key={k}>{t.slice(2, -2)}</mark>);
    else if (t.startsWith("`")) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("[")) {
      const label = t.slice(1, t.indexOf("]("));
      out.push(
        <span key={k} className="kb-mm-link">
          {label}
        </span>,
      );
    } else out.push(<em key={k}>{t.slice(1, -1)}</em>);
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
