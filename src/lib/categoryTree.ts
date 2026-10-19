/**
 * 待办分类树工具（v66 多级分类）。后端只给平铺列表 + parent_id，树在前端拼。
 *
 * 侧栏、分类管理、新建待办的分类选择都用这一份，排序与层级口径一致：
 * 同级按 sort_order → id，父级在前、子级紧跟其后（深度优先）。
 */
import type { TaskCategory } from "@/types";

export interface CategoryRow {
  category: TaskCategory;
  depth: number;
  hasChildren: boolean;
}

function byOrder(a: TaskCategory, b: TaskCategory): number {
  return a.sort_order - b.sort_order || a.id - b.id;
}

function childrenMap(cats: TaskCategory[]): Map<number | null, TaskCategory[]> {
  const ids = new Set(cats.map((c) => c.id));
  const map = new Map<number | null, TaskCategory[]>();
  for (const c of cats) {
    // 父级不存在（被删 / 还没同步到）就当顶层显示，别让它在树里消失
    const pid =
      c.parent_id != null && ids.has(c.parent_id) ? c.parent_id : null;
    const arr = map.get(pid) ?? [];
    arr.push(c);
    map.set(pid, arr);
  }
  for (const arr of map.values()) arr.sort(byOrder);
  return map;
}

/**
 * 深度优先展开成带层级的有序列表。
 * `collapsed` 里的分类不展开子级（侧栏折叠用）。
 */
export function flattenCategoryTree(
  cats: TaskCategory[],
  collapsed: ReadonlySet<number> = new Set(),
): CategoryRow[] {
  const map = childrenMap(cats);
  const out: CategoryRow[] = [];
  const seen = new Set<number>();
  const walk = (pid: number | null, depth: number) => {
    for (const c of map.get(pid) ?? []) {
      if (seen.has(c.id)) continue; // 脏数据成环时防死循环
      seen.add(c.id);
      const kids = map.get(c.id) ?? [];
      out.push({ category: c, depth, hasChildren: kids.length > 0 });
      if (!collapsed.has(c.id)) walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** 某分类自身 + 所有子孙的 id */
export function collectCategorySubtree(
  cats: TaskCategory[],
  rootId: number,
): Set<number> {
  const map = childrenMap(cats);
  const out = new Set<number>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const c of map.get(id) ?? []) stack.push(c.id);
  }
  return out;
}

export interface CategoryTreeNode {
  value: number;
  title: string;
  color: string;
  children?: CategoryTreeNode[];
}

/**
 * antd TreeSelect 的 treeData。
 * `excludeSubtreeOf`：编辑某分类的上级时，排除它自己和它的子孙（选了就成环）。
 */
export function categoryTreeSelectData(
  cats: TaskCategory[],
  excludeSubtreeOf?: number,
): CategoryTreeNode[] {
  const excluded =
    excludeSubtreeOf != null
      ? collectCategorySubtree(cats, excludeSubtreeOf)
      : new Set<number>();
  const map = childrenMap(cats);
  const build = (pid: number | null, guard: Set<number>): CategoryTreeNode[] =>
    (map.get(pid) ?? [])
      .filter((c) => !excluded.has(c.id) && !guard.has(c.id))
      .map((c) => {
        const next = new Set(guard).add(c.id);
        const kids = build(c.id, next);
        return {
          value: c.id,
          title: c.name,
          color: c.color,
          ...(kids.length > 0 ? { children: kids } : {}),
        };
      });
  return build(null, new Set());
}

/** 每个分类的「自身 + 子孙」任务数（侧栏计数：点父分类看到的就是这么多） */
export function subtreeCounts(
  cats: TaskCategory[],
  ownCounts: ReadonlyMap<number, number>,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const c of cats) {
    let n = 0;
    for (const id of collectCategorySubtree(cats, c.id))
      n += ownCounts.get(id) ?? 0;
    out.set(c.id, n);
  }
  return out;
}
