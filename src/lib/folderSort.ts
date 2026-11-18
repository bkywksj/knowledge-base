import { folderApi } from "@/lib/api";
import type { Folder } from "@/types";

/**
 * 文件夹排序（PC 侧栏「排序」与手机笔记页共用一份）：把某一层的子文件夹一次性排好、写进 sort_order。
 * 排完仍可手动拖动调整；顺序随同步到其它设备。
 */
export type FolderSortMode = "name-asc" | "name-desc" | "updated" | "created";

export const FOLDER_SORT_OPTIONS: { mode: FolderSortMode; label: string }[] = [
  { mode: "name-asc", label: "按名称 A → Z" },
  { mode: "name-desc", label: "按名称 Z → A" },
  { mode: "updated", label: "按最近更新" },
  { mode: "created", label: "按最近创建" },
];

/**
 * 排序 `parentId` 这一层（null = 根层）的子文件夹。
 * `siblings` 是这一层当前的子文件夹列表：按名称排在前端算好顺序再写回；按时间交给后端（它有时间戳）。
 */
export async function sortFolderLevel(parentId: number | null, siblings: Folder[], mode: FolderSortMode): Promise<void> {
  if (mode === "name-asc" || mode === "name-desc") {
    const sorted = [...siblings].sort((a, b) => a.name.localeCompare(b.name, "zh", { numeric: true }));
    if (mode === "name-desc") sorted.reverse();
    await folderApi.reorder(sorted.map((f) => f.id));
  } else {
    await folderApi.sortChildrenByTime(parentId, mode);
  }
}
