import { describe, expect, it } from "vitest";
import { daysUntilPurge, purgeLabel } from "./trashPurge";

const at = (s: string) => new Date(s.replace(" ", "T")).getTime();

describe("daysUntilPurge", () => {
  it("从不清理返回 null", () => {
    expect(daysUntilPurge("2026-11-01 00:00:00", "2026-11-01 00:00:00", 0)).toBeNull();
  });

  it("新删的按删除时间起算", () => {
    expect(
      daysUntilPurge("2026-11-01 10:00:00", "2026-01-01 00:00:00", 7, at("2026-11-02 10:00:00")),
    ).toBe(6);
  });

  it("规则生效前就在回收站里的按生效时间起算", () => {
    expect(
      daysUntilPurge("2025-01-01 00:00:00", "2026-11-04 00:00:00", 30, at("2026-11-05 00:00:00")),
    ).toBe(29);
    expect(daysUntilPurge(null, "2026-11-04 00:00:00", 30, at("2026-11-05 00:00:00"))).toBe(29);
  });

  it("过期不出负数", () => {
    expect(
      daysUntilPurge("2026-01-01 00:00:00", "2026-01-01 00:00:00", 7, at("2026-11-05 00:00:00")),
    ).toBe(0);
  });
});

describe("purgeLabel", () => {
  it("文案", () => {
    expect(purgeLabel(null)).toBeNull();
    expect(purgeLabel(0)).toBe("即将自动删除");
    expect(purgeLabel(12)).toBe("12 天后自动删除");
  });
});
