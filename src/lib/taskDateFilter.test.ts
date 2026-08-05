import { describe, it, expect } from "vitest";
import { filterTasksByDateRange, taskFilterDay } from "./taskDateFilter";

type Row = { id: number; status: 0 | 1 | 2; due_date: string | null; completed_at: string | null };

function t(id: number, status: Row["status"], due: string | null, completed: string | null = null): Row {
  return { id, status, due_date: due, completed_at: completed };
}

describe("taskFilterDay", () => {
  it("未完成任务看截止日期", () => {
    expect(taskFilterDay(t(1, 0, "2026-08-05 22:00"))).toBe("2026-08-05");
  });

  it("已完成任务看完成日期，而不是截止日期", () => {
    expect(taskFilterDay(t(1, 1, "2026-08-01 22:00", "2026-08-04 09:12"))).toBe("2026-08-04");
  });

  it("已放弃任务同样按完成日期算", () => {
    expect(taskFilterDay(t(1, 2, "2026-08-01", "2026-08-03"))).toBe("2026-08-03");
  });

  it("已完成但缺 completed_at 的旧数据回落到截止日期", () => {
    expect(taskFilterDay(t(1, 1, "2026-08-01", null))).toBe("2026-08-01");
  });

  it("既无截止日也无完成日 → null", () => {
    expect(taskFilterDay(t(1, 0, null))).toBeNull();
  });
});

describe("filterTasksByDateRange", () => {
  const rows = [
    t(1, 0, "2026-08-01"),
    t(2, 0, "2026-08-05"),
    t(3, 0, "2026-08-10"),
    t(4, 0, null), // 无日期
    t(5, 1, "2026-07-01", "2026-08-06"), // 完成日落在区间内，截止日不在
  ];

  it("两端都为空 = 未启用，原样返回", () => {
    expect(filterTasksByDateRange(rows, null, null)).toBe(rows);
  });

  it("闭区间含首尾两天", () => {
    const got = filterTasksByDateRange(rows, "2026-08-01", "2026-08-05").map((r) => r.id);
    expect(got).toEqual([1, 2]);
  });

  it("只给开始 = 某天及以后", () => {
    const got = filterTasksByDateRange(rows, "2026-08-05", null).map((r) => r.id);
    expect(got).toEqual([2, 3, 5]);
  });

  it("只给结束 = 某天及以前", () => {
    const got = filterTasksByDateRange(rows, null, "2026-08-05").map((r) => r.id);
    expect(got).toEqual([1, 2]);
  });

  it("已完成任务按完成日期落入区间", () => {
    const got = filterTasksByDateRange(rows, "2026-08-06", "2026-08-06").map((r) => r.id);
    expect(got).toEqual([5]);
  });

  it("无日期任务在筛选启用时被排除", () => {
    const got = filterTasksByDateRange(rows, "2026-01-01", "2026-12-31").map((r) => r.id);
    expect(got).not.toContain(4);
  });

  it("区间外全空时返回空数组", () => {
    expect(filterTasksByDateRange(rows, "2025-01-01", "2025-12-31")).toEqual([]);
  });
});
