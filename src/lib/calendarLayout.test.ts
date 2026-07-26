import { describe, it, expect } from "vitest";
import dayjs from "dayjs";
import { layoutWeek, shiftRangeTo, taskRange } from "./calendarLayout";
import type { Task } from "@/types";

/** 造一条最小可用的 Task；只填布局用得上的字段，其余给类型要求的默认值 */
function task(p: Partial<Task> & { id: number }): Task {
  return {
    title: `任务${p.id}`,
    description: null,
    priority: 1,
    important: false,
    status: 0,
    due_date: null,
    completed_at: null,
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
    remind_before_minutes: null,
    reminded_at: null,
    repeat_kind: "none",
    repeat_interval: 1,
    repeat_weekdays: null,
    repeat_until: null,
    repeat_count: null,
    repeat_done_count: 0,
    source_batch_id: null,
    category_id: null,
    parent_task_id: null,
    kanban_stage: "todo",
    project_id: null,
    start_date: null,
    stable_uuid: null,
    is_deleted: false,
    subtask_done: 0,
    subtask_total: 0,
    links: [],
    ...p,
  } as Task;
}

/** 2026-07-06 是周一 */
const WEEK = dayjs("2026-07-06");

describe("taskRange", () => {
  it("start + due 组成区间", () => {
    const r = taskRange(task({ id: 1, start_date: "2026-07-07", due_date: "2026-07-10 18:00:00" }));
    expect(r?.from.format("YYYY-MM-DD")).toBe("2026-07-07");
    expect(r?.to.format("YYYY-MM-DD")).toBe("2026-07-10");
  });

  it("只有 due 时退化成当天一格（老的截止点语义）", () => {
    const r = taskRange(task({ id: 1, due_date: "2026-07-08 09:00:00" }));
    expect(r?.from.isSame(r!.to, "day")).toBe(true);
  });

  it("两个日期都没有 → 不上日历", () => {
    expect(taskRange(task({ id: 1 }))).toBeNull();
  });

  it("脏数据（开始晚于结束）自动交换，不产生负宽度的条", () => {
    const r = taskRange(task({ id: 1, start_date: "2026-07-10", due_date: "2026-07-07" }));
    expect(r?.from.format("YYYY-MM-DD")).toBe("2026-07-07");
    expect(r?.to.format("YYYY-MM-DD")).toBe("2026-07-10");
  });
});

describe("layoutWeek · 列计算", () => {
  it("周一到周三的区间落在 0–2 列，且不带截断箭头", () => {
    const bars = layoutWeek(WEEK, [
      task({ id: 1, start_date: "2026-07-06", due_date: "2026-07-08" }),
    ]);
    expect(bars).toHaveLength(1);
    expect(bars[0].startCol).toBe(0);
    expect(bars[0].endCol).toBe(2);
    expect(bars[0].continuesLeft).toBe(false);
    expect(bars[0].continuesRight).toBe(false);
  });

  it("跨到上一周的区间：左端截断到 0 列并标记 continuesLeft", () => {
    const bars = layoutWeek(WEEK, [
      task({ id: 1, start_date: "2026-07-01", due_date: "2026-07-08" }),
    ]);
    expect(bars[0].startCol).toBe(0);
    expect(bars[0].continuesLeft).toBe(true);
    expect(bars[0].continuesRight).toBe(false);
  });

  it("跨到下一周的区间：右端截断到 6 列并标记 continuesRight", () => {
    const bars = layoutWeek(WEEK, [
      task({ id: 1, start_date: "2026-07-09", due_date: "2026-07-20" }),
    ]);
    expect(bars[0].endCol).toBe(6);
    expect(bars[0].continuesRight).toBe(true);
  });

  it("整周被跨过（前后都在本周之外）：两端都截断，占满 0–6", () => {
    const bars = layoutWeek(WEEK, [
      task({ id: 1, start_date: "2026-06-20", due_date: "2026-07-25" }),
    ]);
    expect(bars[0].startCol).toBe(0);
    expect(bars[0].endCol).toBe(6);
    expect(bars[0].continuesLeft).toBe(true);
    expect(bars[0].continuesRight).toBe(true);
  });

  it("与本周无交集的任务被跳过", () => {
    const bars = layoutWeek(WEEK, [
      task({ id: 1, due_date: "2026-06-01" }),
      task({ id: 2, due_date: "2026-08-01" }),
      task({ id: 3 }), // 没有任何日期
    ]);
    expect(bars).toHaveLength(0);
  });
});

