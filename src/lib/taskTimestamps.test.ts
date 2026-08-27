import { describe, it, expect } from "vitest";
import { formatTaskTime, taskTimeLines } from "./taskTimestamps";
import type { Task } from "@/types";

/** 造一个最小可用的 Task（只填本模块关心的字段） */
function mkTask(over: Partial<Task>): Task {
  return {
    id: 1,
    title: "t",
    description: null,
    priority: 1,
    important: 0,
    status: 0,
    due_date: null,
    start_date: null,
    completed_at: null,
    created_at: "2026-04-21 07:29:53",
    updated_at: "2026-04-21 07:29:53",
    ...over,
  } as Task;
}

describe("formatTaskTime", () => {
  it("解析后端真实格式 datetime('now','localtime')", () => {
    // 真实库里取的样本
    expect(formatTaskTime("2026-04-21 07:29:53")).toBe("04-21 07:29");
    expect(formatTaskTime("2026-05-23 11:05:59")).toBe("05-23 11:05");
  });

  it("withYear 带年份", () => {
    expect(formatTaskTime("2026-04-21 07:29:53", true)).toBe("2026-04-21 07:29");
  });

  it("兼容 ISO 的 T 分隔与缺省秒", () => {
    expect(formatTaskTime("2026-04-21T07:29:53")).toBe("04-21 07:29");
    expect(formatTaskTime("2026-04-21 07:29")).toBe("04-21 07:29");
  });

  it("空值 / 脏值一律返回 null，绝不吐 Invalid Date", () => {
    expect(formatTaskTime(null)).toBeNull();
    expect(formatTaskTime(undefined)).toBeNull();
    expect(formatTaskTime("")).toBeNull();
    expect(formatTaskTime("not a date")).toBeNull();
    expect(formatTaskTime("2026-04-21")).toBeNull(); // 只有日期没时间
  });

  it("首尾空白容错", () => {
    expect(formatTaskTime("  2026-04-21 07:29:53  ")).toBe("04-21 07:29");
  });
});

describe("taskTimeLines", () => {
  it("未完成任务只显示创建时间", () => {
    const lines = taskTimeLines(mkTask({ status: 0 }));
    expect(lines).toEqual([{ label: "创建", value: "04-21 07:29" }]);
  });

  it("已完成任务显示创建 + 完成", () => {
    const lines = taskTimeLines(
      mkTask({ status: 1, completed_at: "2026-05-23 11:05:59" }),
    );
    expect(lines).toEqual([
      { label: "创建", value: "04-21 07:29" },
      { label: "完成", value: "05-23 11:05" },
    ]);
  });

  it("status=1 但 completed_at 为空（历史脏数据）→ 只显示创建，不崩", () => {
    const lines = taskTimeLines(mkTask({ status: 1, completed_at: null }));
    expect(lines).toEqual([{ label: "创建", value: "04-21 07:29" }]);
  });

  it("未完成但残留 completed_at → 不显示完成时间（以 status 为准）", () => {
    const lines = taskTimeLines(
      mkTask({ status: 0, completed_at: "2026-05-23 11:05:59" }),
    );
    expect(lines).toEqual([{ label: "创建", value: "04-21 07:29" }]);
  });

  it("created_at 脏值 → 该行跳过而不是显示脏字符串", () => {
    const lines = taskTimeLines(mkTask({ created_at: "???" }));
    expect(lines).toEqual([]);
  });
});
