/**
 * 搜索页没输入关键词时的三列：标签 · 文件夹 · 文件。
 *
 * 不打字也能找到文件：点标签或文件夹，右列原地切换，可以连续试几个而不用来回跳页。
 * 选中项由父组件存在筛选条件里（见 resolveBrowseSelection），这里只负责展示和上报。
 */
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { Button, Empty, Spin, Tree, message } from "antd";
import { FileText, Folder as FolderIcon, PenTool } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { noteApi, tagApi } from "@/lib/api";
import { buildFolderPath } from "@/lib/folderPath";
import {
  buildTagTree,
  folderSubtreeCount,
  sortByRecent,
  type BrowseSelection,
  type TagNode,
} from "@/lib/searchBrowse";
import { relativeTime } from "@/lib/utils";
import type { Folder, Note, PageResult, Tag } from "@/types";

/** 最近列表要先取一批再按修改时间重排（见 sortByRecent），多取的部分用来抵掉置顶笔记 */
const RECENT_FETCH = 40;
const RECENT_SHOW = 30;
const PAGE_SIZE = 50;
const UNCATEGORIZED_KEY = "uncategorized";

export interface SearchBrowseHandle {
  /** 上下移动高亮的文件 */
  move: (delta: number) => void;
  /** 打开高亮的文件；没有高亮时返回 false */
  openActive: () => boolean;
}

interface Props {
  ref?: Ref<SearchBrowseHandle>;
  folders: Folder[];
  tags: Tag[];
  showTags: boolean;
  selection: BrowseSelection;
  onSelect: (next: BrowseSelection) => void;
}

function nodeTitle(name: string, count?: number): ReactNode {
  return (
    <span className="kb-browse-node">
      <span className="kb-browse-node-name">{name}</span>
      {count != null && count > 0 && <b>{count}</b>}
    </span>
  );
}

function folderTreeData(folders: Folder[]): { key: number; title: ReactNode; children: unknown[] }[] {
  return folders.map((f) => ({
    key: f.id,
    title: nodeTitle(f.name, folderSubtreeCount(f)),
    children: folderTreeData(f.children ?? []),
  }));
}

function tagTreeData(nodes: TagNode[]): { key: number; title: ReactNode; children: unknown[] }[] {
  return nodes.map((n) => ({
    key: n.tag.id,
    title: nodeTitle(n.tag.name, n.tag.note_count),
    children: tagTreeData(n.children),
  }));
}

function fetchNotes(selection: BrowseSelection, page: number): Promise<PageResult<Note>> {
  switch (selection.kind) {
    case "folder":
      return noteApi.list({
        folder_id: selection.id,
        include_descendants: true,
        page,
        page_size: PAGE_SIZE,
      });
    case "uncategorized":
      return noteApi.list({ uncategorized: true, page, page_size: PAGE_SIZE });
    case "tag":
      return tagApi.listNotesByTag(selection.id, page, PAGE_SIZE);
    default:
      return noteApi.list({ page: 1, page_size: RECENT_FETCH });
  }
}

