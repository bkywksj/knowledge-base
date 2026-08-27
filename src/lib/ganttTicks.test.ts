import { describe, it, expect } from "vitest";
import {
  buildGanttTicks,
  pxPerDayFor,
  tickSpanFor,
  todayOffsetPx,
} from "./ganttTicks";

/** 用户截图里的真实范围：2026-07-03 — 2026-10-30（约 119 天） */
const START = new Date(2026, 6, 3); // 月份 0-based：6 = 七月
const DAYS = 119;

describe("按周模式：标题不再空白（本次修复的核心）", () => {
  it("每一格都有标签", () => {
    const ticks = buildGanttTicks(START, DAYS, "week");
    expect(ticks.length).toBeGreaterThan(0);
    // 修复前：只有第一格和每月 1 号有字，其余是 ""
    const blank = ticks.filter((t) => t.label === "");
    expect(blank).toEqual([]);
  });

  it("标签是该周起始日", () => {
    const ticks = buildGanttTicks(START, DAYS, "week");
    expect(ticks[0].label).toBe("7/3");
    expect(ticks[1].label).toBe("7/10");
    expect(ticks[2].label).toBe("7/17");
  });

  it("每格跨 7 天，格数约为天数的 1/7", () => {
    const ticks = buildGanttTicks(START, DAYS, "week");
    expect(ticks.length).toBe(Math.ceil(DAYS / 7));
    expect(ticks[0].spanDays).toBe(7);
  });

  it("按周画布比按天窄（修复前反而宽 3 倍）", () => {
    const dayWidth = DAYS * pxPerDayFor("day"); // 119 × 22 = 2618
    const weekWidth = DAYS * pxPerDayFor("week"); // 119 × 10 = 1190
    expect(weekWidth).toBeLessThan(dayWidth);
    // 修复前是 119 × 70 = 8330，比按天还宽
    expect(weekWidth).toBeLessThan(DAYS * 70);
  });

  it("一周仍占 70px，视觉密度与改造前一致", () => {
    expect(pxPerDayFor("week") * tickSpanFor("week")).toBe(70);
  });

  it("末尾不足一整周时按剩余天数算，不超出总宽", () => {
    // 10 天 = 1 整周 + 3 天
    const ticks = buildGanttTicks(START, 10, "week");
    expect(ticks.length).toBe(2);
    expect(ticks[0].spanDays).toBe(7);
    expect(ticks[1].spanDays).toBe(3);
    const total = ticks.reduce((s, t) => s + t.spanDays, 0);
    expect(total).toBe(10);
  });

  it("跨月的那一周标记 isMonthStart（只判起始日会整年画不出分隔线）", () => {
    // 7/3 起第 5 格 = 7/31，其 7 天内含 8/1
    const ticks = buildGanttTicks(START, DAYS, "week");
    const crossing = ticks.find((t) => t.label === "7/31");
    expect(crossing?.isMonthStart).toBe(true);
    // 完全在月中的一周不标记
    const midMonth = ticks.find((t) => t.label === "7/10");
    expect(midMonth?.isMonthStart).toBe(false);
  });

  it("按周模式不标周末（整格跨越工作日与周末，标了没意义）", () => {
    const ticks = buildGanttTicks(START, DAYS, "week");
    expect(ticks.every((t) => t.isWeekend === false)).toBe(true);
  });
});

describe("按天模式：保持原有行为", () => {
  it("每天一格，标签为 M/D", () => {
    const ticks = buildGanttTicks(START, 5, "day");
    expect(ticks.length).toBe(5);
    expect(ticks.map((t) => t.label)).toEqual([
      "7/3",
      "7/4",
      "7/5",
      "7/6",
      "7/7",
    ]);
    expect(ticks.every((t) => t.spanDays === 1)).toBe(true);
  });

  it("周末被标记", () => {
    // 2026-07-03 是周五 → 7/4 周六、7/5 周日
    const ticks = buildGanttTicks(START, 5, "day");
    expect(ticks[0].isWeekend).toBe(false); // 周五
    expect(ticks[1].isWeekend).toBe(true); // 周六
    expect(ticks[2].isWeekend).toBe(true); // 周日
    expect(ticks[3].isWeekend).toBe(false); // 周一
  });

  it("每月 1 号标记 isMonthStart", () => {
    const ticks = buildGanttTicks(new Date(2026, 6, 30), 5, "day");
    const first = ticks.find((t) => t.label === "8/1");
    expect(first?.isMonthStart).toBe(true);
  });

  it("每天 22px 不变", () => {
    expect(pxPerDayFor("day")).toBe(22);
    expect(tickSpanFor("day")).toBe(1);
  });
});

describe("todayOffsetPx", () => {
  it("范围内按天偏移换算", () => {
    const now = new Date(2026, 6, 6); // 起点后第 3 天
    expect(todayOffsetPx(START, new Date(2026, 6, 30), 22, now)).toBe(3 * 22);
    expect(todayOffsetPx(START, new Date(2026, 6, 30), 10, now)).toBe(3 * 10);
  });

  it("超出范围返回 null", () => {
    expect(
      todayOffsetPx(START, new Date(2026, 6, 10), 22, new Date(2026, 6, 1)),
    ).toBeNull();
    expect(
      todayOffsetPx(START, new Date(2026, 6, 10), 22, new Date(2026, 7, 1)),
    ).toBeNull();
  });

  it("当天带时分也按 0 点算，不出现小数偏移", () => {
    const now = new Date(2026, 6, 6, 15, 42, 7);
    expect(todayOffsetPx(START, new Date(2026, 6, 30), 22, now)).toBe(3 * 22);
  });
});
