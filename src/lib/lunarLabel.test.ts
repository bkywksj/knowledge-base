import { describe, expect, it } from "vitest";
import { Solar } from "lunar-javascript";
import { lunarLabelOf } from "./lunarLabel";

const at = (y: number, m: number, d: number) => lunarLabelOf(Solar.fromYmd(y, m, d));

describe("lunarLabelOf", () => {
  it("平常日子显示农历日期", () => {
    expect(at(2026, 11, 18)).toBe("十月初十");
    expect(at(2026, 12, 9)).toBe("冬月初一");
  });

  it("节气日显示节气", () => {
    expect(at(2026, 11, 7)).toBe("立冬");
  });

  it("农历传统节日和公历节日优先于农历日期", () => {
    expect(at(2026, 10, 18)).toBe("重阳节");
    expect(at(2026, 9, 25)).toBe("中秋节");
    expect(at(2027, 2, 6)).toBe("春节");
    expect(at(2026, 10, 1)).toBe("国庆节");
  });
});
