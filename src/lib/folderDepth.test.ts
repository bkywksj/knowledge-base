import { describe, expect, it } from "vitest";

import type { Folder } from "@/types";
import { folderKeysFromDepth, maxFolderDepth } from "./folderDepth";

/** 只关心 id / children，其余字段对深度计算无意义 */
function f(id: number, children: Folder[] = []): Folder {
  return { id, children } as unknown as Folder;
}

// 1
// ├─ 2
// │   └─ 4
// │       └─ 5
// └─ 3
// 6
const tree: Folder[] = [f(1, [f(2, [f(4, [f(5)])]), f(3)]), f(6)];

describe("maxFolderDepth", () => {
  it("没有文件夹是 0", () => {
    expect(maxFolderDepth([])).toBe(0);
  });

  it("只有根级是 1", () => {
    expect(maxFolderDepth([f(1), f(2)])).toBe(1);
  });

  it("取所有分支里最深的一条", () => {
    expect(maxFolderDepth(tree)).toBe(4);
  });
});

describe("folderKeysFromDepth", () => {
  it("depth=1 即全部折叠，包含每一个文件夹", () => {
    expect(folderKeysFromDepth(tree, 1).sort()).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("depth=2：根级保持展开，二级及更深折叠", () => {
    expect(folderKeysFromDepth(tree, 2).sort()).toEqual(["2", "3", "4", "5"]);
  });

  it("depth=3 只折叠三级及更深", () => {
    expect(folderKeysFromDepth(tree, 3).sort()).toEqual(["4", "5"]);
  });

  it("depth 等于最大层数时只折叠最深那一层", () => {
    expect(folderKeysFromDepth(tree, 4)).toEqual(["5"]);
  });

  it("depth 超过最大层数时没有需要折叠的（等同全部展开）", () => {
    expect(folderKeysFromDepth(tree, 5)).toEqual([]);
  });

  it("空树返回空数组", () => {
    expect(folderKeysFromDepth([], 1)).toEqual([]);
  });
});
