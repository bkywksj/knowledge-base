import { describe, it, expect } from "vitest";
import { isLocalAssetUrl, mapWithConcurrency } from "./printNote";

describe("isLocalAssetUrl · 需要内嵌的本地资源", () => {
  it("kb-asset:// 是笔记素材的标准形态", () => {
    expect(isLocalAssetUrl("kb-asset://attachments/a.pdf")).toBe(true);
  });

  it("asset:// 与 file:// 也算本地", () => {
    expect(isLocalAssetUrl("asset://localhost/E:/x/a.pdf")).toBe(true);
    expect(isLocalAssetUrl("file:///E:/x/a.pdf")).toBe(true);
  });

  it("裸路径（相对 / 绝对）算本地", () => {
    expect(isLocalAssetUrl("attachments/a.pdf")).toBe(true);
    expect(isLocalAssetUrl("E:/notes/a.pdf")).toBe(true);
  });

  it("http://asset.localhost 是本地资源，不能当外链排除掉", () => {
    // 这条最容易写错：它是 http 开头，但指向的是本机 asset 协议
    expect(isLocalAssetUrl("http://asset.localhost/E%3A/x/a.pdf")).toBe(true);
    expect(isLocalAssetUrl("https://asset.localhost/E%3A/x/a.pdf")).toBe(true);
  });
});

describe("isLocalAssetUrl · 不该内嵌的", () => {
  it("真正的外链排除", () => {
    expect(isLocalAssetUrl("https://example.com/a.pdf")).toBe(false);
    expect(isLocalAssetUrl("http://example.com/a.pdf")).toBe(false);
  });

  it("已内嵌 / 锚点 / 协议类链接排除", () => {
    expect(isLocalAssetUrl("data:application/pdf;base64,AAA")).toBe(false);
    expect(isLocalAssetUrl("blob:http://localhost/uuid")).toBe(false);
    expect(isLocalAssetUrl("#heading-1")).toBe(false);
    expect(isLocalAssetUrl("mailto:a@b.com")).toBe(false);
    expect(isLocalAssetUrl("tel:10086")).toBe(false);
  });

  it("空串 / 纯空白排除", () => {
    expect(isLocalAssetUrl("")).toBe(false);
    expect(isLocalAssetUrl("   ")).toBe(false);
  });
});

describe("mapWithConcurrency", () => {
  it("每个任务都会被执行一次，顺序不限", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    const seen: number[] = [];
    await mapWithConcurrency(items, 3, async (n) => {
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it("并发数不超过上限（这正是限内存峰值的关键）", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let running = 0;
    let peak = 0;
    await mapWithConcurrency(items, 4, async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // 确实并发了，不是退化成串行
  });

  it("任务数少于并发上限时不会空转", async () => {
    let calls = 0;
    await mapWithConcurrency([1, 2], 8, async () => {
      calls++;
    });
    expect(calls).toBe(2);
  });

  it("空列表直接返回", async () => {
    let calls = 0;
    await mapWithConcurrency([], 4, async () => {
      calls++;
    });
    expect(calls).toBe(0);
  });
});
