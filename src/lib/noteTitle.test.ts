import { describe, expect, it } from "vitest";

import {
  fallbackNoteTitle,
  resolveNoteTitle,
  titleFromContent,
} from "./noteTitle";

const NOW = new Date(2026, 9, 19, 9, 5, 0);

describe("resolveNoteTitle", () => {
  it("用户填了标题就原样用（去首尾空白）", () => {
    expect(resolveNoteTitle("  周报  ", "正文", NOW)).toBe("周报");
  });

  it("标题空：取正文第一行有字的内容并去 markdown", () => {
    expect(resolveNoteTitle("", "\n\n## 本周 **重点**\n其它", NOW)).toBe(
      "本周 重点",
    );
    expect(resolveNoteTitle(" ", "- [ ] 买菜", NOW)).toBe("买菜");
    expect(resolveNoteTitle("", "> 引用一句话", NOW)).toBe("引用一句话");
    expect(resolveNoteTitle("", "[官网](https://a.com) 介绍", NOW)).toBe(
      "官网 介绍",
    );
  });

  it("跳过图片无 alt、代码块、分隔线", () => {
    expect(
      resolveNoteTitle("", "![](kb-asset://a.png)\n---\n```js\nx\n```\n正文", NOW),
    ).toBe("正文");
  });

  it("超长截 30 字（按字符不按字节）", () => {
    const long = "一".repeat(40);
    expect(Array.from(resolveNoteTitle("", long, NOW))).toHaveLength(30);
  });

  it("正文也空：未命名笔记 + 时间", () => {
    expect(resolveNoteTitle("", "  \n", NOW)).toBe("未命名笔记 2026-10-19 09:05");
    expect(fallbackNoteTitle(NOW)).toBe("未命名笔记 2026-10-19 09:05");
  });

  it("表格首行取单元格文字", () => {
    expect(titleFromContent("| 姓名 | 年龄 |\n| --- | --- |")).toBe("姓名 年龄");
  });
});
