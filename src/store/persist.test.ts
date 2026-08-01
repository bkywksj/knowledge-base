import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { persistValueEqual, changedPersistKeys } from "./index";

describe("persistValueEqual · 标量", () => {
  it("同值相等、异值不等", () => {
    expect(persistValueEqual(1, 1)).toBe(true);
    expect(persistValueEqual("a", "a")).toBe(true);
    expect(persistValueEqual(true, true)).toBe(true);
    expect(persistValueEqual(1, 2)).toBe(false);
    expect(persistValueEqual("a", "b")).toBe(false);
  });

  it("null / undefined 各自与自身相等，互不相等", () => {
    expect(persistValueEqual(null, null)).toBe(true);
    expect(persistValueEqual(undefined, undefined)).toBe(true);
    expect(persistValueEqual(null, undefined)).toBe(false);
  });

  it("类型不同不相等（不做隐式转换）", () => {
    expect(persistValueEqual(1, "1")).toBe(false);
    expect(persistValueEqual(0, false)).toBe(false);
    expect(persistValueEqual([], {})).toBe(false);
  });
});

describe("persistValueEqual · 数组（按内容不按引用）", () => {
  it("内容相同的两个不同数组相等 —— 这正是避免无谓写盘的关键", () => {
    expect(persistValueEqual(["a", "b"], ["a", "b"])).toBe(true);
  });

  it("顺序不同 / 长度不同 / 元素不同都算变了", () => {
    expect(persistValueEqual(["a", "b"], ["b", "a"])).toBe(false);
    expect(persistValueEqual(["a"], ["a", "b"])).toBe(false);
    expect(persistValueEqual(["a"], ["c"])).toBe(false);
  });

  it("空数组相等", () => {
    expect(persistValueEqual([], [])).toBe(true);
  });
});

describe("persistValueEqual · 对象（notesHeadingFolded 形态：Record<id, string[]>）", () => {
  it("内容相同的不同对象相等", () => {
    expect(persistValueEqual({ 1: ["a"] }, { 1: ["a"] })).toBe(true);
  });

  it("嵌套数组的差异能被发现（只比一层就会漏掉这条）", () => {
    expect(persistValueEqual({ 1: ["a"] }, { 1: ["a", "b"] })).toBe(false);
    expect(persistValueEqual({ 1: ["a"] }, { 1: ["z"] })).toBe(false);
  });

  it("键数不同 / 键名不同算变了", () => {
    expect(persistValueEqual({ 1: ["a"] }, { 1: ["a"], 2: [] })).toBe(false);
    expect(persistValueEqual({ 1: ["a"] }, { 2: ["a"] })).toBe(false);
  });

  it("空对象相等", () => {
    expect(persistValueEqual({}, {})).toBe(true);
  });
});

describe("changedPersistKeys", () => {
  it("无基线（首次写盘）→ 全部字段都要写", () => {
    const payload = { a: 1, b: 2 };
    expect(changedPersistKeys(payload, null).sort()).toEqual(["a", "b"]);
  });

  it("没有任何变化 → 空数组（调用方据此完全跳过磁盘 IO）", () => {
    const payload = { a: 1, b: ["x"] };
    expect(changedPersistKeys(payload, { a: 1, b: ["x"] })).toEqual([]);
  });

  it("只报真正变了的键 —— 这是修复「副窗覆写主窗设置」的核心", () => {
    // 场景复现：副窗内存里 editorHeadingNumber 还是 false（主窗已改成 true 并落盘），
    // 副窗只动了 sidePanelWidth。增量写必须只输出 sidePanelWidth，
    // 绝不能把副窗那份陈旧的 editorHeadingNumber 一起写回去。
    const baseline = { editorHeadingNumber: false, sidePanelWidth: 240 };
    const payload = { editorHeadingNumber: false, sidePanelWidth: 300 };
    expect(changedPersistKeys(payload, baseline)).toEqual(["sidePanelWidth"]);
  });

  it("基线里没有的新键算变了（版本升级新增字段）", () => {
    expect(changedPersistKeys({ a: 1, brandNew: 5 }, { a: 1 })).toEqual([
      "brandNew",
    ]);
  });

  it("值变成 undefined 也算变了", () => {
    expect(changedPersistKeys({ a: undefined }, { a: 1 })).toEqual(["a"]);
  });
});

/**
 * 源码一致性守卫。
 *
 * 持久化链路有三段：collectPersistPayload（写什么）、loadThemeFromStore（读什么）。
 * 任一段漏挂字段，症状都是"这个设置重启后回默认"——而且非常难查（功能正常、只是不持久）。
 * 历史上 `pasteCodeAsBlock` 就漏在变更检测里过。
 *
 * 这里直接解析源码做集合比对，让漏挂在 CI 阶段就红，而不是等用户反馈。
 */
describe("持久化字段三方一致性（源码静态校验）", () => {
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");

  /** collectPersistPayload 里声明的字段（写盘 + 变更检测的唯一真相源） */
  function payloadKeys(): string[] {
    const m = src.match(
      /function collectPersistPayload\(state: AppStore\): Record<string, unknown> \{\s*return \{([\s\S]*?)\n {2}\};/,
    );
    expect(m, "没能定位 collectPersistPayload —— 函数签名改了就同步改这里").toBeTruthy();
    return [...m![1].matchAll(/^\s{4}([A-Za-z0-9_]+):/gm)].map((x) => x[1]);
  }

  /** loadThemeFromStore 里 store.get(...) 读回的键（泛型参数可能含嵌套 <>，故非贪婪到 '('） */
  function loadedKeys(): string[] {
    return [
      ...src.matchAll(/store\.get(?:<.*?>)?\(\s*["']([A-Za-z0-9_]+)["']/g),
    ].map((x) => x[1]);
  }

  it("payload 字段无重复（重复 = 后者静默覆盖前者）", () => {
    const keys = payloadKeys();
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("字段数量在合理量级（防正则失配后空跑成假绿）", () => {
    expect(payloadKeys().length).toBeGreaterThan(40);
    expect(loadedKeys().length).toBeGreaterThan(40);
  });

  it("每个会被写盘的字段，启动时都要读回来（否则重启即回默认）", () => {
    const loaded = new Set(loadedKeys());
    const missing = payloadKeys().filter((k) => !loaded.has(k));
    expect(missing, `这些字段存了却没在 loadThemeFromStore 里读回：${missing.join(", ")}`).toEqual([]);
  });

  it("每个读回来的字段，都要在 payload 里（否则改了它不会落盘）", () => {
    const inPayload = new Set(payloadKeys());
    const orphan = [...new Set(loadedKeys())].filter((k) => !inPayload.has(k));
    expect(orphan, `这些字段读了却不会被写回：${orphan.join(", ")}`).toEqual([]);
  });
});
