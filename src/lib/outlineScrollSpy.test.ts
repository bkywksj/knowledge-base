import { describe, it, expect } from "vitest";
import { pickActiveIndex, type OutlineProbe } from "./outlineScrollSpy";

/** 测试助手：把一串 top 值（null = 折叠/无 DOM）变成探针数组 */
function probes(tops: (number | null)[]): OutlineProbe[] {
  return tops.map((top) => ({ top }));
}

/** 常用场景：容器顶 0、工具栏 80px、呼吸 8px → 判定线 88；容器高 800 */
const CTX = { lineY: 88, bottomY: 800, atBottom: false };

describe("pickActiveIndex · 基础判定", () => {
  it("取最后一个已越过判定线的标题", () => {
    // 标题 0/1 已滚过工具栏下沿，2/3 还在下方
    expect(pickActiveIndex(probes([-200, 40, 300, 600]), CTX)).toBe(1);
  });

  it("恰好压在判定线上算已越过（滚动落点就是这个位置）", () => {
    expect(pickActiveIndex(probes([-200, 88, 300]), CTX)).toBe(1);
  });

  it("还没滚到第一个标题时高亮第一条，不留空", () => {
    expect(pickActiveIndex(probes([300, 600]), CTX)).toBe(0);
  });

  it("没有任何可用标题时返回 -1", () => {
    expect(pickActiveIndex(probes([null, null]), CTX)).toBe(-1);
    expect(pickActiveIndex([], CTX)).toBe(-1);
  });
});

describe("pickActiveIndex · 相邻标题挨得近（本次 bug 的核心场景）", () => {
  it("目标标题停在工具栏下沿时，高亮归目标而不是躲在工具栏底下的上一条", () => {
    // 点击第 2 条后：第 1 条被推到 top=48（仍在容器矩形内，但被 80px 工具栏遮住），
    // 第 2 条落在判定线 88。旧实现取"相交项里 top 最小的"会选中第 1 条 → 看似点不动。
    expect(pickActiveIndex(probes([48, 88, 400]), CTX)).toBe(1);
  });

  it("连续三个紧挨的标题逐个点击，高亮逐个跟上", () => {
    expect(pickActiveIndex(probes([88, 128, 168]), CTX)).toBe(0);
    expect(pickActiveIndex(probes([48, 88, 128]), CTX)).toBe(1);
    expect(pickActiveIndex(probes([8, 48, 88]), CTX)).toBe(2);
  });
});

describe("pickActiveIndex · 滚到底的尾部标题", () => {
  it("滚到底时取视野内最靠下的标题（尾部标题越不过判定线也能点亮）", () => {
    // 末尾两条被 clamp 卡在判定线下方，主规则只能选到 index 1
    const tops = probes([-400, 40, 300, 500]);
    expect(pickActiveIndex(tops, CTX)).toBe(1);
    expect(pickActiveIndex(tops, { ...CTX, atBottom: true })).toBe(3);
  });

  it("滚到底但最后一条仍在容器视野外时不越界选它", () => {
    // bottomY=800，最后一条 top=900 在视野外
    expect(pickActiveIndex(probes([-400, 40, 500, 900]), { ...CTX, atBottom: true })).toBe(2);
  });
});

describe("pickActiveIndex · 折叠隐藏的标题", () => {
  it("被折叠的标题（top=null）不参与判定，不会因 rect 全 0 抢走高亮", () => {
    // index 1、2 被折叠隐藏；若把它们当 top=0 处理会误选 index 2
    expect(pickActiveIndex(probes([-200, null, null, 300]), CTX)).toBe(0);
  });

  it("折叠项也不会被选为兜底的第一条", () => {
    expect(pickActiveIndex(probes([null, 300, 600]), CTX)).toBe(1);
  });
});
