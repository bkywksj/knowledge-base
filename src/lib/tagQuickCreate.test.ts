import { describe, expect, it } from "vitest";

import { matchTagByName } from "./tagQuickCreate";

const tags = [
  { id: 1, name: "工作" },
  { id: 2, name: "ai" },
  { id: 3, name: "周报" },
];

describe("matchTagByName", () => {
  it("没有同名标签时可以新建", () => {
    const m = matchTagByName(tags, "灵感");
    expect(m.canCreate).toBe(true);
    expect(m.exact).toBeUndefined();
    expect(m.name).toBe("灵感");
  });

  it("有同名标签时返回它，不提供新建", () => {
    const m = matchTagByName(tags, "工作");
    expect(m.exact?.id).toBe(1);
    expect(m.canCreate).toBe(false);
  });

  it("首尾空白被忽略", () => {
    const m = matchTagByName(tags, "  周报 ");
    expect(m.exact?.id).toBe(3);
    expect(m.name).toBe("周报");
    expect(m.canCreate).toBe(false);
  });

  it("区分大小写，和后端判重一致：AI 与 ai 是两个标签", () => {
    const m = matchTagByName(tags, "AI");
    expect(m.exact).toBeUndefined();
    expect(m.canCreate).toBe(true);
  });

  it("只是子串不算同名：输入「工」不该命中「工作」", () => {
    const m = matchTagByName(tags, "工");
    expect(m.exact).toBeUndefined();
    expect(m.canCreate).toBe(true);
  });

  it("空输入和纯空白不可新建", () => {
    for (const s of ["", "   ", "\t"]) {
      const m = matchTagByName(tags, s);
      expect(m.canCreate).toBe(false);
      expect(m.exact).toBeUndefined();
    }
  });

  it("没有任何标签时，非空输入可新建", () => {
    expect(matchTagByName([], "第一个").canCreate).toBe(true);
  });
});
