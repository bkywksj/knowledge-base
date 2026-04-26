import { useState, useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Tree,
  Button,
  theme as antdTheme,
  Input,
  message,
  Modal,
  Dropdown,
  type MenuProps,
} from "antd";
import {
  NotebookText,
  FolderPlus,
  ChevronDown,
  ChevronRight,
  Edit3,
  Trash,
  Plus,
  FolderOpen,
  FolderInput,
  Folder as FolderIcon,
  ChevronsDownUp,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOutlined } from "@ant-design/icons";
import type { DataNode } from "antd/es/tree";
import { useAppStore } from "@/store";
import { folderApi, importApi, noteApi } from "@/lib/api";
import type { Folder, ScannedFile } from "@/types";
import { NewNoteButton } from "@/components/NewNoteButton";
import { createBlankAndOpen } from "@/lib/noteCreator";
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

/** 将 Folder[] 转为 antd Tree 的 DataNode[]（可插入临时新建节点） */
function foldersToTreeData(
  folders: Folder[],
  creatingUnderKey: string | null,
): DataNode[] {
  return folders.map((f) => {
    const children: DataNode[] = f.children.length
      ? foldersToTreeData(f.children, creatingUnderKey)
      : [];

    if (creatingUnderKey === String(f.id)) {
      children.push({
        key: `${NEW_NODE_PREFIX}${f.id}`,
        title: "",
        isLeaf: true,
      });
    }

    return {
      key: String(f.id),
      title: f.name,
      children: children.length ? children : undefined,
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

export function NotesPanel() {
  const navigate = useNavigate();
  const location = useLocation();
  const isUncategorizedActive =
    location.pathname === "/notes" &&
    new URLSearchParams(location.search).get("folder") === "uncategorized";
  const foldersRefreshTick = useAppStore((s) => s.foldersRefreshTick);
  const { token } = antdTheme.useToken();

  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderExpanded, setFolderExpanded] = useState(true);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);

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

  // Dropdown trigger=[] 不会自己处理外部点击关闭，手动挂全局监听
  useEffect(() => {
    if (!contextMenu) return;
    function handleMouseDown(e: MouseEvent) {
      if (e.button === 2) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        target.closest(
          ".ant-dropdown, .ant-dropdown-menu, .ant-dropdown-menu-submenu-popup",
        )
      )
        return;
      setContextMenu(null);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setContextMenu(null);
    }
    document.addEventListener("mousedown", handleMouseDown, true);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown, true);
      document.removeEventListener("keydown", handleKey);
    };
  }, [contextMenu]);

  // 双击判定：300ms 内同一节点视为双击（进入重命名）
  const lastClickRef = useRef<{ key: string; time: number } | null>(null);
  // Esc 取消编辑时置 true，后续 onBlur 跳过提交
  const cancelEditRef = useRef(false);

  useEffect(() => {
    loadFolders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foldersRefreshTick]);

  useEffect(() => {
    if (folders.length > 0 && expandedKeys.length === 0) {
      setExpandedKeys(collectAllKeys(folders));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders]);

  async function loadFolders() {
    try {
      const list = await folderApi.list();
      setFolders(list);
    } catch (e) {
      console.error("加载文件夹失败:", e);
    }
  }

  /** 打开本机 .md 文件 → 导入/复用笔记 → 跳转 */
  async function handleOpenMarkdown() {
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
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
      setExpandedKeys((prev) =>
        prev.includes(parentKey) ? prev : [...prev, parentKey],
      );
      loadFolders();
      useAppStore.getState().bumpFoldersRefresh();
    } catch (e) {
      message.error(String(e));
    }
  }

  function startCreateChild(parentKey: string) {
    setCreatingUnderKey(parentKey);
    setNewChildName("");
    setExpandedKeys((prev) =>
      prev.includes(parentKey) ? prev : [...prev, parentKey],
    );
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

  function handleTitleClick(key: string) {
    if (key.startsWith(NEW_NODE_PREFIX)) return;
    if (editingKey === key) return;

    const now = Date.now();
    const last = lastClickRef.current;
    if (last && last.key === key && now - last.time < 300) {
      lastClickRef.current = null;
      const name = findFolderName(folders, Number(key));
      if (name !== null) startRename(key, name);
      return;
    }

    lastClickRef.current = { key, time: now };

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

  function buildMenuItems(key: string, name: string): MenuProps["items"] {
    const close = () => setContextMenu(null);
    return [
      {
        key: "new-child",
        icon: <Plus size={14} />,
        label: "新建子文件夹",
        onClick: () => {
          startCreateChild(key);
          close();
        },
      },
      {
        key: "new-note",
        icon: <NotebookText size={14} />,
        label: "在此新建笔记",
        onClick: () => {
          createBlankAndOpen(Number(key), navigate);
          close();
        },
      },
      { type: "divider" },
      {
        key: "import-md-files",
        icon: <FolderInput size={14} />,
        label: "导入 Markdown 文件…",
        onClick: () => {
          void handleImportMdFiles(key);
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

  async function handleImportMdFiles(folderKey: string) {
    const folderId = Number(folderKey);
    try {
      const picked = await openDialog({
        multiple: true,
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      });
      if (!picked) return;
      const paths = Array.isArray(picked) ? picked : [picked];
      if (paths.length === 0) return;
      const hide = message.loading(`正在导入 ${paths.length} 个 Markdown 文件…`, 0);
      try {
        const result = await importApi.importSelected(paths, folderId);
        hide();
        if (result.imported > 0) {
          message.success(`已导入 ${result.imported} 篇到此文件夹`);
        } else if (result.skipped > 0) {
          message.info(`全部 ${result.skipped} 篇已跳过（空文件）`);
        }
        if (result.errors.length > 0) {
          message.warning(`${result.errors.length} 个文件失败，详见控制台`);
          console.warn("[import] 失败明细:", result.errors);
        }
        useAppStore.getState().bumpNotesRefresh();
        useAppStore.getState().bumpFoldersRefresh();
      } catch (e) {
        hide();
        message.error(`导入失败: ${e}`);
      }
    } catch (e) {
      message.error(`选择文件失败: ${e}`);
    }
  }

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
          style={{ width: 160 }}
          onClick={(e) => e.stopPropagation()}
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
          style={{ width: 160 }}
          onClick={(e) => e.stopPropagation()}
        />
      );
    }

    const name = String(node.title ?? "");
    return (
      <span
        className="flex items-center gap-1.5 w-full"
        onClick={(e) => {
          e.stopPropagation();
          handleTitleClick(key);
        }}
      >
        <FolderOutlined style={{ flexShrink: 0 }} />
        <span className="truncate">{name}</span>
      </span>
    );
  }

  const treeData = foldersToTreeData(folders, creatingUnderKey);

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
            // 折叠/展开全部文件夹
            if (expandedKeys.length === 0) {
              setExpandedKeys(collectAllKeys(folders));
            } else {
              setExpandedKeys([]);
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
            {treeData.length > 0 ? (
              <Tree
                className="sidebar-folder-tree"
                treeData={treeData}
                blockNode
                draggable={{ icon: false }}
                onDrop={handleDrop}
                selectedKeys={selectedKey ? [selectedKey] : []}
                expandedKeys={expandedKeys}
                onExpand={(keys) => setExpandedKeys(keys)}
                titleRender={renderTitle}
                onRightClick={({ event, node }) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const key = String(node.key);
                  if (key.startsWith(NEW_NODE_PREFIX)) return;
                  const name = findFolderName(folders, Number(key));
                  if (name === null) return;
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
            {/* 常驻虚拟"未分类"文件夹：folder_id IS NULL 的笔记自动归在这里，
                不需要用户手动建。点击跳到 /notes?folder=uncategorized */}
            <div
              className="cursor-pointer select-none flex items-center gap-2"
              style={{
                padding: "4px 10px",
                marginTop: 4,
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
              onClick={() => navigate("/notes?folder=uncategorized")}
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
              <FolderIcon size={13} style={{ opacity: 0.6 }} />
              <span>未分类</span>
            </div>
          </div>
        )}
      </div>

      {/* 右键菜单（幻影锚点） */}
      {contextMenu && (
        <Dropdown
          key={contextMenu.ts}
          open
          onOpenChange={(open) => {
            if (!open) setContextMenu(null);
          }}
          menu={{ items: buildMenuItems(contextMenu.key, contextMenu.name) }}
          trigger={[]}
        >
          <div
            style={{
              position: "fixed",
              left: contextMenu.x,
              top: contextMenu.y,
              width: 1,
              height: 1,
              pointerEvents: "none",
            }}
          />
        </Dropdown>
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
    </div>
  );
}
