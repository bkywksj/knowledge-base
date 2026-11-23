import { describe, expect, it } from "vitest";
import { nextFontSize } from "./fontSizeStep";

describe("nextFontSize", () => {
  it("在档位上时跳到相邻一档", () => {
    expect(nextFontSize(16, 1)).toBe("18px");
    expect(nextFontSize(16, -1)).toBe("15px");
  });

  it("不在档位上时跳到最近的一档，而不是原地不动", () => {
    expect(nextFontSize(17, 1)).toBe("18px");
    expect(nextFontSize(17, -1)).toBe("16px");
    expect(nextFontSize(15.5, 1)).toBe("16px");
  });

  it("到头返回 null", () => {
    expect(nextFontSize(48, 1)).toBeNull();
    expect(nextFontSize(12, -1)).toBeNull();
    expect(nextFontSize(60, 1)).toBeNull();
  });
});
