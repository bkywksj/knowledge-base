/**
 * 「当前选中了什么」→「新建笔记该落到哪」的判定。
 *
 * 这条规则原本散在三个地方各写各的，口径不一致：
 * 侧边栏拖入文件按 selectedKey 落到选中文件夹（NotesPanel 里 T-016 那段），
 * 紧挨着的「+ 新建笔记」按钮却永远传 null，笔记页顶部按钮又读 URL 的 ?folder=。
 * 同一个选中态，三种答案。抽到这里统一，并用测试锁住。
 */

/** 侧边栏树里「未分类」虚拟根节点的 key（与 NotesPanel 内的常量同值） */
export const UNCATEGORIZED_KEY = "__uncategorized__";
/** 笔记叶节点的 key 前缀（与 NotesPanel 内的 NOTE_KEY_PREFIX 同值） */
export const NOTE_KEY_PREFIX = "note:";
/** URL `?folder=` 表示「未分类」时的取值 */
export const UNCATEGORIZED_PARAM = "uncategorized";

/**
 * 新建笔记的落点。
 *
 * 光有 `folderId: number | null` 表达不了区别：**没有上下文的 null**（应该套用
 * 全局默认文件夹）和**用户明确点了「未分类」的 null**（就该待在未分类，不能被
 * 默认文件夹劫持）是两回事。所以额外带一个 `useDefaults`。
 */
export interface NewNoteTarget {
  /** 归入的文件夹 id；null = 不归任何文件夹 */
  folderId: number | null;
  /** 是否套用全局「默认文件夹 / 默认标签」偏好 */
  useDefaults: boolean;
}

/** 无上下文：交给全局默认偏好（首页大按钮、托盘新建等） */
const NO_CONTEXT: NewNoteTarget = { folderId: null, useDefaults: false };

/**
 * 侧边栏树的选中 key → 新建落点。
 *
 * - 文件夹 key（纯数字）→ 落到该文件夹
 * - `__uncategorized__` → 明确落未分类，**不套默认**
 * - 笔记 key（`note:123`）→ 无文件夹上下文。选中一篇笔记表达的是"我在看这篇"，
 *   不是"我在这个文件夹里工作"，不该拿它的 folder_id 猜用户想建到哪
 * - null / 空 / 非法数字 → 无上下文
 */
export function targetFromSidebarKey(
  selectedKey: string | null | undefined,
): NewNoteTarget {
  if (!selectedKey) return { ...NO_CONTEXT, useDefaults: true };
  if (selectedKey === UNCATEGORIZED_KEY) {
    return { folderId: null, useDefaults: false };
  }
  if (selectedKey.startsWith(NOTE_KEY_PREFIX)) {
    return { ...NO_CONTEXT, useDefaults: true };
  }
  const id = Number(selectedKey);
  if (!Number.isInteger(id) || id <= 0) {
    return { ...NO_CONTEXT, useDefaults: true };
  }
  return { folderId: id, useDefaults: false };
}

/**
 * URL 的 `?folder=` 参数 → 新建落点。规则与 {@link targetFromSidebarKey} 一致，
 * 只是「未分类」的表示法不同（URL 用 `uncategorized`，树用 `__uncategorized__`）。
 *
 * 给笔记页顶部按钮和 Ctrl+N 用 —— 用户在某文件夹页面按 Ctrl+N，
 * 期望和点那个页面上的「+ 新建笔记」结果一样。
 */
export function targetFromFolderParam(
  folderParam: string | null | undefined,
): NewNoteTarget {
  if (!folderParam) return { ...NO_CONTEXT, useDefaults: true };
  if (folderParam === UNCATEGORIZED_PARAM) {
    return { folderId: null, useDefaults: false };
  }
  const id = Number(folderParam);
  if (!Number.isInteger(id) || id <= 0) {
    return { ...NO_CONTEXT, useDefaults: true };
  }
  return { folderId: id, useDefaults: false };
}
