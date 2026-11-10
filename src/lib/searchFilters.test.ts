import { describe, expect, it } from "vitest";
import type { Folder } from "@/types";
import { buildSearchFilters, collectSubtreeIds, searchTimePresetRange, toDayRange } from "./searchFilters";

const tree = [
  { id: 1, name: "工作", children: [{ id: 2, name: "周会", children: [{ id: 3, name: "十一月", children: [] }] }] },
  { id: 4, name: "生活", children: [] },
] as unknown as Folder[];

const empty = { folders: [], tags: [], types: [], dateRange: null, createdRange: null, titleOnly: false };

describe("searchFilters", () => {
  it("选中文件夹含全部子孙", () => {
    expect(collectSubtreeIds(tree, [1]).sort()).toEqual([1, 2, 3]);
    expect(collectSubtreeIds(tree, [2, 4]).sort()).toEqual([2, 3, 4]);
  });

  it("没勾的维度省略字段；全没勾返回 undefined（后端空数组 = 零结果）", () => {
    expect(buildSearchFilters(empty, tree)).toBeUndefined();
    expect(buildSearchFilters({ ...empty, tags: [7], titleOnly: true }, tree)).toEqual({ tagIds: [7], titleOnly: true });
  });

  it("文件夹树还没拉到时先用选中 id 本身，不展开成空数组", () => {
    expect(buildSearchFilters({ ...empty, folders: [1] }, [])).toEqual({ folderIds: [1] });
  });

  it("日期范围补时分秒；时间预设按本地日期算", () => {
    expect(toDayRange(["2026-11-04", "2026-11-10"])).toEqual(["2026-11-04 00:00:00", "2026-11-10 23:59:59"]);
    expect(toDayRange(["", "2026-11-10"])).toBeNull();
    const now = new Date(2026, 10, 10, 9);
    expect(searchTimePresetRange("today", now)).toEqual(["2026-11-10", "2026-11-10"]);
    expect(searchTimePresetRange("7d", now)).toEqual(["2026-11-04", "2026-11-10"]);
    expect(searchTimePresetRange("30d", now)).toEqual(["2026-10-12", "2026-11-10"]);
    expect(searchTimePresetRange("year", now)).toEqual(["2026-01-01", "2026-11-10"]);
  });
});
