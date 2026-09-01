import { describe, it, expect } from "vitest";
import { extractFirstUrl, hasUrl } from "./extractUrl";

describe("extractFirstUrl", () => {
  it("纯 URL 原样返回", () => {
    expect(extractFirstUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(extractFirstUrl("http://example.com")).toBe("http://example.com");
  });

  it("从站酷分享文本里提取（真实用例）", () => {
    // 用户实际粘贴的原文：标题含全角问号、感叹号、破折号，链接在尾部，
    // 且 URL 里带 base64 的 `=` 号
    const text =
      "能把你的表情转化为气味的AI互动装置？！-原创设计作品-站酷（ZCOOL） -艺术家胡帅 https://www.zcool.com.cn/work/ZNzQwNDc2NTY=.html";
    expect(extractFirstUrl(text)).toBe(
      "https://www.zcool.com.cn/work/ZNzQwNDc2NTY=.html",
    );
  });

  it("链接在文本开头 / 中间也能提取", () => {
    expect(extractFirstUrl("https://a.com/x 这是我刚看到的文章")).toBe("https://a.com/x");
    expect(extractFirstUrl("看看 https://a.com/x 这篇")).toBe("https://a.com/x");
  });

  it("剥掉紧跟其后的中英文句读", () => {
    expect(extractFirstUrl("详见 https://a.com/x。")).toBe("https://a.com/x");
    expect(extractFirstUrl("详见 https://a.com/x，然后")).toBe("https://a.com/x");
    expect(extractFirstUrl("link: https://a.com/x.")).toBe("https://a.com/x");
    expect(extractFirstUrl("link: https://a.com/x,")).toBe("https://a.com/x");
    expect(extractFirstUrl("really? https://a.com/x!")).toBe("https://a.com/x");
  });

  it("不把全角/半角右括号吃进 URL", () => {
    // 中文分享文本常把链接包在括号里，贪婪匹配会把 `）` 带上导致 404
    expect(extractFirstUrl("作品（https://a.com/x）很棒")).toBe("https://a.com/x");
    expect(extractFirstUrl("see (https://a.com/x) here")).toBe("https://a.com/x");
    expect(extractFirstUrl("【标题】https://a.com/x【完】")).toBe("https://a.com/x");
  });

  it("多个链接时取第一个", () => {
    // 分享文本惯例是正文链接在前、推广/短链在后
    expect(extractFirstUrl("https://a.com/first 另见 https://b.com/second")).toBe(
      "https://a.com/first",
    );
  });

  it("保留 URL 里的查询串与锚点", () => {
    expect(extractFirstUrl("https://a.com/x?id=1&t=2#sec")).toBe(
      "https://a.com/x?id=1&t=2#sec",
    );
  });

  it("换行分隔的文本也能提取", () => {
    expect(extractFirstUrl("标题\n作者\nhttps://a.com/x\n")).toBe("https://a.com/x");
  });

  it("没有 http(s) 链接时返回 null", () => {
    expect(extractFirstUrl("随便一段没有链接的文字")).toBeNull();
    expect(extractFirstUrl("")).toBeNull();
    expect(extractFirstUrl("   ")).toBeNull();
  });

  it("不猜裸域名", () => {
    // example.com 可能只是正文里提到的一个词，猜错会去抓用户没想抓的站
    expect(extractFirstUrl("访问 example.com 看看")).toBeNull();
    expect(extractFirstUrl("www.example.com")).toBeNull();
  });

  it("只有孤零零的协议头时返回 null", () => {
    expect(extractFirstUrl("https://")).toBeNull();
    expect(extractFirstUrl("前缀 http:// 后缀")).toBeNull();
  });

  it("大小写协议头都认", () => {
    expect(extractFirstUrl("HTTPS://A.com/X")).toBe("HTTPS://A.com/X");
  });
});

describe("hasUrl", () => {
  it("与 extractFirstUrl 判定一致", () => {
    expect(hasUrl("看看 https://a.com/x")).toBe(true);
    expect(hasUrl("没有链接")).toBe(false);
    expect(hasUrl("https://")).toBe(false);
  });
});
