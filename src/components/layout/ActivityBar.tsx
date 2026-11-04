import { cloneElement, Fragment, isValidElement, startTransition, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Tooltip, Badge, theme as antdTheme, message } from "antd";
import { hiddenPinApi } from "@/lib/api";
import { isNoActivityPath } from "@/lib/noteWorkspaceRoute";
import { HiddenPinUnlockModal } from "@/components/hidden/HiddenPinUnlockModal";
import {
  RailBell,
  RailBot,
  RailCalendar,
  RailCards,
  RailCheck,
  RailEyeOff,
  RailGraph,
  RailHome,
  RailInfo,
  RailLock,
  RailNote,
  RailSearch,
  RailSpark,
  RailTag,
  RailTrash,
} from "./railIcons";
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

/**
 * 活动栏宽度：显示文字标签时 64，纯图标时 48。
 *
 * 🔴 AppLayout 布局计算（Sider 宽度 / 主区左偏移 / 自动隐藏时的位移）必须用
 * 同一份数值，否则纯图标模式下会留出 16px 空白或者盖住内容。用
 * {@link activityBarWidth} 统一取值，不要在任何一侧再写死数字。
 */
export const ACTIVITY_BAR_WIDTH_WITH_LABELS = 64;
export const ACTIVITY_BAR_WIDTH_ICON_ONLY = 48;

export function activityBarWidth(showLabels: boolean): number {
  return showLabels
    ? ACTIVITY_BAR_WIDTH_WITH_LABELS
    : ACTIVITY_BAR_WIDTH_ICON_ONLY;
}

interface ActivityItem {
  view: ActiveView;
  route: string;
  /** 完整名：悬停提示、aria-label、功能模块开关等处用 */
  label: string;
  /** 活动栏上显示的短名（原型 .ra span）：栏宽 52，「卡片复习」这类四字名会挤满。缺省用 label */
  short?: string;
  icon: React.ReactNode;
  /**
   * 核心视图：永远显示，不受用户"功能模块"开关影响。
   * 关闭笔记/搜索/回收站等核心入口会让应用变残废，所以不允许关。
   */
  core?: boolean;
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
  [{ view: "home", route: "/", label: "首页", icon: <RailHome />, core: true }],
  // 创作 / 工作流
  [
    { view: "notes", route: "/notes", label: "笔记", icon: <RailNote />, core: true },
    { view: "daily", route: "/daily", label: "日记", icon: <RailCalendar /> },
    { view: "tasks", route: "/tasks", label: "待办", icon: <RailCheck /> },
    { view: "cards", route: "/cards", label: "卡片复习", short: "复习", icon: <RailCards /> },
  ],
  // 检索 / 发现
  [
    { view: "search", route: "/search", label: "搜索", icon: <RailSearch />, core: true },
    { view: "tags", route: "/tags", label: "标签", icon: <RailTag /> },
    { view: "graph", route: "/graph", label: "知识图谱", short: "图谱", icon: <RailGraph /> },
  ],
  // AI 辅助
  [
    { view: "ai", route: "/ai", label: "AI 问答", short: "AI", icon: <RailBot /> },
    { view: "prompts", route: "/prompts", label: "提示词", icon: <RailSpark /> },
    { view: "push", route: "/push", label: "定时推送", short: "推送", icon: <RailBell /> },
  ],
];

/** 底部视图（放最下方，视觉上与主视图分组） */
const BOTTOM_ITEMS: ActivityItem[] = [
  { view: "hidden", route: "/hidden", label: "隐藏笔记", short: "隐藏", icon: <RailEyeOff /> },
  { view: "trash", route: "/trash", label: "回收站", icon: <RailTrash />, core: true },
  { view: "about", route: "/about", label: "关于", icon: <RailInfo />, core: true },
];

