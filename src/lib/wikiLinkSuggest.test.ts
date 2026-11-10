import { describe, expect, it } from "vitest";
import { wikiSuggestionAllowed } from "./wikiLinkSuggest";

describe("双链候选是否弹出", () => {
  it("正在输入（含空格、中文）时弹", () => {
    expect(wikiSuggestionAllowed("[[")).toBe(true);
    expect(wikiSuggestionAllowed("[[接口")).toBe(true);
    expect(wikiSuggestionAllowed("[[deep work")).toBe(true);
  });

  it("用户自己敲完 ]] 时不弹", () => {
    expect(wikiSuggestionAllowed("[[接口规范]]")).toBe(false);
  });

  it("光标停在已闭合双链后面时不弹（打开笔记光标落在段尾的误弹）", () => {
    expect(wikiSuggestionAllowed("[[双链]] 与列表。")).toBe(false);
    expect(wikiSuggestionAllowed("[[标题|12]] 后面还有字")).toBe(false);
  });
});
