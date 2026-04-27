import type { Editor } from "@tiptap/react";

/**
 * 编辑器字数 / 字符 / 段落 / 阅读时长统计
 *
 * 历史问题：之前 EditorStats.tsx 与 TiptapEditor.tsx 各写了一套算法，CJK 范围
 * 和文本源（textContent vs getText）都不同，导致同一篇笔记顶部和底部数字差好几个。
 * 这里抽成单一来源真相，两边都用同一个 calcEditorStats，确保**永远一致**。
 *
 * 设计选择：
 *   1. 文本源：用 `editor.getText({ blockSeparator: "\n\n" })`。比 doc.textContent
 *      多了块边界分隔符，能让"段落 → 代码块 → 标题"之间的英文不被错误粘成一个词。
 *   2. CJK 范围：包括 CJK Unified、Ext A 罕用字、平假名、片假名。覆盖中日双语笔记。
 *   3. 阅读速度：300 字/分钟（中文默读速度的中位数；250 偏慢，400 接近浏览）。
 */

/** 算 1 个"字"的字符：中文（含 Ext A）+ 日文假名 */
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff]/g;

/** 阅读速度（字/分钟） */
const READ_WPM = 300;

export interface EditorTextStats {
  /** 字数 = CJK 字符数 + 英文（按空白分词）单词数 */
  words: number;
  /** 字符数（含空白，按 Unicode 码点而非 UTF-16 单元，emoji 不会被计成 2） */
  chars: number;
  /** 字符数（不含任何空白） */
  charsNoSpace: number;
  /** 非空段落数（paragraph 节点 textContent.trim().length > 0） */
  paragraphs: number;
  /** 阅读时长，向上取整，最少 1 分钟 */
  readMinutes: number;
}

export function calcEditorStats(editor: Editor): EditorTextStats {
  // blockSeparator 让块边界处的英文词不被错误连接（例如代码块结束接段落）
  const text = editor.getText({ blockSeparator: "\n\n" });

  const cjkCount = (text.match(CJK_REGEX) || []).length;
  const nonCjk = text.replace(CJK_REGEX, " ");
  const engWords = nonCjk.split(/\s+/).filter(Boolean).length;
  const words = cjkCount + engWords;

  const chars = [...text].length;
  const charsNoSpace = [...text.replace(/\s+/g, "")].length;

  let paragraphs = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "paragraph" && node.textContent.trim().length > 0) {
      paragraphs += 1;
    }
    return true;
  });

  const readMinutes = Math.max(1, Math.ceil(words / READ_WPM));

  return { words, chars, charsNoSpace, paragraphs, readMinutes };
}
