/**
 * 搜索页空状态「标签 / 文件夹 / 文件」三列的纯逻辑，组件和单测共用。
 */
import type { Folder, Note, Tag } from "@/types";

export type BrowseSelection =
  | { kind: "recent" }
  | { kind: "uncategorized" }
  | { kind: "folder"; id: number }
  | { kind: "tag"; id: number };

/**
 * 由搜索条件推出当前选中项。选中项就是筛选条件本身（只选了一个文件夹或一个标签），
 * 所以开始输入后自动变成筛选，返回页面时也能从 URL 恢复。
 * 在筛选条里多选过的情况没法对应到单个节点，回到最近列表。
 */
export function resolveBrowseSelection(s: {
  uncategorized: boolean;
  folders: number[];
  tags: number[];
}): BrowseSelection {
  if (s.uncategorized) return { kind: "uncategorized" };
  if (s.folders.length === 1 && s.tags.length === 0) {
    return { kind: "folder", id: s.folders[0] };
  }
  if (s.tags.length === 1 && s.folders.length === 0) {
    return { kind: "tag", id: s.tags[0] };
  }
  return { kind: "recent" };
}

/**
 * 含子孙的笔记数。后端的 note_count 只数文件夹自身，而右列点父文件夹时连子孙一起列，
 * 不汇总的话左边的数字和右边的条数对不上。
 */
export function folderSubtreeCount(folder: Folder): number {
  return (folder.children ?? []).reduce(
    (sum, child) => sum + folderSubtreeCount(child),
    folder.note_count,
  );
}

export interface TagNode {
  tag: Tag;
  children: TagNode[];
}

/** 后端给的是平铺列表，按 parent_id 组成树；找不到父标签的放到顶层，不能让它消失 */
export function buildTagTree(tags: Tag[]): TagNode[] {
  const nodes = new Map(tags.map((tag) => [tag.id, { tag, children: [] as TagNode[] }]));
  const roots: TagNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.tag.parent_id == null ? undefined : nodes.get(node.tag.parent_id);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/**
 * list_notes 把置顶排在最前，直接用的话很久没动的置顶笔记会占住「最近」的开头，
 * 这里按修改时间重排。updated_at 只精确到秒，并列时用 id 保证新写入的在前。
 */
export function sortByRecent(notes: Note[], limit: number): Note[] {
  return [...notes]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id)
    .slice(0, limit);
}
