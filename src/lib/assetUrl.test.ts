import { describe, it, expect } from "vitest";
import { needsLegacyPathResolve } from "./assetUrl";

/**
 * `needsLegacyPathResolve` 的回归测试。
 *
 * 这个函数是编辑器 MutationObserver 的**死循环闸门**（见 TiptapEditor 的资产渲染拦截）：
 * 返回 true 的 src 会被送去后端兜底解析并回写 `src`；一旦把「运行期 asset URL」
 * 误判成 true，就会形成 解析→回写→再次触发 observer→再解析 的无限同步循环，
 * 主线程彻底冻结（v1.50.0 在 macOS 上的「打开笔记就卡死」事故）。
 *
 * 所以下面对**各平台 asset URL 形态**的断言是硬约束，改动前请先读懂事故成因。
 */
describe("needsLegacyPathResolve", () => {
  /**
   * ⚠️ 核心回归：Tauri 的 `convertFileSrc` 在不同平台产出不同协议
   * （tauri/scripts/core.js）：
   *   Windows / Android → `http://asset.localhost/<encodeURIComponent(路径)>`
   *   macOS / Linux / iOS → `asset://localhost/<encodeURIComponent(路径)>`
   * 两种都必须判为 false，否则对应平台整个应用卡死。
   */
  describe("运行期 asset URL —— 一律不得走兜底（否则死循环）", () => {
    it("macOS / Linux 形态 asset://localhost/", () => {
      expect(
        needsLegacyPathResolve(
          "asset://localhost/%2FUsers%2Fme%2FLibrary%2FApplication%20Support%2Fcom.agilefr.kb%2Fkb_assets%2Fimages%2F1%2Fx.png",
        ),
      ).toBe(false);
    });

    it("Windows / Android 形态 http://asset.localhost/", () => {
      expect(
        needsLegacyPathResolve(
          "http://asset.localhost/E%3A%5Ckb%5Ckb_assets%5Cimages%5C1%5Cx.png",
        ),
      ).toBe(false);
    });

    it("https 变体（protocolScheme 可配置为 https）", () => {
      expect(needsLegacyPathResolve("https://asset.localhost/C%3A%2Fkb%2Fa.png")).toBe(false);
    });

    it("裸 asset:// 变体", () => {
      expect(needsLegacyPathResolve("asset://localhost/foo.png")).toBe(false);
      expect(needsLegacyPathResolve("asset://foo.png")).toBe(false);
    });

    /**
     * 结构性防线：任何**当前未知**的协议也必须落 false。
     * 这条断言保证「将来 Tauri 又换一种协议格式」不会再引发同类事故 ——
     * 最坏结果只是不做兜底，不会卡死。
     */
    it("未知/未来协议同样不走兜底", () => {
      expect(needsLegacyPathResolve("tauri://localhost/x.png")).toBe(false);
      expect(needsLegacyPathResolve("some-future-scheme://host/x.png")).toBe(false);
      expect(needsLegacyPathResolve("kb-asset://kb_assets/images/1/x.png")).toBe(false);
    });
  });

  describe("老形态本地路径 —— 需要兜底解析", () => {
    it("file:// 附件链接（Windows 三斜杠形态）", () => {
      expect(needsLegacyPathResolve("file:///E:/kb/attachments/5/report.pdf")).toBe(true);
    });

    it("file:// 附件链接（POSIX 形态）", () => {
      expect(needsLegacyPathResolve("file:///Users/me/kb/attachments/5/a.pdf")).toBe(true);
    });

    it("Windows 裸绝对路径（反斜杠与正斜杠都要认）", () => {
      expect(needsLegacyPathResolve("E:\\my\\kb\\kb_assets\\images\\3\\p.png")).toBe(true);
      expect(needsLegacyPathResolve("C:/kb/kb_assets/images/3/p.png")).toBe(true);
    });

    it("UNC 路径", () => {
      expect(needsLegacyPathResolve("\\\\server\\share\\kb\\a.png")).toBe(true);
    });

    it("POSIX 裸绝对路径", () => {
      expect(needsLegacyPathResolve("/Users/me/kb/kb_assets/images/1/x.png")).toBe(true);
      expect(needsLegacyPathResolve("/home/me/kb/a.png")).toBe(true);
    });
  });

  describe("外链与特殊值 —— 不碰", () => {
    it("真外链", () => {
      expect(needsLegacyPathResolve("https://example.com/pic.png")).toBe(false);
      expect(needsLegacyPathResolve("http://example.com/pic.png")).toBe(false);
    });

    it("data: / blob:", () => {
      expect(needsLegacyPathResolve("data:image/png;base64,iVBORw0KGgo=")).toBe(false);
      expect(needsLegacyPathResolve("blob:http://localhost/abc-123")).toBe(false);
    });

    it("协议相对 URL 是外链，不是本地路径", () => {
      expect(needsLegacyPathResolve("//cdn.example.com/x.png")).toBe(false);
    });

    it("裸相对路径不走兜底（v54 迁移已把它们归一化成 kb-asset://）", () => {
      expect(needsLegacyPathResolve("kb_assets/images/1/x.png")).toBe(false);
      expect(needsLegacyPathResolve("./x.png")).toBe(false);
    });

    it("空值 / 空白", () => {
      expect(needsLegacyPathResolve("")).toBe(false);
      expect(needsLegacyPathResolve("   ")).toBe(false);
      expect(needsLegacyPathResolve(null)).toBe(false);
      expect(needsLegacyPathResolve(undefined)).toBe(false);
    });
  });

  /**
   * 直接复刻 Tauri `convertFileSrc` 的实现，对两个平台各跑一遍真实数据目录路径，
   * 断言产出的 URL 都不会触发兜底。
   *
   * 与上面逐条断言的区别：这里锁的是**生成规则**本身 —— 即使有人改了
   * `resolveAssetSrc` 的拼法，只要它仍走 convertFileSrc，这条测试就依然有效。
   */
  describe("模拟 convertFileSrc 的跨平台输出", () => {
    /** 复刻自 tauri-2.10.3/scripts/core.js 的 convertFileSrc */
    function convertFileSrcLike(filePath: string, osName: string, protocolScheme = "http") {
      const path = encodeURIComponent(filePath);
      return osName === "windows" || osName === "android"
        ? `${protocolScheme}://asset.localhost/${path}`
        : `asset://localhost/${path}`;
    }

    const cases: Array<{ os: string; abs: string }> = [
      { os: "windows", abs: "E:\\my\\kb\\kb_assets\\images\\1\\x.png" },
      { os: "android", abs: "/data/data/com.agilefr.kb/files/kb_assets/images/1/x.png" },
      { os: "macos", abs: "/Users/me/Library/Application Support/com.agilefr.kb/kb_assets/images/1/x.png" },
      { os: "linux", abs: "/home/me/.local/share/com.agilefr.kb/kb_assets/images/1/x.png" },
      { os: "ios", abs: "/var/mobile/Containers/Data/Application/kb/kb_assets/images/1/x.png" },
    ];

    for (const { os, abs } of cases) {
      it(`${os}: 运行期 asset URL 不触发兜底`, () => {
        const url = convertFileSrcLike(abs, os);
        expect(needsLegacyPathResolve(url)).toBe(false);
      });
    }

    it("原始绝对路径本身（未经 convertFileSrc）则应触发兜底", () => {
      for (const { abs } of cases) {
        expect(needsLegacyPathResolve(abs)).toBe(true);
      }
    });
  });
});
