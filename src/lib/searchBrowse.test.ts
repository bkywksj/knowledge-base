import { describe, expect, it } from "vitest";
import {
  buildTagTree,
  folderSubtreeCount,
  resolveBrowseSelection,
  sortByRecent,
} from "./searchBrowse";
import type { Folder, Note, Tag } from "@/types";

const folder = (id: number, note_count: number, children: Folder[] = []): Folder => ({
  id,
  name: `f${id}`,
  parent_id: null,
  sort_order: 0,
  children,
  note_count,
  color: null,
});

const tag = (id: number, parent_id: number | null = null): Tag => ({
  id,
  name: `t${id}`,
  color: null,
  note_count: 0,
  parent_id,
});

const note = (id: number, updated_at: string, is_pinned = false) =>
  ({ id, updated_at, is_pinned }) as Note;

describe("resolveBrowseSelection", () => {
  const base = { uncategorized: false, folders: [] as number[], tags: [] as number[] };

  it("没有条件时是最近列表", () => {
    expect(resolveBrowseSelection(base)).toEqual({ kind: "recent" });
  });

  it("单选文件夹 / 标签 / 未分类", () => {
    expect(resolveBrowseSelection({ ...base, folders: [3] })).toEqual({ kind: "folder", id: 3 });
    expect(resolveBrowseSelection({ ...base, tags: [5] })).toEqual({ kind: "tag", id: 5 });
    expect(resolveBrowseSelection({ ...base, uncategorized: true })).toEqual({
      kind: "uncategorized",
    });
  });

  it("多选或同时有文件夹和标签时对应不到单个节点", () => {
    expect(resolveBrowseSelection({ ...base, folders: [1, 2] })).toEqual({ kind: "recent" });
    expect(resolveBrowseSelection({ ...base, folders: [1], tags: [2] })).toEqual({ kind: "recent" });
  });
});

describe("folderSubtreeCount", () => {
  it("汇总所有子孙", () => {
    expect(folderSubtreeCount(folder(1, 2, [folder(2, 3, [folder(3, 4)]), folder(4, 0)]))).toBe(9);
  });

  it("自身为 0 但子文件夹有笔记时不显示成空", () => {
    expect(folderSubtreeCount(folder(1, 0, [folder(2, 1)]))).toBe(1);
  });
});

describe("buildTagTree", () => {
  it("按 parent_id 组树", () => {
    const tree = buildTagTree([tag(1), tag(2, 1), tag(3, 2), tag(4)]);
    expect(tree.map((n) => n.tag.id)).toEqual([1, 4]);
    expect(tree[0].children[0].tag.id).toBe(2);
    expect(tree[0].children[0].children[0].tag.id).toBe(3);
  });

  it("父标签不存在时放到顶层", () => {
    expect(buildTagTree([tag(2, 99)]).map((n) => n.tag.id)).toEqual([2]);
  });

  it("子标签排在父标签前面也能挂上", () => {
    const tree = buildTagTree([tag(2, 1), tag(1)]);
    expect(tree.map((n) => n.tag.id)).toEqual([1]);
    expect(tree[0].children[0].tag.id).toBe(2);
  });
});

describe("sortByRecent", () => {
  it("很久没动的置顶笔记不占开头", () => {
    const sorted = sortByRecent(
      [note(1, "2020-01-01 00:00:00", true), note(2, "2026-01-01 00:00:00")],
      10,
    );
    expect(sorted.map((n) => n.id)).toEqual([2, 1]);
  });

  it("同一秒内后写入的在前，并按上限截断", () => {
    const t = "2026-01-01 00:00:00";
    expect(sortByRecent([note(1, t), note(3, t), note(2, t)], 2).map((n) => n.id)).toEqual([3, 2]);
  });

  it("不改原数组", () => {
    const input = [note(1, "2020-01-01 00:00:00"), note(2, "2026-01-01 00:00:00")];
    sortByRecent(input, 10);
    expect(input[0].id).toBe(1);
  });
});
