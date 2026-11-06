import { describe, expect, it } from "vitest";
import {
  LIST_DENSITY_DEFAULT,
  LIST_PAGE_SIZE_DEFAULT,
  sanitizeListDensity,
  sanitizeListPageSize,
} from "./listDensity";

describe("sanitizeListDensity", () => {
  it("合法值原样返回", () => {
    expect(sanitizeListDensity("compact")).toBe("compact");
    expect(sanitizeListDensity("comfortable")).toBe("comfortable");
  });

  it("缺失或非法时回到默认（标准）", () => {
    expect(LIST_DENSITY_DEFAULT).toBe("standard");
    for (const raw of [undefined, null, "", "tight", 1]) {
      expect(sanitizeListDensity(raw)).toBe("standard");
    }
  });
});

describe("sanitizeListPageSize", () => {
  it("只接受下拉里有的值", () => {
    expect(sanitizeListPageSize(50)).toBe(50);
    expect(sanitizeListPageSize(12)).toBe(12);
  });

  it("其它值回到默认 30", () => {
    expect(LIST_PAGE_SIZE_DEFAULT).toBe(30);
    for (const raw of [undefined, 0, 13, -1, "50", NaN]) {
      expect(sanitizeListPageSize(raw)).toBe(30);
    }
  });
});
