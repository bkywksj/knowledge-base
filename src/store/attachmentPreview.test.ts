import { describe, it, expect } from "vitest";
import {
  isPreviewableAttachment,
  isTextAttachmentExt,
  OFFICE_ATTACHMENT_EXTS,
  TEXT_ATTACHMENT_EXTS,
} from "./attachmentPreview";

/** 从路径取扩展名 —— 与 AttachmentPreviewModal 里的推导保持同一套语义 */
function extOf(pathOrName: string): string {
  return pathOrName.toLowerCase().split(".").pop() ?? "";
}

describe("附件预览：扩展名分类", () => {
  it("PDF 不属于文本类 —— 绝不能落进 TextPreview", () => {
    // 这是 bug 的核心：改过名的 PDF 曾被兜底分支当文本读，
    // 报 "stream did not contain valid UTF-8"
    expect(isTextAttachmentExt("pdf")).toBe(false);
  });

  it.each(OFFICE_ATTACHMENT_EXTS)("Office 类型 %s 也不走文本预览", (ext) => {
    expect(isTextAttachmentExt(ext)).toBe(false);
  });

  it.each(["txt", "md", "json", "csv", "rs", "ts", "yaml"])(
    "文本类型 %s 走文本预览",
    (ext) => {
      expect(isTextAttachmentExt(ext)).toBe(true);
    },
  );

  it("大小写不敏感", () => {
    expect(isTextAttachmentExt("MD")).toBe(true);
    expect(isTextAttachmentExt("PDF")).toBe(false);
  });

  it("未知类型不走文本预览（显示「暂不支持预览」而不是硬读二进制）", () => {
    for (const ext of ["zip", "exe", "mp4", "psd", ""]) {
      expect(isTextAttachmentExt(ext)).toBe(false);
    }
  });
});

describe("附件预览：可预览判定与预览器选择必须口径一致", () => {
  /**
   * 这是本 bug 的根因回归测试。
   *
   * 曾经：「能不能预览」按 rel（真实路径）判断，「用哪个预览器」按 fileName
   * （笔记里链接的显示文本）判断。用户把链接文本改成不带扩展名的中文标题后，
   * 前者放行、后者认不出 → 落到 TextPreview 兜底 → UTF-8 读二进制 PDF 报错。
   *
   * 现在两处都按 rel 判断，这里锁死：凡是 isPreviewableAttachment 放行的路径，
   * 都必须能被三类预览器之一接住，绝不会掉进「没人认领」的状态。
   */
  const cases = [
    "kb_assets/attachments/2373/关于某某某的通知.pdf",
    "kb_assets/attachments/1/report.docx",
    "kb_assets/attachments/1/data.xlsx",
    "kb_assets/attachments/1/notes.md",
    "kb_assets/attachments/1/带 空格 和中文.txt",
  ];

  it.each(cases)("%s 能被某个预览器接住", (rel) => {
    expect(isPreviewableAttachment(rel)).toBe(true);
    const ext = extOf(rel);
    const claimed =
      ext === "pdf" ||
      OFFICE_ATTACHMENT_EXTS.includes(ext) ||
      isTextAttachmentExt(ext);
    expect(claimed).toBe(true);
  });

  it("显示名不带扩展名时，仍按 rel 正确识别为 PDF", () => {
    // 用户把链接文本改成了标题，rel 才是真相
    const rel = "kb_assets/attachments/2373/关于某某某的通知.pdf";
    const displayName = "关于某某某的通知"; // 链接文本，无扩展名
    expect(extOf(rel)).toBe("pdf");
    expect(extOf(displayName)).not.toBe("pdf"); // 按显示名推导会失败——这正是老 bug
  });

  it(".doc 与 .docx 必须能按 rel 区分开（走不同的解析分支）", () => {
    // DocxPreview 内部：.doc 要先转 docx 再喂 mammoth，.docx 直接读。
    // 这个判断曾经也按 fileName 做，改过名的 .doc 会跳过转换 →
    // 把老 Word 二进制直接喂给只吃 zip 的 mammoth → 解析失败。
    expect(extOf("kb_assets/attachments/1/关于某某的通知.doc")).toBe("doc");
    expect(extOf("kb_assets/attachments/1/关于某某的通知.docx")).toBe("docx");
    // 两者都属于 Office，都会被路由到 DocxPreview
    expect(OFFICE_ATTACHMENT_EXTS).toContain("doc");
    expect(OFFICE_ATTACHMENT_EXTS).toContain("docx");
  });

  it("不可预览的类型不会被误判为文本", () => {
    expect(isPreviewableAttachment("a/b/archive.zip")).toBe(false);
    expect(isTextAttachmentExt("zip")).toBe(false);
  });

  it("没有扩展名的路径不可预览", () => {
    expect(isPreviewableAttachment("a/b/README")).toBe(false);
  });

  it("三张扩展名表之间没有重叠（同一类型只能有一个归属）", () => {
    const overlap = OFFICE_ATTACHMENT_EXTS.filter((e) =>
      TEXT_ATTACHMENT_EXTS.includes(e),
    );
    expect(overlap).toEqual([]);
    expect(OFFICE_ATTACHMENT_EXTS).not.toContain("pdf");
    expect(TEXT_ATTACHMENT_EXTS).not.toContain("pdf");
  });
});
