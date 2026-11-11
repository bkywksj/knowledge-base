import { describe, expect, it } from "vitest";
import { dueChipLabel, remindLabel, toLocalInput, toSqliteDate } from "./taskForm";

describe("待办表单小工具", () => {
  const now = new Date(2026, 10, 11, 10, 0, 0); // 2026-11-11

  it("截止胶囊文案：今天 / 明天 / 本年 / 跨年，23:59 不写时间", () => {
    expect(dueChipLabel("2026-11-11 14:00:00", now)).toBe("今天 14:00");
    expect(dueChipLabel("2026-11-11 23:59:59", now)).toBe("今天");
    expect(dueChipLabel("2026-11-12 18:00:00", now)).toBe("明天 18:00");
    expect(dueChipLabel("2026-12-05 09:30:00", now)).toBe("12 月 5 日 09:30");
    expect(dueChipLabel("2027-01-02 23:59:59", now)).toBe("2027 年 1 月 2 日");
  });

  it("提醒文案：0 是准时，null 才是不提醒", () => {
    expect(remindLabel(null)).toBe("不提醒");
    expect(remindLabel(0)).toBe("准时提醒");
    expect(remindLabel(90)).toBe("提前 90 分钟");
    expect(remindLabel(1440)).toBe("提前 1 天");
  });

  it("datetime-local 与 SQLite 互转", () => {
    expect(toSqliteDate("2026-11-11T14:00")).toBe("2026-11-11 14:00:00");
    expect(toSqliteDate("")).toBeNull();
    expect(toLocalInput("2026-11-11 14:00:00")).toBe("2026-11-11T14:00");
    expect(toLocalInput(null)).toBe("");
  });
});