describe("shiftRangeTo · 拖动区间任务", () => {
  it("整体平移：落点成为新开始日，跨度保持不变", () => {
    const t = task({ id: 1, start_date: "2026-07-08", due_date: "2026-07-15 09:00:00" });
    expect(shiftRangeTo(t, "2026-07-20")).toEqual({
      start_date: "2026-07-20",
      due_date: "2026-07-27", // 原跨度 7 天，平移后保持
    });
  });

  it("往前拖同样保持跨度", () => {
    const t = task({ id: 1, start_date: "2026-07-08", due_date: "2026-07-10" });
    expect(shiftRangeTo(t, "2026-07-01")).toEqual({
      start_date: "2026-07-01",
      due_date: "2026-07-03",
    });
  });

  it("拖回原位（落点 = 当前开始日）→ null，调用方不必发请求", () => {
    const t = task({ id: 1, start_date: "2026-07-08", due_date: "2026-07-15" });
    expect(shiftRangeTo(t, "2026-07-08")).toBeNull();
  });

  it("非区间任务 → null，走原来的「只改截止日」逻辑", () => {
    const t = task({ id: 1, due_date: "2026-07-08 09:00:00" });
    expect(shiftRangeTo(t, "2026-07-20")).toBeNull();
  });
});

describe("layoutWeek · 跑道分配", () => {
  it("时间不重叠的任务复用同一条跑道", () => {
    const bars = layoutWeek(WEEK, [
      task({ id: 1, start_date: "2026-07-06", due_date: "2026-07-07" }),
      task({ id: 2, start_date: "2026-07-09", due_date: "2026-07-10" }),
    ]);
    expect(bars.map((b) => b.lane)).toEqual([0, 0]);
  });

  it("时间重叠的任务依次往下排跑道", () => {
    const bars = layoutWeek(WEEK, [
      task({ id: 1, start_date: "2026-07-06", due_date: "2026-07-10" }),
      task({ id: 2, start_date: "2026-07-07", due_date: "2026-07-09" }),
      task({ id: 3, start_date: "2026-07-08", due_date: "2026-07-08" }),
    ]);
    expect([...bars].sort((a, b) => a.task.id - b.task.id).map((b) => b.lane)).toEqual([
      0, 1, 2,
    ]);
  });

  it("首尾相接（前一条结束当天下一条开始）视为冲突，不挤在同一跑道", () => {
    // 同一天里两条都要露出来，否则用户会以为任务丢了
    const bars = layoutWeek(WEEK, [
      task({ id: 1, start_date: "2026-07-06", due_date: "2026-07-08" }),
      task({ id: 2, start_date: "2026-07-08", due_date: "2026-07-10" }),
    ]);
    expect(bars.map((b) => b.lane)).toEqual([0, 1]);
  });

  it("同一起始列时长条排在上面（信息量大的优先占顶部跑道）", () => {
    const bars = layoutWeek(WEEK, [
      task({ id: 1, start_date: "2026-07-06", due_date: "2026-07-06" }),
      task({ id: 2, start_date: "2026-07-06", due_date: "2026-07-10" }),
    ]);
    const byId = new Map(bars.map((b) => [b.task.id, b.lane]));
    expect(byId.get(2)).toBe(0);
    expect(byId.get(1)).toBe(1);
  });

  it("同起始列同长度时未完成排在已完成之前", () => {
    const bars = layoutWeek(WEEK, [
      task({ id: 1, start_date: "2026-07-06", due_date: "2026-07-07", status: 1 }),
      task({ id: 2, start_date: "2026-07-06", due_date: "2026-07-07", status: 0 }),
    ]);
    const byId = new Map(bars.map((b) => [b.task.id, b.lane]));
    expect(byId.get(2)).toBe(0);
    expect(byId.get(1)).toBe(1);
  });
});
