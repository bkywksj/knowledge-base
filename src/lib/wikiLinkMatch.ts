/**
 * wiki 双链 `[[标题]]` / `[[标题|123]]` 的文本匹配。
 *
 * 为什么要单独抽出来：decoration 原先是**逐 text node** 跑正则的，而 ProseMirror 会在
 * mark 边界切分 text node —— 只要这串字符里夹了任何格式差异（局部加粗 / 颜色 / 高亮，
 * 或从外部粘贴表格、Word 时带进来的 textStyle），`[[标题]]` 就会落进两个以上 text node，
 * 正则永远匹配不到：双链既不变蓝、点上去也毫无反应（`closest('[data-wiki-link]')` 返回
 * null，handleClick 直接 return false）。用户反馈「双链点击没反应」的真正原因就是这个。
 *
 * 修法是把匹配粒度从 text node 提到**块级节点**：先取整块的完整文本，再在上面匹配。
 * 本模块只负责「给定一段文本，找出里面的双链」，块级遍历在 WikiLinkDecoration 里做。
 */

/**
 * 识别两种形式：
 *  - 旧 / 手敲：`[[标题]]`
 *  - 候选下拉插入：`[[标题|123]]` —— ID 是稳定锚点，目标改名也能跳对
 *
 * 标题段 `[^\[\]\n|]+` 排除 `|`，让 ID 段能独立捕获；ID 必须是纯数字。
 */
const WIKI_LINK_REGEX = /\[\[([^\[\]\n|]+)(?:\|(\d+))?\]\]/g;

export interface WikiLinkMatch {
  /** 完整匹配文本，如 `[[标题|123]]` */
  raw: string;
  /** 标题（已 trim） */
  title: string;
  /** ID 锚点原文（纯数字字符串）；旧格式无 ID 时为 undefined */
  id?: string;
  /** 相对所在文本的起始偏移 */
  start: number;
  /** 相对所在文本的结束偏移（不含） */
  end: number;
}

/**
 * 在一段文本里找出所有双链。
 *
 * ⚠️ 传进来的必须是**整个块级节点**的文本。传单个 text node 的文本会重现本模块开头
 * 描述的那个 bug —— 被切开的 `[[` 和 `标题]]` 各自都匹配不到。
 */
export function findWikiLinks(text: string): WikiLinkMatch[] {
  const out: WikiLinkMatch[] = [];
  WIKI_LINK_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKI_LINK_REGEX.exec(text)) !== null) {
    const title = m[1].trim();
    // `[[   ]]` 这种空标题不算双链（原实现同样跳过），继续往后找
    if (!title) continue;
    out.push({
      raw: m[0],
      title,
      id: m[2],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

/**
 * 判断某个偏移是否落在双链上，是则返回那条双链。
 *
 * 用途：点击双链时**不能只靠 `event.target`**。Tiptap 的表格是带 NodeView 的容器，
 * 点在单元格里时事件 target 会被换成外层的 `<div class="tableWrapper">`，
 * `closest('[data-wiki-link]')` 因此拿不到 decoration span —— 表格里的双链看着是蓝的
 * 却点不动，而表格外的同款双链一点就跳。ProseMirror 传给 handleClick 的 `pos` 是真实
 * 文档位置，换算成块内偏移后用本函数反查，不依赖任何 DOM 结构，容器怎么包都不受影响。
 *
 * 边界取闭区间 `[start, end]`：点在 `[[` 最左侧或 `]]` 最右侧的贴边位置也算命中，
 * 与 decoration 的视觉范围一致。
 */
export function wikiLinkAtOffset(
  text: string,
  offset: number,
): WikiLinkMatch | null {
  for (const hit of findWikiLinks(text)) {
    if (offset >= hit.start && offset <= hit.end) return hit;
  }
  return null;
}
