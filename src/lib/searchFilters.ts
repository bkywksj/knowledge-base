import type { Folder, NoteType, SearchFilters } from "@/types";

/**
 * 搜索筛选条件的组装（纯函数）。
 *
 * 原来写在 PC 搜索页（pages/search/index.tsx）里，2026-11 手机端 v4 重构时原样挪到这里：
 * 手机搜索页的时间 / 文件夹 / 标签 / 仅标题筛选要和 PC 走同一套规则（含子文件夹、没勾的维度省略字段）。
 */

/** 把文件夹树拍平成"该节点 + 全部子孙"的 id 列表 */
export function collectSubtreeIds(folders: Folder[], targetIds: number[]): number[] {
  const out = new Set<number>();
  const walk = (nodes: Folder[], inside: boolean) => {
    for (const n of nodes) {
      const hit = inside || targetIds.includes(n.id);
      if (hit) out.add(n.id);
      const children = (n as Folder & { children?: Folder[] }).children;
      if (children?.length) walk(children, hit);
    }
  };
  walk(folders, false);
  return [...out];
}

/**
 * RangePicker 给出的 [起, 止] 日期串 → 后端要的时间范围（任一端为空返回 null = 不筛选）。
 *
 * 后端比的是 notes 表的 `YYYY-MM-DD HH:MM:SS`，补上时分秒才能让"选到今天"
 * 含当天全部笔记，而不是卡在 00:00:00。
 */
export function toDayRange(strs: [string, string]): [string, string] | null {
  return strs[0] && strs[1] ? [`${strs[0]} 00:00:00`, `${strs[1]} 23:59:59`] : null;
}

/**
 * 组装成后端要的 filters。
 *
 * 🔴 没勾的维度必须**省略字段**而不是传 `[]` —— 后端 fail-closed，
 * 空数组表示"勾了但没选中"会直接返回零结果（见 types/SearchFilters 注释）。
 * 抽成纯函数：外部跳转时要按 URL 里的新条件立刻搜，不能等 state 更新后再读 useMemo。
 */
export function buildSearchFilters(
  s: {
    folders: number[];
    tags: number[];
    types: NoteType[];
    dateRange: [string, string] | null;
    createdRange: [string, string] | null;
    titleOnly: boolean;
  },
  folderTree: Folder[],
): SearchFilters | undefined {
  const f: SearchFilters = {};
  if (s.folders.length > 0) {
    // 选了「工作」应当含其下所有子文件夹，否则用户会觉得"明明在这个目录里却搜不到"。
    // 🔴 从 URL 恢复时文件夹树可能还没拉到：此时子树展开会得到 []，后端 fail-closed 直接零结果。
    //    先用选中的 id 本身，树到了 filtersKey 变化会自动按子树重搜。
    f.folderIds =
      folderTree.length > 0 ? collectSubtreeIds(folderTree, s.folders) : s.folders;
  }
  if (s.tags.length > 0) f.tagIds = s.tags;
  if (s.types.length > 0) f.noteTypes = s.types;
  if (s.dateRange) {
    f.updatedAfter = s.dateRange[0];
    f.updatedBefore = s.dateRange[1];
  }
  if (s.createdRange) {
    f.createdAfter = s.createdRange[0];
    f.createdBefore = s.createdRange[1];
  }
  // 只在勾选时才传：不勾 = 省略字段，保持与旧版请求完全一致
  if (s.titleOnly) f.titleOnly = true;
  return Object.keys(f).length > 0 ? f : undefined;
}

/** 时间筛选预设（按更新时间，与 PC 搜索页的四个快捷项一致） */
export type SearchTimePreset = "today" | "7d" | "30d" | "year";

export const SEARCH_TIME_PRESETS: { key: SearchTimePreset; label: string }[] = [
  { key: "today", label: "今天" },
  { key: "7d", label: "最近 7 天" },
  { key: "30d", label: "最近 30 天" },
  { key: "year", label: "今年" },
];

/** 预设 → [起, 止] 日期串（YYYY-MM-DD，本地时区），再交给 toDayRange 补时分秒 */
export function searchTimePresetRange(key: SearchTimePreset, now = new Date()): [string, string] {
  const ymd = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const end = ymd(now);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (key === "7d") start.setDate(start.getDate() - 6);
  else if (key === "30d") start.setDate(start.getDate() - 29);
  else if (key === "year") start.setMonth(0, 1);
  return [ymd(start), end];
}
