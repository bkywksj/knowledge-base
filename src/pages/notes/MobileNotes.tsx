import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { message, Modal } from "antd";
import {
  ArrowDownUp,
  Check,
  ChevronRight,
  Copy,
  Download,
  Ellipsis,
  FilePlus2,
  FileStack,
  Folder as FolderIcon,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Inbox,
  Link,
  Lock,
  Palette,
  Pencil,
  PenTool,
  Pin,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { TAG_COLORS } from "@/components/TagColorPicker";
import { MSheet } from "@/components/mobile/MSheet";
import { QuickCreateSheet } from "@/components/mobile/QuickCreate";
import { aiChatApi, folderApi, linkApi, noteApi, tagApi, trashApi, whiteboardApi } from "@/lib/api";
import { useAppStore } from "@/store";
import type { Folder, Note, NoteQuery, NoteTagBrief, Tag } from "@/types";
import { relativeTime } from "@/lib/utils";
import { notePreviewText } from "@/lib/notePreview";
import { useLongPress } from "@/hooks/useLongPress";
import { ActionSheet, type ActionSheetItem } from "@/components/mobile/ActionSheet";
import { FolderPickerSheet } from "@/components/mobile/FolderPickerSheet";
import { SwipeRow } from "@/components/mobile/SwipeRow";
import { TextPromptModal } from "@/components/mobile/TextPromptModal";
import { LinkBadge, MGroup, MPageHeader, MSectionHeader, MTag } from "@/components/mobile/primitives";

/**
 * 移动端笔记页（v4 原型第 02 / 03 屏；功能底稿 docs/tasks/mobile-v4-feature-inventory.md）
 *
 * 对应 PC 笔记侧栏的文件夹树：逐层进入文件夹，面包屑跳回任意一级。
 * - 网址参数与 PC 一致：`/notes?folder=<id>` / `?folder=uncategorized`；进入下一层是 push，
 *   所以安卓返回键 / 手势返回天然就是「退回上一层」
 * - 根目录：顶层文件夹 + 「未分类」入口，下面保留原来的「全部笔记」（按更新时间）
 * - 文件夹里：先子文件夹，再直属笔记（不含子孙，和 PC 树一致）
 * - 在哪一层点 ＋，新笔记就建在哪一层
 * - 笔记行：左滑「移动 / 删除」，长按完整菜单（同 PC 右键：置顶 / 重命名 / 移动到 / 复制 wiki 链接 / 复制 ID / 删除）
 * - 文件夹：长按或顶栏「…」出菜单（新建笔记 / 子文件夹 / 重命名 / 移动到 / 删除，删除逻辑同 PC）
 */

const PAGE_SIZE = 30;
const UNCATEGORIZED = "uncategorized";

type SortBy = NonNullable<NoteQuery["sort_by"]>;
const SORT_LABEL: Record<Exclude<SortBy, "custom">, string> = {
  default: "修改时间",
  created: "创建时间",
  title: "标题",
};

function findPath(list: Folder[], id: number, trail: Folder[] = []): Folder[] | null {
  for (const f of list) {
    const next = [...trail, f];
    if (f.id === id) return next;
    if (f.children?.length) {
      const hit = findPath(f.children, id, next);
      if (hit) return hit;
    }
  }
  return null;
}

export function MobileNotes() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const folderParam = params.get("folder");
  const isUncategorized = folderParam === UNCATEGORIZED;
  const folderId = folderParam && !isUncategorized ? Number(folderParam) : null;
  const tab = params.get("tab") === "tags" ? "tags" : "folders";

  const [folders, setFolders] = useState<Folder[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  /** 每行的标签 + 入链数（按页批量取，见 loadNotes） */
  const [rowExtra, setRowExtra] = useState<Map<number, RowExtra>>(new Map());
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState<Exclude<SortBy, "custom">>("default");
  const [tags, setTags] = useState<Tag[]>([]);

  // 弹层状态
  const [sheetNote, setSheetNote] = useState<Note | null>(null);
  const [sheetFolder, setSheetFolder] = useState<Folder | null>(null);
  /** 「图标颜色」面板（同 PC 文件夹右键的颜色选择） */
  const [colorFolder, setColorFolder] = useState<Folder | null>(null);
  /** 「从模板建」：打开新建面板，目标文件夹预选为这个 */
  const [templateFolderId, setTemplateFolderId] = useState<number | null | undefined>(undefined);
  const [sortOpen, setSortOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<{ kind: "note"; note: Note } | { kind: "folder"; folder: Folder } | null>(null);
  const [prompt, setPrompt] = useState<
    | { kind: "new-folder"; parentId: number | null }
    | { kind: "rename-folder"; folder: Folder }
    | { kind: "rename-note"; note: Note }
    | null
  >(null);

  const refreshTick = useAppStore((s) => s.notesRefreshTick);
  const foldersTick = useAppStore((s) => s.foldersRefreshTick);

  // ─── 数据 ───
  const loadFolders = useCallback(async () => {
    try {
      setFolders(await folderApi.list());
    } catch (e) {
      console.error("[MobileNotes] load folders failed:", e);
    }
  }, []);

  const query = useMemo<NoteQuery>(() => {
    if (isUncategorized) return { uncategorized: true, sort_by: sortBy };
    if (folderId != null) return { folder_id: folderId, include_descendants: false, sort_by: sortBy };
    return { sort_by: sortBy };
  }, [folderId, isUncategorized, sortBy]);

  const loadNotes = useCallback(
    async (nextPage = 1) => {
      setLoading(true);
      try {
        const res = await noteApi.list({ ...query, page: nextPage, page_size: PAGE_SIZE });
        setNotes((prev) => (nextPage === 1 ? res.items ?? [] : [...prev, ...(res.items ?? [])]));
        setTotal(res.total ?? 0);
        setPage(nextPage);
        // 行上的标签胶囊 +「↔ 链入 N」（原型 02）：这一页的笔记批量取，失败不影响列表
        const ids = (res.items ?? []).map((n) => n.id);
        if (ids.length > 0) {
          Promise.all([linkApi.getBacklinkCounts(ids).catch(() => []), tagApi.getForNotes(ids).catch(() => ({}))]).then(([counts, tags]) => {
            setRowExtra((prev) => {
              const next = nextPage === 1 ? new Map<number, RowExtra>() : new Map(prev);
              const linkMap = new Map(counts ?? []);
              for (const id of ids) next.set(id, { links: linkMap.get(id) ?? 0, tags: (tags as Record<number, NoteTagBrief[]>)[id] ?? [] });
              return next;
            });
          });
        }
      } catch (e) {
        console.error("[MobileNotes] load notes failed:", e);
      } finally {
        setLoading(false);
      }
    },
    [query],
  );

  useEffect(() => {
    void loadFolders();
  }, [loadFolders, foldersTick]);

  useEffect(() => {
    if (tab === "folders") void loadNotes(1);
  }, [loadNotes, refreshTick, tab]);

  useEffect(() => {
    if (tab !== "tags") return;
    tagApi
      .list()
      .then((list) => setTags([...list].sort((a, b) => b.note_count - a.note_count)))
      .catch((e) => console.error("[MobileNotes] load tags failed:", e));
  }, [tab]);

  const reloadAll = useCallback(async () => {
    await Promise.all([loadFolders(), loadNotes(1)]);
  }, [loadFolders, loadNotes]);

  // ─── 派生 ───
  const path = useMemo(() => (folderId != null ? findPath(folders, folderId) ?? [] : []), [folders, folderId]);
  const current = path[path.length - 1] ?? null;
  const subfolders = isUncategorized ? [] : folderId != null ? current?.children ?? [] : folders;
  const isRoot = folderId == null && !isUncategorized;

  const goFolder = (id: number | typeof UNCATEGORIZED | null) => {
    const next = new URLSearchParams();
    if (id != null) next.set("folder", String(id));
    setParams(next); // push：返回键 = 回上一层
  };
  const setTab = (t: "folders" | "tags") => {
    const next = new URLSearchParams(params);
    if (t === "tags") next.set("tab", "tags");
    else next.delete("tab");
    setParams(next, { replace: true });
  };

  // ─── 操作 ───
  async function createNote(targetFolderId: number | null) {
    try {
      const note = await noteApi.create({ title: "无标题笔记", content: "", folder_id: targetFolderId });
      useAppStore.getState().bumpNotesRefresh();
      navigate(`/notes/${note.id}`);
    } catch (e) {
      message.error(`创建失败: ${e}`);
    }
  }

  /** 在文件夹里新建白板（同 PC 新建白板：先建再进画布） */
  async function createWhiteboard(targetFolderId: number) {
    try {
      const wb = await whiteboardApi.create(undefined, targetFolderId);
      useAppStore.getState().bumpNotesRefresh();
      navigate(`/whiteboard/${wb.id}`);
    } catch (e) {
      message.error(`创建白板失败: ${e}`);
    }
  }

  /** 对此文件夹问 AI：新建一个检索范围限定在本文件夹（含子孙）的会话，同 PC 文件夹右键 */
  async function askAiAboutFolder(folder: Folder) {
    try {
      const conv = await aiChatApi.createConversation(`📁 ${folder.name}`, undefined, folder.id);
      navigate(`/ai-chat/${conv.id}`);
    } catch (e) {
      message.error(`发起文件夹问答失败: ${e}`);
    }
  }

  async function setFolderColor(folder: Folder, color: string | null) {
    try {
      await folderApi.setColor(folder.id, color);
      useAppStore.getState().bumpFoldersRefresh();
      setColorFolder(null);
    } catch (e) {
      message.error(`设置颜色失败: ${e}`);
    }
  }

  async function togglePin(note: Note) {
    try {
      await noteApi.togglePin(note.id);
      message.success(note.is_pinned ? "已取消置顶" : "已置顶");
      await loadNotes(1);
    } catch (e) {
      message.error(String(e));
    }
  }

  async function deleteNote(note: Note) {
    // 软删到回收站（可在回收站恢复），无需二次确认 —— 与原版一致
    try {
      await trashApi.softDelete(note.id);
      message.success("已移到回收站");
      await reloadAll();
    } catch (e) {
      message.error(String(e));
    }
  }

  function copyText(text: string, ok: string) {
    navigator.clipboard
      .writeText(text)
      .then(() => message.success(ok))
      .catch(() => message.error("复制失败"));
  }

  async function renameNote(note: Note, title: string) {
    try {
      // 先取最新的完整笔记再写回：列表里的内容可能已经被别处改过，直接拿来存会覆盖掉
      const fresh = await noteApi.get(note.id);
      await noteApi.update(note.id, { title, content: fresh.content, folder_id: fresh.folder_id });
      message.success("已重命名");
      await loadNotes(1);
    } catch (e) {
      message.error(`重命名失败: ${e}`);
      throw e;
    }
  }

  async function moveNote(note: Note, to: number | null) {
    try {
      await noteApi.moveToFolder(note.id, to);
      message.success("已移动");
      await reloadAll();
    } catch (e) {
      message.error(`移动失败: ${e}`);
    }
  }

  async function moveFolder(folder: Folder, to: number | null) {
    try {
      await folderApi.move(folder.id, to);
      message.success("已移动");
      useAppStore.getState().bumpFoldersRefresh();
      await loadFolders();
    } catch (e) {
      message.error(`移动失败: ${e}`);
    }
  }

  /** 删除文件夹：与 PC 侧栏同逻辑 —— 空的直接删；非空级联删除，笔记进回收站，日记回到未分类 */
  async function deleteFolder(folder: Folder) {
    let stats = { folders: 0, notes: 0, dailies: 0 };
    try {
      stats = await folderApi.subtreeStats(folder.id);
    } catch {
      // 统计失败按空处理，后端非空会兜底报错
    }
    const done = async () => {
      useAppStore.getState().bumpFoldersRefresh();
      useAppStore.getState().bumpNotesRefresh();
      if (folderId === folder.id || path.some((p) => p.id === folder.id)) goFolder(folder.parent_id);
      await reloadAll();
    };
    if (stats.folders === 0 && stats.notes === 0) {
      Modal.confirm({
        title: `删除文件夹「${folder.name}」`,
        content:
          stats.dailies > 0
            ? `文件夹是空的，但关联着 ${stats.dailies} 篇日记。删除后这些日记回到「未分类」，内容不受影响。`
            : "文件夹是空的，删除后不可恢复。",
        okText: "删除",
        okType: "danger",
        cancelText: "取消",
        centered: true,
        async onOk() {
          await folderApi.delete(folder.id);
          await done();
        },
      });
      return;
    }
    const parts = [stats.folders > 0 && `${stats.folders} 个子文件夹`, stats.notes > 0 && `${stats.notes} 篇笔记`].filter(Boolean).join(" 和 ");
    Modal.confirm({
      title: `删除「${folder.name}」及其内容？`,
      content: `里面还有 ${parts}：笔记移入回收站（可恢复），文件夹一并删除${stats.dailies > 0 ? `；${stats.dailies} 篇日记不会删除，只回到「未分类」` : ""}。`,
      okText: "全部删除",
      okType: "danger",
      cancelText: "取消",
      centered: true,
      async onOk() {
        const r = await folderApi.deleteCascade(folder.id);
        message.success(r.notes_trashed > 0 ? `已删除文件夹，${r.notes_trashed} 篇笔记已移入回收站` : "已删除文件夹");
        await done();
      },
    });
  }

  // ─── 长按菜单 ───
  const noteItems: ActionSheetItem[] = sheetNote
    ? [
        { key: "pin", label: sheetNote.is_pinned ? "取消置顶" : "置顶", icon: <Pin size={20} />, onClick: () => togglePin(sheetNote) },
        {
          key: "rename",
          label: "重命名",
          icon: <Pencil size={20} />,
          onClick: () =>
            sheetNote.is_encrypted
              ? message.info("加密笔记请进入笔记后修改标题")
              : setPrompt({ kind: "rename-note", note: sheetNote }),
        },
        { key: "move", label: "移动到…", icon: <FolderInput size={20} />, onClick: () => setMoveTarget({ kind: "note", note: sheetNote }) },
        { key: "wiki", label: "复制 wiki 链接", icon: <Link size={20} />, onClick: () => copyText(`[[${sheetNote.title}]]`, "已复制 wiki 链接") },
        // 与 PC 一致：给外部 agent / MCP 用，拿到 ID 直接 get_note(id)
        { key: "copy-id", label: "复制笔记 ID", icon: <Copy size={20} />, onClick: () => copyText(String(sheetNote.id), `已复制 ID：${sheetNote.id}`) },
        { key: "delete", label: "删除", icon: <Trash2 size={20} />, danger: true, onClick: () => deleteNote(sheetNote) },
      ]
    : [];

  const folderItems: ActionSheetItem[] = sheetFolder
    ? [
        { key: "rename", label: "重命名", icon: <Pencil size={20} />, onClick: () => setPrompt({ kind: "rename-folder", folder: sheetFolder }) },
        { key: "color", label: "图标颜色", icon: <Palette size={20} />, onClick: () => setColorFolder(sheetFolder) },
        { key: "move", label: "移动到…", icon: <FolderInput size={20} />, onClick: () => setMoveTarget({ kind: "folder", folder: sheetFolder }) },
        { key: "ask-ai", label: "对此文件夹问 AI", icon: <Sparkles size={20} />, onClick: () => void askAiAboutFolder(sheetFolder) },
        {
          key: "export",
          label: "导出此文件夹…",
          icon: <Download size={20} />,
          extra: "桌面端",
          // 导出要选保存位置（系统保存对话框），手机上没有可靠的落盘位置；同「我的」页的桌面专属项说明
          onClick: () =>
            Modal.info({ title: "导出文件夹请在桌面端操作", content: "桌面端在文件夹上右键 →「导出此文件夹…」，可导出为 Markdown / Word / PDF。", okText: "知道了", centered: true }),
        },
        { key: "delete", label: "删除文件夹", icon: <Trash2 size={20} />, danger: true, onClick: () => deleteFolder(sheetFolder) },
      ]
    : [];

  const pinned = isRoot && sortBy === "default" ? notes.filter((n) => n.is_pinned) : [];
  const rest = isRoot && sortBy === "default" ? notes.filter((n) => !n.is_pinned) : notes;
  const locationName = isUncategorized ? "未分类" : current?.name ?? "全部笔记";

  return (
    <div className="mx-auto w-full max-w-[860px] pb-8">
      <MPageHeader
        title="笔记"
        actions={
          <>
            <button type="button" aria-label="搜索" className="m-icon-btn" onClick={() => navigate("/search")}>
              <Search size={20} />
            </button>
            {current && (
              <button type="button" aria-label="文件夹操作" className="m-icon-btn" onClick={() => setSheetFolder(current)}>
                <Ellipsis size={20} />
              </button>
            )}
            {/* 新建放顶栏：列表摘要伸到右下角，FAB 会压住内容 */}
            <button type="button" aria-label="新建笔记" className="m-icon-btn is-primary ml-1 mr-2" onClick={() => createNote(folderId)}>
              <Plus size={22} />
            </button>
          </>
        }
      />

      <div className="m-gutter mt-3">
        <div className="flex rounded-[var(--m-r-l)] p-[3px]" style={{ background: "var(--m-well)" }} role="tablist">
          {(["folders", "tags"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className="m-tapx h-8 flex-1 rounded-[var(--m-r-m)] text-[14px]"
              style={tab === t ? { background: "var(--m-surface)", color: "var(--m-ink)", fontWeight: 700 } : { color: "var(--m-ink3)" }}
            >
              {t === "folders" ? "文件夹" : "标签"}
            </button>
          ))}
        </div>
      </div>

      {tab === "tags" ? (
        <TagList tags={tags} onOpen={(t) => navigate(`/search?q=${encodeURIComponent("#" + t.name)}`)} onManage={() => navigate("/tags")} />
      ) : (
        <>
          {/* 面包屑：可横滑，点任意一级跳回 */}
          <div className="m-gutter m-hscroll mt-3 flex items-center gap-1 whitespace-nowrap text-[14px]">
            <button type="button" className="m-tapx" style={{ color: isRoot ? "var(--m-ink)" : "var(--m-ink3)", fontWeight: isRoot ? 700 : 400 }} onClick={() => goFolder(null)}>
              全部
            </button>
            {isUncategorized && (
              <>
                <ChevronRight size={14} style={{ color: "var(--m-ink4)" }} />
                <span className="font-bold" style={{ color: "var(--m-ink)" }}>未分类</span>
              </>
            )}
            {path.map((f, i) => (
              <span key={f.id} className="flex items-center gap-1">
                <ChevronRight size={14} style={{ color: "var(--m-ink4)" }} />
                {i === path.length - 1 ? (
                  <span className="font-bold" style={{ color: "var(--m-ink)" }}>{f.name}</span>
                ) : (
                  <button type="button" className="m-tapx" style={{ color: "var(--m-ink3)" }} onClick={() => goFolder(f.id)}>
                    {f.name}
                  </button>
                )}
              </span>
            ))}
          </div>

          {/* 文件夹 */}
          {(subfolders.length > 0 || isRoot) && (
            <div className="m-gutter mt-3">
              <MGroup>
                {subfolders.map((f) => (
                  <FolderRow key={f.id} folder={f} onOpen={() => goFolder(f.id)} onMenu={() => setSheetFolder(f)} />
                ))}
                {isRoot && (
                  <button type="button" className="m-row m-row-icon" onClick={() => goFolder(UNCATEGORIZED)}>
                    <span className="flex w-6 shrink-0 justify-center" style={{ color: "var(--m-ink3)" }}>
                      <Inbox size={21} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[15px]">未分类</span>
                    <ChevronRight size={16} style={{ color: "var(--m-ink4)" }} />
                  </button>
                )}
              </MGroup>
              {isRoot && folders.length === 0 && (
                <button type="button" className="m-t-meta mt-1 flex min-h-[44px] items-center gap-1" onClick={() => setPrompt({ kind: "new-folder", parentId: null })}>
                  <FolderPlus size={14} /> 还没有文件夹，点这里新建
                </button>
              )}
            </div>
          )}

          {/* 笔记 */}
          <MSectionHeader
            className="m-gutter mt-6 mb-2"
            title={isRoot ? "全部笔记" : "笔记"}
            count={`${total} 篇`}
            action={
              <button type="button" className="m-tapx m-t-meta flex items-center gap-1" onClick={() => setSortOpen(true)}>
                <ArrowDownUp size={14} />
                {SORT_LABEL[sortBy]}
              </button>
            }
          />
          <div className="m-gutter">
            {loading && notes.length === 0 ? (
              <MGroup className="py-8 text-center">
                <span className="m-t-meta">加载中…</span>
              </MGroup>
            ) : notes.length === 0 ? (
              <MGroup className="py-8 text-center">
                <div className="m-t-body">{isRoot ? "还没有笔记" : `「${locationName}」里还没有笔记`}</div>
                <div className="m-t-meta mt-1">点右上角 ＋ 在这里新建</div>
              </MGroup>
            ) : (
              <>
                {pinned.length > 0 && (
                  <>
                    <div className="m-t-cap mb-1.5 flex items-center gap-1">
                      <Pin size={12} /> 置顶
                    </div>
                    <NoteGroup notes={pinned} extra={rowExtra} onOpen={(n) => navigate(`/notes/${n.id}`)} onMenu={setSheetNote} onMove={(n) => setMoveTarget({ kind: "note", note: n })} onDelete={deleteNote} />
                    {rest.length > 0 && <div className="m-t-cap mt-4 mb-1.5">最近</div>}
                  </>
                )}
                {rest.length > 0 && (
                  <NoteGroup notes={rest} extra={rowExtra} onOpen={(n) => navigate(`/notes/${n.id}`)} onMenu={setSheetNote} onMove={(n) => setMoveTarget({ kind: "note", note: n })} onDelete={deleteNote} />
                )}
                {notes.length < total && (
                  <button
                    type="button"
                    disabled={loading}
                    className="m-group mt-3 flex h-11 w-full items-center justify-center text-[14px] font-semibold"
                    style={{ color: "var(--m-accent-ink)" }}
                    onClick={() => loadNotes(page + 1)}
                  >
                    {loading ? "加载中…" : `加载更多（还有 ${total - notes.length} 篇）`}
                  </button>
                )}
              </>
            )}
          </div>
        </>
      )}

      {/* ── 弹层 ── */}
      <ActionSheet open={!!sheetNote} title={sheetNote?.title || "未命名笔记"} items={noteItems} onClose={() => setSheetNote(null)} />

      <ActionSheet
        open={!!sheetFolder}
        title={sheetFolder?.name}
        subtitle={sheetFolder ? [(findPath(folders, sheetFolder.id) ?? []).map((f) => f.name).join(" / "), sheetFolder.children?.length ? `${sheetFolder.children.length} 个文件夹` : null, `${sheetFolder.note_count} 篇`].filter(Boolean).join(" · ") : undefined}
        headerIcon={<FolderOpen size={22} style={{ color: sheetFolder?.color || undefined }} />}
        grid={
          sheetFolder
            ? [
                { key: "new-note", label: "新建笔记", icon: <FilePlus2 size={22} />, onClick: () => createNote(sheetFolder.id) },
                { key: "new-folder", label: "子文件夹", icon: <FolderPlus size={22} />, onClick: () => setPrompt({ kind: "new-folder", parentId: sheetFolder.id }) },
                { key: "from-template", label: "从模板建", icon: <FileStack size={22} />, onClick: () => setTemplateFolderId(sheetFolder.id) },
                { key: "new-wb", label: "新建白板", icon: <PenTool size={22} />, onClick: () => void createWhiteboard(sheetFolder.id) },
              ]
            : undefined
        }
        items={folderItems}
        onClose={() => setSheetFolder(null)}
      />

      {/* 图标颜色：PC 文件夹右键同款色板（标签色板第一排 10 色）+ 恢复默认 */}
      <MSheet open={!!colorFolder} title="图标颜色" caption={colorFolder?.name} onClose={() => setColorFolder(null)}>
        <div className="m-group grid grid-cols-5 gap-y-1 p-2">
          {TAG_COLORS.slice(0, 10).map((c) => {
            const on = (colorFolder?.color ?? "").toLowerCase() === c.toLowerCase();
            return (
              <button key={c} type="button" aria-label={`颜色 ${c}`} aria-pressed={on} className="flex h-12 items-center justify-center" onClick={() => colorFolder && void setFolderColor(colorFolder, c)}>
                <span className="flex h-8 w-8 items-center justify-center rounded-full" style={{ background: c, boxShadow: on ? "0 0 0 2px var(--m-surface), 0 0 0 4px var(--m-accent-ink)" : undefined }}>
                  {on && <Check size={16} color="#fff" />}
                </span>
              </button>
            );
          })}
        </div>
        <div className="m-group mt-3">
          <button type="button" className="m-row m-row-icon" onClick={() => colorFolder && void setFolderColor(colorFolder, null)}>
            <span className="flex w-6 shrink-0 justify-center" style={{ color: "var(--m-ink2)" }}>
              <FolderIcon size={20} />
            </span>
            <span className="min-w-0 flex-1 text-[15px]">恢复默认颜色</span>
            {!colorFolder?.color && <Check size={18} style={{ color: "var(--m-accent-ink)" }} />}
          </button>
        </div>
      </MSheet>

      {/* 从模板建：复用新建面板（含模板列表），目标文件夹预选为当前文件夹 */}
      <QuickCreateSheet open={templateFolderId !== undefined} onClose={() => setTemplateFolderId(undefined)} defaultFolderId={templateFolderId ?? null} />

      <ActionSheet
        open={sortOpen}
        title="排序"
        items={(Object.keys(SORT_LABEL) as Array<keyof typeof SORT_LABEL>).map((k) => ({
          key: k,
          label: SORT_LABEL[k],
          icon: sortBy === k ? <Check size={20} style={{ color: "var(--m-accent-ink)" }} /> : <span className="w-5" />,
          onClick: () => setSortBy(k),
        }))}
        onClose={() => setSortOpen(false)}
      />

      <FolderPickerSheet
        open={!!moveTarget}
        title={moveTarget?.kind === "folder" ? `移动文件夹「${moveTarget.folder.name}」到…` : "移动到…"}
        folders={folders}
        currentId={moveTarget?.kind === "folder" ? moveTarget.folder.parent_id : moveTarget?.note.folder_id ?? null}
        movingFolderId={moveTarget?.kind === "folder" ? moveTarget.folder.id : undefined}
        rootLabel={moveTarget?.kind === "folder" ? "根目录" : "未分类"}
        onPick={(to) => {
          if (!moveTarget) return;
          if (moveTarget.kind === "note") void moveNote(moveTarget.note, to);
          else void moveFolder(moveTarget.folder, to);
        }}
        onClose={() => setMoveTarget(null)}
      />

      <TextPromptModal
        open={!!prompt}
        title={prompt?.kind === "new-folder" ? "新建文件夹" : "重命名"}
        initialValue={prompt?.kind === "rename-folder" ? prompt.folder.name : prompt?.kind === "rename-note" ? prompt.note.title : ""}
        placeholder={prompt?.kind === "new-folder" ? "文件夹名称" : "新名称"}
        okText={prompt?.kind === "new-folder" ? "创建" : "保存"}
        onOk={async (v) => {
          if (!prompt) return;
          if (prompt.kind === "rename-note") return renameNote(prompt.note, v);
          try {
            if (prompt.kind === "new-folder") await folderApi.create(v, prompt.parentId ?? undefined);
            else await folderApi.rename(prompt.folder.id, v);
            message.success(prompt.kind === "new-folder" ? "已创建" : "已重命名");
            useAppStore.getState().bumpFoldersRefresh();
            await loadFolders();
          } catch (e) {
            message.error(String(e));
            throw e;
          }
        }}
        onClose={() => setPrompt(null)}
      />
    </div>
  );
}

// ─── 文件夹行：轻点进入，长按出菜单 ───
function FolderRow({ folder, onOpen, onMenu }: { folder: Folder; onOpen: () => void; onMenu: () => void }) {
  const lp = useLongPress(onMenu, { onClick: onOpen });
  return (
    <div {...lp} role="button" tabIndex={0} className="m-row m-row-icon cursor-pointer select-none" style={{ WebkitTouchCallout: "none" }}>
      <span className="flex w-6 shrink-0 justify-center" style={{ color: folder.color || "var(--kb-folder-icon, var(--m-accent))" }}>
        <FolderIcon size={21} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[15px]">{folder.name}</span>
      <span className="m-t-meta m-num">{folder.note_count}</span>
      <ChevronRight size={16} style={{ color: "var(--m-ink4)" }} />
    </div>
  );
}

// ─── 笔记分组：左滑「移动 / 删除」，轻点进入，长按出完整菜单 ───
/** 笔记行的附加信息：标签 + 入链数（按页批量取） */
interface RowExtra {
  links: number;
  tags: NoteTagBrief[];
}

function NoteGroup({
  notes,
  extra,
  onOpen,
  onMenu,
  onMove,
  onDelete,
}: {
  notes: Note[];
  extra: Map<number, RowExtra>;
  onOpen: (n: Note) => void;
  onMenu: (n: Note) => void;
  onMove: (n: Note) => void;
  onDelete: (n: Note) => void;
}) {
  return (
    <MGroup>
      {notes.map((n, i) => (
        <div key={n.id} className="relative">
          {/* 分隔线从文字处起（左缩 16），与分组列表一致；画在左滑容器外面，滑动时不跟着动 */}
          {i > 0 && <span className="pointer-events-none absolute top-0 right-0 left-4 z-[1] h-[0.5px]" style={{ background: "var(--m-hair)" }} />}
          <SwipeRow
            actions={[
              { key: "move", label: "移动", icon: <FolderInput size={18} />, tone: "info", onClick: () => onMove(n) },
              { key: "del", label: "删除", icon: <Trash2 size={18} />, tone: "bad", onClick: () => onDelete(n) },
            ]}
          >
            <NoteRow note={n} extra={extra.get(n.id)} onOpen={() => onOpen(n)} onMenu={() => onMenu(n)} />
          </SwipeRow>
        </div>
      ))}
    </MGroup>
  );
}

function NoteRow({ note, extra, onOpen, onMenu }: { note: Note; extra?: RowExtra; onOpen: () => void; onMenu: () => void }) {
  const lp = useLongPress(onMenu, { onClick: onOpen });
  const preview = note.is_encrypted ? "已加密，解锁后查看" : notePreviewText(note.content, { title: note.title, max: 80, noteType: note.note_type });
  return (
    <div {...lp} role="button" tabIndex={0} className="cursor-pointer select-none px-4 py-3.5" style={{ WebkitTouchCallout: "none" }}>
      <div className="flex items-center gap-1.5">
        {note.is_encrypted ? (
          <Lock size={14} className="shrink-0" style={{ color: "var(--m-warn)" }} aria-label="已加密" />
        ) : note.is_pinned ? (
          <Pin size={14} className="shrink-0" style={{ color: "var(--m-accent-ink)" }} aria-label="已置顶" />
        ) : null}
        <span className="m-t-title min-w-0 flex-1 truncate">{note.title || "未命名笔记"}</span>
      </div>
      {preview && (
        <div className="mt-1 truncate text-[14px]" style={{ color: "var(--m-ink3)" }}>
          {preview}
        </div>
      )}
      {/* 原型：[标签] 时间 · 字数 · ↔ 链入 N；标签最多 2 个，免得一行挤不下 */}
      <div className="mt-2 flex min-w-0 items-center gap-2 overflow-hidden">
        {note.is_daily && <MTag tone="warn">日记</MTag>}
        {extra?.tags.slice(0, 2).map((t) => (
          <MTag key={t.id} tone="info" className="max-w-[6em] shrink-0 truncate">
            {t.name}
          </MTag>
        ))}
        <span className="m-t-cap shrink-0">{relativeTime(note.updated_at)}</span>
        <span className="m-t-cap m-num shrink-0">{note.word_count.toLocaleString()} 字</span>
        {extra && extra.links > 0 && <LinkBadge>链入 {extra.links}</LinkBadge>}
      </div>
    </div>
  );
}

// ─── 标签页签：列出标签 + 笔记数，点击搜索该标签；完整管理去标签页 ───
function TagList({ tags, onOpen, onManage }: { tags: Tag[]; onOpen: (t: Tag) => void; onManage: () => void }) {
  return (
    <div className="m-gutter mt-3">
      {tags.length === 0 ? (
        <MGroup className="py-8 text-center">
          <span className="m-t-meta">还没有标签</span>
        </MGroup>
      ) : (
        <MGroup>
          {tags.map((t) => (
            <button key={t.id} type="button" className="m-row m-row-icon" onClick={() => onOpen(t)}>
              <span className="flex w-6 shrink-0 justify-center">
                <span className="m-dot" style={{ background: t.color || "var(--m-ink4)" }} />
              </span>
              <span className="min-w-0 flex-1 truncate text-[15px]">#{t.name}</span>
              <span className="m-t-meta m-num">{t.note_count}</span>
            </button>
          ))}
        </MGroup>
      )}
      <button type="button" className="m-tapx mt-3 block w-full text-center text-[14px] font-semibold" style={{ color: "var(--m-accent-ink)" }} onClick={onManage}>
        管理标签（改色 / 重命名 / 删除）
      </button>
    </div>
  );
}
