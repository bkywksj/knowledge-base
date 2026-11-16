/**
 * 换行统一：从 Word / 网页复制来的内容常混着两种换行——
 * 段内换行（hardBreak，Markdown 里是行尾 `\`）和真分段（paragraph）。
 * 前者只隔一个行高，后者还要加段间距，于是同一段文字间距忽大忽小。
 *
 * - splitHardBreaks：段内换行全部拆成独立段落，全文间距一致
 * - mergeParagraphs：选中的相邻段落合并成一段，用段内换行连接，排得紧凑
 *
 * 两者都只产出一个 Transaction（Ctrl+Z 整体撤销），没命中的内容不动。
 */
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";

/** 列表项里的段内换行是「同一条目换行」，拆开会变成一条目多段，语义就变了 */
const SKIP_PARENTS = new Set(["listItem", "taskItem"]);

function isBlankInline(nodes: readonly PMNode[]): boolean {
  return nodes.every(
    (n) => n.type.name === "hardBreak" || (n.isText && !(n.text ?? "").trim()),
  );
}

function childrenOf(node: PMNode): PMNode[] {
  const out: PMNode[] = [];
  node.content.forEach((c) => out.push(c));
  return out;
}

/**
 * 把段落按 hardBreak 切成若干段内容。首尾的空段丢掉（如开头孤立的一个 `\`），
 * 中间连续多个空段只留一个——那是原文有意空出的一行。
 */
export function splitByHardBreak(paragraph: PMNode): PMNode[][] {
  const groups: PMNode[][] = [[]];
  paragraph.content.forEach((child) => {
    if (child.type.name === "hardBreak") groups.push([]);
    else groups[groups.length - 1].push(child);
  });
  while (groups.length > 0 && isBlankInline(groups[0])) groups.shift();
  while (groups.length > 0 && isBlankInline(groups[groups.length - 1])) groups.pop();
  return groups.filter(
    (g, i) => !(i > 0 && isBlankInline(g) && isBlankInline(groups[i - 1])),
  );
}

/** 段内换行 → 独立段落。count = 处理掉的段内换行数；返回 null 表示没有可拆的 */
export function splitHardBreaks(
  state: EditorState,
): { tr: Transaction; count: number } | null {
  const targets: { pos: number; node: PMNode; breaks: number }[] = [];
  state.doc.descendants((node, pos, parent) => {
    if (node.type.name !== "paragraph") return true;
    if (parent && SKIP_PARENTS.has(parent.type.name)) return false;
    let breaks = 0;
    node.content.forEach((c) => {
      if (c.type.name === "hardBreak") breaks += 1;
    });
    if (breaks > 0) targets.push({ pos, node, breaks });
    return false;
  });
  if (targets.length === 0) return null;

  const tr = state.tr;
  let count = 0;
  // 从后往前替换，前面的位置不受影响
  for (let i = targets.length - 1; i >= 0; i -= 1) {
    const { pos, node, breaks } = targets[i];
    const groups = splitByHardBreak(node);
    // 整段只有换行 / 空白：留一个空段落，不凭空删掉用户的空行
    const paragraphs =
      groups.length === 0
        ? [node.type.create(node.attrs, null, node.marks)]
        : groups.map((g) => node.type.create(node.attrs, g, node.marks));
    tr.replaceWith(pos, pos + node.nodeSize, paragraphs);
    count += breaks;
  }
  return { tr, count };
}

/**
 * 选区覆盖的相邻段落（同一父节点下、中间不隔其他块）合并成一段，用 hardBreak 连接。
 * 夹在中间的空段落直接去掉——合并就是为了排紧凑。
 * count = 被并掉的段落数；返回 null 表示选区里不足两段可合并。
 */
export function mergeParagraphs(
  state: EditorState,
): { tr: Transaction; count: number } | null {
  const hardBreak = state.schema.nodes.hardBreak;
  if (!hardBreak) return null;
  const { from, to } = state.selection;

  // 按「父节点 + 位置紧挨」分组：每组是一串连续段落
  const runs: { pos: number; node: PMNode }[][] = [];
  let lastParent: PMNode | null = null;
  let lastEnd = -1;
  state.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (node.type.name !== "paragraph") return true;
    if (parent && SKIP_PARENTS.has(parent.type.name)) return false;
    if (parent === lastParent && pos === lastEnd) runs[runs.length - 1].push({ pos, node });
    else runs.push([{ pos, node }]);
    lastParent = parent;
    lastEnd = pos + node.nodeSize;
    return false;
  });

  const tr = state.tr;
  let count = 0;
  for (let r = runs.length - 1; r >= 0; r -= 1) {
    const run = runs[r];
    if (run.length < 2) continue;
    const kept = run.filter((p) => !isBlankInline(childrenOf(p.node)));
    if (kept.length === 0) continue;
    const inline: PMNode[] = [];
    kept.forEach((p, i) => {
      if (i > 0) inline.push(hardBreak.create());
      p.node.content.forEach((c) => inline.push(c));
    });
    const first = run[0].node;
    const last = run[run.length - 1];
    tr.replaceWith(
      run[0].pos,
      last.pos + last.node.nodeSize,
      first.type.create(first.attrs, inline, first.marks),
    );
    count += run.length - 1;
  }
  if (count === 0) return null;
  return { tr, count };
}
