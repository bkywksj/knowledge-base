import { describe, expect, it } from "vitest";
import { heldDeletionsText, pushSafetyMessage } from "./syncGuards";

describe("pushSafetyMessage", () => {
  it("取出后端安全检查的原因", () => {
    expect(pushSafetyMessage("PUSH_SAFETY:本机没有任何笔记")).toBe("本机没有任何笔记");
    expect(pushSafetyMessage("Error: PUSH_SAFETY: 少了一半")).toBe("少了一半");
  });

  it("其他错误不当成安全检查", () => {
    expect(pushSafetyMessage("网络超时")).toBeNull();
    expect(pushSafetyMessage(undefined)).toBeNull();
  });
});

describe("heldDeletionsText", () => {
  it("没有被暂停的删除时不提示", () => {
    expect(heldDeletionsText({ deletionsHeld: 0, localNotes: 10 })).toBeNull();
    expect(heldDeletionsText({})).toBeNull();
  });

  it("写明数量和占比", () => {
    expect(heldDeletionsText({ deletionsHeld: 40, localNotes: 50 })).toBe(
      "云端要求删除 40 篇笔记（本机共 50 篇，占本机 80%），数量异常，这次先没有删。",
    );
  });
});
