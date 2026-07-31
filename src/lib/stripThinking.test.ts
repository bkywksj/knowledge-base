import { describe, it, expect } from "vitest";
import { splitThinking } from "./stripThinking";

describe("splitThinking · 无思考标签", () => {
  it("普通文本原样返回（仅 trim）", () => {
    expect(splitThinking("  改写后的句子。  ")).toEqual({
      content: "改写后的句子。",
      thinking: "",
      thinkingOpen: false,
    });
  });

  it("空串安全", () => {
    expect(splitThinking("")).toEqual({
      content: "",
      thinking: "",
      thinkingOpen: false,
    });
  });

  it("正文里的普通尖括号不被误伤（代码/数学式常见）", () => {
    const raw = "当 a < b 且 List<String> 非空时，走 <br> 分支。";
    const r = splitThinking(raw);
    expect(r.content).toBe(raw);
    expect(r.thinking).toBe("");
  });
});

describe("splitThinking · 成对块", () => {
  it("剥掉 <think>…</think>，只留正文", () => {
    const r = splitThinking(
      "<think>用户想让我把这段改得更正式。先看主语…</think>\n改写后的正式版本。",
    );
    expect(r.content).toBe("改写后的正式版本。");
    expect(r.thinking).toBe("用户想让我把这段改得更正式。先看主语…");
    expect(r.thinkingOpen).toBe(false);
  });

  it("思考块在正文中间也能剥干净", () => {
    const r = splitThinking("前半段。<think>斟酌一下</think>后半段。");
    expect(r.content).toBe("前半段。后半段。");
    expect(r.thinking).toBe("斟酌一下");
  });

  it("多个思考块按出现顺序合并", () => {
    const r = splitThinking(
      "<think>第一轮</think>正文A<thinking>第二轮</thinking>正文B",
    );
    expect(r.content).toBe("正文A正文B");
    expect(r.thinking).toBe("第一轮\n\n第二轮");
  });

  it("标签大小写 / 内部空格变体都认", () => {
    const r = splitThinking("<Think >推理中</ THINK>结果");
    expect(r.content).toBe("结果");
    expect(r.thinking).toBe("推理中");
  });

  it("<reasoning> / <thought> 变体同样处理", () => {
    expect(splitThinking("<reasoning>abc</reasoning>正文").content).toBe("正文");
    expect(splitThinking("<thought>abc</thought>正文").content).toBe("正文");
  });

  it("只有思考没有正文时 content 为空（调用方据此禁用替换）", () => {
    const r = splitThinking("<think>想了半天没给结论</think>");
    expect(r.content).toBe("");
    expect(r.thinking).toBe("想了半天没给结论");
  });
});

describe("splitThinking · 孤立闭合标签（R1 模板预填 <think> 被吞）", () => {
  it("闭合标签之前的内容全部算思考", () => {
    const r = splitThinking("先分析一下用户意图……\n</think>\n最终结果。");
    expect(r.content).toBe("最终结果。");
    expect(r.thinking).toBe("先分析一下用户意图……");
    expect(r.thinkingOpen).toBe(false);
  });

  it("闭合标签在开头（思考为空）时不误吞正文", () => {
    const r = splitThinking("</think>直接给结果");
    expect(r.content).toBe("直接给结果");
    expect(r.thinking).toBe("");
  });
});

describe("splitThinking · 流式进行中", () => {
  it("开标签已到、闭合未到 → thinkingOpen 为 true 且正文为空", () => {
    const r = splitThinking("<think>让我先理解这段话的语气");
    expect(r.content).toBe("");
    expect(r.thinking).toBe("让我先理解这段话的语气");
    expect(r.thinkingOpen).toBe(true);
  });

  it("正文已出、后面又起了新思考块（未闭合）→ 正文保住", () => {
    const r = splitThinking("<think>第一轮</think>正文A<think>第二轮还没写完");
    expect(r.content).toBe("正文A");
    expect(r.thinking).toBe("第一轮\n\n第二轮还没写完");
    expect(r.thinkingOpen).toBe(true);
  });

  it("逐 token 累积过程中每一步都不会把思考或半截标签漏进正文", () => {
    const full = "<think>斟酌用词</think>最终结果。";
    for (let i = 1; i <= full.length; i++) {
      const r = splitThinking(full.slice(0, i), { streaming: true });
      // 正文只可能是「最终结果。」的某个前缀，绝不含思考文字和标签碎片
      expect("最终结果。".startsWith(r.content)).toBe(true);
      expect(r.content).not.toContain("斟酌");
      expect(r.content).not.toContain("<");
    }
  });

  it("streaming 时挂起半截标签，非 streaming 时保留真实尖括号", () => {
    expect(splitThinking("结果。<th", { streaming: true }).content).toBe("结果。");
    // 输出已完结：末尾的 `<` 是正文内容，不能吞
    expect(splitThinking("比较符号 <").content).toBe("比较符号 <");
  });

  it("streaming 时不误挂起非标签前缀的尖括号", () => {
    expect(splitThinking("条件 a < b", { streaming: true }).content).toBe(
      "条件 a < b",
    );
  });
});
