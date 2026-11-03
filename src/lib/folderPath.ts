import type { Folder } from "@/types";

/**
 * 在文件夹树里找出从根到 targetId 的路径（面包屑用）。找不到返回空数组。
 * 笔记编辑页、白板页的顶部面包屑共用。
 */
export function buildFolderPath(
  folders: Folder[],
  targetId: number,
): { id: number; name: string }[] {
  for (const f of folders) {
    if (f.id === targetId) {
      return [{ id: f.id, name: f.name }];
    }
    if (f.children?.length) {
      const sub = buildFolderPath(f.children, targetId);
      if (sub.length > 0) {
        return [{ id: f.id, name: f.name }, ...sub];
      }
    }
  }
  return [];
}
