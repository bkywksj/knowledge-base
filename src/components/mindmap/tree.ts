/**
 * 思维导图的数据层：笔记 Markdown ↔ 节点树，以及编辑操作。全部是纯函数，不碰 DOM。
 *
 * 约定（见 docs/tasks/mindmap-editor-tasks.md）：
 * - 导图就是笔记正文里的「标题 + 嵌套列表」，中心主题 = 笔记标题（不在正文里）
 * - 只有纯大纲（只含标题 / 列表项 / 空行）才允许编辑；其余内容写回会丢，只读
 * - 写回格式对齐编辑器 tiptap-markdown 的序列化：`-` 无序、紧凑列表、
 *   嵌套缩进 = 父列表标记宽度 + 1（`- ` → 2 空格，`1. ` → 3 空格）。
 *   对齐它是为了写回后编辑器再序列化不产生差异，避免导图 ↔ 编辑器来回改出脏标记
 *
 * 编辑操作都返回新树（不改入参），撤销重做直接存树快照即可。
 */

/** 节点在 Markdown 里的形态 */
export type MindNodeKind =
  | { type: "root" }
  | { type: "heading"; level: number }
  /** 列表项：ordered = 有序列表；task = 任务项勾选状态（null 表示不是任务项） */
  | { type: "item"; ordered: boolean; task: boolean | null };

export interface MindNode {
  id: string;
  /** 节点文字，保留行内 Markdown 原文（**粗体**、[链接](…) 等），显示时再渲染 */
  text: string;
  kind: MindNodeKind;
  children: MindNode[];
}

export interface ParseResult {
  root: MindNode;
  /** 能否在导图里编辑：false 时 reason 说明是哪一行挡住了 */
  editable: boolean;
  reason?: string;
}

let idSeq = 0;
/** 进程内唯一即可：id 只用于界面选中 / 折叠，不落盘 */
export function newNodeId(): string {
  idSeq += 1;
  return `m${idSeq}`;
}

/** 结尾的闭合 `#` 前必须有空格才算标记（CommonMark），否则「# C#」会被吃成「C」 */
const HEADING_RE = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const ITEM_RE = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;
/** 空列表项（`-` 后面直接换行）：tiptap 会序列化出这种行 */
const EMPTY_ITEM_RE = /^(\s*)([-*+]|\d+[.)])\s*$/;

/** 列表项相对标题的「深度键」：标题 1–6，列表项从 10 起按缩进递增，保证列表永远挂在标题下面 */
const ITEM_KEY_BASE = 10;

/** 把一行缩进换算成列数（Tab 按 4 列） */
function indentWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch === "\t" ? 4 : 1;
  return w;
}

/**
 * 笔记 Markdown → 节点树。
 *
 * 层级用「栈 + 深度键」确定：新节点不断弹出键 ≥ 自己的栈顶，剩下的栈顶就是父节点。
 * 标题键 = 级别；列表项键 = 10 + 缩进列数。这样「H2 下的列表」「列表里再缩进」
 * 「跳级标题（H1 后直接 H3）」都能挂到正确的父节点上。
 */
export function parseMindMap(markdown: string, title: string): ParseResult {
  const root: MindNode = { id: newNodeId(), text: title, kind: { type: "root" }, children: [] };
  const stack: { node: MindNode; key: number }[] = [];
  let editable = true;
  let reason: string | undefined;

  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;

    let node: MindNode | null = null;
    let key = 0;
    const h = HEADING_RE.exec(line);
    const it = h ? null : ITEM_RE.exec(line);
    const empty = h || it ? null : EMPTY_ITEM_RE.exec(line);

    if (h) {
      key = h[1].length;
      node = { id: newNodeId(), text: h[2], kind: { type: "heading", level: key }, children: [] };
    } else if (it || empty) {
      const m = (it ?? empty)!;
      const marker = m[2];
      key = ITEM_KEY_BASE + indentWidth(m[1]);
      const task = it && it[3] !== undefined ? it[3] !== " " : null;
      node = {
        id: newNodeId(),
        text: it ? it[4] : "",
        kind: { type: "item", ordered: /^\d/.test(marker), task },
        children: [],
      };
    } else {
      // 段落、表格、引用、代码块……导图里放不下，标记只读但继续解析，让只读视图仍能看大纲
      if (editable) {
        editable = false;
        const preview = line.trim();
        reason = `正文里有不是标题或列表的内容（如「${preview.length > 20 ? `${preview.slice(0, 20)}…` : preview}」），在导图里编辑会丢掉这些内容`;
      }
      continue;
    }

    while (stack.length && stack[stack.length - 1].key >= key) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].node : root;
    parent.children.push(node);
    stack.push({ node, key });
  }

  return { root, editable, reason };
}

