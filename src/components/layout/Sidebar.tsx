import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Menu, Tree, Button, theme as antdTheme, Input, message } from "antd";
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
} from "lucide-react";
import { FolderOutlined } from "@ant-design/icons";
import type { DataNode } from "antd/es/tree";
import { useAppStore } from "@/store";
import { folderApi } from "@/lib/api";
import type { Folder } from "@/types";

/** 导航菜单项 */
const navItems = [
  { key: "/", icon: <Home size={16} />, label: "首页" },
  { key: "/notes", icon: <FileText size={16} />, label: "笔记" },
  { key: "/search", icon: <Search size={16} />, label: "搜索" },
  { key: "/daily", icon: <Calendar size={16} />, label: "每日笔记" },
  { key: "/tags", icon: <Tags size={16} />, label: "标签" },
  { key: "/graph", icon: <GitBranch size={16} />, label: "知识图谱" },
  { key: "/ai", icon: <Bot size={16} />, label: "AI 问答" },
  { key: "/about", icon: <Info size={16} />, label: "关于" },
];

/** 底部快捷入口 */
const bottomItems = [
  { key: "/trash", icon: <Trash2 size={16} />, label: "回收站" },
];

/** 将 Folder[] 转为 antd Tree 的 DataNode[] */
function foldersToTreeData(folders: Folder[]): DataNode[] {
  return folders.map((f) => ({
    key: String(f.id),
    title: f.name,
    icon: <FolderOutlined />,
    children: f.children.length > 0 ? foldersToTreeData(f.children) : undefined,
  }));
}

export function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const { token } = antdTheme.useToken();

  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderExpanded, setFolderExpanded] = useState(true);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  useEffect(() => {
    loadFolders();
  }, []);

  async function loadFolders() {
    try {
      const list = await folderApi.list();
      setFolders(list);
    } catch (e) {
      console.error("加载文件夹失败:", e);
    }
  }

  async function handleCreateFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      await folderApi.create(name);
      setNewFolderName("");
      setCreatingFolder(false);
      loadFolders();
    } catch (e) {
      message.error(String(e));
    }
  }

  function handleFolderSelect(selectedKeys: React.Key[]) {
    if (selectedKeys.length > 0) {
      navigate(`/notes?folder=${selectedKeys[0]}`);
    }
  }

  /** 当前路径匹配 */
  const selectedNav = navItems.find((item) =>
    item.key === "/"
      ? location.pathname === "/"
      : location.pathname.startsWith(item.key)
  );

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
          KB
        </div>
        <Menu
          mode="inline"
          selectedKeys={selectedNav ? [selectedNav.key] : []}
          items={navItems}
          onClick={({ key }) => navigate(key)}
          style={{ border: "none", flex: 1 }}
        />
      </div>
    );
  }

  const treeData = foldersToTreeData(folders);

  return (
    <div className="flex flex-col h-full" style={{ overflow: "hidden" }}>
      {/* Logo */}
      <div
        className="h-12 flex items-center justify-center font-bold text-base shrink-0"
        style={{
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          color: token.colorText,
        }}
      >
        Knowledge Base
      </div>

      {/* 第1段: 导航菜单 */}
      <Menu
        mode="inline"
        selectedKeys={selectedNav ? [selectedNav.key] : []}
        items={navItems}
        onClick={({ key }) => navigate(key)}
        style={{ border: "none", flexShrink: 0 }}
      />

      {/* 分割线 */}
      <div
        style={{
          height: 1,
          margin: "4px 16px",
          background: token.colorBorderSecondary,
        }}
      />

      {/* 第2段: 文件夹树 */}
      <div className="flex-1 overflow-auto" style={{ minHeight: 0 }}>
        <div
          className="flex items-center justify-between px-4 py-1.5 cursor-pointer select-none"
          style={{ color: token.colorTextSecondary, fontSize: 12 }}
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
              setCreatingFolder(true);
            }}
            style={{ width: 24, height: 24, padding: 0 }}
          />
        </div>

        {folderExpanded && (
          <div style={{ padding: "0 8px" }}>
            {creatingFolder && (
              <Input
                size="small"
                placeholder="文件夹名称"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onPressEnter={handleCreateFolder}
                onBlur={() => {
                  if (!newFolderName.trim()) setCreatingFolder(false);
                  else handleCreateFolder();
                }}
                autoFocus
                style={{ marginBottom: 4 }}
              />
            )}
            {treeData.length > 0 ? (
              <Tree
                treeData={treeData}
                showIcon
                defaultExpandAll
                onSelect={(keys) => handleFolderSelect(keys)}
                style={{ background: "transparent" }}
              />
            ) : (
              !creatingFolder && (
                <div
                  className="text-center py-4"
                  style={{ color: token.colorTextQuaternary, fontSize: 12 }}
                >
                  暂无文件夹
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
        selectedKeys={bottomItems.some((i) => location.pathname === i.key) ? [location.pathname] : []}
        items={bottomItems}
        onClick={({ key }) => navigate(key)}
        style={{ border: "none", flexShrink: 0 }}
      />
    </div>
  );
}
