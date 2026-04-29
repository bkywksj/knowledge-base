import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Tree,
  Button,
  Skeleton,
  theme as antdTheme,
  Input,
  message,
  Modal,
} from "antd";
import {
  ContextMenuOverlay,
  type ContextMenuEntry,
} from "@/components/ui/ContextMenuOverlay";
import {
  NotebookText,
  FolderPlus,
  ChevronDown,
  ChevronRight,
  Edit3,
  Trash,
  Trash2,
  Plus,
  FolderOpen,
  Folder as FolderIcon,
  FileText,
  ChevronsDownUp,
  LayoutTemplate,
  ExternalLink,
  Copy,
  Pin,
  PinOff,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderFilled } from "@ant-design/icons";
import type { DataNode } from "antd/es/tree";
import { useAppStore } from "@/store";
import { useTabsStore } from "@/store/tabs";
import { folderApi, importApi, noteApi, trashApi } from "@/lib/api";
import type { Folder, Note, ScannedFile } from "@/types";
import { parseEmojiPrefix } from "@/lib/treeIcons";
import { NewNoteButton } from "@/components/NewNoteButton";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { TemplatePickerModal } from "@/components/TemplatePickerModal";
import {
  createBlankAndOpen,
  importPdfsFlow,
  importTextFlow,
  importWordFlow,
} from "@/lib/noteCreator";
import { ImportPreviewModal } from "@/components/ImportPreviewModal";

/**
 * NotesPanel —— Activity Bar 模式下"笔记"视图的主面板内容。
 *
 * 负责：
 *   · 顶部：视图标题 + 新建笔记 + 打开本机 md
 *   · 主体：文件夹树（创建 / 重命名 / 删除 / 拖拽 / 右键菜单 / 导入）
 *
 * 实现基线：从原 Sidebar.tsx 的文件夹树部分拆出，交互零改动。
 */

/** 临时"新建子文件夹"节点的 key 前缀 */
const NEW_NODE_PREFIX = "__new_under_";

/** 笔记叶节点 key 前缀（与文件夹 id 区分） */
const NOTE_KEY_PREFIX = "note:";

/** 单个文件夹直属笔记的展示上限（超过引导用户去主区） */
const NOTES_PER_FOLDER_LIMIT = 100;

function isNoteKey(key: string): boolean {
  return key.startsWith(NOTE_KEY_PREFIX);
}
function noteIdFromKey(key: string): number {
  return Number(key.slice(NOTE_KEY_PREFIX.length));
}
function noteKey(id: number): string {
  return `${NOTE_KEY_PREFIX}${id}`;
}

/** 收集所有文件夹 id 字符串（用于 defaultExpandAll 场景） */
function collectAllKeys(folders: Folder[]): string[] {
  const keys: string[] = [];
  const walk = (list: Folder[]) => {
    for (const f of list) {
      keys.push(String(f.id));
      if (f.children.length) walk(f.children);
    }
  };
  walk(folders);
  return keys;
}

/** Tree DataNode 扩展：携带 isNote 标志和原始数据，便于 renderTitle 区分 */
type TreeNoteData = { isNote: true; note: Note };
type TreeFolderData = { isNote: false };
type TreeNodeData = TreeNoteData | TreeFolderData;
type EnrichedNode = DataNode & { data?: TreeNodeData };

/** 将 Folder[] + 各文件夹直属笔记 转为 antd Tree 的 DataNode[]
 *
 * 子节点顺序：先所有子文件夹（保持原有顺序），后所有直属笔记（按 updated_at 倒序，
 * 由后端排序）。单个文件夹笔记数 > NOTES_PER_FOLDER_LIMIT 时只展示前 N 条。
 */
function foldersToTreeData(
  folders: Folder[],
  creatingUnderKey: string | null,
  notesByFolder: Map<number, Note[]>,
  tabTitleByNoteId: Map<number, string>,
): EnrichedNode[] {
  return folders.map((f) => {
    const subFolders: EnrichedNode[] = f.children.length
      ? foldersToTreeData(f.children, creatingUnderKey, notesByFolder, tabTitleByNoteId)
      : [];

    const noteLeaves: EnrichedNode[] = (notesByFolder.get(f.id) ?? [])
      .slice(0, NOTES_PER_FOLDER_LIMIT)
      .map((n) => ({
        key: noteKey(n.id),
        // 当该笔记 tab 已打开时，优先用 tabs store 的实时 title（编辑器
        // handleTitleChange 同步进去）→ 用户在编辑器键入即可看到侧边栏跟随。
        // 没打开 tab 时回退到 DB 拉的 n.title。
        title: tabTitleByNoteId.get(n.id) || n.title || "未命名",
        isLeaf: true,
        data: { isNote: true, note: n },
      }));

    const children: EnrichedNode[] = [...subFolders, ...noteLeaves];

    if (creatingUnderKey === String(f.id)) {
      children.unshift({
        key: `${NEW_NODE_PREFIX}${f.id}`,
        title: "",
        isLeaf: true,
      });
    }

    return {
      key: String(f.id),
      title: f.name,
      children: children.length ? children : undefined,
      data: { isNote: false },
    };
  });
}

/** 在文件夹树中按 id 查找名称 */
function findFolderName(folders: Folder[], id: number): string | null {
  for (const f of folders) {
    if (f.id === id) return f.name;
    if (f.children.length) {
      const found = findFolderName(f.children, id);
      if (found !== null) return found;
    }
  }
  return null;
}

/** 获取指定父节点下的所有直接子文件夹 id（parent_id == null 代表根级） */
function getChildIds(folders: Folder[], parentId: number | null): number[] {
  if (parentId === null) return folders.map((f) => f.id);
  let result: number[] = [];
  const walk = (list: Folder[]) => {
    for (const f of list) {
      if (f.id === parentId) {
        result = f.children.map((c) => c.id);
        return;
      }
      if (f.children.length) walk(f.children);
    }
  };
  walk(folders);
  return result;
}

/** 在文件夹树中按 id 查找父节点 id（根节点返回 null；未找到返回 null） */
function findFolderParentId(folders: Folder[], id: number): number | null {
  let result: number | null = null;
  let found = false;
  const walk = (list: Folder[]) => {
    for (const f of list) {
      if (found) return;
      if (f.id === id) {
        result = f.parent_id;
        found = true;
        return;
      }
      if (f.children.length) walk(f.children);
    }
  };
  walk(folders);
  return result;
}

/**
 * 收集从根到 targetId（含）的所有祖先文件夹 id 路径
 *
 * 用于"跳到笔记 → 自动展开树"：把这条路径上的所有文件夹从 collapsed 集合中移除，
 * 即可把目标笔记所在层级展开到可见。targetId 不在树里时返回空数组。
 */
function collectAncestorFolderIds(folders: Folder[], targetId: number): number[] {
  let path: number[] = [];
  const walk = (list: Folder[], stack: number[]): boolean => {
    for (const f of list) {
      const next = [...stack, f.id];
      if (f.id === targetId) {
        path = next;
        return true;
      }
      if (f.children.length && walk(f.children, next)) return true;
    }
    return false;
  };
  walk(folders, []);
  return path;
}

