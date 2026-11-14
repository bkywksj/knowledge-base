import { describe, it, expect } from "vitest";
import { hitDropTarget, layoutMindMap, type PlacedNode } from "./layout";
import { parseMindMap, type MindNode } from "./tree";

const SIZE = { w: 100, h: 30 };
const OPTS = { hGap: 40, vGap: 10, mode: "both" as const };

function byText(root: MindNode, nodes: PlacedNode[]) {
  const map = new Map<string, PlacedNode>();
  const walk = (n: MindNode) => {
    const p = nodes.find((x) => x.id === n.id);
    if (p) map.set(n.text, p);
    n.children.forEach(walk);
  };
  walk(root);
  return map;
}

function overlaps(a: PlacedNode, b: PlacedNode) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe("layoutMindMap", () => {
  it("中心主题居中在原点", () => {
    const { root } = parseMindMap("", "中心");
    const r = layoutMindMap(root, () => SIZE, new Set(), OPTS);
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0]).toMatchObject({ x: -50, y: -15, side: "center" });
  });

  it("一级分支左右分布：前一半在右、其余在左，各自保持原顺序从上到下", () => {
    const { root } = parseMindMap("- A\n- B\n- C\n- D\n", "c");
    const m = byText(root, layoutMindMap(root, () => SIZE, new Set(), OPTS).nodes);
    expect(m.get("A")!.side).toBe("right");
    expect(m.get("B")!.side).toBe("right");
    expect(m.get("C")!.side).toBe("left");
    expect(m.get("D")!.side).toBe("left");
    expect(m.get("A")!.y).toBeLessThan(m.get("B")!.y);
    expect(m.get("C")!.y).toBeLessThan(m.get("D")!.y);
    // 右侧节点左边缘 = 中心右边缘 + 间距；左侧节点右边缘 = 中心左边缘 - 间距
    expect(m.get("A")!.x).toBe(50 + 40);
    expect(m.get("C")!.x + 100).toBe(-50 - 40);
  });

  it("只往右模式：全部在右", () => {
    const { root } = parseMindMap("- A\n- B\n- C\n", "c");
    const r = layoutMindMap(root, () => SIZE, new Set(), { ...OPTS, mode: "right" });
    expect(r.nodes.filter((n) => n.side === "left")).toHaveLength(0);
  });

  it("父节点在其子树竖条里垂直居中；节点两两不重叠", () => {
    const { root } = parseMindMap("- A\n  - A1\n  - A2\n  - A3\n- B\n  - B1\n", "c");
    const r = layoutMindMap(root, () => SIZE, new Set(), OPTS);
    const m = byText(root, r.nodes);
    const a = m.get("A")!;
    const mid = (m.get("A1")!.y + m.get("A3")!.y + SIZE.h) / 2;
    expect(a.y + SIZE.h / 2).toBeCloseTo(mid);
    for (let i = 0; i < r.nodes.length; i++) {
      for (let j = i + 1; j < r.nodes.length; j++) {
        expect(overlaps(r.nodes[i], r.nodes[j]), `${r.nodes[i].id} vs ${r.nodes[j].id}`).toBe(false);
      }
    }
  });

  it("折叠的节点不排子节点；连线数 = 可见节点数 - 1", () => {
    const { root } = parseMindMap("- A\n  - A1\n  - A2\n- B\n", "c");
    const aId = root.children[0].id;
    const r = layoutMindMap(root, () => SIZE, new Set([aId]), OPTS);
    expect(r.nodes.map((n) => n.id)).not.toContain(root.children[0].children[0].id);
    expect(r.edges).toHaveLength(r.nodes.length - 1);
  });

  it("按一级分支编号着色：子孙继承所在分支", () => {
    const { root } = parseMindMap("- A\n  - A1\n- B\n", "c");
    const m = byText(root, layoutMindMap(root, () => SIZE, new Set(), OPTS).nodes);
    expect(m.get("A1")!.branch).toBe(m.get("A")!.branch);
    expect(m.get("B")!.branch).not.toBe(m.get("A")!.branch);
  });

  it("用实际尺寸排：宽节点把子节点推得更远；没量到的按默认尺寸", () => {
    const { root } = parseMindMap("- 很宽\n  - 子\n", "c");
    const wideId = root.children[0].id;
    const r = layoutMindMap(root, (id) => (id === wideId ? { w: 300, h: 30 } : undefined), new Set(), OPTS);
    const m = byText(root, r.nodes);
    expect(m.get("子")!.x).toBe(m.get("很宽")!.x + 300 + 40);
    expect(m.get("子")!.w).toBe(80); // FALLBACK
  });
});

describe("hitDropTarget", () => {
  const nodes: PlacedNode[] = [
    { id: "root", x: -50, y: -15, w: 100, h: 30, side: "center", depth: 0, branch: -1 },
    { id: "a", x: 90, y: -50, w: 100, h: 40, side: "right", depth: 1, branch: 0 },
  ];
  it("上沿 1/4 前插、下沿 1/4 后插、中间当子节点", () => {
    expect(hitDropTarget(nodes, 120, -48, new Set())).toEqual({ id: "a", position: "before" });
    expect(hitDropTarget(nodes, 120, -30, new Set())).toEqual({ id: "a", position: "inside" });
    expect(hitDropTarget(nodes, 120, -12, new Set())).toEqual({ id: "a", position: "after" });
  });
  it("中心主题只能放进去；排除的节点不命中；空白处返回 null", () => {
    expect(hitDropTarget(nodes, 0, -14, new Set())).toEqual({ id: "root", position: "inside" });
    expect(hitDropTarget(nodes, 120, -30, new Set(["a"]))).toBeNull();
    expect(hitDropTarget(nodes, 500, 500, new Set())).toBeNull();
  });
});
