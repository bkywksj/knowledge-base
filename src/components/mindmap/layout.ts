/**
 * 思维导图布局：给定每个节点的尺寸，算出节点坐标和连线。纯函数，不碰 DOM。
 *
 * 做法（经典的水平树布局）：
 * 1. 自底向上算每棵子树占的高度 = max(自身高, 子树高之和 + 间距)；折叠的节点只算自身
 * 2. 中心主题的一级分支按子树高度分成左右两半（先填右边到总高一半，其余放左边），
 *    阅读顺序：右侧从上往下，左侧也从上往下
 * 3. 自顶向下排位：每棵子树在自己的竖条里垂直居中，子节点贴着父节点外侧排开
 *
 * 坐标系：中心主题的中心在 (0, 0)；返回的 x / y 是节点左上角。
 */
import type { MindNode } from "./tree";

export interface Size {
  w: number;
  h: number;
}

export type Side = "left" | "right" | "center";

export interface PlacedNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  side: Side;
  depth: number;
  /** 所属一级分支的序号（中心主题为 -1），用于按分支着色 */
  branch: number;
}

export interface Edge {
  from: string;
  to: string;
  side: Side;
  branch: number;
  /** 起点（父节点外侧边中点）、终点（子节点内侧边中点） */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface LayoutResult {
  nodes: PlacedNode[];
  edges: Edge[];
  /** 整张图的外接矩形，用于「适应窗口」 */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface LayoutOptions {
  /** 父子之间的水平间距 */
  hGap: number;
  /** 同级子树之间的垂直间距 */
  vGap: number;
  /** "both" = 左右分布；"right" = 全部往右 */
  mode: "both" | "right";
}

export const DEFAULT_LAYOUT: LayoutOptions = { hGap: 48, vGap: 14, mode: "both" };

/** 未量到尺寸的节点（刚新建、还没渲染）先按这个尺寸排，下一帧量到后再重排 */
const FALLBACK: Size = { w: 80, h: 32 };

export function layoutMindMap(
  root: MindNode,
  sizeOf: (id: string) => Size | undefined,
  collapsed: ReadonlySet<string>,
  opts: LayoutOptions = DEFAULT_LAYOUT,
): LayoutResult {
  const size = (id: string) => sizeOf(id) ?? FALLBACK;
  const blockH = new Map<string, number>();

  const visibleChildren = (n: MindNode) => (collapsed.has(n.id) ? [] : n.children);

  function measure(n: MindNode): number {
    const kids = visibleChildren(n);
    const own = size(n.id).h;
    let sum = 0;
    kids.forEach((c, i) => {
      sum += measure(c) + (i > 0 ? opts.vGap : 0);
    });
    const h = Math.max(own, sum);
    blockH.set(n.id, h);
    return h;
  }
  measure(root);

  const nodes: PlacedNode[] = [];
  const edges: Edge[] = [];

  const rootSize = size(root.id);
  const rootNode: PlacedNode = {
    id: root.id,
    x: -rootSize.w / 2,
    y: -rootSize.h / 2,
    w: rootSize.w,
    h: rootSize.h,
    side: "center",
    depth: 0,
    branch: -1,
  };
  nodes.push(rootNode);

  /** 一组子树在竖条 [top, top+total) 里依次排开，整体在父节点的竖直中线上居中 */
  function placeChildren(parent: PlacedNode, kids: MindNode[], side: "left" | "right", branchOf: (i: number) => number) {
    if (!kids.length) return;
    const total = kids.reduce((s, c, i) => s + blockH.get(c.id)! + (i > 0 ? opts.vGap : 0), 0);
    let top = parent.y + parent.h / 2 - total / 2;
    kids.forEach((c, i) => {
      place(c, parent, side, top, branchOf(i));
      top += blockH.get(c.id)! + opts.vGap;
    });
  }

  function place(n: MindNode, parent: PlacedNode, side: "left" | "right", top: number, branch: number) {
    const s = size(n.id);
    const block = blockH.get(n.id)!;
    const x = side === "right" ? parent.x + parent.w + opts.hGap : parent.x - opts.hGap - s.w;
    const placed: PlacedNode = {
      id: n.id,
      x,
      y: top + (block - s.h) / 2,
      w: s.w,
      h: s.h,
      side,
      depth: parent.depth + 1,
      branch,
    };
    nodes.push(placed);
    edges.push({
      from: parent.id,
      to: n.id,
      side,
      branch,
      x1: side === "right" ? parent.x + parent.w : parent.x,
      y1: parent.y + parent.h / 2,
      x2: side === "right" ? placed.x : placed.x + placed.w,
      y2: placed.y + placed.h / 2,
    });
    placeChildren(placed, visibleChildren(n), side, () => branch);
  }

  const first = visibleChildren(root);
  const { right, left } = splitSides(first, blockH, opts);
  const branchIndex = new Map(first.map((c, i) => [c.id, i]));
  placeChildren(rootNode, right, "right", (i) => branchIndex.get(right[i].id)!);
  placeChildren(rootNode, left, "left", (i) => branchIndex.get(left[i].id)!);

  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of nodes) {
    bounds.minX = Math.min(bounds.minX, p.x);
    bounds.minY = Math.min(bounds.minY, p.y);
    bounds.maxX = Math.max(bounds.maxX, p.x + p.w);
    bounds.maxY = Math.max(bounds.maxY, p.y + p.h);
  }

  return { nodes, edges, bounds };
}

/**
 * 拖放命中：指针（画布坐标）落在哪个节点上、放在它的前 / 后 / 里面。
 * - 节点上沿 1/4 → before，下沿 1/4 → after，中间 → inside（成为子节点）
 * - 中心主题只能 inside；被拖的节点及其子孙不参与命中（exclude 由调用方给）
 * - 不在任何节点上 → null（松手即取消）
 */
export function hitDropTarget(
  nodes: PlacedNode[],
  x: number,
  y: number,
  exclude: ReadonlySet<string>,
): { id: string; position: "before" | "after" | "inside" } | null {
  // 节点不重叠，命中至多一个；四周放宽几像素，贴边松手也算
  const slop = 4;
  for (const p of nodes) {
    if (exclude.has(p.id)) continue;
    if (x < p.x - slop || x > p.x + p.w + slop || y < p.y - slop || y > p.y + p.h + slop) continue;
    if (p.depth === 0) return { id: p.id, position: "inside" };
    const rel = (y - p.y) / p.h;
    return { id: p.id, position: rel < 0.25 ? "before" : rel > 0.75 ? "after" : "inside" };
  }
  return null;
}

/**
 * 一级分支分左右：按顺序往右边放，直到右边累计高度达到总高的一半，其余放左边。
 * 保持原顺序（不做最优装箱），这样和大纲里的顺序一致、用户好对应。
 * 只有 1 个分支时放右边。
 */
export function splitSides(
  kids: MindNode[],
  blockH: Map<string, number>,
  opts: LayoutOptions,
): { right: MindNode[]; left: MindNode[] } {
  if (opts.mode === "right" || kids.length < 2) return { right: kids, left: [] };
  const total = kids.reduce((s, c) => s + blockH.get(c.id)!, 0);
  let acc = 0;
  let cut = 0;
  while (cut < kids.length - 1) {
    const h = blockH.get(kids[cut].id)!;
    // 放进这一个后离「一半」更远了就停（至少放一个）
    if (cut > 0 && Math.abs(acc + h - total / 2) > Math.abs(acc - total / 2)) break;
    acc += h;
    cut += 1;
  }
  return { right: kids.slice(0, cut), left: kids.slice(cut) };
}
