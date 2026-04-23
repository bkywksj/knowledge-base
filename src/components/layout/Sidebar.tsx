import { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Badge,
  Menu,
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
  Home,
  FileText,
  Search,
  Calendar,
  Tags,
  GitBranch,
  Bot,
  Info,
  Trash2,
  FolderPlus,
  ChevronDown,
  ChevronRight,
  Edit3,
  Trash,
  Plus,
  CheckSquare,
  FolderOpen,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOutlined } from "@ant-design/icons";
import type { DataNode } from "antd/es/tree";
import { useAppStore } from "@/store";
import { folderApi, importApi } from "@/lib/api";
import type { Folder } from "@/types";

/** 导航菜单项（静态部分，用于路由高亮匹配） */
const navItems = [
  { key: "/", icon: <Home size={16} />, label: "首页" },
  { key: "/notes", icon: <FileText size={16} />, label: "笔记" },
  { key: "/search", icon: <Search size={16} />, label: "搜索" },
  { key: "/daily", icon: <Calendar size={16} />, label: "每日笔记" },
  { key: "/tags", icon: <Tags size={16} />, label: "标签" },
  { key: "/tasks", icon: <CheckSquare size={16} />, label: "待办" },
  { key: "/graph", icon: <GitBranch size={16} />, label: "知识图谱" },
  { key: "/ai", icon: <Bot size={16} />, label: "AI 问答" },
  { key: "/about", icon: <Info size={16} />, label: "关于" },
];

/** 底部快捷入口 */
const bottomItems = [
  { key: "/trash", icon: <Trash2 size={16} />, label: "回收站" },
];

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

    // 如果正在该文件夹下创建新子项，插入一个占位节点
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

