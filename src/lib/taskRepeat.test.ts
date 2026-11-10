import { describe, expect, it } from "vitest";

import { describeRepeat, repeatDraftFromTask, repeatDraftToUpdate } from "./taskRepeat";

const r = (
  repeat_kind: string,
  repeat_interval = 1,
  repeat_weekdays: string | null = null,
) =>
  describeRepeat({
    repeat_kind: repeat_kind as never,
    repeat_interval,
    repeat_weekdays,
  });

describe("describeRepeat", () => {
  it("不循环返回空串", () => {
    expect(r("none")).toBe("");
  });

  it("天 / 月 / 周的间隔", () => {
    expect(r("daily")).toBe("每天");
    expect(r("daily", 3)).toBe("每3天");
    expect(r("monthly", 2)).toBe("每2月");
    expect(r("weekly")).toBe("每周");
    expect(r("weekly", 2)).toBe("每2周");
    // 脏数据 interval=0 按 1 处理
    expect(r("daily", 0)).toBe("每天");
  });

  it("指定星期：排序、过滤非法值、工作日简写", () => {
    expect(r("weekly", 1, "5,1,3")).toBe("周一三五");
    expect(r("weekly", 1, "1,2,3,4,5")).toBe("工作日");
    expect(r("weekly", 1, "7, 9")).toBe("周日");
  });
});

describe("repeatDraftFromTask / repeatDraftToUpdate", () => {
  const t = (repeat_kind: string, repeat_interval = 1, repeat_weekdays: string | null = null) => ({
    repeat_kind: repeat_kind as never,
    repeat_interval,
    repeat_weekdays,
  });

  it("默认间隔的常见规则落到预设，其余算自定义", () => {
    expect(repeatDraftFromTask(t("none")).preset).toBe("none");
    expect(repeatDraftFromTask(t("daily")).preset).toBe("daily");
    expect(repeatDraftFromTask(t("weekly", 1, "1,2,3,4,5")).preset).toBe("weekdays");
    expect(repeatDraftFromTask(t("weekly")).preset).toBe("weekly");
    expect(repeatDraftFromTask(t("monthly")).preset).toBe("monthly");
    expect(repeatDraftFromTask(t("weekly", 2, "1,3"))).toEqual({ preset: "custom", unit: "week", interval: 2, weekdays: [1, 3] });
    expect(repeatDraftFromTask(t("weekly", 1, "1,3,5")).preset).toBe("custom");
  });

  it("改成不重复时清掉周几与结束条件", () => {
    expect(repeatDraftToUpdate({ preset: "none", unit: "day", interval: 1, weekdays: [] })).toEqual({
      repeat_kind: "none",
      clear_repeat_weekdays: true,
      clear_repeat_until: true,
      clear_repeat_count: true,
    });
  });

  it("改规则时不碰结束条件；周几排序后写入，非按周单位清掉周几", () => {
    const weekly = repeatDraftToUpdate({ preset: "custom", unit: "week", interval: 2, weekdays: [5, 1] });
    expect(weekly).toEqual({ repeat_kind: "weekly", repeat_interval: 2, repeat_weekdays: "1,5" });
    expect(weekly).not.toHaveProperty("clear_repeat_until");
    expect(repeatDraftToUpdate({ preset: "custom", unit: "month", interval: 0, weekdays: [1] })).toEqual({
      repeat_kind: "monthly",
      repeat_interval: 1,
      clear_repeat_weekdays: true,
    });
    expect(repeatDraftToUpdate({ preset: "weekdays", unit: "week", interval: 1, weekdays: [] })).toMatchObject({
      repeat_kind: "weekly",
      repeat_weekdays: "1,2,3,4,5",
    });
  });

  it("往返一致：规则 → 预设 → 负载 不改变规则本身", () => {
    for (const task of [t("daily", 3), t("weekly", 1, "1,2,3,4,5"), t("weekly", 2, "2,4"), t("monthly")]) {
      const u = repeatDraftToUpdate(repeatDraftFromTask(task));
      expect(u.repeat_kind).toBe(task.repeat_kind);
      expect(u.repeat_interval).toBe(task.repeat_interval);
      expect(u.repeat_weekdays ?? null).toBe(task.repeat_weekdays);
    }
  });
});
