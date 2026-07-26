import { describe, it, expect } from "vitest";
import {
  addCjkLatinSpacing,
  cleanText,
  isBlankText,
  squeezeSpaces,
  trimEdges,
} from "./editorCleanup";

describe("addCjkLatinSpacing", () => {
  it("中文与英文/数字之间补空格", () => {
    expect(addCjkLatinSpacing("知识库v1.2版本")).toBe("知识库 v1.2 版本");
    expect(addCjkLatinSpacing("用Rust写的")).toBe("用 Rust 写的");
  });

  it("已有空格时不重复补", () => {
    expect(addCjkLatinSpacing("知识库 v1.2 版本")).toBe("知识库 v1.2 版本");
  });

  it("纯中文 / 纯英文不受影响", () => {
    expect(addCjkLatinSpacing("全部都是中文")).toBe("全部都是中文");
    expect(addCjkLatinSpacing("all english here")).toBe("all english here");
  });

  it("中文标点旁不补空格（补了反而难看）", () => {
    expect(addCjkLatinSpacing("他说：Rust 很好")).toBe("他说：Rust 很好");
  });
});

describe("trimEdges", () => {
  it("去掉半角 / 全角 / 不换行空格", () => {
    expect(trimEdges("  正文  ")).toBe("正文");
    expect(trimEdges("　　正文　　")).toBe("正文");
    expect(trimEdges(" 正文 ")).toBe("正文");
  });

  it("段内空格保留", () => {
    expect(trimEdges(" a b ")).toBe("a b");
  });
});

describe("squeezeSpaces", () => {
  it("连续空格压成一个", () => {
    expect(squeezeSpaces("a    b")).toBe("a b");
    expect(squeezeSpaces("a　　b")).toBe("a b");
  });

  it("单个空格不动", () => {
    expect(squeezeSpaces("a b c")).toBe("a b c");
  });
});

describe("isBlankText", () => {
  it.each(["", "   ", "　　", " "])("空白判定：%s", (t) => {
    expect(isBlankText(t)).toBe(true);
  });

  it("有内容就不算空", () => {
    expect(isBlankText("  x  ")).toBe(false);
  });
});

describe("cleanText · 规则组合", () => {
  it("全开时顺序正确：压缩 → 补空格 → 去首尾", () => {
    expect(
      cleanText("  用Rust    写的  ", { trim: true, squeeze: true, cjkSpacing: true }),
    ).toBe("用 Rust 写的");
  });

  it("只开 trim 时不动段内内容", () => {
    expect(cleanText("  用Rust  写的  ", { trim: true })).toBe("用Rust  写的");
  });

  it("全不开时原样返回", () => {
    expect(cleanText("  用Rust  写的  ", {})).toBe("  用Rust  写的  ");
  });
});