export function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const urgentTodoCount = useAppStore((s) => s.urgentTodoCount);
  const refreshTaskStats = useAppStore((s) => s.refreshTaskStats);
  const { token } = antdTheme.useToken();

  // 应用启动时拉一次紧急任务数，后续由任务页在变更后触发 refreshTaskStats
  useEffect(() => {
    refreshTaskStats();
  }, [refreshTaskStats]);

  // 在导航项"待办"上叠加红色 Badge（紧急数=0 时自动隐藏，不占空间）
  const menuItems = useMemo(
    () =>
      navItems.map((item) => {
        if (item.key !== "/tasks") return item;
        return {
          ...item,
          label: (
            <span className="flex items-center justify-between gap-2">
              <span>{item.label}</span>
              <Badge
                count={urgentTodoCount}
                size="small"
                overflowCount={99}
                style={{ marginRight: 4 }}
              />
            </span>
          ),
        };
      }),
    [urgentTodoCount],
  );

  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderExpanded, setFolderExpanded] = useState(true);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);

  // 根级"新建文件夹"
  const [creatingRoot, setCreatingRoot] = useState(false);
  const [newRootName, setNewRootName] = useState("");

  // 某个文件夹下"新建子文件夹"
  const [creatingUnderKey, setCreatingUnderKey] = useState<string | null>(null);
  const [newChildName, setNewChildName] = useState("");

  // 内联重命名
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  // 当前选中的节点（用于 F2 快捷键）
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // 右键菜单（Tree 级别，使用幻影锚点 Dropdown 定位）
  const [contextMenu, setContextMenu] = useState<{
    key: string;
    name: string;
    x: number;
    y: number;
    ts: number;
  } | null>(null);

  // Dropdown 的 trigger 为空数组时 antd 不会自己监听"外部点击关闭"，
  // 这里手动挂全局 mousedown / Esc 监听，点到 .ant-dropdown 外或按 Esc 就关闭。
  // 另外遇到右键再次打开新菜单（同一帧内 contextMenu 被 setState 替换）时，
  // 用 capture 阶段的 mousedown，只对 button !== 2（非右键）做关闭，避免打架。
  useEffect(() => {
    if (!contextMenu) return;
    function handleMouseDown(e: MouseEvent) {
      if (e.button === 2) return; // 右键另建新菜单，由 onRightClick 处理
      const target = e.target as HTMLElement | null;
      if (target && target.closest(".ant-dropdown")) return;
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

  // 双击检测：记录最近一次点击时间，300ms 内同一节点再次点击视为双击
  const lastClickRef = useRef<{ key: string; time: number } | null>(null);
  // 按 Esc 取消编辑时置为 true，随后的 onBlur 跳过提交
  const cancelEditRef = useRef(false);

  useEffect(() => {
    loadFolders();
  }, []);

  // 首次加载后默认展开所有节点
  useEffect(() => {
    if (folders.length > 0 && expandedKeys.length === 0) {
      setExpandedKeys(collectAllKeys(folders));
    }
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
    // Esc 取消：跳过提交
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
      // 创建后确保父节点展开
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
    // 展开父节点以显示输入框
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
    // 空名或未变化则直接退出编辑态
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
          // 清理选中态
          if (selectedKey === key) setSelectedKey(null);
          loadFolders();
          useAppStore.getState().bumpFoldersRefresh();
        } catch (e) {
          message.error(String(e));
          throw e; // 让 Modal 保持打开状态以便用户看到错误
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
    // 不处理临时节点
    if (dragKey.startsWith(NEW_NODE_PREFIX) || dropKey.startsWith(NEW_NODE_PREFIX)) return;

    const dragId = Number(dragKey);
    const dropId = Number(dropKey);
    const currentParentId = findFolderParentId(folders, dragId);

    // antd 相对位置：-1 表示目标上方，1 表示目标下方
    const posArr = info.node.pos.split("-");
    const dropOffset =
      info.dropPosition - Number(posArr[posArr.length - 1]);

    try {
      if (!info.dropToGap) {
        // 拖到目标节点内部：作为其子节点，放到最前面
        if (currentParentId === dropId) {
          // 已是该文件夹的子节点，仅把自己置顶
          const siblings = getChildIds(folders, dropId);
          const withoutDrag = siblings.filter((id) => id !== dragId);
          await folderApi.reorder([dragId, ...withoutDrag]);
        } else {
          // 先改 parent
          await folderApi.move(dragId, dropId);
          // 再把自己置顶
          const siblings = getChildIds(folders, dropId);
          await folderApi.reorder([dragId, ...siblings]);
        }
        loadFolders();
        useAppStore.getState().bumpFoldersRefresh();
        return;
      }

      // 拖到节点之间（gap）：新父节点 = 目标的父节点
      const newParentId = findFolderParentId(folders, dropId);

      // 取新父节点下的同级列表
      const rawSiblings = getChildIds(folders, newParentId);
      const withoutDrag = rawSiblings.filter((id) => id !== dragId);
      const targetIdx = withoutDrag.indexOf(dropId);
      const insertIdx = dropOffset <= 0 ? targetIdx : targetIdx + 1;
      const newOrder = [...withoutDrag];
      newOrder.splice(insertIdx, 0, dragId);

      // 跨父容器：先 move，再 reorder
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
    // 临时节点不响应
    if (key.startsWith(NEW_NODE_PREFIX)) return;
    // 正在编辑时不响应
    if (editingKey === key) return;

    const now = Date.now();
    const last = lastClickRef.current;
    if (last && last.key === key && now - last.time < 300) {
      // 双击：进入重命名（覆盖第一次单击的跳转）
      lastClickRef.current = null;
      const name = findFolderName(folders, Number(key));
      if (name !== null) startRename(key, name);
      return;
    }

    lastClickRef.current = { key, time: now };

    // 单击：若已选中 → 取消筛选回到全部笔记；否则进入该文件夹筛选
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
      const name = findFolderName(folders, Number(selectedKey));
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
          navigate(`/notes?folder=${key}&new=1`);
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

  // ─── 自定义节点渲染 ─────────────────────────

  function renderTitle(node: DataNode): React.ReactNode {
    const key = String(node.key);

    // 临时"新建子文件夹"节点：渲染输入框
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

    // 重命名态：渲染输入框
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

    // 正常态：纯 span，点击跳转/重命名；右键菜单由 Tree 级 onRightClick 统一处理
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

  /** 当前路径匹配 */
  const selectedNav = navItems.find((item) =>
    item.key === "/"
      ? location.pathname === "/"
      : location.pathname.startsWith(item.key),
  );

  // ─── 折叠态视图 ───────────────────────────

  if (collapsed) {
    return (
      <div className="flex flex-col h-full">
        <div
          className="h-12 flex items-center justify-center font-bold text-base"
          style={{
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            color: token.colorText,
          }}
        >
          知{import.meta.env.DEV ? "·D" : ""}
        </div>
        <Menu
          mode="inline"
          selectedKeys={selectedNav ? [selectedNav.key] : []}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{ border: "none", flex: 1 }}
        />
      </div>
    );
  }

  const treeData = foldersToTreeData(folders, creatingUnderKey);

  // ─── 展开态视图 ───────────────────────────

  return (
    <div
      className="flex flex-col h-full"
      style={{ overflow: "hidden" }}
      // 容器级别屏蔽 WebView 默认右键菜单
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Logo */}
      <div
        className="h-12 flex items-center justify-center font-bold text-base shrink-0"
        style={{
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          color: token.colorText,
        }}
      >
        知识库{import.meta.env.DEV ? " [DEV]" : ""}
      </div>

      {/* 全局"新建笔记"+ "打开 md 文件"按钮 */}
      <div
        style={{
          padding: collapsed ? "8px 6px" : "10px 12px",
          display: "flex",
          gap: 6,
        }}
      >
        <Button
          type="primary"
          icon={<Plus size={collapsed ? 16 : 14} />}
          style={{ flex: 1 }}
          onClick={() => useAppStore.getState().openCreateModal()}
          title="新建笔记 (Ctrl+N)"
        >
          {!collapsed && "新建笔记"}
        </Button>
        <Button
          icon={<FolderOpen size={collapsed ? 16 : 14} />}
          onClick={handleOpenMarkdown}
          title="打开本机 .md 文件"
        />
      </div>

      {/* 第1段: 导航菜单 */}
      <Menu
        mode="inline"
        selectedKeys={selectedNav ? [selectedNav.key] : []}
        items={menuItems}
        onClick={({ key }) => navigate(key)}
        style={{ border: "none", flexShrink: 0 }}
      />

      {/* 分割线（和上面的导航菜单拉开距离） */}
      <div
        style={{
          height: 1,
          marginTop: 20,
          marginLeft: 16,
          marginRight: 16,
          marginBottom: 10,
          background: token.colorBorderSecondary,
        }}
      />

      {/* 第2段: 文件夹树 */}
      <div className="flex-1 overflow-auto" style={{ minHeight: 0, paddingTop: 4 }}>
        <div
          className="flex items-center justify-between cursor-pointer select-none"
          style={{
            color: token.colorTextSecondary,
            fontSize: 12,
            // 用 inline style 写死 + 加大数值，避免 HMR 半生效 / tailwind preflight 覆盖
            paddingLeft: 16,
            paddingRight: 16,
            paddingTop: 20,
            paddingBottom: 10,
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

      {/* 分割线 */}
      <div
        style={{
          height: 1,
          margin: "4px 16px",
          background: token.colorBorderSecondary,
        }}
      />

      {/* 第3段: 快捷入口 */}
      <Menu
        mode="inline"
        selectedKeys={
          bottomItems.some((i) => location.pathname === i.key)
            ? [location.pathname]
            : []
        }
        items={bottomItems}
        onClick={({ key }) => navigate(key)}
        style={{ border: "none", flexShrink: 0 }}
      />

      {/* 右键菜单（幻影锚点，跟随鼠标坐标定位） */}
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

// ─── 辅助函数 ─────────────────────────────

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
