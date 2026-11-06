import { describe, expect, it } from "vitest";
import { focusSnippet } from "./highlight";

describe("focusSnippet", () => {
  it("命中词靠后时，裁到命中词前只留 lead 个字", () => {
    const text = "一二三四五六七八九十一二三四五六七八九十一二三四五 白天 之后";
    const out = focusSnippet(text, "白天", 4);
    expect(out.startsWith("...")).toBe(true);
    expect(out.indexOf("白天")).toBe(3 + 4);
  });

  it("命中词本来就靠前时原样返回", () => {
    expect(focusSnippet("...白天和黑夜", "白天")).toBe("...白天和黑夜");
    expect(focusSnippet("今天白天很热", "白天")).toBe("今天白天很热");
  });

  it("多个关键词按最早出现的那个裁，大小写不敏感", () => {
    const text = `${"x".repeat(40)}Alpha${"y".repeat(10)}beta`;
    const out = focusSnippet(text, "BETA alpha", 2);
    expect(out).toBe(`...xxAlpha${"y".repeat(10)}beta`);
  });

  it("没命中、空关键词、空文本都原样返回", () => {
    expect(focusSnippet("abc", "zzz")).toBe("abc");
    expect(focusSnippet("abc", "  ")).toBe("abc");
    expect(focusSnippet("", "a")).toBe("");
  });

  it("不把 emoji 从中间切开", () => {
    const text = `${"a".repeat(20)}😀命中`;
    const out = focusSnippet(text, "命中", 1);
    expect(out).toBe("...😀命中");
  });
});