export function NotesPanel() {
  const navigate = useNavigate();
  const location = useLocation();
  const isUncategorizedActive =
    location.pathname === "/notes" &&
    new URLSearchParams(location.search).get("folder") === "uncategorized";
  const foldersRefreshTick = useAppStore((s) => s.foldersRefreshTick);
  const notesRefreshTick = useAppStore((s) => s.notesRefreshTick);
  // 订阅 tabs：编辑器 handleTitleChange 实时调 updateTabTitle，这里把 tab.title
  // 当作 ephemeral overlay 覆盖渲染——用户在编辑器输入标题立刻能看到侧边栏跟随，
  // 不必等保存。tab 关闭后 overlay 自然消失，回退到 DB 标题。
  const tabs = useTabsStore((s) => s.tabs);
  const tabTitleByNoteId = useMemo(
    () => new Map(tabs.map((t) => [t.id, t.title])),
    [tabs],
  );
  const { token } = antdTheme.useToken();

  // 文件夹直属笔记缓存（按 folderId 索引）。
  // 展开时按需加载；notesRefreshTick 变化时清空已加载的项触发重拉。
  const [notesByFolder, setNotesByFolder] = useState<Map<number, Note[]>>(
    () => new Map(),
  );
  // 正在请求的 folderId 集合，避免同一个文件夹并发请求
  const loadingNotesRef = useRef<Set<number>>(new Set());

  // 未分类笔记（folder_id IS NULL）：底部"未分类"虚拟节点展开时按需加载，
  // 让用户在 NotesPanel 顶部"+ 新建笔记"建出来的 null-folder 笔记能立刻看到。
  // 展开/收起态走 store 持久化（跨视图保留），笔记列表本地缓存（首次展开后秒开）。
  const uncategorizedExpanded = useAppStore((s) => s.notesUncategorizedExpanded);
  const setUncategorizedExpanded = useAppStore((s) => s.setNotesUncategorizedExpanded);
  const [uncategorizedNotes, setUncategorizedNotes] = useState<Note[]>([]);
  const loadingUncategorizedRef = useRef(false);

  /** 拉某个文件夹的直属笔记（include_descendants=false） */
  async function loadNotesForFolder(folderId: number) {
    if (loadingNotesRef.current.has(folderId)) return;
    loadingNotesRef.current.add(folderId);
    try {
      const r = await noteApi.list({
        folder_id: folderId,
        include_descendants: false,
        page: 1,
        page_size: NOTES_PER_FOLDER_LIMIT,
        // 树是组织视图，按用户自定义顺序展示（sort_order ASC）；
        // 未拖排过的笔记 sort_order 由 v31 迁移按 updated_at DESC 初始化，
        // 肉眼仍是时间序，拖排后立刻可见
        sort_by: "custom",
      });
      setNotesByFolder((prev) => {
        const next = new Map(prev);
        next.set(folderId, r.items);
        return next;
      });
    } catch (e) {
      console.warn(`[notes-panel] 加载文件夹 ${folderId} 笔记失败:`, e);
    } finally {
      loadingNotesRef.current.delete(folderId);
    }
  }

  /** 拉未分类笔记（folder_id IS NULL） */
  async function loadUncategorizedNotes() {
    if (loadingUncategorizedRef.current) return;
    loadingUncategorizedRef.current = true;
    try {
      const r = await noteApi.list({
        uncategorized: true,
        page: 1,
        page_size: NOTES_PER_FOLDER_LIMIT,
        sort_by: "custom",
      });
      setUncategorizedNotes(r.items);
    } catch (e) {
      console.warn("[notes-panel] 加载未分类笔记失败:", e);
    } finally {
      loadingUncategorizedRef.current = false;
    }
  }

  // 用 store 里的预热缓存做种子，避免首次打开 Panel 时空白闪烁；
  // useEffect 仍会后台 loadFolders 拿最新数据替换。
  const [folders, setFolders] = useState<Folder[]>(
    () => useAppStore.getState().prefetchedFolders ?? [],
  );
  // 仅当无预热缓存且尚未首次 loadFolders 时为 true → 显示 Skeleton 而不是"暂无文件夹"
  const [initialLoading, setInitialLoading] = useState(
    () => useAppStore.getState().prefetchedFolders === null,
  );
  const [folderExpanded, setFolderExpanded] = useState(true);

  // 文件夹展开状态由 store 的"折叠集合"派生：collapsed 之外的所有文件夹 id 视为展开。
  // 这样新建文件夹默认展开（因为不在 collapsed 集合里），符合直觉；
  // 用户每次操作 → setNotesFolderCollapsed → 自动 persist → 跨视图/重启保留。
  const collapsedFolderKeys = useAppStore((s) => s.notesCollapsedFolderKeys);
  const allFolderKeys = useMemo(() => collectAllKeys(folders), [folders]);
  const expandedKeys = useMemo<React.Key[]>(() => {
    if (allFolderKeys.length === 0) return [];
    const collapsed = new Set(collapsedFolderKeys);
    return allFolderKeys.filter((k) => !collapsed.has(k));
  }, [allFolderKeys, collapsedFolderKeys]);

  // 首次进入（含老版本升级后第一次打开）：把全部文件夹默认折叠。
  // 之后由用户操作驱动，flag 持久化后不再重置。
  const initialCollapseDone = useAppStore(
    (s) => s.notesFoldersInitialCollapseDone,
  );
  useEffect(() => {
    if (initialCollapseDone) return;
    if (folders.length === 0) return;
    useAppStore.getState().setNotesAllFoldersCollapsed(allFolderKeys);
    useAppStore.getState().markNotesFoldersInitialCollapseDone();
  }, [initialCollapseDone, folders.length, allFolderKeys]);

  const [creatingRoot, setCreatingRoot] = useState(false);
  const [newRootName, setNewRootName] = useState("");

  const [creatingUnderKey, setCreatingUnderKey] = useState<string | null>(null);
  const [newChildName, setNewChildName] = useState("");

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const [contextMenu, setContextMenu] = useState<{
    key: string;
    name: string;
    x: number;
    y: number;
    ts: number;
  } | null>(null);

  /** OS 文件拖拽到面板时的高亮态（只对包含 Files 的 dataTransfer 生效，不干扰 Tree 内部拖拽） */
  const [fileDragOver, setFileDragOver] = useState(false);

  // 扫描文件夹导入的预览弹窗状态
  const [importPreview, setImportPreview] = useState<{
    files: ScannedFile[];
    rootPath: string;
    folderId: number;
  } | null>(null);

  // 右键"从模板…"弹窗状态：folderId=null 表示尚未打开
  const [templatePickerFolder, setTemplatePickerFolder] = useState<number | null>(null);

  // 外部点击 / Esc 关闭由 ContextMenuOverlay 内部自管，无需在此挂监听

  // 双击判定：300ms 内同一节点视为双击（进入重命名）
  const lastClickRef = useRef<{ key: string; time: number } | null>(null);
  // Esc 取消编辑时置 true，后续 onBlur 跳过提交
  const cancelEditRef = useRef(false);

  useEffect(() => {
    loadFolders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foldersRefreshTick]);

  /**
   * URL → 树状态同步：当路由进入 /notes/:id（来自搜索面板、Ctrl+K、首页 dropdown 等）时，
   *
   *   1. 立刻把 selectedKey 设到该笔记，让侧栏高亮一致
   *   2. 异步查 note.folder_id：
   *        - null → 展开"未分类"虚拟节点 + 触发拉取
   *        - 非 null → 收集从根到 folder 的所有祖先 id，
   *          从 collapsed 集合中移除，让该层级在树上可见 + 拉笔记列表
   *
   * 不依赖任何缓存（直接 noteApi.get 拿权威 folder_id），避免缓存陈旧导致跳错位置。
   * folders 加进 deps：首次 panel mount 时 folders 可能还在加载，等加载完会重跑这条 effect。
   */
  const noteIdFromUrl = useMemo<number | null>(() => {
    const m = location.pathname.match(/^\/notes\/(\d+)$/);
    return m ? Number(m[1]) : null;
  }, [location.pathname]);

  useEffect(() => {
    if (noteIdFromUrl == null) return;

    // ① 立即高亮（不等异步）—— 用户视觉立刻有反馈
    setSelectedKey(noteKey(noteIdFromUrl));

    // ② 异步：查 folder_id 并展开到对应位置
    let cancelled = false;
    noteApi
      .get(noteIdFromUrl)
      .then((note) => {
        if (cancelled) return;
        const fid = note.folder_id;
        if (fid === null) {
          // 未分类：展开虚拟节点 + 拉笔记
          const store = useAppStore.getState();
          if (!store.notesUncategorizedExpanded) {
            store.setNotesUncategorizedExpanded(true);
          }
          if (uncategorizedNotes.length === 0) {
            void loadUncategorizedNotes();
          }
        } else {
          // 在文件夹下：把祖先全展开
          const path = collectAncestorFolderIds(folders, fid);
          if (path.length > 0) {
            const expandKeys = new Set(path.map(String));
            const store = useAppStore.getState();
            const newCollapsed = store.notesCollapsedFolderKeys.filter(
              (k) => !expandKeys.has(k),
            );
            if (
              newCollapsed.length !== store.notesCollapsedFolderKeys.length
            ) {
              store.setNotesAllFoldersCollapsed(newCollapsed);
            }
          }
          // 拉这个文件夹的直属笔记（懒加载缓存）
          if (!notesByFolder.has(fid)) {
            void loadNotesForFolder(fid);
          }
        }
      })
      .catch(() => {
        // 笔记不存在 / 已删，安静失败：保留高亮即可，不打扰用户
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteIdFromUrl, folders]);

  // notes 数据变化时（新建/编辑/删除）：清空缓存 + 重拉所有已展开的文件夹。
  // 避免遗留旧标题。expand 阶段没拉过的文件夹不需要预热。
  useEffect(() => {
    const expandedFolderIds: number[] = [];
    for (const k of expandedKeys) {
      const s = String(k);
      if (!s.startsWith(NEW_NODE_PREFIX) && !isNoteKey(s)) {
        const id = Number(s);
        if (Number.isFinite(id)) expandedFolderIds.push(id);
      }
    }
    setNotesByFolder(new Map());
    expandedFolderIds.forEach((id) => void loadNotesForFolder(id));
    // 同步重拉未分类（仅在已展开时；折叠态等下次展开按需拉）
    if (uncategorizedExpanded) {
      void loadUncategorizedNotes();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notesRefreshTick]);

  // 切换"未分类"展开：展开时第一次进入要拉数据；折叠不卸载缓存（下次展开秒开）
  useEffect(() => {
    if (uncategorizedExpanded && uncategorizedNotes.length === 0) {
      void loadUncategorizedNotes();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uncategorizedExpanded]);

  /**
   * 展开/收起：把 antd 给的 keys 视作"用户期望展开的全集"，
   * 反推折叠集合 = 所有现存文件夹 id - 期望展开的 → 写入 store 持久化。
   * 同时对"新出现"的展开节点触发按需加载。
   */
  function handleExpand(keys: React.Key[]) {
    const expandedFolderSet = new Set<string>();
    for (const k of keys) {
      const s = String(k);
      if (s.startsWith(NEW_NODE_PREFIX) || isNoteKey(s)) continue;
      if (Number.isFinite(Number(s))) expandedFolderSet.add(s);
    }

    const prevSet = new Set(expandedKeys.map(String));
    const newCollapsed = allFolderKeys.filter((k) => !expandedFolderSet.has(k));
    useAppStore.getState().setNotesAllFoldersCollapsed(newCollapsed);

    for (const k of expandedFolderSet) {
      if (prevSet.has(k)) continue;
      const id = Number(k);
      if (Number.isFinite(id) && !notesByFolder.has(id)) {
        void loadNotesForFolder(id);
      }
    }
  }

  // 初次拿到文件夹后，对默认展开的文件夹批量预热笔记，避免一打开就要点一下才显示
  useEffect(() => {
    if (folders.length === 0 || expandedKeys.length === 0) return;
    for (const k of expandedKeys) {
      const s = String(k);
      if (s.startsWith(NEW_NODE_PREFIX) || isNoteKey(s)) continue;
      const id = Number(s);
      if (Number.isFinite(id) && !notesByFolder.has(id)) {
        void loadNotesForFolder(id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders, expandedKeys]);

  async function loadFolders() {
    try {
      const list = await folderApi.list();
      setFolders(list);
      // 顺手清理已删除文件夹在折叠集合里的孤儿 id，避免持久化无限沉淀
      useAppStore.getState().pruneNotesCollapsedFolders(collectAllKeys(list));
    } catch (e) {
      console.error("加载文件夹失败:", e);
    } finally {
      setInitialLoading(false);
    }
  }

  /** 打开本机 .md / .txt 文件 → 导入/复用笔记 → 跳转 */
  async function handleOpenMarkdown() {
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [
          { name: "文本", extensions: ["md", "markdown", "txt"] },
        ],
      });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;
      const result = await importApi.openMarkdownFile(path);
      if (result.wasSynced) {
        message.info("已根据最新 md 文件同步笔记内容");
      }
      useAppStore.getState().bumpNotesRefresh();
      navigate(`/notes/${result.noteId}`);
    } catch (e) {
      message.error(`打开失败: ${e}`);
    }
  }

  // ─── 创建（根级 / 子级） ───────────────────────

  async function submitCreateRoot() {
    if (cancelEditRef.current) {
      cancelEditRef.current = false;
      setCreatingRoot(false);
      setNewRootName("");
      return;
    }
    const name = newRootName.trim();
    if (!name) {
      setCreatingRoot(false);
      setNewRootName("");
      return;
    }
    try {
      await folderApi.create(name);
      setNewRootName("");
      setCreatingRoot(false);
      loadFolders();
      useAppStore.getState().bumpFoldersRefresh();
    } catch (e) {
      message.error(String(e));
    }
  }

  async function submitCreateChild() {
    if (cancelEditRef.current) {
      cancelEditRef.current = false;
      setCreatingUnderKey(null);
      setNewChildName("");
      return;
    }
    const name = newChildName.trim();
    const parentKey = creatingUnderKey;
    if (!name || !parentKey) {
      setCreatingUnderKey(null);
      setNewChildName("");
      return;
    }
    try {
      await folderApi.create(name, Number(parentKey));
      setNewChildName("");
      setCreatingUnderKey(null);
      useAppStore.getState().setNotesFolderCollapsed(parentKey, false);
      loadFolders();
      useAppStore.getState().bumpFoldersRefresh();
    } catch (e) {
      message.error(String(e));
    }
  }

  function startCreateChild(parentKey: string) {
    setCreatingUnderKey(parentKey);
    setNewChildName("");
    useAppStore.getState().setNotesFolderCollapsed(parentKey, false);
  }

  // ─── 重命名 ─────────────────────────────────

  function startRename(key: string, currentName: string) {
    setEditingKey(key);
    setEditingName(currentName);
  }

  async function submitRename() {
    if (cancelEditRef.current) {
      cancelEditRef.current = false;
      setEditingKey(null);
      setEditingName("");
      return;
    }
    if (!editingKey) return;
    const key = editingKey;
    const name = editingName.trim();

    // 笔记重命名：复用 update_note Command（带原 content / folder_id 一起更新）
    if (isNoteKey(key)) {
      const id = noteIdFromKey(key);
      const note = findNoteById(id);
      if (!note) {
        setEditingKey(null);
        setEditingName("");
        return;
      }
      if (!name || name === note.title) {
        setEditingKey(null);
        setEditingName("");
        return;
      }
      // 加密笔记的 content 是占位符，直接 update_note 会把真实加密内容覆盖掉。
      // 引导用户在编辑器里改标题（那里能拿到解密后内容）。
      if (note.is_encrypted) {
        message.info("加密笔记请在编辑器内修改标题");
        setEditingKey(null);
        setEditingName("");
        return;
      }
      try {
        await noteApi.update(id, {
          title: name,
          content: note.content,
          folder_id: note.folder_id,
        });
        setEditingKey(null);
        setEditingName("");
        useAppStore.getState().bumpNotesRefresh();
        // 同步 TabBar：编辑器只在自己改 title 时调 updateTabTitle，从这里
        // 改名要主动通知 tabs store，否则顶部标签栏还在显示旧标题
        useTabsStore.getState().updateTabTitle(id, name);
      } catch (e) {
        message.error(String(e));
      }
      return;
    }

    const original = findFolderName(folders, Number(key));
    if (!name || name === original) {
      setEditingKey(null);
      setEditingName("");
      return;
    }
    try {
      await folderApi.rename(Number(key), name);
      setEditingKey(null);
      setEditingName("");
      loadFolders();
      useAppStore.getState().bumpFoldersRefresh();
    } catch (e) {
      message.error(String(e));
    }
  }

  // ─── 删除 ─────────────────────────────────

  function confirmDelete(key: string, name: string) {
    Modal.confirm({
      title: `删除文件夹"${name}"`,
      content: "若文件夹下含有子文件夹或笔记，将拒绝删除。请先清空内容。",
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      async onOk() {
        try {
          await folderApi.delete(Number(key));
          if (selectedKey === key) setSelectedKey(null);
          loadFolders();
          useAppStore.getState().bumpFoldersRefresh();
        } catch (e) {
          message.error(String(e));
          throw e;
        }
      },
    });
  }

  // ─── 拖拽移动 ───────────────────────────────

  type DropInfo = {
    node: { key: React.Key; pos: string };
    dragNode: { key: React.Key };
    dropPosition: number;
    dropToGap: boolean;
  };

  async function handleDrop(info: DropInfo) {
    // 防御：OS 文件拖入时 antd Tree 的 onDrop 理论上不会触发（内部无 dragNode），
    // 但不同版本行为有差异，保底校验避免 undefined.key 抛错
    if (!info.dragNode || info.dragNode.key == null) return;
    const dragKey = String(info.dragNode.key);
    const dropKey = String(info.node.key);
    if (dragKey.startsWith(NEW_NODE_PREFIX) || dropKey.startsWith(NEW_NODE_PREFIX)) return;

    // ── 笔记拖动 → 跨 folder 改 folder_id；同 folder 内调 reorder 改 sort_order ──
    // Why: 跨 folder 时改 sort_order 没意义（用户肯定还要再拖到目标位置），保持原行为；
    //      同 folder 时拖到另一笔记上/旁 → 重排，注意：仅在列表页"自定义排序"模式下可见
    if (isNoteKey(dragKey)) {
      const noteId = noteIdFromKey(dragKey);
      const note = findNoteById(noteId);
      if (!note) return;

      // 计算目标 folderId：
      //   - 落在文件夹节点上（!dropToGap） → 目标 = 该文件夹
      //   - 落在文件夹之间的 gap → 目标 = 该文件夹的父
      //   - 落在另一篇笔记上/旁 → 目标 = 那篇笔记所在的文件夹
      let targetFolderId: number | null;
      let dropNoteId: number | null = null;
      if (isNoteKey(dropKey)) {
        dropNoteId = noteIdFromKey(dropKey);
        const dropNote = findNoteById(dropNoteId);
        targetFolderId = dropNote ? dropNote.folder_id : note.folder_id;
      } else {
        const dropFolderId = Number(dropKey);
        if (!Number.isFinite(dropFolderId)) return;
        targetFolderId = info.dropToGap
          ? findFolderParentId(folders, dropFolderId)
          : dropFolderId;
      }

      // 跨 folder：保持原"只换 folder_id"行为
      if (targetFolderId !== note.folder_id) {
        try {
          await noteApi.moveToFolder(noteId, targetFolderId);
          useAppStore.getState().bumpNotesRefresh();
        } catch (e) {
          message.error(String(e));
        }
        return;
      }

      // 同 folder + 落在另一个笔记叶子上/旁 → 重排该 folder 内笔记顺序
      if (dropNoteId == null || dropNoteId === noteId) return;
      const dropNote = findNoteById(dropNoteId);
      if (!dropNote) return;
      // 同档校验：list_notes 第一排序键是 is_pinned DESC，置顶笔记永远在前。
      // 跨档拖排 sort_order 写入后视觉上会"跳回"置顶档，体验非常迷惑——直接拒绝
      if (note.is_pinned !== dropNote.is_pinned) {
        message.info(
          note.is_pinned
            ? "置顶笔记不能拖到普通笔记之间（先取消置顶）"
            : "普通笔记不能拖到置顶笔记之间（先置顶它）",
        );
        return;
      }
      const siblings: Note[] =
        targetFolderId == null
          ? uncategorizedNotes
          : (notesByFolder.get(targetFolderId) ?? []);
      const withoutDrag = siblings.filter((n) => n.id !== noteId);
      const dropIdx = withoutDrag.findIndex((n) => n.id === dropNoteId);
      if (dropIdx < 0) return;
      // antd Tree 的 dropPosition 相对父级位置；diff 出 dropOffset 判断"落在前/后"
      const posArr = info.node.pos.split("-");
      const dropOffset =
        info.dropPosition - Number(posArr[posArr.length - 1]);
      const insertIdx = dropOffset > 0 ? dropIdx + 1 : dropIdx;
      const newOrder = [...withoutDrag];
      newOrder.splice(insertIdx, 0, note);
      try {
        await noteApi.reorder(newOrder.map((n) => n.id));
        // 重载该 folder 笔记缓存以反映新顺序（list_notes 默认按时间序，所以肉眼
        // 看不到差异；切到列表页"自定义排序"模式才能看见）
        if (targetFolderId == null) {
          loadingUncategorizedRef.current = false;
          void loadUncategorizedNotes();
        } else {
          loadingNotesRef.current.delete(targetFolderId);
          void loadNotesForFolder(targetFolderId);
        }
        useAppStore.getState().bumpNotesRefresh();
      } catch (e) {
        message.error(String(e));
      }
      return;
    }

    // 拖动文件夹时：目标若是笔记，忽略
    if (isNoteKey(dropKey)) return;

    const dragId = Number(dragKey);
    const dropId = Number(dropKey);
    const currentParentId = findFolderParentId(folders, dragId);

    const posArr = info.node.pos.split("-");
    const dropOffset = info.dropPosition - Number(posArr[posArr.length - 1]);

    try {
      if (!info.dropToGap) {
        if (currentParentId === dropId) {
          const siblings = getChildIds(folders, dropId);
          const withoutDrag = siblings.filter((id) => id !== dragId);
          await folderApi.reorder([dragId, ...withoutDrag]);
        } else {
          await folderApi.move(dragId, dropId);
          const siblings = getChildIds(folders, dropId);
          await folderApi.reorder([dragId, ...siblings]);
        }
        loadFolders();
        useAppStore.getState().bumpFoldersRefresh();
        return;
      }

      const newParentId = findFolderParentId(folders, dropId);
      const rawSiblings = getChildIds(folders, newParentId);
      const withoutDrag = rawSiblings.filter((id) => id !== dragId);
      const targetIdx = withoutDrag.indexOf(dropId);
      const insertIdx = dropOffset <= 0 ? targetIdx : targetIdx + 1;
      const newOrder = [...withoutDrag];
      newOrder.splice(insertIdx, 0, dragId);

      if (currentParentId !== newParentId) {
        await folderApi.move(dragId, newParentId);
      }
      await folderApi.reorder(newOrder);
      loadFolders();
      useAppStore.getState().bumpFoldersRefresh();
    } catch (e) {
      message.error(String(e));
    }
  }

  // ─── 单击/双击 ─────────────────────────────

  /** 在 notesByFolder 缓存里按 id 查找笔记（跨所有已加载文件夹） */
  function findNoteById(id: number): Note | null {
    for (const list of notesByFolder.values()) {
      const found = list.find((n) => n.id === id);
      if (found) return found;
    }
    return null;
  }

  function handleTitleClick(key: string) {
    if (key.startsWith(NEW_NODE_PREFIX)) return;
    if (editingKey === key) return;

    // 笔记叶节点：单击打开编辑器；300ms 内同节点二次点击 → 进入重命名
    if (isNoteKey(key)) {
      const now = Date.now();
      const last = lastClickRef.current;
      if (last && last.key === key && now - last.time < 300) {
        lastClickRef.current = null;
        const note = findNoteById(noteIdFromKey(key));
        if (note) startRename(key, note.title || "");
        return;
      }
      lastClickRef.current = { key, time: now };
      const id = noteIdFromKey(key);
      if (Number.isFinite(id)) {
        setSelectedKey(key);
        navigate(`/notes/${id}`);
      }
      return;
    }

    const now = Date.now();
    const last = lastClickRef.current;
    if (last && last.key === key && now - last.time < 300) {
      lastClickRef.current = null;
      const name = findFolderName(folders, Number(key));
      if (name !== null) startRename(key, name);
      return;
    }

    lastClickRef.current = { key, time: now };

    // 点文件夹标题 = 切换展开/折叠（与 chevron 行为对齐，VS Code / Finder 同款）
    // 第一次点：展开（按需加载笔记）；再点：折叠。chevron 仍可单独点。
    const wasExpanded = expandedKeys.some((k) => String(k) === key);
    useAppStore.getState().setNotesFolderCollapsed(key, wasExpanded);
    if (!wasExpanded) {
      const id = Number(key);
      if (Number.isFinite(id) && !notesByFolder.has(id)) {
        void loadNotesForFolder(id);
      }
    }

    if (selectedKey === key) {
      setSelectedKey(null);
      navigate("/notes");
    } else {
      setSelectedKey(key);
      navigate(`/notes?folder=${key}`);
    }
  }

  // ─── F2 快捷键 ─────────────────────────────

  function handleTreeKeyDown(e: React.KeyboardEvent) {
    if (e.key === "F2" && selectedKey && !editingKey) {
      const name = findFolderName(selectedKey ? folders : [], Number(selectedKey));
      if (name !== null) {
        e.preventDefault();
        startRename(selectedKey, name);
      }
    }
  }

  // ─── 右键菜单 ─────────────────────────────

  function buildMenuItems(key: string, name: string): ContextMenuEntry[] {
    const close = () => setContextMenu(null);

    // ─── 笔记叶子菜单 ───
    if (isNoteKey(key)) {
      const noteId = noteIdFromKey(key);
      const note = findNoteById(noteId);
      const isPinned = note?.is_pinned ?? false;
      return [
        {
          key: "open",
          icon: <ExternalLink size={14} />,
          label: "打开",
          onClick: () => {
            navigate(`/notes/${noteId}`);
            close();
          },
        },
        {
          key: "rename",
          icon: <Edit3 size={14} />,
          label: "重命名",
          onClick: () => {
            startRename(key, name);
            close();
          },
        },
        {
          key: "copy-wiki",
          icon: <Copy size={14} />,
          label: "复制 wiki 链接",
          onClick: () => {
            navigator.clipboard
              .writeText(`[[${name}]]`)
              .then(() => message.success("已复制"))
              .catch((err) => message.error(String(err)));
            close();
          },
        },
        {
          key: "toggle-pin",
          icon: isPinned ? <PinOff size={14} /> : <Pin size={14} />,
          label: isPinned ? "取消置顶" : "置顶",
          onClick: async () => {
            close();
            try {
              const next = await noteApi.togglePin(noteId);
              message.success(next ? "已置顶" : "已取消置顶");
              useAppStore.getState().bumpNotesRefresh();
            } catch (e) {
              message.error(String(e));
            }
          },
        },
        { type: "divider" },
        {
          key: "soft-delete",
          icon: <Trash2 size={14} />,
          label: "移到回收站",
          danger: true,
          onClick: async () => {
            close();
            try {
              await trashApi.softDelete(noteId);
              useTabsStore.getState().closeTab(noteId);
              message.success("已移到回收站");
              useAppStore.getState().bumpNotesRefresh();
            } catch (e) {
              message.error(String(e));
            }
          },
        },
      ];
    }

    // ─── 文件夹菜单（原有逻辑） ───
    const folderId = Number(key);
    return [
      // ─── 创建：高频操作放第一位 ───
      {
        key: "new-note",
        icon: <NotebookText size={14} />,
        label: "在此新建笔记",
        onClick: () => {
          createBlankAndOpen(folderId, navigate);
          close();
        },
      },
      {
        key: "new-child",
        icon: <Plus size={14} />,
        label: "新建子文件夹",
        onClick: () => {
          startCreateChild(key);
          close();
        },
      },
      { type: "divider" },
      {
        key: "new-from-template",
        icon: <LayoutTemplate size={14} />,
        label: "从模板新建…",
        onClick: () => {
          setTemplatePickerFolder(folderId);
          close();
        },
      },
      { type: "divider" },
      // ─── 导入：与"+ 新建笔记"按钮口径一致（MD/TXT/PDF/Word），文件夹递归是侧边栏独占 ───
      {
        key: "import-text",
        icon: <FileTypeIcon type="md" size={14} />,
        label: "导入 Markdown / TXT 文件…",
        onClick: () => {
          void importTextFlow(folderId);
          close();
        },
      },
      {
        key: "import-md-folder",
        icon: <FolderOpen size={14} />,
        label: "导入 Markdown 文件夹…",
        onClick: () => {
          void handleImportMdFolder(key);
          close();
        },
      },
      {
        key: "import-pdf",
        icon: <FileTypeIcon type="pdf" size={14} />,
        label: "导入 PDF…",
        onClick: () => {
          void importPdfsFlow(folderId);
          close();
        },
      },
      {
        key: "import-word",
        icon: <FileTypeIcon type="docx" size={14} />,
        label: "导入 Word…",
        onClick: () => {
          void importWordFlow(folderId);
          close();
        },
      },
      { type: "divider" },
      {
        key: "rename",
        icon: <Edit3 size={14} />,
        label: "重命名",
        onClick: () => {
          startRename(key, name);
          close();
        },
      },
      { type: "divider" },
      {
        key: "delete",
        icon: <Trash size={14} />,
        label: "删除",
        danger: true,
        onClick: () => {
          confirmDelete(key, name);
          close();
        },
      },
    ];
  }

  // ─── 导入到当前文件夹 ─────────────────────
  // 单文件导入（MD/TXT/PDF/Word）已统一走 noteCreator 里的 importTextFlow / importPdfsFlow / importWordFlow，
  // 这里只保留侧边栏独有的"扫描文件夹递归导入"流程（带 ImportPreviewModal 选副本策略 + 保留层级）。

  async function handleImportMdFolder(folderKey: string) {
    const folderId = Number(folderKey);
    try {
      const picked = await openDialog({
        directory: true,
        title: "选择要导入的 Markdown 文件夹",
      });
      if (!picked || Array.isArray(picked)) return;
      const rootPath = picked;
      const hide = message.loading("扫描中…", 0);
      let files: ScannedFile[];
      try {
        files = await importApi.scan(rootPath);
      } catch (e) {
        hide();
        message.error(`扫描失败: ${e}`);
        return;
      }
      hide();
      if (files.length === 0) {
        message.info("该文件夹下没有 .md 文件");
        return;
      }
      setImportPreview({ files, rootPath, folderId });
    } catch (e) {
      message.error(`选择目录失败: ${e}`);
    }
  }

  // ─── OS 文件拖入新建笔记 ───────────────────

  /** 识别 .md/.markdown/.txt 文本文件（按扩展名；MIME 在 Windows 上常为空） */
  function isDroppedTextFile(f: File): boolean {
    const dot = f.name.lastIndexOf(".");
    if (dot < 0) return false;
    const ext = f.name.slice(dot + 1).toLowerCase();
    return ext === "md" || ext === "markdown" || ext === "txt";
  }

  /** 只有 OS 文件拖入（dataTransfer.types 含 "Files"）才视为新建笔记场景，避免干扰 Tree 内部节点拖动 */
  function hasOsFiles(dt: DataTransfer): boolean {
    // dataTransfer.types 在 DOMStringList / ReadonlyArray 两种实现间兼容，统一转数组再判断
    for (let i = 0; i < dt.types.length; i++) {
      if (dt.types[i] === "Files") return true;
    }
    return false;
  }

  /**
   * 尝试从 File 对象上读非标准的 `path` 属性（Tauri 2 + WebView2 在 dragDropEnabled=false
   * 时会把 OS 绝对路径挂上来）。返回值为 null 表示至少一个文件没拿到路径。
   *
   * Why: 能拿到路径就能走 `importApi.importSelected` 全流程（去重 / source_file_path /
   *      副本策略等），比"读内容 + noteApi.create"信息量大一个维度。
   */
  function collectOsPaths(files: File[]): string[] | null {
    const paths: string[] = [];
    for (const f of files) {
      const p = (f as File & { path?: string }).path;
      if (!p) return null;
      paths.push(p);
    }
    return paths;
  }

  /**
   * 把拖入的文件各自建成笔记。优先走 importApi.importSelected（能拿到 OS 路径时，
   * 享受去重/副本/source_file 追踪）；否则回退到前端 File.text() + noteApi.create。
   */
  async function handleOsFilesDropped(files: File[]) {
    const texts = files.filter(isDroppedTextFile);
    const skipped = files.length - texts.length;
    if (texts.length === 0) {
      message.warning("仅支持 .md / .txt 拖入新建笔记（附件拖放请拖到编辑器内）");
      return;
    }

    // ── 快路径：能拿到 OS 路径则走 importApi（仅对 .md/.markdown，.txt 走慢路径） ──
    const mdOnly = texts.filter((f) => {
      const ext = f.name.slice(f.name.lastIndexOf(".") + 1).toLowerCase();
      return ext === "md" || ext === "markdown";
    });
    const paths = mdOnly.length === texts.length ? collectOsPaths(texts) : null;
    // T-016: 当前侧栏选中了文件夹时，落到该文件夹下（OB 用户期望）；未选中则落根
    const targetFolderId = selectedKey ? Number(selectedKey) : null;
    if (paths && paths.length > 0) {
      const hide = message.loading(`正在导入 ${paths.length} 个 Markdown 文件…`, 0);
      try {
        const result = await importApi.importSelected(paths, targetFolderId);
        hide();
        const parts: string[] = [];
        if (result.imported > 0) parts.push(`新建 ${result.imported}`);
        if (result.duplicated > 0) parts.push(`副本 ${result.duplicated}`);
        if (result.skipped > 0) parts.push(`跳过 ${result.skipped}`);
        message.success(parts.length ? `导入完成：${parts.join("，")}` : "无新增");
        if (result.errors.length > 0) {
          console.warn("[notes-panel drop] 导入失败:", result.errors);
          message.warning(`${result.errors.length} 个文件失败`);
        }
        useAppStore.getState().bumpNotesRefresh();
        useAppStore.getState().bumpFoldersRefresh();
      } catch (e) {
        hide();
        message.error(`导入失败: ${e}`);
      }
      return;
    }

    // ── 慢路径：File.text() + noteApi.create（含 .txt / 路径不可用场景） ──
    let lastId: number | null = null;
    let ok = 0;
    const errors: string[] = [];
    for (const f of texts) {
      try {
        const content = await f.text();
        const title = f.name.replace(/\.(md|markdown|txt)$/i, "").trim() || "未命名";
        // T-016: 与快路径保持一致，选中文件夹时落到该文件夹
        const note = await noteApi.create({
          title,
          content,
          folder_id: targetFolderId,
        });
        lastId = note.id;
        ok++;
      } catch (e) {
        errors.push(`${f.name}: ${e}`);
      }
    }
    if (ok > 0) {
      message.success(
        `已新建 ${ok} 篇笔记${skipped > 0 ? `（忽略 ${skipped} 个非文本文件）` : ""}`,
      );
      useAppStore.getState().bumpNotesRefresh();
      useAppStore.getState().bumpFoldersRefresh();
      if (lastId) navigate(`/notes/${lastId}`);
    }
    if (errors.length > 0) {
      console.warn("[notes-panel drop] 导入失败:", errors);
      message.warning(`${errors.length} 个文件失败`);
    }
  }

  // ─── 自定义节点渲染 ─────────────────────────

  function renderTitle(node: DataNode): React.ReactNode {
    const key = String(node.key);

    if (key.startsWith(NEW_NODE_PREFIX)) {
      return (
        <Input
          size="small"
          placeholder="子文件夹名称"
          value={newChildName}
          onChange={(e) => setNewChildName(e.target.value)}
          onPressEnter={submitCreateChild}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              cancelEditRef.current = true;
              setCreatingUnderKey(null);
              setNewChildName("");
            }
          }}
          onBlur={submitCreateChild}
          autoFocus
          style={{ width: "100%", minWidth: 0 }}
          onClick={(e) => e.stopPropagation()}
          // 阻止 mousedown 冒泡到 Tree node：在输入框拖选文本时不让 HTML5 drag 启动
          onMouseDown={(e) => e.stopPropagation()}
          draggable={false}
        />
      );
    }

    if (editingKey === key) {
      return (
        <Input
          size="small"
          value={editingName}
          onChange={(e) => setEditingName(e.target.value)}
          onPressEnter={submitRename}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              cancelEditRef.current = true;
              setEditingKey(null);
              setEditingName("");
            }
          }}
          onBlur={submitRename}
          autoFocus
          onFocus={(e) => e.target.select()}
          style={{ width: "100%", minWidth: 0 }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          draggable={false}
        />
      );
    }

    const name = String(node.title ?? "");
    const { emoji, rest } = parseEmojiPrefix(name);
    const display = rest || name;
    // 右键菜单当前指向本节点 → 文字外加 1px 描边提示
    const contextActive = contextMenu?.key === key;
    const ctxStyle: React.CSSProperties = contextActive
      ? {
          outline: `1px solid ${token.colorPrimary}`,
          outlineOffset: 2,
          borderRadius: 4,
        }
      : {};

    if (isNoteKey(key)) {
      return (
        <span
          className="flex items-center gap-1.5 w-full min-w-0"
          onClick={(e) => {
            e.stopPropagation();
            handleTitleClick(key);
          }}
          title={name}
          style={ctxStyle}
        >
          {emoji ? (
            <span style={{ fontSize: 14, flexShrink: 0, lineHeight: 1 }}>
              {emoji}
            </span>
          ) : (
            <FileText
              size={13}
              style={{ flexShrink: 0, color: token.colorTextTertiary }}
            />
          )}
          <span className="truncate">{display}</span>
        </span>
      );
    }

    // 文件夹：emoji 优先；否则用 hash 配色的填充文件夹图标
    return (
      <span
        className="flex items-center gap-1.5 w-full"
        onClick={(e) => {
          e.stopPropagation();
          handleTitleClick(key);
        }}
        title={name}
        style={ctxStyle}
      >
        {emoji ? (
          <span style={{ fontSize: 14, flexShrink: 0, lineHeight: 1 }}>
            {emoji}
          </span>
        ) : (
          <FolderFilled style={{ flexShrink: 0, color: token.colorPrimary }} />
        )}
        <span className="truncate">{display}</span>
      </span>
    );
  }

  const treeData = foldersToTreeData(folders, creatingUnderKey, notesByFolder, tabTitleByNoteId);

  return (
    <div
      className="flex flex-col h-full"
      style={{ overflow: "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 视图标题栏 */}
      <div
        className="flex items-center gap-2 px-3 py-2.5 shrink-0"
        style={{
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <NotebookText size={15} style={{ color: token.colorPrimary }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: token.colorText }}>
          笔记
        </span>
        <div style={{ flex: 1 }} />
        <Button
          type="text"
          size="small"
          icon={<ChevronsDownUp size={14} />}
          onClick={() => {
            // 折叠/展开全部文件夹（state 走 store，自动 persist）
            const store = useAppStore.getState();
            if (expandedKeys.length === 0) {
              store.clearNotesCollapsedFolders();
            } else {
              store.setNotesAllFoldersCollapsed(allFolderKeys);
            }
          }}
          style={{ width: 24, height: 24, padding: 0 }}
          title="折叠/展开全部"
        />
      </div>

      {/* 新建笔记 + 打开 md */}
      <div
        style={{
          padding: "10px 12px",
          display: "flex",
          gap: 6,
          flexShrink: 0,
        }}
      >
        <div style={{ flex: 1, display: "flex" }}>
          <NewNoteButton block />
        </div>
        <Button
          icon={<FolderOpen size={14} />}
          onClick={handleOpenMarkdown}
          title="打开本机 .md 文件"
        />
      </div>

      {/* 文件夹小节 —— 兼任 OS 文件拖入区（.md/.txt → 新建笔记） */}
      <div
        className="flex-1 overflow-auto"
        style={{
          minHeight: 0,
          paddingTop: 4,
          // 始终预留滚动条空间——展开未分类后内容超长出现滚动条时，
          // 不会让上方文件夹/标题区的可用宽度突然收缩。WebView2 / Chromium 94+ 原生支持
          scrollbarGutter: "stable",
          outline: fileDragOver
            ? `2px dashed ${token.colorPrimary}`
            : "none",
          outlineOffset: -2,
          transition: "outline 0.15s",
        }}
        onDragOver={(e) => {
          if (!hasOsFiles(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          if (!fileDragOver) setFileDragOver(true);
        }}
        onDragLeave={(e) => {
          // 仅当离开到本容器外时清理，避免在子元素间移动时闪烁
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setFileDragOver(false);
        }}
        onDrop={(e) => {
          setFileDragOver(false);
          if (!hasOsFiles(e.dataTransfer)) return;
          e.preventDefault();
          e.stopPropagation();

          // 同步检查 —— DataTransfer 在 await 之后就失效，必须在这里拿到 items
          // 目的：文件夹拖入在 WebView 里拿不到 OS 路径（items 的 FileSystemDirectoryEntry
          // 只给 fullPath 相对值），引导用户改走右键菜单那条已工作的路径
          const hasDirectory = Array.from(e.dataTransfer.items ?? []).some((it) => {
            if (it.kind !== "file") return false;
            const entry = it.webkitGetAsEntry?.();
            return entry?.isDirectory === true;
          });
          if (hasDirectory) {
            message.info("拖文件夹请改用右键菜单『导入 Markdown 文件夹…』（能保留目录层级 + 扫描去重）");
            return;
          }

          const files = Array.from(e.dataTransfer.files);
          if (files.length === 0) return;
          void handleOsFilesDropped(files);
        }}
      >
        <div
          className="flex items-center justify-between cursor-pointer select-none"
          style={{
            color: token.colorTextSecondary,
            fontSize: 12,
            paddingLeft: 16,
            paddingRight: 16,
            paddingTop: 12,
            paddingBottom: 8,
          }}
          onClick={() => setFolderExpanded(!folderExpanded)}
        >
          <span className="flex items-center gap-1">
            {folderExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            文件夹
          </span>
          <Button
            type="text"
            size="small"
            icon={<FolderPlus size={14} />}
            onClick={(e) => {
              e.stopPropagation();
              setCreatingRoot(true);
            }}
            style={{ width: 24, height: 24, padding: 0 }}
          />
        </div>

        {folderExpanded && (
          <div
            style={{ padding: "0 12px" }}
            tabIndex={0}
            onKeyDown={handleTreeKeyDown}
          >
            {creatingRoot && (
              <Input
                size="small"
                placeholder="文件夹名称"
                value={newRootName}
                onChange={(e) => setNewRootName(e.target.value)}
                onPressEnter={submitCreateRoot}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    cancelEditRef.current = true;
                    setCreatingRoot(false);
                    setNewRootName("");
                  }
                }}
                onBlur={submitCreateRoot}
                autoFocus
                style={{ marginBottom: 4 }}
              />
            )}
            {initialLoading && treeData.length === 0 ? (
              <div style={{ padding: "4px 8px" }}>
                <Skeleton
                  active
                  paragraph={{ rows: 4, width: ["80%", "60%", "70%", "50%"] }}
                  title={false}
                />
              </div>
            ) : treeData.length > 0 ? (
              <Tree
                className="sidebar-folder-tree"
                treeData={treeData}
                blockNode
                draggable={{
                  icon: false,
                  // 编辑态（重命名/新建子文件夹）的节点禁拖：在 input 里拖选文本
                  // 时不应触发 antd Tree 的 HTML5 drag，否则光标改不动反而把节点拖走
                  nodeDraggable: (node) => {
                    const k = String(node.key);
                    if (editingKey === k) return false;
                    if (creatingUnderKey && k.startsWith(NEW_NODE_PREFIX)) return false;
                    return true;
                  },
                }}
                onDrop={handleDrop}
                selectedKeys={selectedKey ? [selectedKey] : []}
                expandedKeys={expandedKeys}
                onExpand={handleExpand}
                titleRender={renderTitle}
                switcherIcon={({ expanded }) =>
                  expanded ? (
                    <ChevronDown size={11} strokeWidth={2.2} />
                  ) : (
                    <ChevronRight size={11} strokeWidth={2.2} />
                  )
                }
                onRightClick={({ event, node }) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const key = String(node.key);
                  if (key.startsWith(NEW_NODE_PREFIX)) return;
                  // 笔记叶节点：用 note.title 作为 name 传给菜单
                  let name: string | null;
                  if (isNoteKey(key)) {
                    const note = findNoteById(noteIdFromKey(key));
                    if (!note) return;
                    name = note.title;
                  } else {
                    name = findFolderName(folders, Number(key));
                    if (name === null) return;
                  }
                  setContextMenu({
                    key,
                    name,
                    x: (event as unknown as React.MouseEvent).clientX,
                    y: (event as unknown as React.MouseEvent).clientY,
                    ts: Date.now(),
                  });
                }}
                style={{ background: "transparent" }}
              />
            ) : (
              !creatingRoot && (
                <div
                  className="text-center py-3"
                  style={{ color: token.colorTextQuaternary, fontSize: 12 }}
                >
                  暂无文件夹
                  <br />
                  <span
                    className="cursor-pointer"
                    style={{ color: token.colorPrimary, fontSize: 11 }}
                    onClick={() => setCreatingRoot(true)}
                  >
                    + 新建文件夹
                  </span>
                </div>
              )
            )}
            {/* 常驻虚拟"未分类"文件夹：folder_id IS NULL 的笔记归在这里。
                · 点 chevron 展开 → 直接看到所有未分类笔记的扁平列表
                · 点标题文字 → 跳到 /notes?folder=uncategorized 看完整列表
                这样从 NotesPanel 顶部"+ 新建笔记"建出来的笔记（默认 null folder）
                能立刻在侧边栏看到，不用切到主区。 */}
            <div style={{ marginTop: 4 }}>
              <div
                className="select-none flex items-center gap-1"
                style={{
                  padding: "4px 10px",
                  borderRadius: 4,
                  fontSize: 13,
                  color: isUncategorizedActive
                    ? token.colorPrimary
                    : token.colorTextSecondary,
                  background: isUncategorizedActive
                    ? token.colorPrimaryBg
                    : "transparent",
                  transition: "background-color .12s",
                }}
                onMouseEnter={(e) => {
                  if (!isUncategorizedActive) {
                    e.currentTarget.style.background = token.colorFillTertiary;
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isUncategorizedActive) {
                    e.currentTarget.style.background = "transparent";
                  }
                }}
              >
                <span
                  className="cursor-pointer flex items-center"
                  onClick={(e) => {
                    e.stopPropagation();
                    setUncategorizedExpanded(!uncategorizedExpanded);
                  }}
                  style={{ width: 14, height: 14, color: token.colorTextTertiary }}
                  title={uncategorizedExpanded ? "收起" : "展开"}
                >
                  {uncategorizedExpanded ? (
                    <ChevronDown size={11} strokeWidth={2.2} />
                  ) : (
                    <ChevronRight size={11} strokeWidth={2.2} />
                  )}
                </span>
                <span
                  className="cursor-pointer flex items-center gap-2 flex-1 min-w-0"
                  onClick={() => {
                    // 与文件夹一致：点标题 = 切换展开/折叠 + 跳主区
                    setUncategorizedExpanded(!uncategorizedExpanded);
                    navigate("/notes?folder=uncategorized");
                  }}
                >
                  <FolderIcon size={13} style={{ opacity: 0.6, flexShrink: 0 }} />
                  <span className="truncate">未分类</span>
                  {uncategorizedNotes.length > 0 && (
                    <span
                      style={{
                        fontSize: 11,
                        color: token.colorTextQuaternary,
                        flexShrink: 0,
                      }}
                    >
                      {uncategorizedNotes.length}
                    </span>
                  )}
                </span>
              </div>
              {uncategorizedExpanded && (
                <div style={{ paddingLeft: 22 }}>
                  {uncategorizedNotes.length === 0 ? (
                    <div
                      style={{
                        padding: "4px 10px",
                        fontSize: 12,
                        color: token.colorTextQuaternary,
                      }}
                    >
                      暂无未分类笔记
                    </div>
                  ) : (
                    uncategorizedNotes.map((n) => {
                      const displayTitle =
                        tabTitleByNoteId.get(n.id) || n.title || "未命名";
                      const { emoji, rest } = parseEmojiPrefix(displayTitle);
                      const display = rest || displayTitle;
                      const noteSelected = selectedKey === noteKey(n.id);
                      return (
                        <div
                          key={n.id}
                          className="cursor-pointer select-none flex items-center gap-1.5"
                          style={{
                            padding: "3px 10px",
                            borderRadius: 4,
                            fontSize: 13,
                            color: noteSelected
                              ? token.colorPrimary
                              : token.colorText,
                            background: noteSelected
                              ? token.colorPrimaryBg
                              : "transparent",
                            transition: "background-color .12s",
                          }}
                          onMouseEnter={(e) => {
                            if (!noteSelected) {
                              e.currentTarget.style.background =
                                token.colorFillTertiary;
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (!noteSelected) {
                              e.currentTarget.style.background = "transparent";
                            }
                          }}
                          onClick={() => {
                            setSelectedKey(noteKey(n.id));
                            navigate(`/notes/${n.id}`);
                          }}
                          title={displayTitle}
                        >
                          {emoji ? (
                            <span
                              style={{
                                fontSize: 14,
                                flexShrink: 0,
                                lineHeight: 1,
                              }}
                            >
                              {emoji}
                            </span>
                          ) : (
                            <FileText
                              size={13}
                              style={{
                                flexShrink: 0,
                                color: token.colorTextTertiary,
                              }}
                            />
                          )}
                          <span className="truncate">{display}</span>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 右键菜单（幻影锚点） */}
      {contextMenu && (
        <ContextMenuOverlay
          open
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildMenuItems(contextMenu.key, contextMenu.name)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* 扫描文件夹 → 预览 → 导入 */}
      {importPreview && (
        <ImportPreviewModal
          open
          files={importPreview.files}
          rootPath={importPreview.rootPath}
          defaultPreserveRoot
          onCancel={() => setImportPreview(null)}
          onConfirm={async ({ policy, preserveRoot }) => {
            const { files, rootPath, folderId } = importPreview;
            setImportPreview(null);
            const paths = files.map((f) => f.path);
            const hide = message.loading(`正在导入 ${paths.length} 个文件…`, 0);
            try {
              const result = await importApi.importSelected(
                paths,
                folderId,
                rootPath,
                preserveRoot,
                policy,
              );
              hide();
              const parts: string[] = [];
              if (result.imported > 0) parts.push(`导入 ${result.imported} 篇`);
              if (result.duplicated > 0) parts.push(`副本 ${result.duplicated} 篇`);
              if (result.skipped > 0) parts.push(`跳过 ${result.skipped} 篇`);
              if (result.tags_attached && result.tags_attached > 0) {
                parts.push(`关联标签 ${result.tags_attached} 条`);
              }
              if (result.attachments_copied && result.attachments_copied > 0) {
                parts.push(`复制图片 ${result.attachments_copied} 张`);
              }
              if (parts.length > 0) message.success(parts.join("，"));
              const missCount = result.attachments_missing?.length ?? 0;
              if (missCount > 0) {
                message.warning(
                  `${missCount} 张图片在 vault 里找不到，已保留原引用`,
                );
                console.warn(
                  "[import] 缺失图片清单:",
                  result.attachments_missing,
                );
              }
              if (result.errors.length > 0) {
                message.warning(
                  `${result.errors.length} 个文件失败，详见控制台`,
                );
                console.warn("[import] 失败明细:", result.errors);
              }
              useAppStore.getState().bumpNotesRefresh();
              useAppStore.getState().bumpFoldersRefresh();
            } catch (e) {
              hide();
              message.error(`导入失败: ${e}`);
            }
          }}
        />
      )}

      {/* 右键"从模板新建…" */}
      <TemplatePickerModal
        open={templatePickerFolder !== null}
        folderId={templatePickerFolder}
        onClose={() => setTemplatePickerFolder(null)}
      />
    </div>
  );
}
