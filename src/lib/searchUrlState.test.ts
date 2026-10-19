import { describe, expect, it } from "vitest";

import {
  hasActiveFilters,
  parseSearchUrl,
  writeSearchUrl,
} from "./searchUrlState";

describe("searchUrlState", () => {
  it("写入再读回，条件原样恢复", () => {
    const state = {
      q: "销售 数据",
      folders: [3, 12],
      tags: [7],
      types: ["markdown" as const],
      updated: ["2026-10-01", "2026-10-19"] as [string, string],
      created: null,
      titleOnly: true,
    };
    const sp = writeSearchUrl(new URLSearchParams("type=notes"), state);
    expect(sp.get("type")).toBe("notes"); // Tab 参数保留
    expect(parseSearchUrl(new URLSearchParams(sp.toString()))).toEqual(state);
  });

  it("空条件不写键，已有的旧键会被删掉", () => {
    const sp = writeSearchUrl(new URLSearchParams("q=old&f=1&to=1"), {
      q: "",
      folders: [],
      tags: [],
      types: [],
      updated: null,
      created: null,
      titleOnly: false,
    });
    expect(sp.toString()).toBe("");
  });

  it("非法值被忽略（手改 URL / 旧链接不报错）", () => {
    const s = parseSearchUrl(
      new URLSearchParams("f=1,abc,-2,0&nt=markdown,pdf&ud=2026-10-01&cd=x~y"),
    );
    expect(s.folders).toEqual([1]);
    expect(s.types).toEqual(["markdown"]);
    expect(s.updated).toBeNull();
    expect(s.created).toBeNull();
    expect(hasActiveFilters(s)).toBe(true);
  });

  it("只有关键词时不算有筛选", () => {
    expect(hasActiveFilters(parseSearchUrl(new URLSearchParams("q=abc")))).toBe(
      false,
    );
  });
});
