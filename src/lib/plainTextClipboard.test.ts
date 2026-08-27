import { describe, it, expect } from "vitest";
import { Schema } from "@tiptap/pm/model";
import type { Node as PMNode } from "@tiptap/pm/model";
import {
  fragmentToPlainText,
  joinPlainTextBlocks,
  collapseBlankLines,
} from "./plainTextClipboard";

/**
 * 复刻编辑器实际用到的节点结构（节点名与 tiptap 保持一致，
 * 因为 TIGHT_CONTAINERS 是按名字匹配的）。
 */
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    heading: {
      content: "inline*",
      group: "block",
      attrs: { level: { default: 1 } },
    },
    codeBlock: { content: "text*", group: "block", code: true },
    orderedList: { content: "listItem+", group: "block" },
    bulletList: { content: "listItem+", group: "block" },
    listItem: { content: "block+" },
    blockquote: { content: "block+", group: "block" },
    table: { content: "tableRow+", group: "block" },
    tableRow: { content: "tableCell+" },
    tableCell: { content: "block+" },
    image: { group: "inline", inline: true },
    hardBreak: { group: "inline", inline: true },
    text: { group: "inline" },
  },
  marks: {},
});

const n = schema.nodes;
const p = (s?: string) => n.paragraph.create(null, s ? schema.text(s) : null);
const li = (...kids: PMNode[]) => n.listItem.create(null, kids);
const cell = (s: string) => n.tableCell.create(null, p(s));

/** 与组件里一致的 leafText：hardBreak → 换行，其余叶子 → 空 */
const leafText = (leaf: PMNode) => (leaf.type.name === "hardBreak" ? "\n" : "");

const render = (kids: PMNode[], labels: string[] = []) =>
  fragmentToPlainText(n.doc.create(null, kids).content, leafText, labels);

describe("复制为纯文本：块拼接", () => {
  it("有序列表各项之间是单换行，不再夹空行（本次修复的核心）", () => {
    // 修复前 textBetween("\n\n") 输出 "alpha\n\nbravo\n\ncharlie"
    const out = render([
      n.orderedList.create(null, [li(p("alpha")), li(p("bravo")), li(p("charlie"))]),
    ]);
    expect(out).toBe("alpha\nbravo\ncharlie");
  });

  it("无序列表同理", () => {
    const out = render([n.bulletList.create(null, [li(p("a")), li(p("b"))])]);
    expect(out).toBe("a\nb");
  });

  it("列表与前后正文之间仍空一行（不能黏在一起）", () => {
    const out = render([
      p("前言"),
      n.orderedList.create(null, [li(p("a")), li(p("b"))]),
      p("后记"),
    ]);
    expect(out).toBe("前言\n\na\nb\n\n后记");
  });

  it("嵌套列表整体保持紧凑", () => {
    const out = render([
      n.bulletList.create(null, [
        li(p("外1"), n.bulletList.create(null, [li(p("内1")), li(p("内2"))])),
        li(p("外2")),
      ]),
    ]);
    expect(out).toBe("外1\n内1\n内2\n外2");
  });

  it("表格单元格之间是单换行，不再每格夹空行", () => {
    const out = render([
      n.table.create(null, [
        n.tableRow.create(null, [cell("r1c1"), cell("r1c2")]),
        n.tableRow.create(null, [cell("r2c1"), cell("r2c2")]),
      ]),
    ]);
    expect(out).toBe("r1c1\nr1c2\nr2c1\nr2c2");
  });

  it("连续空段落压成最多一个空行（修复前是 5 个空行）", () => {
    // 修复前 textBetween 输出 "一\n\n\n\n\n\n二"
    const out = render([p("一"), p(), p(), p("二")]);
    expect(out).toBe("一\n\n二");
  });

  it("普通段落之间保留一个空行", () => {
    expect(render([p("一"), p("二")])).toBe("一\n\n二");
  });

  it("引用块内多段仍按段落处理（空一行）", () => {
    const out = render([n.blockquote.create(null, [p("q1"), p("q2")])]);
    expect(out).toBe("q1\n\nq2");
  });

  it("标题自动编号仍随文本一起复制（既有行为不回退）", () => {
    const out = render(
      [n.heading.create({ level: 1 }, schema.text("第一章")), p("正文")],
      ["1"],
    );
    expect(out).toBe("1 第一章\n\n正文");
  });

  it("多个标题按文档顺序消费编号；无编号的标题不加前缀", () => {
    const out = render(
      [
        n.heading.create({ level: 1 }, schema.text("A")),
        n.heading.create({ level: 2 }, schema.text("B")),
        n.heading.create({ level: 2 }, schema.text("C")),
      ],
      ["1", "1.1"], // 第三个没编号
    );
    expect(out).toBe("1 A\n\n1.1 B\n\nC");
  });

  it("没有编号时标题就是纯文字（不出现 markdown 的 #）", () => {
    expect(render([n.heading.create({ level: 2 }, schema.text("标题"))])).toBe(
      "标题",
    );
  });

  it("段落内的 hardBreak 是单换行，不被当成块分隔", () => {
    const para = n.paragraph.create(null, [
      schema.text("上"),
      n.hardBreak.create(),
      schema.text("下"),
    ]);
    expect(render([para])).toBe("上\n下");
  });

  it("代码块内容原样保留（不递归拆行）", () => {
    const code = n.codeBlock.create(null, schema.text("line1\nline2"));
    expect(render([code])).toBe("line1\nline2");
  });

  it("选区首尾的空段落不留悬空空行", () => {
    expect(render([p(), p("内容"), p()])).toBe("内容");
  });
});

describe("collapseBlankLines", () => {
  it("3 个以上换行压成 2 个", () => {
    expect(collapseBlankLines("a\n\n\n\n\nb")).toBe("a\n\nb");
  });
  it("2 个换行不动", () => {
    expect(collapseBlankLines("a\n\nb")).toBe("a\n\nb");
  });
  it("单换行不动", () => {
    expect(collapseBlankLines("a\nb")).toBe("a\nb");
  });
  it("去首尾空白", () => {
    expect(collapseBlankLines("\n\n内容\n\n")).toBe("内容");
  });
});

describe("joinPlainTextBlocks", () => {
  it("空输入返回空串", () => {
    expect(joinPlainTextBlocks([])).toBe("");
  });
  it("单块原样返回", () => {
    expect(joinPlainTextBlocks([{ text: "只有一块" }])).toBe("只有一块");
  });
  it("只有两边都 tight 才收紧", () => {
    expect(
      joinPlainTextBlocks([
        { text: "段落" },
        { text: "项1", tight: true },
        { text: "项2", tight: true },
      ]),
    ).toBe("段落\n\n项1\n项2");
  });
});