export function SearchBrowse({ ref, folders, tags, showTags, selection, onSelect }: Props) {
  const navigate = useNavigate();
  const [notes, setNotes] = useState<Note[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [expandedFolders, setExpandedFolders] = useState<React.Key[]>([]);
  const [expandedTags, setExpandedTags] = useState<React.Key[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  // 连续点几个文件夹时，慢的旧请求回来不能盖掉新结果
  const seqRef = useRef(0);

  const selectionKey = JSON.stringify(selection);
  useEffect(() => {
    const seq = ++seqRef.current;
    setLoading(true);
    setActiveIndex(-1);
    setPage(1);
    fetchNotes(selection, 1)
      .then((result) => {
        if (seq !== seqRef.current) return;
        setNotes(selection.kind === "recent" ? sortByRecent(result.items, RECENT_SHOW) : result.items);
        setTotal(result.total);
        listRef.current?.scrollTo({ top: 0 });
      })
      .catch((e) => {
        if (seq === seqRef.current) message.error(String(e));
      })
      .finally(() => {
        if (seq === seqRef.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);

  // 返回页面时选中的可能是深层文件夹，要把它的上级展开，否则看不到选中了谁
  useEffect(() => {
    if (selection.kind !== "folder" || folders.length === 0) return;
    const parents = buildFolderPath(folders, selection.id).slice(0, -1).map((f) => f.id);
    if (parents.length > 0) {
      setExpandedFolders((prev) => [...new Set([...prev, ...parents])]);
    }
  }, [folders, selection]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-browse-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function openNote(note: Note) {
    navigate(`/notes/${note.id}`);
  }

  useImperativeHandle(ref, () => ({
    move(delta) {
      setActiveIndex((i) => {
        if (notes.length === 0) return -1;
        const next = i + delta;
        if (next < 0) return i < 0 ? notes.length - 1 : 0;
        return Math.min(next, notes.length - 1);
      });
    },
    openActive() {
      const note = notes[activeIndex];
      if (!note) return false;
      openNote(note);
      return true;
    },
  }));

  async function loadMore() {
    const seq = seqRef.current;
    const nextPage = page + 1;
    setLoadingMore(true);
    try {
      const result = await fetchNotes(selection, nextPage);
      if (seq !== seqRef.current) return;
      setNotes((prev) => [...prev, ...result.items]);
      setPage(nextPage);
    } catch (e) {
      message.error(String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  const tagTree = useMemo(() => tagTreeData(buildTagTree(tags)), [tags]);
  const folderTree = useMemo(
    () => [
      ...folderTreeData(folders),
      { key: UNCATEGORIZED_KEY, title: nodeTitle("未分类"), children: [] },
    ],
    [folders],
  );

  const heading = useMemo(() => {
    switch (selection.kind) {
      case "folder":
        return buildFolderPath(folders, selection.id).slice(-1)[0]?.name ?? "文件夹";
      case "tag":
        return tags.find((t) => t.id === selection.id)?.name ?? "标签";
      case "uncategorized":
        return "未分类";
      default:
        return "最近修改";
    }
  }, [selection, folders, tags]);

  const folderPathOf = (id: number | null) =>
    id == null ? "未分类" : buildFolderPath(folders, id).map((f) => f.name).join(" / ") || "未分类";

  const selectedFolderKeys =
    selection.kind === "folder"
      ? [selection.id]
      : selection.kind === "uncategorized"
        ? [UNCATEGORIZED_KEY]
        : [];

  return (
    <div className="kb-browse-wrap">
      <div className={showTags ? "kb-browse" : "kb-browse no-tags"}>
        {showTags && (
          <section className="kb-browse-col">
            <div className="kb-browse-head">标签</div>
            <div className="kb-browse-body">
              {tags.length === 0 ? (
                <Empty description="暂无标签" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              ) : (
                <Tree
                  blockNode
                  treeData={tagTree as never}
                  selectedKeys={selection.kind === "tag" ? [selection.id] : []}
                  expandedKeys={expandedTags}
                  onExpand={setExpandedTags}
                  onSelect={(_, { node, selected }) => {
                    if (!selected) return onSelect({ kind: "recent" });
                    onSelect({ kind: "tag", id: node.key as number });
                    setExpandedTags((prev) => [...new Set([...prev, node.key])]);
                  }}
                />
              )}
            </div>
          </section>
        )}

        <section className="kb-browse-col">
          <div className="kb-browse-head">文件夹</div>
          <div className="kb-browse-body">
            <Tree
              blockNode
              treeData={folderTree as never}
              selectedKeys={selectedFolderKeys}
              expandedKeys={expandedFolders}
              onExpand={setExpandedFolders}
              onSelect={(_, { node, selected }) => {
                if (!selected) return onSelect({ kind: "recent" });
                if (node.key === UNCATEGORIZED_KEY) return onSelect({ kind: "uncategorized" });
                onSelect({ kind: "folder", id: node.key as number });
                setExpandedFolders((prev) => [...new Set([...prev, node.key])]);
              }}
            />
          </div>
        </section>

        <section className="kb-browse-col kb-browse-files">
          <div className="kb-browse-head">
            <span className="kb-browse-heading" title={heading}>{heading}</span>
            {selection.kind !== "recent" && !loading && <b>{total}</b>}
            {selection.kind !== "recent" && (
              <a className="kb-browse-back" onClick={() => onSelect({ kind: "recent" })}>
                查看最近
              </a>
            )}
          </div>
          <div className="kb-browse-body" ref={listRef}>
            {loading ? (
              <div className="flex justify-center py-12">
                <Spin />
              </div>
            ) : notes.length === 0 ? (
              <Empty description="这里还没有笔记" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <>
                {notes.map((note, index) => {
                  const isBoard = note.note_type === "whiteboard";
                  const path = folderPathOf(note.folder_id);
                  return (
                    <div
                      key={note.id}
                      data-browse-index={index}
                      className={index === activeIndex ? "kb-sr-row is-active" : "kb-sr-row"}
                      onClick={() => openNote(note)}
                    >
                      <span className={isBoard ? "kb-sr-ico is-info" : "kb-sr-ico"}>
                        {isBoard ? <PenTool size={15} /> : <FileText size={15} />}
                      </span>
                      <div className="kb-sr-main">
                        <div className="kb-sr-title">{note.title || "无标题"}</div>
                      </div>
                      <span className="kb-sr-folder" title={path}>
                        <FolderIcon size={12} />
                        <span>{path}</span>
                      </span>
                      <span className="kb-sr-time" title={note.updated_at.slice(0, 16)}>
                        {relativeTime(note.updated_at)}
                      </span>
                    </div>
                  );
                })}
                {selection.kind !== "recent" && notes.length < total && (
                  <div className="py-2 text-center">
                    <Button size="small" type="text" loading={loadingMore} onClick={loadMore}>
                      加载更多（还有 {total - notes.length} 条）
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