/** 同级里先输出列表项、再输出子标题：Markdown 里标题之后的列表会归到那个标题下，顺序反了重新解析会挂错父节点 */
function orderedForOutput(children: MindNode[]): MindNode[] {
  const items = children.filter((c) => c.kind.type === "item");
  const heads = children.filter((c) => c.kind.type !== "item");
  return [...items, ...heads];
}

/** 列表项单行文本里不能有换行 */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ");
}

/** 输出一组同级列表项（含其子孙），indent 为本组的缩进前缀 */
function emitItems(items: MindNode[], indent: string, out: string[]) {
  let ordinal = 0;
  for (const n of items) {
    if (n.kind.type !== "item") continue;
    ordinal = n.kind.ordered ? ordinal + 1 : 0;
    const marker = n.kind.ordered ? `${ordinal}.` : "-";
    const task = n.kind.task === null ? "" : n.kind.task ? "[x] " : "[ ] ";
    out.push(`${indent}${marker} ${task}${oneLine(n.text)}`.trimEnd());
    const childIndent = indent + " ".repeat(marker.length + 1);
    // 列表项下只会有列表项（adaptKind 保证），标题混进来也按列表项输出
    emitItems(
      n.children.map((c) => (c.kind.type === "item" ? c : { ...c, kind: { type: "item", ordered: false, task: null } })),
      childIndent,
      out,
    );
  }
}

/**
 * 节点树 → 笔记 Markdown（中心主题不输出，它是笔记标题）。
 * 块之间空一行：标题、整段列表各算一块。
 */
export function serializeMindMap(root: MindNode): string {
  const blocks: string[] = [];

  function walk(children: MindNode[]) {
    const ordered = orderedForOutput(children);
    const items = ordered.filter((c) => c.kind.type === "item");
    if (items.length) {
      const out: string[] = [];
      emitItems(items, "", out);
      blocks.push(out.join("\n"));
    }
    for (const c of ordered) {
      if (c.kind.type !== "heading") continue;
      blocks.push(`${"#".repeat(c.kind.level)} ${oneLine(c.text)}`.trimEnd());
      walk(c.children);
    }
  }

  walk(root.children);
  return blocks.length ? `${blocks.join("\n\n")}\n` : "";
}

// ─── 查找 ───────────────────────────────────────

export interface NodeLocation {
  node: MindNode;
  parent: MindNode | null;
  index: number;
}

export function locate(root: MindNode, id: string): NodeLocation | null {
  if (root.id === id) return { node: root, parent: null, index: -1 };
  const stack: MindNode[] = [root];
  while (stack.length) {
    const p = stack.pop()!;
    for (let i = 0; i < p.children.length; i++) {
      const c = p.children[i];
      if (c.id === id) return { node: c, parent: p, index: i };
      stack.push(c);
    }
  }
  return null;
}

/** 深拷贝（保留 id），撤销栈存快照用 */
export function cloneTree(n: MindNode): MindNode {
  return { ...n, kind: { ...n.kind }, children: n.children.map(cloneTree) };
}

