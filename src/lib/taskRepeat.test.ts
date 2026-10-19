import { describe, expect, it } from "vitest";

import { describeRepeat } from "./taskRepeat";

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
