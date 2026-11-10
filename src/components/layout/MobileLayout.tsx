import { useEffect, useState } from "react";
import { Outlet, useNavigate, useLocation } from "react-router-dom";
import {
  Home,
  FileText,
  Sparkles,
  CheckSquare,
  User,
  Plus,
  CalendarDays,
  Tag,
  Layers,
  MessageSquareText,
  EyeOff,
  GitFork,
  Search,
  Trash2,
} from "lucide-react";
import {
  MOBILE_TAB_REGISTRY,
  type MobileTabKey,
  type MobileTabMeta,
} from "@/lib/mobileTabRegistry";
import { useWindowSizeClass } from "@/hooks/useWindowSizeClass";
import { useAppStore } from "@/store";
import { QuickCreateSheet } from "@/components/mobile/QuickCreate";

/**
 * 移动端主布局。设计稿位于 output/UI原型/2026-05-04_知识库移动端App/。
 *
 * - 顶部：让出 Android 状态栏（safe-area-inset-top），由系统控制状态栏样式
 * - 中间：全屏 Outlet 容器，可滚动；overflow-y-auto 让长页面（笔记列表）能滑
 * - 导航：随 useWindowSizeClass 切形态
 *   - compact（手机 < 600dp）：底部 5 格 Tab + 右下浮动 FAB
 *   - medium / expanded（平板 / 折叠屏展开 / DeX / WSA 大窗口）：左侧 NavigationRail
 *     + Rail 顶部 FAB。大屏上底部 Tab 会离拇指极远、且横向空间全浪费，Material 3
 *     的标准解法就是 ≥600dp 换 Rail。
 *   - Tab 高亮规则：当前路由匹配 Tab 路径前缀（笔记列表/编辑都高亮"笔记"）
 *   - FAB 全局指向 /quick-create（暂未实现 → 跳到 /notes 让用户用右上 + 新建）
 *
 * 🔴 两种形态刻意共用同一棵 DOM 树（靠 order / flex-direction 切换，nav 始终排在 main
 * 之后），这样平板旋转、折叠屏展开时 <Outlet /> 不会 remount —— 否则页面会重新拉一遍
 * 数据、丢掉滚动位置和编辑器未保存状态。
 *
 * 与桌面 AppLayout 完全隔离：移动端不渲染 ActivityBar / SidePanel / WindowControls，
 * 因为这些是桌面专属（多窗口 / 标签页 / 系统控制按钮等）。
 */

interface TabItem {
  key: string;
  path: string;
  icon: typeof Home;
  label: string;
  matchPrefixes: string[];
}

/** 把 registry 里的 icon key 翻译成 Lucide 组件 */
const ICON_MAP: Record<MobileTabKey, typeof Home> = {
  home: Home,
  notes: FileText,
  ai: Sparkles,
  tasks: CheckSquare,
  daily: CalendarDays,
  tags: Tag,
  cards: Layers,
  prompts: MessageSquareText,
  hidden: EyeOff,
  graph: GitFork,
  search: Search,
  trash: Trash2,
};

function metaToTabItem(meta: MobileTabMeta): TabItem {
  return {
    key: meta.key,
    path: meta.path,
    icon: ICON_MAP[meta.key],
    label: meta.label,
    matchPrefixes: meta.matchPrefixes,
  };
}

/** 「我的」固定为最后一格 */
const ME_TAB: TabItem = {
  key: "me",
  path: "/settings",
  icon: User,
  label: "我的",
  matchPrefixes: ["/settings", "/about", "/feature-toggle"],
};

function isTabActive(item: TabItem, pathname: string): boolean {
  // "/" 单独判（其它前缀都以 "/" 开头会误命中）
  if (item.path === "/") return pathname === "/";
  return item.matchPrefixes.some(
    (p) => p !== "/" && (pathname === p || pathname.startsWith(`${p}/`)),
  );
}

/** 自带 FAB 的页面（路由前缀） — 这些页面下不渲染全局 + FAB，避免重叠 */
const PAGES_WITH_OWN_FAB = ["/ai", "/tasks"];

/**
 * 不放全局 FAB 的页面（精确匹配）：
 * - 首页：金刚区第一格就是「新建笔记」，FAB 重复且会压住待办行尾的时间
 * - 笔记列表：新建按钮在顶栏右侧；列表摘要会伸到右下角，FAB 会压住内容
 * Rail 形态的「新建」在侧边栏里、不压内容，照常显示。
 */
const PAGES_WITHOUT_FAB = ["/", "/notes"];

