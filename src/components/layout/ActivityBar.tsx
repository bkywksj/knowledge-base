import { startTransition, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Tooltip, Badge, theme as antdTheme, message } from "antd";
import { hiddenPinApi } from "@/lib/api";
import { HiddenPinUnlockModal } from "@/components/hidden/HiddenPinUnlockModal";
import {
  Home,
  NotebookText,
  Search,
  Calendar,
  Tags,
  CheckSquare,
  GitBranch,
  Bot,
  Sparkles,
  Trash2,
  Info,
  EyeOff,
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

/**
 * 主视图按"用户意图"分四组，组与组之间渲染分隔线：
 *   1. 概览：首页（每次启动看一眼）
 *   2. 创作 / 工作流：笔记 / 每日笔记 / 待办（日常高频写入）
 *   3. 检索 / 发现：搜索 / 标签 / 知识图谱（找东西）
 *   4. AI 辅助：AI 问答 / 提示词（创作助手）
 *
 * 分组而非平铺的好处：用户扫一眼就能锁定意图所在区，比按使用频率排更省认知。
 */
const MAIN_GROUPS: ActivityItem[][] = [
  // 概览
  [{ view: "home", route: "/", label: "首页", icon: <Home size={18} /> }],
  // 创作 / 工作流
  [
    { view: "notes", route: "/notes", label: "笔记", icon: <NotebookText size={18} /> },
    { view: "daily", route: "/daily", label: "每日笔记", icon: <Calendar size={18} /> },
    { view: "tasks", route: "/tasks", label: "待办", icon: <CheckSquare size={18} /> },
  ],
  // 检索 / 发现
  [
    { view: "search", route: "/search", label: "搜索", icon: <Search size={18} /> },
    { view: "tags", route: "/tags", label: "标签", icon: <Tags size={18} /> },
    { view: "graph", route: "/graph", label: "知识图谱", icon: <GitBranch size={18} /> },
  ],
  // AI 辅助
  [
    { view: "ai", route: "/ai", label: "AI 问答", icon: <Bot size={18} /> },
    { view: "prompts", route: "/prompts", label: "提示词", icon: <Sparkles size={18} /> },
  ],
];

/** 底部视图（放最下方，视觉上与主视图分组） */
const BOTTOM_ITEMS: ActivityItem[] = [
  { view: "hidden", route: "/hidden", label: "隐藏笔记", icon: <EyeOff size={18} /> },
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
  ["/hidden", "hidden"],
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
  const refreshTaskStats = useAppStore((s) => s.refreshTaskStats);
  const isHiddenUnlocked = useAppStore((s) => s.isHiddenUnlocked);
  const [unlockOpen, setUnlockOpen] = useState(false);

  // 启动时拉一次紧急任务数，让待办 Badge 在进应用时就显示正确数字
  // （之后由任务页/各操作主动调 refreshTaskStats 维持新鲜）
  useEffect(() => {
    refreshTaskStats();
  }, [refreshTaskStats]);

  // 以 URL 为准反推当前高亮（避免 store.activeView 与 URL 漂移时 UI 不一致）
  const highlightView: ActiveView | null = useMemo(
    () => deriveActiveViewFromPath(location.pathname) ?? activeView,
    [location.pathname, activeView],
  );

  /** 实际跳转视图（被 handleClick 与 PIN 解锁回调共用）
   *
   * 用 startTransition 把"切视图 + 路由跳转 + 展开面板"标记为低优先级，
   * 让点击事件本身能立即响应（按钮即时高亮），子树重渲染在下一帧再做。
   * 对"点笔记 → 侧边栏弹出"这种带较重子树的场景体感优化最明显。
   */
  function navigateToView(item: ActivityItem) {
    startTransition(() => {
      setActiveView(item.view);
      if (!sidePanelVisible) setSidePanelVisible(true);
      navigate(item.route);
    });
  }

  function handleClick(item: ActivityItem) {
    // VS Code 行为：点当前已高亮的图标 = 翻转 SidePanel 可见性
    // 注意：必须用 URL 真相判断"是否在该视图"，而非 highlightView。
    // highlightView 在无匹配路由时（如 /settings）会回退到 store.activeView，
    // 此时点 ActivityBar 项会被误判成"点当前视图 → 仅折叠面板"，导致无法跳转。
    const onThisView = deriveActiveViewFromPath(location.pathname) === item.view;
    if (onThisView) {
      toggleSidePanel();
      return;
    }

    // 隐藏笔记 PIN 拦截：已设过 PIN 且会话未解锁 → 弹解锁框
    if (item.view === "hidden" && !isHiddenUnlocked()) {
      void (async () => {
        try {
          if (await hiddenPinApi.isSet()) {
            setUnlockOpen(true);
            return;
          }
          navigateToView(item);
        } catch (e) {
          // 后端故障时不锁死入口
          console.warn("[hidden-pin] isSet 查询失败:", e);
          message.warning("PIN 状态查询失败，已跳过验证");
          navigateToView(item);
        }
      })();
      return;
    }

    navigateToView(item);
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
      <Tooltip key={item.view} title={item.label} placement="right" mouseEnterDelay={0.15}>
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
        // 必须撑满 Sider 高度，否则下方 flex:1 spacer 没有空间，
        // 底部三项（隐藏笔记 / 回收站 / 关于）会贴在主组按钮后面而不是钉在左下角
        height: "100%",
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
      {MAIN_GROUPS.flat().map(renderItem)}
      <div style={{ flex: 1 }} />
      {BOTTOM_ITEMS.map(renderItem)}
      <HiddenPinUnlockModal
        open={unlockOpen}
        onSuccess={() => {
          setUnlockOpen(false);
          const hiddenItem = BOTTOM_ITEMS.find((i) => i.view === "hidden");
          if (hiddenItem) navigateToView(hiddenItem);
        }}
        onCancel={() => setUnlockOpen(false)}
      />
    </nav>
  );
}
