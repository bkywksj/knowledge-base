import { describe, it, expect } from "vitest";
import { allowAllExceptDangerous } from "@/components/editor/AllowFileLink";

/**
 * 「粘贴 base64 内联图显示成源码」的回归测试。
 *
 * 根因：本判定曾把整个 `data:` 协议拉黑（比 markdown-it 默认还严），markdown-it 于是
 * 拒绝生成 <img>，`![](data:image/png;base64,…)` 原样吐成字面文本；而走「导入 .md」时
 * Rust 侧会先把 base64 解码落盘，所以同内容导入正常、粘贴成源码。
 */
describe("validateLink · 内联图片 data URI 放行", () => {
  it("png / jpeg / gif / webp 内联图放行（markdown-it 默认也放行这几种）", () => {
    for (const u of [
      "data:image/png;base64,iVBORw0KGgo=",
      "data:image/jpeg;base64,/9j/4AAQ",
      "data:image/gif;base64,R0lGODlh",
      "data:image/webp;base64,UklGRg==",
    ]) {
      expect(allowAllExceptDangerous(u), u).toBe(true);
    }
  });

  it("jpg / avif / bmp 这些安全光栅格式也放行", () => {
    expect(allowAllExceptDangerous("data:image/jpg;base64,AAA")).toBe(true);
    expect(allowAllExceptDangerous("data:image/avif;base64,AAA")).toBe(true);
    expect(allowAllExceptDangerous("data:image/bmp;base64,AAA")).toBe(true);
  });

  it("大小写不敏感（部分导出器写 DATA:IMAGE/PNG）", () => {
    expect(allowAllExceptDangerous("DATA:IMAGE/PNG;base64,AAA")).toBe(true);
  });

  it("前后空白不影响判定", () => {
    expect(allowAllExceptDangerous("  data:image/png;base64,AAA  ")).toBe(true);
  });
});

describe("validateLink · 危险协议仍须拦截", () => {
  it("svg+xml 不放行（可携带脚本，markdown-it 默认同样不放行）", () => {
    expect(allowAllExceptDangerous("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
  });

  it("data:text/html 不放行", () => {
    expect(allowAllExceptDangerous("data:text/html;base64,PGgxPg==")).toBe(false);
  });

  it("javascript: / vbscript: 不放行", () => {
    expect(allowAllExceptDangerous("javascript:alert(1)")).toBe(false);
    expect(allowAllExceptDangerous("vbscript:msgbox(1)")).toBe(false);
  });

  it("伪装成图片前缀的脚本协议不被绕过", () => {
    // 不以 data:image/<光栅格式>; 开头 → 落回黑名单判定
    expect(allowAllExceptDangerous("data:image/png")).toBe(false); // 缺分号，非合法内联图
    expect(allowAllExceptDangerous("data:text/html;image/png;base64,AAA")).toBe(false);
  });
});

describe("validateLink · 本扩展原有职责不回归", () => {
  it("file:// 附件链接仍放行（本扩展存在的初衷）", () => {
    expect(allowAllExceptDangerous("file:///C:/Users/x/a.pdf")).toBe(true);
  });

  it("常规 http(s) / 相对路径 / 应用私有协议放行", () => {
    for (const u of [
      "https://example.com/a.png",
      "http://example.com/a.png",
      "./images/a.png",
      "kb-asset://images/1/a.png",
      "kb-image://1/a.png",
    ]) {
      expect(allowAllExceptDangerous(u), u).toBe(true);
    }
  });
});
