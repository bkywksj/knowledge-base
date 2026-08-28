/**
 * 扫描一个 textblock 的文本，找出应转成行内公式的 `$..$` 范围。
 *
 * 从 TiptapEditor 的 migrateOpenMathStrings 抽出来，为的是能单测——它是整条
 * 「打开笔记时把 markdown 里的 $..$ 升级成 math 节点」链路里唯一容易出错的部分，
 * 而且出错的后果是**正文字符被吞进 latex 属性、从可见文本里消失**。
 *
 * 🔴 传进来的 text 必须是 `node.textBetween(0, node.content.size, undefined, () => "\n")`
 * 的产物，**不能**用 `node.textContent`。两个原因：
 *
 * 1. `textContent` 里 hardBreak 贡献**空串**，多行内容被首尾相连成一行。于是下面正则
 *    里的 `\n` 排除完全失效，`$..$` 会跨行配对。粘贴一段终端日志：
 *
 *      [NAS_DR@NAS-DR ~]$            ← 行末一个 $
 *      [NAS_DR@NAS-DR ~]$ sleep 8    ← 行中一个 $
 *
 *    textContent 拼成 `...~]$[NAS_DR@NAS-DR ~]$ sleep 8`，中间的 `[NAS_DR@NAS-DR ~]`
 *    被当成 LaTeX 吞掉，那一行就此从正文消失。
 *
 * 2. `textContent` 里 hardBreak 贡献 0 字符，但它在 doc 里占 1 个位置。于是 hardBreak
 *    之后的所有匹配，`from/to` 都比真实位置**每个 hardBreak 少 1**，replaceWith 会削掉
 *    错误的字符范围，把邻近文字一起吃掉。
 *
 * 用 leafText 让每个 inline leaf 节点贡献 1 个 "\n"（与其 nodeSize 相等），两个问题
 * 一起解决：字符下标与 doc 内偏移严格一一对应，且公式天然不跨越换行/图片等 leaf。
 */

export type InlineMathRange = {
  /** 相对 textblock 内容起点的字符下标，指向开头那个 `$` */
  start: number;
  /** 结束下标（不含），指向收尾 `$` 的下一位 */
  end: number;
  /** `$` 之间的 LaTeX 源码 */
  latex: string;
};

/**
 * 行内公式 `$..$`。
 *
 * 改写说明：原写法用了 negative lookbehind `(?<!\$)`，老 macOS / Linux webkit2gtk
 * < 2.40 / 老 Edge WebView2 不支持 ES2018 lookbehind，会让 `new RegExp` 直接抛
 * "invalid group specifier name" 致编辑器全屏崩。改用 `(^|[^$])` 显式捕获前导字符
 * 达到等价语义：m[1] 是前导（行首空串或一个非 $ 字符），m[2] 才是 LaTeX 内容。
 *
 * 末尾 `(?!\$|\d)` 避开 `$$` 双号边界和 `$10` 这类货币写法。
 */
const INLINE_MATH_RE = /(^|[^$])\$(?!\$)([^$\n]+?)\$(?!\$|\d)/g;

export function findInlineMathRanges(text: string): InlineMathRange[] {
  if (!text.includes("$")) return [];
  const out: InlineMathRange[] = [];
  const re = new RegExp(INLINE_MATH_RE.source, INLINE_MATH_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const leading = m[1];
    const latex = m[2];
    const start = m.index + leading.length;
    out.push({ start, end: start + latex.length + 2, latex });
  }
  return out;
}
