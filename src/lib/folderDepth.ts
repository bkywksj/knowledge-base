import type { Folder } from "@/types";

/** 文件夹树的层数：没有文件夹 = 0，只有根级 = 1，根下还有子文件夹 = 2 …… */
export function maxFolderDepth(folders: Folder[]): number {
  let max = 0;
  const walk = (list: Folder[], depth: number) => {
    for (const f of list) {
      if (depth > max) max = depth;
      if (f.children.length) walk(f.children, depth + 1);
    }
  };
  walk(folders, 1);
  return max;
}

/**
 * 深度 >= `depth` 的文件夹 id（根级 = 1）。
 *
 * 侧栏的折叠状态就是「被折叠的文件夹 id 集合」，把这些 id 设为折叠，
 * 树就只露出前 `depth` 级文件夹：`depth = 1` 即全部折叠，`depth = 2` 根级展开、
 * 二级可见但折叠，依此类推。
 */
export function folderKeysFromDepth(folders: Folder[], depth: number): string[] {
  const keys: string[] = [];
  const walk = (list: Folder[], d: number) => {
    for (const f of list) {
      if (d >= depth) keys.push(String(f.id));
      if (f.children.length) walk(f.children, d + 1);
    }
  };
  walk(folders, 1);
  return keys;
}
