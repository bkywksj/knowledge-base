import { describe, expect, it } from "vitest";

import {
  MAX_HTML_IMAGES,
  extractImgSrcs,
  fileUrlToPath,
  parseClipboard,
  type ClipboardLike,
} from "./clipboardAttachments";

function clip(data: Record<string, string>, files: File[] = []): ClipboardLike {
  return { getData: (t) => data[t] ?? "", files };
}

const png = () =>
  new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });

describe("parseClipboard", () => {
  it("纯截图：只有文件 → 全部当附件", () => {
    const plan = parseClipboard(clip({}, [png()]));
    expect(plan.files).toHaveLength(1);
    expect(plan.text).toBe("");
  });

  it("纯文字：不识别任何附件", () => {
    const plan = parseClipboard(clip({ "text/plain": "只是一段文字" }));
    expect(plan.files.length + plan.urls.length + plan.paths.length).toBe(0);
  });

  it("网页图文：文字保留，外链图片进 urls，&amp; 被还原", () => {
    const plan = parseClipboard(
      clip({
        "text/plain": "第一段\n第二段",
        "text/html":
          "<p>第一段</p><img src=\"https://a.com/x.png?w=1&amp;h=2\"><p>第二段</p><img alt=1 src='https://b.com/y.jpg'>",
      }),
    );
    expect(plan.text).toContain("第二段");
    expect(plan.urls).toEqual([
      "https://a.com/x.png?w=1&h=2",
      "https://b.com/y.jpg",
    ]);
    expect(plan.files).toHaveLength(0);
  });

  it("微信 / QQ 图文：file:/// 图片进 paths（中文路径解码、去掉盘符前的斜杠）", () => {
    const plan = parseClipboard(
      clip({
        "text/plain": "看这张",
        "text/html":
          '看这张<img src="file:///C:/Users/me/AppData/%E5%9B%BE%E7%89%87.png">',
      }),
    );
    expect(plan.paths).toEqual(["C:/Users/me/AppData/图片.png"]);
  });

  it("data: 内嵌图解码成文件", () => {
    const plan = parseClipboard(
      clip({
        "text/plain": "x",
        "text/html": '<img src="data:image/png;base64,AQID">',
      }),
    );
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0].type).toBe("image/png");
    expect(plan.files[0].size).toBe(3);
  });

  it("Word / Excel：文字 + 带 Office 标记的 HTML + 快照图 → 丢掉快照图只要文字", () => {
    const plan = parseClipboard(
      clip(
        {
          "text/plain": "A\tB\n1\t2",
          "text/html":
            '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><table><tr><td>A</td></tr></table></html>',
        },
        [png()],
      ),
    );
    expect(plan.files).toHaveLength(0);
    expect(plan.text).toContain("A\tB");
  });

  it("非 Office 的「文字 + 图片文件」不丢图", () => {
    const plan = parseClipboard(
      clip({ "text/plain": "看图", "text/html": "<p>看图</p>" }, [png()]),
    );
    expect(plan.files).toHaveLength(1);
  });

  it("QQ 图文（实测剪贴板）：路径带空格且未编码 → 进 paths", () => {
    const plan = parseClipboard(
      clip({
        "text/plain": "不是您说的接入脚本，是原生调用 rdb ",
        "text/html":
          '<html>\r\n<body>\r\n<!--StartFragment-->不是您说的接入脚本，是原生调用 rdb <br><img src="file:///D:/computer/documents/Tencent Files/770492966/nt_qq/nt_data/Pic/2026-10/Ori/9d80846b.png"><!--EndFragment-->\r\n</body>\r\n</html>',
      }),
    );
    expect(plan.paths).toEqual([
      "D:/computer/documents/Tencent Files/770492966/nt_qq/nt_data/Pic/2026-10/Ori/9d80846b.png",
    ]);
    expect(plan.text).toContain("rdb");
  });

  it("file: 路径里的反斜杠和孤立 % 也能解析", () => {
    expect(fileUrlToPath("file:///C:\\Temp\\100%.png")).toBe(
      "C:/Temp/100%.png",
    );
  });

  it("浏览器「复制图片」：文件 + HTML 里同一张 <img> → 只取文件，不重复下载", () => {
    const plan = parseClipboard(
      clip({ "text/html": '<img src="https://a.com/x.png">' }, [png()]),
    );
    expect(plan.files).toHaveLength(1);
    expect(plan.urls).toHaveLength(0);
  });

  it("HTML 图片超过上限只收前 N 张，重复地址只算一次", () => {
    const imgs = Array.from(
      { length: MAX_HTML_IMAGES + 5 },
      (_, i) => `<img src="https://a.com/${i}.png">`,
    );
    const plan = parseClipboard(
      clip({
        "text/plain": "t",
        "text/html": imgs.join("") + '<img src="https://a.com/0.png">',
      }),
    );
    expect(plan.urls).toHaveLength(MAX_HTML_IMAGES);
    expect(plan.skipped).toBe(5);
  });

  it("不认识的 src（blob: / 相对路径）忽略", () => {
    const plan = parseClipboard(
      clip({
        "text/plain": "t",
        "text/html": '<img src="blob:xyz"><img src="/rel.png">',
      }),
    );
    expect(plan.files.length + plan.urls.length + plan.paths.length).toBe(0);
  });
});

describe("helpers", () => {
  it("extractImgSrcs 不把 data-src 之类当 src", () => {
    expect(extractImgSrcs('<img data-src="a.png" src="b.png">')).toEqual([
      "b.png",
    ]);
  });

  it("fileUrlToPath 处理 POSIX 路径", () => {
    expect(fileUrlToPath("file:///home/u/a%20b.png")).toBe("/home/u/a b.png");
  });
});
