import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
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
  FileText,
  FolderPlus,
  ChevronDown,
  ChevronRight,
  Edit3,
  Trash,
  Plus,
  FolderOpen,
  FolderInput,
  ChevronsDownUp,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOutlined } from "@ant-design/icons";
import type { DataNode } from "antd/es/tree";
import { useAppStore } from "@/store";
import { folderApi, importApi } from "@/lib/api";
import type { Folder } from "@/types";
import { NewNoteButton } from "@/components/NewNoteButton";
import { createBlankAndOpen } from "@/lib/noteCreator";

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
        icon: <FileText size={14} />,
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
      let files;
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
      const subdirCount = new Set(
        files.map((f) => f.relative_dir).filter(Boolean),
      ).size;
      const rootName =
        rootPath.split(/[\\/]/).filter(Boolean).pop() ?? "导入";
      Modal.confirm({
        title: "确认导入",
        content: (
          <div style={{ fontSize: 13, lineHeight: 1.7 }}>
            扫描到 <strong>{files.length}</strong> 个 .md 文件
            {subdirCount > 0 && `，分布在 ${subdirCount} 个子目录中`}。
            <br />
            将保留源目录层级，并在当前文件夹下创建
            <strong style={{ margin: "0 4px" }}>{rootName}</strong>
            作为根文件夹。
          </div>
        ),
        okText: "开始导入",
        cancelText: "取消",
        async onOk() {
          const paths = files!.map((f) => f.path);
          const hide2 = message.loading(
            `正在导入 ${paths.length} 个文件…`,
            0,
          );
          try {
            const result = await importApi.importSelected(
              paths,
              folderId,
              rootPath,
              true,
            );
            hide2();
            if (result.imported > 0) {
              message.success(
                `已导入 ${result.imported} 篇到此文件夹，保留层级`,
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
            hide2();
            message.error(`导入失败: ${e}`);
          }
        },
      });
    } catch (e) {
      message.error(`选择目录失败: ${e}`);
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
        <FileText size={15} style={{ color: token.colorPrimary }} />
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

      {/* 文件夹小节 */}
      <div className="flex-1 overflow-auto" style={{ minHeight: 0, paddingTop: 4 }}>
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
    </div>
  );
}