/** 路由 → ActiveView 的反查映射（用于根据 URL 推导高亮态） */
const ROUTE_TO_VIEW: Array<[string, ActiveView]> = [
  ["/notes", "notes"],
  // 白板本质是 note_type=whiteboard 的笔记：高亮「笔记」、侧栏显示笔记面板（v4 原型）。
  // 之前没登记，落到末尾的 "/" 兜底，白板页反而高亮「首页」
  ["/whiteboard", "notes"],
  ["/search", "search"],
  ["/daily", "daily"],
  ["/tags", "tags"],
  ["/tasks", "tasks"],
  ["/cards", "cards"],
  ["/graph", "graph"],
  ["/ai", "ai"],
  ["/prompts", "prompts"],
  ["/push", "push"],
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
  const enabledViews = useAppStore((s) => s.enabledViews);
  const appLockEnabled = useAppStore((s) => s.appLockEnabled);
  const lockAppNow = useAppStore((s) => s.lockAppNow);
  const showLabels = useAppStore((s) => s.activityBarShowLabels);
  const [unlockOpen, setUnlockOpen] = useState(false);

  /** 是否显示某项：核心永远显示；可选项看用户是否在设置里启用 */
  const isVisible = (item: ActivityItem) =>
    item.core || enabledViews.has(item.view);

  // 启动时拉一次紧急任务数，让待办 Badge 在进应用时就显示正确数字
  // （之后由任务页/各操作主动调 refreshTaskStats 维持新鲜）
  useEffect(() => {
    refreshTaskStats();
  }, [refreshTaskStats]);

  // 以 URL 为准反推当前高亮（避免 store.activeView 与 URL 漂移时 UI 不一致）
  const highlightView: ActiveView | null = useMemo(
    () =>
      isNoActivityPath(location.pathname)
        ? null
        : (deriveActiveViewFromPath(location.pathname) ?? activeView),
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
    // 图标颜色：直接通过 prop 注入 lucide 组件，绕开 CSS 继承链。
    // 之前用 <span style="color: inherit"> 桥接 button → svg currentColor 的方案在 antd
    // Badge wrapper 下失效——ant-badge-children 在某些版本会截断 color 继承，导致点"待办"
    // 时图标 stroke 不变色。改用 cloneElement 把 color 显式 prop 注入 lucide CheckSquare，
    // svg stroke 由 prop 直接决定，不再依赖任何祖先 wrapper 的 color 继承行为。
    // （悬停加深由 global.css 的 .activity-item:hover svg 覆盖 stroke 完成，同样不依赖继承）
    const iconColor = isActive ? token.colorPrimary : "var(--kb-rail-ink)";
    const coloredIcon = isValidElement(item.icon)
      ? cloneElement(
          item.icon as React.ReactElement<{ color?: string }>,
          { color: iconColor },
        )
      : item.icon;
    // 待办挂角标："该做的事"属于不主动看就会忘的东西
    const badgeCount = item.view === "tasks" ? urgentTodoCount : 0;
    const iconNode =
      badgeCount > 0 ? (
        <Badge
          count={badgeCount}
          size="small"
          offset={[2, -2]}
          overflowCount={99}
          className="kb-rail-badge"
        >
          {coloredIcon}
        </Badge>
      ) : (
        coloredIcon
      );

    // v4 样式（原型 .ra）：选中 = 白底 / 抬升底 + 主色细描边 + 主色加粗字，不再用左侧竖条；
    // 尺寸与纯图标模式的差异都在 global.css 的 .activity-item / .activity-bar.icon-only 里
    return (
      <Tooltip key={item.view} title={item.label} placement="right" mouseEnterDelay={0.15}>
        <button
          type="button"
          onClick={() => handleClick(item)}
          aria-label={item.label}
          aria-current={isActive ? "page" : undefined}
          className="activity-item"
          data-active={isActive || undefined}
        >
          {iconNode}
          {/* 纯图标模式下不渲染文字：可发现性由外层的 Tooltip 兜底（悬停仍显示名称），
              aria-label 也已在 button 上，无障碍不受影响。 */}
          {showLabels && <span className="activity-label">{item.short ?? item.label}</span>}
        </button>
      </Tooltip>
    );
  }

  // 各组只留启用的项；整组都被功能开关关掉时连同分隔线一起不渲染，避免出现两条线挨着
  const visibleGroups = MAIN_GROUPS.map((g) => g.filter(isVisible)).filter((g) => g.length > 0);

  return (
    <nav
      aria-label="视图切换"
      className={showLabels ? "activity-bar" : "activity-bar icon-only"}
      style={{ width: activityBarWidth(showLabels) }}
    >
      {visibleGroups.map((group, i) => (
        <Fragment key={group[0].view}>
          {i > 0 && <span className="activity-sep" aria-hidden />}
          {group.map(renderItem)}
        </Fragment>
      ))}
      <div style={{ flex: 1 }} />
      {/* 立即锁定：仅在已启用应用锁时显示，点一下回到锁屏（临时离开座位用） */}
      {appLockEnabled && (
        <Tooltip title="立即锁定" placement="right" mouseEnterDelay={0.15}>
          <button
            type="button"
            onClick={lockAppNow}
            aria-label="立即锁定"
            className="activity-item"
          >
            <RailLock color="var(--kb-rail-ink)" />
            {showLabels && <span className="activity-label">锁定</span>}
          </button>
        </Tooltip>
      )}
      {BOTTOM_ITEMS.filter(isVisible).map(renderItem)}
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