/** 按路径不可变更新：只复制从根到目标父节点这一条链 */
function updateNode(root: MindNode, id: string, fn: (n: MindNode) => MindNode): MindNode {
  if (root.id === id) return fn(root);
  let changed = false;
  const children = root.children.map((c) => {
    const next = updateNode(c, id, fn);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...root, children } : root;
}

// ─── 形态推导 ───────────────────────────────────

/** 父节点的「标题级别」：根 = 0；列表项下返回 null（只能挂列表项） */
function headingDepth(parent: MindNode): number | null {
  if (parent.kind.type === "root") return 0;
  if (parent.kind.type === "heading") return parent.kind.level;
  return null;
}

/**
 * 把节点（连同子树）改成能挂在 parent 下的形态：
 * - 列表项下只能是列表项
 * - 标题 / 根下：原来是标题的变成「父级别 + 1」级标题（超过 6 级降为列表项），列表项保持
 */
export function adaptKind(node: MindNode, parent: MindNode): MindNode {
  const depth = headingDepth(parent);
  let kind: MindNodeKind;
  if (node.kind.type === "item") {
    kind = node.kind;
  } else if (depth !== null && depth + 1 <= 6) {
    kind = { type: "heading", level: depth + 1 };
  } else {
    kind = { type: "item", ordered: false, task: null };
  }
  const self: MindNode = { ...node, kind };
  return { ...self, children: node.children.map((c) => adaptKind(c, self)) };
}

/**
 * 新建子节点用什么形态：
 * - 已有子节点 → 跟最后一个子节点一样（同为标题则同级别；列表项则同为有序 / 无序，任务项新建为未勾选）
 * - 没有子节点 → 列表项（标题下新开一段列表最自然）
 */
function kindForNewChild(parent: MindNode): MindNodeKind {
  const last = parent.children[parent.children.length - 1];
  if (last) return kindLike(last);
  return { type: "item", ordered: false, task: null };
}

function kindLike(ref: MindNode): MindNodeKind {
  if (ref.kind.type === "item") return { ...ref.kind, task: ref.kind.task === null ? null : false };
  return { ...ref.kind };
}

// ─── 编辑操作（都返回新树） ─────────────────────

export interface EditResult {
  root: MindNode;
  /** 操作后应选中的节点（新建 / 移动的节点） */
  selectId: string;
}

export function setText(root: MindNode, id: string, text: string): MindNode {
  return updateNode(root, id, (n) => ({ ...n, text: oneLine(text) }));
}

export function addChild(root: MindNode, parentId: string, text = ""): EditResult | null {
  const loc = locate(root, parentId);
  if (!loc) return null;
  const child: MindNode = { id: newNodeId(), text, kind: kindForNewChild(loc.node), children: [] };
  return {
    root: updateNode(root, parentId, (n) => ({ ...n, children: [...n.children, child] })),
    selectId: child.id,
  };
}

/** 在 id 之后插入同级；中心主题没有同级，退化为加子节点 */
export function addSibling(root: MindNode, id: string, text = ""): EditResult | null {
  const loc = locate(root, id);
  if (!loc) return null;
  if (!loc.parent) return addChild(root, id, text);
  const sib: MindNode = { id: newNodeId(), text, kind: kindLike(loc.node), children: [] };
  const parentId = loc.parent.id;
  const at = loc.index + 1;
  return {
    root: updateNode(root, parentId, (p) => ({
      ...p,
      children: [...p.children.slice(0, at), sib, ...p.children.slice(at)],
    })),
    selectId: sib.id,
  };
}

/** 删除节点（含子树）；选中改到前一个同级 → 后一个同级 → 父节点 */
export function removeNode(root: MindNode, id: string): EditResult | null {
  const loc = locate(root, id);
  if (!loc || !loc.parent) return null;
  const siblings = loc.parent.children;
  const next = siblings[loc.index - 1] ?? siblings[loc.index + 1] ?? loc.parent;
  return {
    root: updateNode(root, loc.parent.id, (p) => ({ ...p, children: p.children.filter((c) => c.id !== id) })),
    selectId: next.id,
  };
}

/** 同级内上移 / 下移 */
export function moveAmongSiblings(root: MindNode, id: string, delta: -1 | 1): EditResult | null {
  const loc = locate(root, id);
  if (!loc || !loc.parent) return null;
  const to = loc.index + delta;
  if (to < 0 || to >= loc.parent.children.length) return null;
  return {
    root: updateNode(root, loc.parent.id, (p) => {
      const children = [...p.children];
      const [n] = children.splice(loc.index, 1);
      children.splice(to, 0, n);
      return { ...p, children };
    }),
    selectId: id,
  };
}

/** 降级：变成上一个同级的最后一个子节点 */
export function indent(root: MindNode, id: string): EditResult | null {
  const loc = locate(root, id);
  if (!loc || !loc.parent || loc.index === 0) return null;
  const prev = loc.parent.children[loc.index - 1];
  const moved = adaptKind(loc.node, prev);
  return {
    root: updateNode(root, loc.parent.id, (p) => ({
      ...p,
      children: p.children
        .filter((c) => c.id !== id)
        .map((c) => (c.id === prev.id ? { ...c, children: [...c.children, moved] } : c)),
    })),
    selectId: id,
  };
}

/** 升级：移到父节点后面，成为父节点的下一个同级 */
export function outdent(root: MindNode, id: string): EditResult | null {
  const loc = locate(root, id);
  if (!loc || !loc.parent) return null;
  const parentLoc = locate(root, loc.parent.id);
  if (!parentLoc || !parentLoc.parent) return null; // 已经是中心主题的直接子节点
  const grand = parentLoc.parent;
  const moved = adaptKind(loc.node, grand);
  const parentId = loc.parent.id;
  return {
    root: updateNode(root, grand.id, (g) => {
      const children: MindNode[] = [];
      for (const c of g.children) {
        if (c.id === parentId) {
          children.push({ ...c, children: c.children.filter((x) => x.id !== id) }, moved);
        } else {
          children.push(c);
        }
      }
      return { ...g, children };
    }),
    selectId: id,
  };
}

/** 任务项勾选切换；非任务项不动 */
export function toggleTask(root: MindNode, id: string): MindNode {
  return updateNode(root, id, (n) =>
    n.kind.type === "item" && n.kind.task !== null ? { ...n, kind: { ...n.kind, task: !n.kind.task } } : n,
  );
}
