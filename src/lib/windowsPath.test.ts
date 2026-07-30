import { describe, it, expect } from "vitest";
import { isWindowsPathText } from "./windowsPath";

describe("粘贴 Windows 路径：需要绕开 Markdown 解析的情形", () => {
  it("反斜杠后跟标点的路径（用户实际踩到的坑）", () => {
    // 这几条如果走 Markdown 解析，`\` 会被当转义序列吃掉：
    // D:\111\.vscode → D:\111.vscode
    expect(isWindowsPathText(String.raw`D:\111\.vscode`)).toBe(true);
    expect(
      isWindowsPathText(String.raw`C:\Users\yecha\.claude\settings.json`),
    ).toBe(true);
    expect(isWindowsPathText(String.raw`D:\proj\_private\a.txt`)).toBe(true);
    expect(isWindowsPathText(String.raw`D:\a\#tag\b`)).toBe(true);
    expect(isWindowsPathText(String.raw`D:\a\(x)\b`)).toBe(true);
  });

  it("UNC 路径（开头的双反斜杠同样会塌成一个）", () => {
    expect(isWindowsPathText(String.raw`\\NAS\share\.git`)).toBe(true);
  });

  it("反斜杠后全是字母数字的路径也一并接管", () => {
    // 这类本来不会被 Markdown 改，但同样是路径，走字面插入结果一致，
    // 判定无需为它们开特例
    expect(isWindowsPathText(String.raw`D:\111\test\Users`)).toBe(true);
  });

  it("正反斜杠混用", () => {
    expect(isWindowsPathText(String.raw`C:/mixed\slash\.git`)).toBe(true);
  });

  it("首尾空白不影响判定", () => {
    expect(isWindowsPathText(String.raw`  D:\111\.vscode  `)).toBe(true);
  });

  it("多行路径列表：每行都是路径才算", () => {
    expect(
      isWindowsPathText(String.raw`D:\a\.x` + "\n" + String.raw`E:\b\.y`),
    ).toBe(true);
    // 混了一行普通文字就整体放行，交给默认粘贴
    expect(isWindowsPathText(String.raw`D:\a\.x` + "\n普通说明文字")).toBe(
      false,
    );
  });
});

describe("粘贴 Windows 路径：不该抢走的情形", () => {
  it("纯正斜杠路径 —— Markdown 本来就不会动它", () => {
    expect(isWindowsPathText("C:/pure/forward/slash")).toBe(false);
  });

  it("句子里顺带提到路径 —— 整段不是路径，尊重 Markdown 解析", () => {
    expect(isWindowsPathText(String.raw`配置文件在 D:\a\.vscode 下`)).toBe(false);
  });

  it("含空格的路径 —— 无法与句子区分，判定从严放行", () => {
    // 已知取舍：`C:\Program Files\.vscode` 这类仍会被 Markdown 吃掉反斜杠。
    // 放宽会把「以路径开头的句子」一起抢走，代价更大
    expect(isWindowsPathText(String.raw`C:\Program Files\App\x.exe`)).toBe(
      false,
    );
  });

  it("正常 Markdown 内容", () => {
    expect(isWindowsPathText("# 标题\n正文")).toBe(false);
    expect(isWindowsPathText("- [ ] 待办")).toBe(false);
    expect(isWindowsPathText("https://example.com/a_b")).toBe(false);
  });

  it("代码片段（含反斜杠但不是路径）", () => {
    expect(
      isWindowsPathText(String.raw`function f() { return "a\.b"; }`),
    ).toBe(false);
  });

  it("空文本", () => {
    expect(isWindowsPathText("")).toBe(false);
    expect(isWindowsPathText("   ")).toBe(false);
    expect(isWindowsPathText("\n\n")).toBe(false);
  });
});
