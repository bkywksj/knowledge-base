import { describe, it, expect } from "vitest";
import { Schema, type Node as PMNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { mergeParagraphs, splitHardBreaks } from "./lineBreakCleanup";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      attrs: { textAlign: { default: null } },
      toDOM: () => ["p", 0],
    },
    bulletList: { group: "block", content: "listItem+", toDOM: () => ["ul", 0] },
    listItem: { content: "paragraph block*", toDOM: () => ["li", 0] },
    hardBreak: { group: "inline", inline: true, toDOM: () => ["br"] },
    text: { group: "inline" },
  },
});

const br = () => schema.node("hardBreak");
const t = (s: string) => schema.text(s);
const p = (...c: PMNode[]) => schema.node("paragraph", null, c);

/** 把文档摊成「段落文本（段内换行写成 ⏎）」数组，便于断言 */
function shape(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((n) => {
    if (n.type.name !== "paragraph") return true;
    let s = "";
    n.content.forEach((c) => {
      s += c.type.name === "hardBreak" ? "⏎" : c.text;
    });
    out.push(s);
    return false;
  });
  return out;
}

describe("splitHardBreaks", () => {
  it("段内换行拆成独立段落，丢掉开头孤立的换行", () => {
    const doc = schema.node("doc", null, [
      p(br(), t("毕业于××学院"), br(), t("加入共青团")),
      p(t("父亲"), br(), t("母亲")),
    ]);
    const res = splitHardBreaks(EditorState.create({ doc }));
    expect(res?.count).toBe(3);
    expect(shape(res!.tr.doc)).toEqual(["毕业于××学院", "加入共青团", "父亲", "母亲"]);
  });

  it("连续两个换行保留成一个空段落；整段只有换行时留一个空段", () => {
    const doc = schema.node("doc", null, [
      p(t("甲"), br(), br(), br(), t("乙")),
      p(br()),
    ]);
    const res = splitHardBreaks(EditorState.create({ doc }));
    expect(shape(res!.tr.doc)).toEqual(["甲", "", "乙", ""]);
  });

  it("保留段落属性，不碰列表项里的换行", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", { textAlign: "center" }, [t("a"), br(), t("b")]),
      schema.node("bulletList", null, [
        schema.node("listItem", null, [p(t("条目"), br(), t("续行"))]),
      ]),
    ]);
    const res = splitHardBreaks(EditorState.create({ doc }));
    const out = res!.tr.doc;
    expect(shape(out)).toEqual(["a", "b", "条目⏎续行"]);
    expect(out.child(1).attrs.textAlign).toBe("center");
  });

  it("没有段内换行时返回 null", () => {
    const doc = schema.node("doc", null, [p(t("a")), p(t("b"))]);
    expect(splitHardBreaks(EditorState.create({ doc }))).toBeNull();
  });
});

describe("mergeParagraphs", () => {
  function selectAll(doc: PMNode) {
    const state = EditorState.create({ doc });
    return state.apply(
      state.tr.setSelection(TextSelection.create(doc, 1, doc.content.size - 1)),
    );
  }

  it("选中的相邻段落合并为一段，去掉中间空段", () => {
    const doc = schema.node("doc", null, [p(t("甲")), p(), p(t("乙"), br(), t("丙"))]);
    const res = mergeParagraphs(selectAll(doc));
    expect(res?.count).toBe(2);
    expect(shape(res!.tr.doc)).toEqual(["甲⏎乙⏎丙"]);
  });

  it("被列表隔开的段落各自成组", () => {
    const doc = schema.node("doc", null, [
      p(t("一")),
      p(t("二")),
      schema.node("bulletList", null, [schema.node("listItem", null, [p(t("条目"))])]),
      p(t("三")),
      p(t("四")),
    ]);
    const res = mergeParagraphs(selectAll(doc));
    expect(shape(res!.tr.doc)).toEqual(["一⏎二", "条目", "三⏎四"]);
  });

  it("光标只在一段里时返回 null", () => {
    const doc = schema.node("doc", null, [p(t("甲")), p(t("乙"))]);
    expect(mergeParagraphs(EditorState.create({ doc }))).toBeNull();
  });
});