export function MobileLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const sizeClass = useWindowSizeClass();
  /** ≥600dp 走侧边 Rail；手机维持底部 Tab */
  const isRail = sizeClass !== "compact";
  const hasOwnFab = PAGES_WITH_OWN_FAB.some(
    (p) => location.pathname === p || location.pathname.startsWith(`${p}/`),
  );
  const hideCompactFab = hasOwnFab || PAGES_WITHOUT_FAB.includes(location.pathname);
  /** 待办 Tab 角标：紧急待办数，与 PC 活动栏同一个数据源（App 启动时刷新） */
  const urgentTodoCount = useAppStore((s) => s.urgentTodoCount);
  /** FAB 点开的「新建」面板：在当前页上弹出，不再跳 /quick-create 整页 */
  const [createOpen, setCreateOpen] = useState(false);

  // 用户配置的前 4 格 Tab + 固定「我的」第 5 格
  const tabKeys = useAppStore((s) => s.mobileTabKeys);
  const checkMobileUpdateSilently = useAppStore((s) => s.checkMobileUpdateSilently);
  /** 有新版时给「我的」Tab 打个小红点（更新入口在「我的 → 检查更新」） */
  const hasUpdate = useAppStore((s) => s.mobileUpdateAvailable !== null);
  const TABS: TabItem[] = [
    ...tabKeys.map((k) => metaToTabItem(MOBILE_TAB_REGISTRY[k])),
    ME_TAB,
  ];

  // Android 物理返回键 / 手势：让 history back 优先（路由内导航），
  // 而不是让 WebView 直接关闭应用。
  useEffect(() => {
    function onPopState() {
      // React Router 自己处理；这里仅占位，未来需要拦截"已在根路由还按返回"时退出 app 可在此扩展
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // 启动静默检查更新：延迟 8 秒避开首屏数据加载高峰（首屏要拉笔记/任务/统计，
  // 再插一个网络请求会拖慢冷启动观感）。失败完全静默，见 store 里的实现。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void checkMobileUpdateSilently();
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [checkMobileUpdateSilently]);

  return (
    <div
      className={`m-page flex h-screen w-screen overflow-hidden ${
        isRail ? "flex-row" : "flex-col"
      }`}
      // Android 状态栏让出 padding（系统会在这块绘制信号/电量）。
      // box-border 下 h-screen 自动扣掉这段，不会溢出。
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      {/* 主内容：可滚动 */}
      <main className="relative flex-1 overflow-y-auto overflow-x-hidden">
        {/*
          Rail 模式给内容一个 1100px 上限并居中：尚未做大屏适配的页面（笔记列表等）
          在 1900px 宽窗口里会被拉成一行几个字的长条，限宽后至少可读。
          compact 保持 pb-20 给底部 Tab + FAB 让位。
        */}
        <div
          className={
            isRail
              ? "mx-auto min-h-full w-full max-w-[1100px] pb-6"
              : "min-h-full pb-20"
          }
        >
          <Outlet />
        </div>

        {/* 浮动 FAB（右下，悬浮在 Tab 上方，无阴影）— Rail 模式下改由 Rail 顶部渲染 */}
        {!hideCompactFab && !isRail && (
          <button
            aria-label="新建"
            onClick={() => setCreateOpen(true)}
            className="m-fab transition-transform"
            style={{
              bottom: `calc(56px + env(safe-area-inset-bottom, 0px) + 16px)`,
            }}
          >
            <Plus size={26} strokeWidth={2.4} />
          </button>
        )}
      </main>

      {/*
        导航：DOM 里恒排在 main 之后，Rail 模式靠 order-first 挪到左侧，
        避免切换形态时整棵子树重建（见文件头注释）。
      */}
      <nav
        className={
          isRail
            ? "m-tabbar order-first flex w-20 shrink-0 flex-col overflow-y-auto"
            : "m-tabbar"
        }
        style={
          isRail
            ? {
                paddingLeft: "env(safe-area-inset-left, 0px)",
                borderTop: "none",
                borderRight: "0.5px solid var(--m-hair)",
              }
            : { paddingBottom: "env(safe-area-inset-bottom, 0px)" }
        }
      >
        {/* Rail 顶部「新建」：大屏上底部右角离视线和手指都太远（无阴影） */}
        {isRail && !hasOwnFab && (
          <button
            aria-label="新建"
            onClick={() => setCreateOpen(true)}
            className="m-icon-btn is-primary mx-auto mt-3 mb-2 h-12 w-12 transition-transform active:scale-95"
          >
            <Plus size={24} strokeWidth={2.4} />
          </button>
        )}

        <div
          className={
            isRail
              ? "flex flex-col items-stretch gap-1 px-1.5 pb-3"
              : "flex items-stretch"
          }
        >
          {TABS.map((tab) => {
            const active = isTabActive(tab, location.pathname);
            const Icon = tab.icon;
            const badge = tab.key === "tasks" ? urgentTodoCount : 0;
            return (
              <button
                key={tab.key}
                onClick={() => navigate(tab.path)}
                className={`m-tab ${active ? "is-on" : ""} ${isRail ? "rounded-[var(--m-r-l)] py-2.5" : ""}`}
                style={isRail && active ? { background: "var(--m-accent-soft)" } : undefined}
              >
                {/* 图标外包一层 relative，好让角标 / 更新红点绝对定位到右上角 */}
                <span className="relative inline-flex">
                  <Icon size={22} strokeWidth={active ? 2.2 : 1.8} />
                  {badge > 0 && (
                    <span className="m-badge m-num" aria-label={`${badge} 条紧急待办`}>
                      {badge > 99 ? "99+" : badge}
                    </span>
                  )}
                  {tab.key === "me" && hasUpdate && (
                    <span
                      aria-label="有新版本"
                      className="m-dot absolute -right-1 top-0"
                      style={{
                        width: 7,
                        height: 7,
                        background: "var(--m-badge-bg)",
                        boxShadow: "0 0 0 2px var(--m-surface)",
                      }}
                    />
                  )}
                </span>
                <span className="leading-tight">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      <QuickCreateSheet open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}
