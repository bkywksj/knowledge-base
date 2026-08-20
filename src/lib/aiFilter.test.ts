import { describe, it, expect } from "vitest";
import { stripPseudoToolCalls } from "./aiFilter";

describe("stripPseudoToolCalls — 引用标记", () => {
  it("剥掉完整的引用标记", () => {
    expect(stripPseudoToolCalls("回答正文\n<!--refs:[1,3]-->")).toBe("回答正文");
  });

  it("剥掉流式途中未闭合的标记", () => {
    // 关键场景：token 逐个到达，标记只吐了一半时用户不该看到 `<!--refs:[1`
    expect(stripPseudoToolCalls("回答正文\n<!--refs:[1")).toBe("回答正文");
    expect(stripPseudoToolCalls("回答正文\n<!--refs:")).toBe("回答正文");
    expect(stripPseudoToolCalls("回答正文\n<!--refs")).toBe("回答正文");
  });

  it("容忍模型写出的宽松格式", () => {
    expect(stripPseudoToolCalls("答\n<!-- refs: [2, 5] -->")).toBe("答");
    expect(stripPseudoToolCalls("答\n<!--REFS:[1]-->")).toBe("答");
  });

  it("空引用列表也剥掉", () => {
    expect(stripPseudoToolCalls("答\n<!--refs:[]-->")).toBe("答");
  });

  it("不误删普通 HTML 注释", () => {
    // 用户笔记里可能就有 HTML 注释，模型复述出来不能被吞掉
    const text = "正文 <!-- 这是一段普通注释 -->";
    expect(stripPseudoToolCalls(text)).toBe(text);
  });

  it("与伪工具调用过滤共存", () => {
    const text = "<tool_call>foo()</tool_call>真正的回答\n<!--refs:[1]-->";
    expect(stripPseudoToolCalls(text)).toBe("真正的回答");
  });

  it("没有标记时原样返回", () => {
    expect(stripPseudoToolCalls("普通回答")).toBe("普通回答");
  });
});
