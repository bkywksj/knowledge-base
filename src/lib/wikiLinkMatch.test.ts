import { describe, it, expect } from "vitest";
import { findWikiLinks, wikiLinkAtOffset } from "./wikiLinkMatch";

/** 只取标题，便于断言 */
function titles(text: string) {
  return findWikiLinks(text).map((m) => m.title);
}

describe("findWikiLinks · 基础识别", () => {
  it("旧格式 [[标题]]", () => {
    const hits = findWikiLinks("[[我的笔记]]");
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("我的笔记");
    expect(hits[0].id).toBeUndefined();
    expect(hits[0].start).toBe(0);
    expect(hits[0].end).toBe("[[我的笔记]]".length);
  });

  it("带 ID 锚点 [[标题|123]]", () => {
    const hits = findWikiLinks("[[我的笔记|135]]");
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("我的笔记");
    expect(hits[0].id).toBe("135");
  });

  it("标题含空格 / 下划线 / 中英混排（用户实际数据里就是这种）", () => {
    expect(
      titles("[[查看这个待完成的文档 然后继续完成 _D__download_download_|135]]"),
    ).toEqual(["查看这个待完成的文档 然后继续完成 _D__download_download_"]);
  });

  it("一行里多个双链", () => {
    expect(titles("见 [[笔记A]] 和 [[笔记B|7]] 两篇")).toEqual(["笔记A", "笔记B"]);
  });

  it("夹在正文中间时偏移正确", () => {
    const text = "见 [[笔记A]] 这篇";
    const hit = findWikiLinks(text)[0];
    expect(text.slice(hit.start, hit.end)).toBe("[[笔记A]]");
  });
});

describe("findWikiLinks · 跨 text node（本次 bug 的核心）", () => {
  // 背景：ProseMirror 在 mark 边界切分 text node。`[[标题]]` 里只要夹了一处格式差异
  // （局部加粗 / 颜色，或粘贴表格时带进来的 textStyle），就会被切成多段。
  // 旧实现逐 text node 跑正则 → 每段都匹配不到 → 双链不变蓝、点击无反应。
  const 分片 = ["[[", "查看这个待完成的文档", "|135", "]]"];

  it("分片各自都匹配不到（这就是旧实现失效的原因）", () => {
    for (const piece of 分片) {
      expect(findWikiLinks(piece)).toHaveLength(0);
    }
  });

  it("按块级拼接后能正常匹配（修复后的行为）", () => {
    const hits = findWikiLinks(分片.join(""));
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("查看这个待完成的文档");
    expect(hits[0].id).toBe("135");
  });

  it("只把 ]] 切出去也一样要能认出来", () => {
    expect(titles(["[[笔记A", "]]"].join(""))).toEqual(["笔记A"]);
  });
});

describe("wikiLinkAtOffset · 按位置反查（表格里点不动的兜底路径）", () => {
  // 背景：Tiptap 表格是带 NodeView 的容器，点在单元格里时 event.target 会被换成外层
  // <div class="tableWrapper">，DOM 反查拿不到 decoration span。改用 ProseMirror 给的
  // pos 换算成块内偏移，再用本函数反查，容器怎么包都不受影响。
  const text = "见 [[笔记A|12]] 这篇";
  const start = text.indexOf("[[");
  const end = start + "[[笔记A|12]]".length;

  it("落在双链内部 → 命中", () => {
    expect(wikiLinkAtOffset(text, start + 3)?.title).toBe("笔记A");
    expect(wikiLinkAtOffset(text, start + 3)?.id).toBe("12");
  });

  it("贴着两端的边界也算命中（与 decoration 视觉范围一致）", () => {
    expect(wikiLinkAtOffset(text, start)?.title).toBe("笔记A");
    expect(wikiLinkAtOffset(text, end)?.title).toBe("笔记A");
  });

  it("落在双链之外 → 不命中，让点击照常定位光标", () => {
    expect(wikiLinkAtOffset(text, 0)).toBeNull();
    expect(wikiLinkAtOffset(text, end + 2)).toBeNull();
  });

  it("同一块里有多个双链时取中的那个", () => {
    const t = "[[甲]] 与 [[乙]]";
    expect(wikiLinkAtOffset(t, 2)?.title).toBe("甲");
    expect(wikiLinkAtOffset(t, t.indexOf("[[乙") + 2)?.title).toBe("乙");
  });

  it("空文本 / 越界偏移不炸", () => {
    expect(wikiLinkAtOffset("", 0)).toBeNull();
    expect(wikiLinkAtOffset(text, 9999)).toBeNull();
    expect(wikiLinkAtOffset(text, -1)).toBeNull();
  });
});

describe("findWikiLinks · 不该误判的情形", () => {
  it("空标题不算双链", () => {
    expect(findWikiLinks("[[]]")).toHaveLength(0);
    expect(findWikiLinks("[[   ]]")).toHaveLength(0);
  });

  it("单层方括号不算", () => {
    expect(findWikiLinks("[普通链接](http://x)")).toHaveLength(0);
  });

  it("未闭合不算", () => {
    expect(findWikiLinks("[[没有结尾")).toHaveLength(0);
    expect(findWikiLinks("没有开头]]")).toHaveLength(0);
  });

  it("标题不能跨行", () => {
    expect(findWikiLinks("[[前半\n后半]]")).toHaveLength(0);
  });

  it("ID 段必须是纯数字，否则整体不匹配", () => {
    // `|abc` 不是合法 ID，标题段又排除了 `|`，因此整体匹配失败
    expect(findWikiLinks("[[标题|abc]]")).toHaveLength(0);
  });
});
