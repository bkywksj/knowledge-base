import { describe, it, expect } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { findInlineMathRanges } from "./inlineMathRanges";

describe("行内公式识别：正常公式", () => {
  it("单个 $..$", () => {
    const r = findInlineMathRanges("质能方程 $E=mc^2$ 很有名");
    expect(r).toHaveLength(1);
    expect(r[0].latex).toBe("E=mc^2");
  });

  it("一行里多个公式", () => {
    const r = findInlineMathRanges("$a+b$ 和 $c-d$");
    expect(r.map((x) => x.latex)).toEqual(["a+b", "c-d"]);
  });

  it("多行文本里每行各自的公式互不串", () => {
    const r = findInlineMathRanges("第一行 $x^2$ 结束\n第二行 $y^2$ 结束");
    expect(r.map((x) => x.latex)).toEqual(["x^2", "y^2"]);
  });

  it("start/end 精确框住两个 $", () => {
    const text = "前缀 $E=mc^2$ 后缀";
    const [r] = findInlineMathRanges(text);
    expect(text.slice(r.start, r.end)).toBe("$E=mc^2$");
  });
});

describe("行内公式识别：不该抓的情形", () => {
  it("货币金额", () => {
    expect(findInlineMathRanges("售价 $100 与 $200 元")).toHaveLength(0);
  });

  it("$$ 双号（块级定界符，由规则 0/1 处理）", () => {
    expect(findInlineMathRanges("$$E=mc^2$$")).toHaveLength(0);
  });

  it("孤立的单个 $", () => {
    expect(findInlineMathRanges("单价 $ 未定")).toHaveLength(0);
  });

  it("完全没有 $", () => {
    expect(findInlineMathRanges("普通一段话")).toHaveLength(0);
  });

  it("🔴 跨行的两个 $ 不配对 —— 终端日志被吞的根因", () => {
    // 这两个 $ 分处两行，中间的 `[NAS_DR@NAS-DR ~]` 曾被当成 LaTeX 整段吞掉
    const text = "[NAS_DR@NAS-DR ~]$\n[NAS_DR@NAS-DR ~]$ sleep 8";
    expect(findInlineMathRanges(text)).toHaveLength(0);
  });

  it("🔴 shell 提示符 4 连行一个都不该抓", () => {
    const text = [
      "[NAS_DR@NAS-DR ~]$",
      "[NAS_DR@NAS-DR ~]$ # ④ 等启动并看日志",
      "[NAS_DR@NAS-DR ~]$ sleep 8",
      "[NAS_DR@NAS-DR ~]$ docker logs vaultwarden --tail 15",
    ].join("\n");
    expect(findInlineMathRanges(text)).toHaveLength(0);
  });
});

/**
 * 位置对齐回归：字符下标必须与 ProseMirror doc 内偏移严格一一对应。
 *
 * 之前用 `node.textContent` 时 hardBreak 贡献 0 字符却在 doc 里占 1 位，hardBreak
 * 之后的每个匹配 from/to 都会少 1，replaceWith 削掉错误范围、吃掉邻近文字。
 */
describe("位置对齐：hardBreak 参与后下标仍等于 doc 偏移", () => {
  const schema = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { group: "block", content: "inline*", toDOM: () => ["p", 0] },
      hardBreak: {
        group: "inline",
        inline: true,
        selectable: false,
        toDOM: () => ["br"],
      },
      text: { group: "inline" },
    },
  });

  /** 与 TiptapEditor.migrateOpenMathStrings 里的 blockText 同款 */
  const blockText = (node: import("@tiptap/pm/model").Node) =>
    node.textBetween(0, node.content.size, undefined, () => "\n");

  it("hardBreak 在 textContent 里丢字符（记录旧行为，说明为何必须换掉）", () => {
    const para = schema.node("paragraph", null, [
      schema.text("上一行"),
      schema.node("hardBreak"),
      schema.text("下一行"),
    ]);
    // 旧路径：两行被拼成一行，看不见换行
    expect(para.textContent).toBe("上一行下一行");
    // 新路径：hardBreak 贡献一个 \n
    expect(blockText(para)).toBe("上一行\n下一行");
  });

  it("hardBreak 之后的公式，start 换算出的 doc 位置正好落在 $ 上", () => {
    const para = schema.node("paragraph", null, [
      schema.text("首行文字"),
      schema.node("hardBreak"),
      schema.text("次行 $E=mc^2$ 收尾"),
    ]);
    const doc = schema.node("doc", null, [para]);

    const text = blockText(para);
    const ranges = findInlineMathRanges(text);
    expect(ranges).toHaveLength(1);

    // TiptapEditor 里的换算：textStartInDoc = pos + 1，pos 是段落在 doc 里的位置(0)
    const textStartInDoc = 0 + 1;
    const from = textStartInDoc + ranges[0].start;
    const to = textStartInDoc + ranges[0].end;

    // doc 里 [from, to) 取出来必须正好是 `$E=mc^2$`
    expect(doc.textBetween(from, to, undefined, () => "\n")).toBe("$E=mc^2$");
  });

  it("多个 hardBreak 累积也不漂移", () => {
    const para = schema.node("paragraph", null, [
      schema.text("a"),
      schema.node("hardBreak"),
      schema.text("b"),
      schema.node("hardBreak"),
      schema.text("c"),
      schema.node("hardBreak"),
      schema.text("尾行 $x+y$ 完"),
    ]);
    const doc = schema.node("doc", null, [para]);
    const ranges = findInlineMathRanges(blockText(para));
    expect(ranges).toHaveLength(1);
    const from = 1 + ranges[0].start;
    const to = 1 + ranges[0].end;
    expect(doc.textBetween(from, to, undefined, () => "\n")).toBe("$x+y$");
  });
});
