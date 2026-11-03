import { describe, expect, it } from "vitest";

import {
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  clampColumnWidth,
  sanitizeNotesColumnPrefs,
  DEFAULT_NOTES_COLUMN_PREFS,
} from "./notesListColumns";

describe("clampColumnWidth", () => {
  it("范围内取整后原样返回", () => {
    expect(clampColumnWidth(120.4)).toBe(120);
  });

  it("太窄夹到下限，太宽夹到上限", () => {
    expect(clampColumnWidth(3)).toBe(MIN_COLUMN_WIDTH);
    expect(clampColumnWidth(-50)).toBe(MIN_COLUMN_WIDTH);
    expect(clampColumnWidth(99999)).toBe(MAX_COLUMN_WIDTH);
  });
});

describe("sanitizeNotesColumnPrefs", () => {
  it("非对象一律回默认", () => {
    for (const bad of [null, undefined, 0, "x", true]) {
      expect(sanitizeNotesColumnPrefs(bad)).toEqual(DEFAULT_NOTES_COLUMN_PREFS);
    }
  });

  it("合法数据原样保留", () => {
    const out = sanitizeNotesColumnPrefs({
      hidden: ["folder", "word_count"],
      widths: { tags: 200, updated_at: 90 },
    });
    expect(out.hidden).toEqual(["folder", "word_count"]);
    expect(out.widths).toEqual({ tags: 200, updated_at: 90 });
  });

  it("未知列名和重复项被丢掉", () => {
    const out = sanitizeNotesColumnPrefs({ hidden: ["tags", "nope", "tags", 3, null] });
    expect(out.hidden).toEqual(["tags"]);
  });

  it("宽度不是有限数字的丢掉，越界的夹回范围", () => {
    const out = sanitizeNotesColumnPrefs({
      widths: { tags: "wide", folder: NaN, word_count: 1, updated_at: 10_000 },
    });
    expect(out.widths.tags).toBeUndefined();
    expect(out.widths.folder).toBeUndefined();
    expect(out.widths.word_count).toBe(MIN_COLUMN_WIDTH);
    expect(out.widths.updated_at).toBe(MAX_COLUMN_WIDTH);
  });

  it("不可拖宽的列（序号）即使被写进 widths 也忽略", () => {
    const out = sanitizeNotesColumnPrefs({ widths: { index: 300 } });
    expect(out.widths.index).toBeUndefined();
  });

  it("hidden / widths 类型不对时不抛错，hidden 回到默认隐藏列", () => {
    expect(sanitizeNotesColumnPrefs({ hidden: "folder", widths: [1, 2] })).toEqual({
      hidden: ["index", "word_count"],
      widths: {},
      showHeader: false,
    });
  });

  it("v4 默认：序号 / 字数收起、不显示表头", () => {
    expect(DEFAULT_NOTES_COLUMN_PREFS).toEqual({
      hidden: ["index", "word_count"],
      widths: {},
      showHeader: false,
    });
  });

  it("空数组 hidden 表示用户主动全部显示，不能被默认值覆盖", () => {
    expect(sanitizeNotesColumnPrefs({ hidden: [] }).hidden).toEqual([]);
  });

  it("showHeader 只认布尔值，旧数据没有这个字段时按默认（不显示）", () => {
    expect(sanitizeNotesColumnPrefs({ hidden: [], showHeader: true }).showHeader).toBe(true);
    expect(sanitizeNotesColumnPrefs({ hidden: [] }).showHeader).toBe(false);
    expect(sanitizeNotesColumnPrefs({ hidden: [], showHeader: "yes" }).showHeader).toBe(false);
  });
});
