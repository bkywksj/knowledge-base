import { describe, expect, it } from "vitest";
import {
  buildFrontMatter,
  frontMatterEntries,
  frontMatterInner,
  matchFrontMatter,
} from "./frontMatter";

describe("matchFrontMatter", () => {
  it("识别文档开头的 YAML 块，只取到闭合行", () => {
    const m = matchFrontMatter("---\nplatform: 安卓\ntype: 逆向\n---\n\n# 标题\n\n---\n");
    expect(m).toEqual({ raw: "---\nplatform: 安卓\ntype: 逆向\n---", lineCount: 4 });
  });

  it("CRLF 文件也能识别，raw 统一成 LF", () => {
    expect(matchFrontMatter("---\r\na: 1\r\n---\r\n正文")?.raw).toBe("---\na: 1\n---");
  });

  it("支持列表、缩进、注释和 ... 闭合", () => {
    const text = "---\ntags:\n  - a\n- b\n# 注释\ntitle: x\n...\n正文";
    expect(matchFrontMatter(text)?.lineCount).toBe(7);
  });

  it.each([
    ["分割线 + 标题 + 分割线", "---\n\n## 标题\n\n---\n正文"],
    ["分割线 + 标题紧贴", "---\n# 标题\n---\n"],
    ["分割线 + 普通文字 + 分割线", "---\n这是一段正文\n---\n"],
    ["中间夹普通段落", "---\na: 1\n这是一段正文\n---\n"],
    ["没有闭合行", "---\na: 1\n\n正文"],
    ["已被旧版损坏的文件", "---\n\n## platform: 安卓\\\ntype: 逆向\n\n# 标题\n"],
    ["不在文档开头", "\n---\na: 1\n---\n"],
    ["网址不算 key", "---\nhttp://a.com\n---\n"],
  ])("不误判：%s", (_name, text) => {
    expect(matchFrontMatter(text)).toBeNull();
  });
});

describe("编辑后拼回", () => {
  it("往返不变", () => {
    const raw = "---\nplatform: 安卓\ntags:\n  - a\n---";
    expect(buildFrontMatter(frontMatterInner(raw))).toBe(raw);
  });

  it("拒绝会破坏块结构的内容", () => {
    expect(buildFrontMatter("a: 1\n---\nb: 2")).toBeNull();
    expect(buildFrontMatter("这不是 YAML")).toBeNull();
    expect(buildFrontMatter("")).toBeNull();
  });
});

describe("frontMatterEntries", () => {
  const entries = (inner: string) => frontMatterEntries(`---\n${inner}\n---`);

  it("拆出键值", () => {
    expect(entries("platform: 安卓\ntype: 逆向")).toEqual([
      { key: "platform", value: "安卓" },
      { key: "type", value: "逆向" },
    ]);
  });

  it("去掉成对引号，值里的冒号不截断", () => {
    expect(entries('title: "a: b"\nurl: https://a.com')).toEqual([
      { key: "title", value: "a: b" },
      { key: "url", value: "https://a.com" },
    ]);
  });

  it("两种写法的列表都显示成逗号分隔", () => {
    expect(entries("tags:\n  - a\n  - 'b'\nkeywords: [c, \"d\"]\nitems:\n- e")).toEqual([
      { key: "tags", value: "a, b" },
      { key: "keywords", value: "c, d" },
      { key: "items", value: "e" },
    ]);
  });

  it("嵌套结构保留 YAML 原文", () => {
    expect(entries("meta:\n  a: 1\n  b: 2\npeople:\n  - name: x")).toEqual([
      { key: "meta", value: "  a: 1\n  b: 2" },
      { key: "people", value: "  - name: x" },
    ]);
  });

  it("空值和注释", () => {
    expect(entries("draft:\n# 注释\ntitle: x")).toEqual([
      { key: "draft", value: "" },
      { key: "title", value: "x" },
    ]);
  });
});
