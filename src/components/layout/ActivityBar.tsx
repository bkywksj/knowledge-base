import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Tooltip, Badge, theme as antdTheme } from "antd";
import {
  Home,
  FileText,
  Search,
  Calendar,
  Tags,
  CheckSquare,
  GitBranch,
  Bot,
  Sparkles,
  Trash2,
  Info,
} from "lucide-react";
import { useAppStore } from "@/store";
import type { ActiveView } from "@/store";

/**
 * ActivityBar —— 方案 C 侧边栏的左侧 48px 窄图标栏。
 *
 * 职责：
 *   · 切换活动视图（activeView）
 *   · 同步跳转路由
 *   · 点击当前已高亮的图标 = 折叠/展开右侧 SidePanel（VS Code 行为）
 *
 * 非职责：
 *   · 不渲染任何视图内容（由 SidePanel 按 activeView 分发）
 *   · 不感知文件夹 / 标签 / 待办的业务数据
 */

interface ActivityItem {
  view: ActiveView;
  route: string;
  label: string;
  icon: React.ReactNode;
}

/** 主视图（上半部分） */
const MAIN_ITEMS: ActivityItem[] = [
  { view: "home", route: "/", label: "首页", icon: <Home size={18} /> },
  { view: "notes", route: "/notes", label: "笔记", icon: <FileText size={18} /> },
  { view: "search", route: "/search", label: "搜索", icon: <Search size={18} /> },
  { view: "daily", route: "/daily", label: "每日笔记", icon: <Calendar size={18} /> },
  { view: "tags", route: "/tags", label: "标签", icon: <Tags size={18} /> },
  { view: "tasks", route: "/tasks", label: "待办", icon: <CheckSquare size={18} /> },
  { view: "graph", route: "/graph", label: "知识图谱", icon: <GitBranch size={18} /> },
  { view: "ai", route: "/ai", label: "AI 问答", icon: <Bot size={18} /> },
  { view: "prompts", route: "/prompts", label: "提示词", icon: <Sparkles size={18} /> },
];

/** 底部视图（放最下方，视觉上与主视图分组） */
const BOTTOM_ITEMS: ActivityItem[] = [
  { view: "trash", route: "/trash", label: "回收站", icon: <Trash2 size={18} /> },
  { view: "about", route: "/about", label: "关于", icon: <Info size={18} /> },
];

/** 路由 → ActiveView 的反查映射（用于根据 URL 推导高亮态） */
const ROUTE_TO_VIEW: Array<[string, ActiveView]> = [
  ["/notes", "notes"],
  ["/search", "search"],
  ["/daily", "daily"],
  ["/tags", "tags"],
  ["/tasks", "tasks"],
  ["/graph", "graph"],
  ["/ai", "ai"],
  ["/prompts", "prompts"],
  ["/trash", "trash"],
  ["/about", "about"],
  ["/", "home"], // 放最后：以 startsWith 匹配时 "/" 会错匹所有路径
];

export function deriveActiveViewFromPath(pathname: string): ActiveView | null {
  // 先精确匹配非根路径，根路径单独处理
  for (const [prefix, view] of ROUTE_TO_VIEW) {
    if (prefix === "/") continue;
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return view;
  }
  if (pathname === "/") return "home";
  return null;
}

export function ActivityBar() {
  const { token } = antdTheme.useToken();
  const navigate = useNavigate();
  const location = useLocation();
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const sidePanelVisible = useAppStore((s) => s.sidePanelVisible);
  const setSidePanelVisible = useAppStore((s) => s.setSidePanelVisible);
  const toggleSidePanel = useAppStore((s) => s.toggleSidePanel);
  const urgentTodoCount = useAppStore((s) => s.urgentTodoCount);

  // 以 URL 为准反推当前高亮（避免 store.activeView 与 URL 漂移时 UI 不一致）
  const highlightView: ActiveView | null = useMemo(
    () => deriveActiveViewFromPath(location.pathname) ?? activeView,
    [location.pathname, activeView],
  );

  function handleClick(item: ActivityItem) {
    // VS Code 行为：点当前已高亮的图标 = 翻转 SidePanel 可见性
    if (highlightView === item.view) {
      toggleSidePanel();
      return;
    }
    // 切换到新视图：更新 store + 跳转路由；若面板之前被折叠，自动展开
    setActiveView(item.view);
    if (!sidePanelVisible) setSidePanelVisible(true);
    navigate(item.route);
  }

  function renderItem(item: ActivityItem) {
    const isActive = highlightView === item.view;
    const iconNode =
      item.view === "tasks" ? (
        <Badge
          count={urgentTodoCount}
          size="small"
          offset={[2, -2]}
          overflowCount={99}
        >
          {item.icon}
        </Badge>
      ) : (
        item.icon
      );

    return (
      <Tooltip key={item.view} title={item.label} placement="right" mouseEnterDelay={0.35}>
        <button
          type="button"
          onClick={() => handleClick(item)}
          aria-label={item.label}
          aria-current={isActive ? "page" : undefined}
          className="activity-item"
          data-active={isActive || undefined}
          style={{
            width: 40,
            height: 40,
            borderRadius: 8,
            border: "none",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: isActive ? `${token.colorPrimary}14` : "transparent",
            color: isActive ? token.colorPrimary : token.colorTextSecondary,
            position: "relative",
            transition: "background .15s, color .15s",
          }}
        >
          {iconNode}
          {isActive && (
            <span
              aria-hidden
              style={{
                position: "absolute",
                left: -6,
                top: 8,
                bottom: 8,
                width: 2,
                borderRadius: 2,
                background: token.colorPrimary,
              }}
            />
          )}
        </button>
      </Tooltip>
    );
  }

  return (
    <nav
      aria-label="视图切换"
      className="activity-bar"
      style={{
        width: 48,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        paddingTop: 8,
        paddingBottom: 8,
        gap: 2,
        background: token.colorBgContainer,
        borderRight: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      {MAIN_ITEMS.map(renderItem)}
      <div style={{ flex: 1 }} />
      {BOTTOM_ITEMS.map(renderItem)}
    </nav>
  );
}
