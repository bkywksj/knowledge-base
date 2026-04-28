import type { ReactNode } from "react";

/**
 * 把文本中所有匹配 keyword 的片段（大小写不敏感、多个关键词按空格切分）
 * 包成 <mark>，返回 ReactNode 给 React 直接渲染。
 *
 * 与后端 FTS5 `snippet()` 输出 `<mark>...</mark>` 风格保持一致，
 * 前端再额外把 title 文本上不会被后端高亮的部分补上。
 *
 * 不修改不匹配的部分，所以原文样式（颜色/省略号）不受影响。
 */
export function highlightText(text: string, keyword: string): ReactNode {
  const raw = (keyword ?? "").trim();
  if (!raw || !text) return text;

  // 多关键词：按空白切分，按长度降序匹配（避免短词在长词内提前命中）
  const tokens = raw
    .split(/\s+/)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (tokens.length === 0) return text;

  // 转义正则特殊字符，避免用户输入 ".*" 等导致非预期匹配
  const escaped = tokens.map(escapeRegex);
  const re = new RegExp(`(${escaped.join("|")})`, "gi");

  const parts = text.split(re);
  // String.split 携带捕获组时会把命中的子串穿插进结果数组
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      return (
        <mark
          key={i}
          style={{
            background: "rgba(255, 217, 102, 0.5)",
            color: "inherit",
            padding: 0,
          }}
        >
          {part}
        </mark>
      );
    }
    return part;
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 处理后端 search_notes 返回的 snippet（带 `<mark>...</mark>` 的 HTML 字符串）。
 *
 * **为什么不直接 dangerouslySetInnerHTML：**
 * 后端 FTS5 + unicode61 中文分词器会把相邻汉字合并成一个长 token（如
 * "本地优先的知识库桌面应用"是一个 token），用 `本地*` 前缀匹配时整个 token 都被
 * `<mark>` 包住，结果"地优先的知识库桌面应用"也被高亮，干扰阅读。
 *
 * 这里先用正则剥掉后端的 mark 标签，再按用户输入的字符级关键词重新高亮——
 * 高亮范围严格等于关键词本身，不会扩散到整个 token。
 */
export function highlightSnippet(snippetHtml: string, keyword: string): ReactNode {
  const plain = snippetHtml.replace(/<\/?mark>/gi, "");
  return highlightText(plain, keyword);
}
