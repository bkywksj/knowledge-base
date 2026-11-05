import { describe, expect, it } from "vitest";
import { escapeHtml, quickTextToNote } from "./quickNote";

describe("quickTextToNote", () => {
  it("第一行作标题，其余每行一段", () => {
    expect(quickTextToNote("买菜清单\n土豆\n\n番茄")).toEqual({
      title: "买菜清单",
      content: "<p>土豆</p><p>番茄</p>",
    });
  });

  it("只有一行时正文为空", () => {
    expect(quickTextToNote("  一个想法  ")).toEqual({ title: "一个想法", content: "" });
  });

  it("标题过长截断，正文保留全文", () => {
    const long = "字".repeat(70);
    const r = quickTextToNote(long);
    expect(r.title).toBe(`${"字".repeat(60)}…`);
    expect(r.content).toBe(`<p>${long}</p>`);
  });

  it("用户输入的尖括号按文字保存，不当成 HTML", () => {
    expect(quickTextToNote("标题\n<b>x</b> & y").content).toBe("<p>&lt;b&gt;x&lt;/b&gt; &amp; y</p>");
    expect(escapeHtml("a<b")).toBe("a&lt;b");
  });
});
