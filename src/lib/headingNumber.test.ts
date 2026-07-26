import { describe, it, expect } from "vitest";
import {
  computeLabels,
  hasManualNumber,
  stripManualNumber,
  toChineseNumber,
} from "./headingNumber";

/** 测试助手：把 "1,2,2,1" 这样的层级串变成 items，标题文本用占位符 */
function h(levels: number[], texts?: string[]) {
  return levels.map((level, i) => ({ level, text: texts?.[i] ?? `标题${i + 1}` }));
}

/** 只取 label，便于断言 */
function labels(items: { level: number; text: string }[], opts = {}) {
  return computeLabels(items, opts).map((e) => e.label);
}

describe("computeLabels · 基础层级", () => {
  it("同级递增、进入下级从 1 开始", () => {
    expect(labels(h([1, 2, 2, 1]))).toEqual(["1", "1.1", "1.2", "2"]);
  });

  it("回到上级时下级必须重置（旧 CSS 方案在折叠后失效的正是这条）", () => {
    // H1 / H2 / H3 / H3 / H2 / H3
    expect(labels(h([1, 2, 3, 3, 2, 3]))).toEqual([
      "1",
      "1.1",
      "1.1.1",
      "1.1.2",
      "1.2",
      "1.2.1",
    ]);
  });

  it("用户反馈场景：跨 H2 后 H3 从 1 重新编号，而不是继续累加", () => {
    // 笔记模块(H2) 下 9 个 H3 → AI问答模块(H2) 下第 1 个 H3
    const levels = [1, 2, ...Array(9).fill(3), 2, 3];
    const got = labels(h(levels));
    expect(got[got.length - 3]).toBe("1.1.9"); // 笔记模块最后一条
    expect(got[got.length - 2]).toBe("1.2"); // AI问答模块
    expect(got[got.length - 1]).toBe("1.2.1"); // 不是 "1.2.10"
  });

  it("六级全开", () => {
    expect(labels(h([1, 2, 3, 4, 5, 6]))).toEqual([
      "1",
      "1.1",
      "1.1.1",
      "1.1.1.1",
      "1.1.1.1.1",
      "1.1.1.1.1.1",
    ]);
  });

  it("空输入返回空数组", () => {
    expect(labels([])).toEqual([]);
  });
});

describe("computeLabels · 跳级容错", () => {
  it("H1 直接跟 H3，中间缺失层级按 1 计", () => {
    expect(labels(h([1, 3]))).toEqual(["1", "1.1.1"]);
  });

  it("文档从 H3 开头也能给出完整编号", () => {
    expect(labels(h([3]))).toEqual(["1.1.1"]);
  });

  it("跳级后回到中间层级，继续接在补出来的 1 之后", () => {
    expect(labels(h([1, 3, 2]))).toEqual(["1", "1.1.1", "1.2"]);
  });
});

describe("computeLabels · 手写编号（AI 生成文档场景）", () => {
  it("默认跳过已手写编号的标题，避免出现「1.1.1 1.1 公司定位」", () => {
    const items = h([1, 2, 2], ["产品方案", "1.1 公司定位", "硬件产品"]);
    expect(labels(items)).toEqual(["1", null, "1.2"]);
  });

  it("被跳过的标题仍占计数位，后续编号不错位", () => {
    // 三个 H2 但文档里没有 H1 → 上层按跳级规则补 1，第三个标题应是 1.3 而非 1.1
    const items = h([2, 2, 2], ["一、现状", "二、目标", "落地路径"]);
    expect(labels(items)).toEqual([null, null, "1.3"]);
  });

  it("skipManual=false 时照常叠加（保留旧行为的逃生口）", () => {
    const items = h([1, 2], ["产品方案", "1.1 公司定位"]);
    expect(labels(items, { skipManual: false })).toEqual(["1", "1.1"]);
  });
});

describe("hasManualNumber · 保守识别，不误伤正常标题", () => {
  it.each([
    "1.1 公司定位",
    "1.2.3 硬件产品",
    "1. 概述",
    "2、背景",
    "一、现状分析",
    "（一）目标",
    "(1) 步骤",
    "第一章 总则",
    "第 2 节 实施",
  ])("认得出手写编号：%s", (text) => {
    expect(hasManualNumber(text)).toBe(true);
  });

  it.each([
    "2026 年度总结",
    "3 分钟看懂 Tauri",
    "第一次做产品的坑",
    "V5.0 版本说明",
    "架构设计",
  ])("不误判正常标题：%s", (text) => {
    expect(hasManualNumber(text)).toBe(false);
  });
});

describe("stripManualNumber", () => {
  it("剥掉手写编号，保留正文", () => {
    expect(stripManualNumber("1.1 公司定位")).toBe("公司定位");
    expect(stripManualNumber("一、现状分析")).toBe("现状分析");
    expect(stripManualNumber("（一）目标")).toBe("目标");
    expect(stripManualNumber("第一章 总则")).toBe("总则");
  });

  it("没有手写编号时原样返回", () => {
    expect(stripManualNumber("架构设计")).toBe("架构设计");
    expect(stripManualNumber("2026 年度总结")).toBe("2026 年度总结");
  });

  it("整段都是编号时不清空（避免标题变空）", () => {
    expect(stripManualNumber("1.1")).toBe("1.1");
  });
});

describe("computeLabels · 层级范围", () => {
  it("startLevel=2 时 H1 不编号，H2 从 1 起算", () => {
    const items = h([1, 2, 3, 2]);
    expect(labels(items, { startLevel: 2 })).toEqual([null, "1", "1.1", "2"]);
  });

  it("maxLevel=3 时 H4 及以下不编号，也不打乱上层计数", () => {
    const items = h([1, 2, 3, 4, 3]);
    expect(labels(items, { maxLevel: 3 })).toEqual([
      "1",
      "1.1",
      "1.1.1",
      null,
      "1.1.2",
    ]);
  });
});

describe("computeLabels · 中文公文格式", () => {
  it("按层级换符号，且不累积", () => {
    const items = h([1, 2, 3, 4, 2]);
    expect(labels(items, { format: "chineseOutline" })).toEqual([
      "一、",
      "（一）",
      "1.",
      "（1）",
      "（二）",
    ]);
  });
});

describe("toChineseNumber", () => {
  it.each([
    [1, "一"],
    [9, "九"],
    [10, "十"],
    [11, "十一"],
    [19, "十九"],
    [20, "二十"],
    [21, "二十一"],
    [99, "九十九"],
  ])("%i → %s", (n, expected) => {
    expect(toChineseNumber(n)).toBe(expected);
  });

  it("超出范围回退阿拉伯数字", () => {
    expect(toChineseNumber(100)).toBe("100");
  });
});
