/**
 * AI 回答下方的「出处」编号卡片（v4 原型 .refs）：标题 · 所在文件夹，点击打开笔记。
 *
 * 回答只带了被引用笔记的 id（TurnView.refs），标题和文件夹要现查：
 * - 笔记标题：noteApi.get，进程内缓存，同一篇只查一次；查不到（已删除）就不显示那张卡
 * - 文件夹路径：folderApi.list 拉一次整棵树，全页共享
 * 原型里的「相关度」后端没返回，不显示。
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { folderApi, noteApi } from "@/lib/api";
import { buildFolderPath } from "@/lib/folderPath";
import type { Folder } from "@/types";

export type NoteBrief = { title: string; folderId: number | null } | null;

export interface RefCard {
  id: number;
  /** 编号 = 在引用列表里的原始序号（1 起），跟回答正文里的角标对得上；中间有删掉的笔记也不重排 */
  no: number;
  title: string;
  /** 「父 / 子」文件夹路径；不在任何文件夹里为「未分类」 */
  path: string;
}

/**
 * 纯函数：把引用 id 列表 + 已查到的笔记摘要 + 文件夹树整理成要渲染的卡片。
 * 还没查到（undefined）或已删除（null）的笔记不出卡片。
 */
export function resolveRefCards(
  noteIds: number[],
  briefs: Map<number, NoteBrief>,
  folders: Folder[] | null,
): RefCard[] {
  const out: RefCard[] = [];
  noteIds.forEach((id, i) => {
    const b = briefs.get(id);
    if (!b) return;
    const path =
      b.folderId != null && folders
        ? buildFolderPath(folders, b.folderId).map((f) => f.name).join(" / ")
        : "";
    out.push({ id, no: i + 1, title: b.title || "未命名", path: path || "未分类" });
  });
  return out;
}

const noteCache = new Map<number, NoteBrief>();
let folderTree: Folder[] | null = null;
let folderTreeLoading: Promise<void> | null = null;

function loadFolders(): Promise<void> {
  if (folderTree) return Promise.resolve();
  if (!folderTreeLoading) {
    folderTreeLoading = folderApi
      .list()
      .then((f) => {
        folderTree = f;
      })
      .catch(() => {
        folderTree = [];
      });
  }
  return folderTreeLoading;
}

export function RefSourceCards({ noteIds }: { noteIds: number[] }) {
  const navigate = useNavigate();
  const [, bump] = useState(0);
  const key = noteIds.join(",");

  useEffect(() => {
    let alive = true;
    const missing = noteIds.filter((id) => !noteCache.has(id));
    Promise.all([
      loadFolders(),
      ...missing.map((id) =>
        noteApi
          .get(id)
          .then((n) => noteCache.set(id, { title: n.title, folderId: n.folder_id }))
          .catch(() => noteCache.set(id, null)),
      ),
    ]).then(() => alive && bump((n) => n + 1));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const cards = resolveRefCards(noteIds, noteCache, folderTree);
  if (cards.length === 0) return null;

  return (
    <div className="kb-refs">
      {cards.map(({ id, no, title, path }) => (
        <button
          key={id}
          type="button"
          className="kb-ref"
          title="打开这篇笔记"
          onClick={() => navigate(`/notes/${id}`)}
        >
          <span className="kb-ref-no">{no}</span>
          <span className="kb-ref-main">
            <b>{title}</b>
            <span>{path}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
