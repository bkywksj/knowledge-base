import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@/types";
import {
  applySmartFilter,
  describeDueDate,
  dueShortText,
  filterToStatusArg,
  groupTasks,
} from "./taskFilters";

// 固定「今天」= 2026-11-10（周二），避免跨天跑测试结果不稳定
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 10, 9, 0, 0));
});
afterEach(() => {
  vi.useRealTimers();
});

function task(id: number, over: Partial<Task> = {}): Task {
  return {
    id,
    title: `任务 ${id}`,
    status: 0,
    priority: 1,
    due_date: null,
    repeat_kind: "none",
    links: [],
    ...over,
  } as Task;
}

const T = {
  overdue: task(1, { due_date: "2026-11-08 18:00" }),
  today: task(2, { due_date: "2026-11-10 14:00", priority: 0 }),
  week: task(3, { due_date: "2026-11-14" }),
  far: task(4, { due_date: "2026-12-30", priority: 2 }),
  noDate: task(5),
  done: task(6, { status: 1, due_date: "2026-11-01" }),
  abandoned: task(7, { status: 2, due_date: "2026-11-01" }),
  recurring: task(8, { repeat_kind: "daily", due_date: "2026-11-10" }),
};
const ALL = Object.values(T);

describe("filterToStatusArg", () => {
  it("已完成 / 已放弃 / 全部分别对应后端 status，其余维度都只查未完成", () => {
    expect(filterToStatusArg("done")).toBe(1);
    expect(filterToStatusArg("abandoned")).toBe(2);
    expect(filterToStatusArg("all")).toBeUndefined();
    expect(filterToStatusArg("overdue")).toBe(0);
    expect(filterToStatusArg("urgent")).toBe(0);
  });
});

describe("applySmartFilter", () => {
  const ids = (list: Task[]) => list.map((t) => t.id).sort((a, b) => a - b);

  it("逾期 / 今天 / 本周 / 无日期按截止日划分，已完成的不算逾期", () => {
    expect(ids(applySmartFilter(ALL, "overdue"))).toEqual([1]);
    expect(ids(applySmartFilter(ALL, "today"))).toEqual([2, 8]);
    expect(ids(applySmartFilter(ALL, "week"))).toEqual([3]);
    expect(ids(applySmartFilter(ALL, "no-date"))).toEqual([5]);
  });

  it("优先级与循环只看未完成", () => {
    expect(ids(applySmartFilter(ALL, "urgent"))).toEqual([2]);
    expect(ids(applySmartFilter(ALL, "low"))).toEqual([4]);
    expect(ids(applySmartFilter(ALL, "recurring"))).toEqual([8]);
  });

  it("列表视图摘掉已放弃；日历 / 甘特保留", () => {
    expect(ids(applySmartFilter(ALL, "todo", "list"))).not.toContain(7);
    expect(ids(applySmartFilter(ALL, "todo", "calendar"))).toContain(7);
  });
});

describe("groupTasks", () => {
  it("已完成与已放弃进底部折叠区，其余按逾期 / 今天 / 之后 / 无日期分组", () => {
    const g = groupTasks(ALL);
    expect(g.overdue.map((t) => t.id)).toEqual([1]);
    expect(g.today.map((t) => t.id)).toEqual([2, 8]);
    expect(g.upcoming.map((t) => t.id)).toEqual([3, 4]);
    expect(g.noDate.map((t) => t.id)).toEqual([5]);
    expect(g.done.map((t) => t.id)).toEqual([6, 7]);
  });
});

describe("截止时间文案", () => {
  it("describeDueDate：逾期 N 天标红，已完成退化为中性日期", () => {
    expect(describeDueDate("2026-11-08 18:00")).toEqual({ text: "逾期 2 天 18:00", overdue: true });
    expect(describeDueDate("2026-11-10 14:00")).toEqual({ text: "今天 14:00", overdue: false });
    expect(describeDueDate("2026-11-08", true)).toEqual({ text: "2026-11-08", overdue: false });
  });

  it("dueShortText：今天给时分，昨天 / 明天 / 周几 / MM-DD", () => {
    expect(dueShortText("2026-11-10 14:00")).toBe("14:00");
    expect(dueShortText("2026-11-09")).toBe("昨天");
    expect(dueShortText("2026-11-11 09:30")).toBe("明天 09:30");
    expect(dueShortText("2026-11-13")).toBe("周五");
    expect(dueShortText("2026-12-30")).toBe("12-30");
    expect(dueShortText(null)).toBe("");
  });
});
