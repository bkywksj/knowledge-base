import { describe, expect, it } from "vitest";

import type { TaskCategory } from "@/types";
import {
  categoryTreeSelectData,
  collectCategorySubtree,
  flattenCategoryTree,
  subtreeCounts,
} from "./categoryTree";

function c(
  id: number,
  name: string,
  parent: number | null,
  sort = 0,
): TaskCategory {
  return {
    id,
    name,
    color: "#1677ff",
    icon: null,
    sort_order: sort,
    created_at: "",
    parent_id: parent,
  };
}

// 工作(1) ─ 项目(2) ─ 周会(3)
//        └ 报销(4)
// 生活(5)        孤儿(6, 父级 99 不存在)
const CATS = [
  c(5, "生活", null, 1),
  c(3, "周会", 2),
  c(1, "工作", null, 0),
  c(4, "报销", 1, 1),
  c(2, "项目", 1, 0),
  c(6, "孤儿", 99, 2),
];

describe("categoryTree", () => {
  it("深度优先展开：父在前、子紧跟，同级按 sort_order；父级不存在的当顶层", () => {
    const rows = flattenCategoryTree(CATS).map(
      (r) => `${"-".repeat(r.depth)}${r.category.name}`,
    );
    expect(rows).toEqual(["工作", "-项目", "--周会", "-报销", "生活", "孤儿"]);
  });

  it("折叠的分类不展开子级", () => {
    const rows = flattenCategoryTree(CATS, new Set([1])).map(
      (r) => r.category.name,
    );
    expect(rows).toEqual(["工作", "生活", "孤儿"]);
  });

  it("子树 id 与子树计数", () => {
    expect([...collectCategorySubtree(CATS, 1)].sort()).toEqual([1, 2, 3, 4]);
    const counts = subtreeCounts(
      CATS,
      new Map([
        [1, 1],
        [3, 2],
        [5, 4],
      ]),
    );
    expect(counts.get(1)).toBe(3);
    expect(counts.get(2)).toBe(2);
    expect(counts.get(5)).toBe(4);
  });

  it("TreeSelect 数据排除自身子树（防止选成环）", () => {
    const data = categoryTreeSelectData(CATS, 2);
    const titles = JSON.stringify(data);
    expect(titles).not.toContain("项目");
    expect(titles).not.toContain("周会");
    expect(titles).toContain("报销");
  });

  it("脏数据成环不死循环", () => {
    const loop = [c(1, "A", 2), c(2, "B", 1)];
    expect(() => flattenCategoryTree(loop)).not.toThrow();
    expect(() => categoryTreeSelectData(loop)).not.toThrow();
  });
});
