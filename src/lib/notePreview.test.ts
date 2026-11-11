import { describe, expect, it } from "vitest";
import { notePreviewText } from "./notePreview";

describe("笔记预览文字", () => {
  it("去掉标题 / 列表 / 加粗 / 双链标记，压成一行", () => {
    const md = "## 背景\n\n- 第一条 **重点**\n- 见 [[接口规范|12]]\n\n> 引用一句";
    expect(notePreviewText(md)).toBe("背景 第一条 重点 见 接口规范 引用一句");
  });

  it("正文第一行与标题相同则跳过", () => {
    expect(notePreviewText("# 周会纪要\n\n讨论了排期", { title: "周会纪要" })).toBe("讨论了排期");
  });

  it("HTML 正文同样能取出文字", () => {
    expect(notePreviewText("<p>你好&nbsp;世界</p><p>第二段</p>")).toBe("你好 世界 第二段");
  });

  it("去掉分割线与代码块围栏", () => {
    expect(notePreviewText("开头\n\n---\n\n```js\nconst a = 1\n```")).toBe("开头 const a = 1");
  });

  it("跳过只剩标记的行（空标题 #、空列表项 -）", () => {
    expect(notePreviewText("#\n\n#\n\n### 的单位知识星球\n\n-\n\n- 来了")).toBe("的单位知识星球 来了");
  });

  it("白板固定显示「白板」，不露出 JSON", () => {
    expect(notePreviewText('{"type":"excalidraw","elements":[]}', { noteType: "whiteboard" })).toBe("白板");
  });

  it("按 max 截断；空正文返回空串", () => {
    expect(notePreviewText("一二三四五六", { max: 3 })).toBe("一二三");
    expect(notePreviewText("")).toBe("");
  });
});
