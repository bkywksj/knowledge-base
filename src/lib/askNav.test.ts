import { describe, expect, it } from "vitest";
import { activeAskIndex, askLabel, stepAsk } from "./askNav";

describe("askLabel", () => {
  it("取首个非空行", () => {
    expect(askLabel("\n  我有哪些笔记  \n第二行")).toBe("我有哪些笔记");
  });

  it("附件提问只显示真正的问题，带 📎", () => {
    const content =
      "📎 用户附带了 1 个附件，内容如下：\n\n## 附件 1: 表.xlsx\n| a |\n\n---\n\n帮我统计一下\n补充";
    expect(askLabel(content)).toBe("📎 帮我统计一下");
  });

  it("附件提问没有问题文字时给兜底", () => {
    expect(askLabel("📎 用户附带了 1 个附件，内容如下：\n\n## 附件 1")).toBe("📎 附件提问");
  });

  it("空内容", () => {
    expect(askLabel("   \n ")).toBe("（空）");
  });
});

describe("activeAskIndex", () => {
  it("没有提问返回 -1", () => {
    expect(activeAskIndex([], 100)).toBe(-1);
  });

  it("取越过锚线的最后一条", () => {
    expect(activeAskIndex([-500, -20, 80, 400], 120)).toBe(2);
  });

  it("都还在锚线下方时取第一条", () => {
    expect(activeAskIndex([300, 600], 120)).toBe(0);
  });
});

describe("stepAsk", () => {
  it("上下跳，到头停住", () => {
    expect(stepAsk(1, 4, 1)).toBe(2);
    expect(stepAsk(3, 4, 1)).toBe(3);
    expect(stepAsk(0, 4, -1)).toBe(0);
  });

  it("没有当前项时从第一条起算；没有提问返回 -1", () => {
    expect(stepAsk(-1, 3, 1)).toBe(1);
    expect(stepAsk(0, 0, 1)).toBe(-1);
  });
});
