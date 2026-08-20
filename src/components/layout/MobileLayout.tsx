import { useEffect } from "react";
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
  activeColor?: "primary" | "accent";
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
    activeColor: meta.activeColor,
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

/** 自带 FAB 的页面（路由前缀） — 这些页面下不渲染全局蓝色 + FAB，避免重叠 */
const PAGES_WITH_OWN_FAB = ["/ai", "/tasks"];

export function MobileLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const sizeClass = useWindowSizeClass();
  /** ≥600dp 走侧边 Rail；手机维持底部 Tab */
  const isRail = sizeClass !== "compact";
  const hasOwnFab = PAGES_WITH_OWN_FAB.some(
    (p) => location.pathname === p || location.pathname.startsWith(`${p}/`),
  );

  // 用户配置的前 4 格 Tab + 固定「我的」第 5 格
  const tabKeys = useAppStore((s) => s.mobileTabKeys);
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

  return (
    <div
      className={`flex h-screen w-screen overflow-hidden bg-slate-50 ${
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

        {/* 浮动 FAB（右下，悬浮在 Tab 上方）— Rail 模式下改由 Rail 顶部渲染 */}
        {!hasOwnFab && !isRail && (
          <button
            aria-label="新建"
            onClick={() => navigate("/quick-create")}
            className="fixed right-5 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-[#1677FF] text-white shadow-[0_8px_24px_rgba(22,119,255,0.4)] active:scale-95 transition-transform"
            style={{
              bottom: `calc(64px + env(safe-area-inset-bottom, 0px) + 16px)`,
            }}
          >
            <Plus size={28} strokeWidth={2.5} />
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
            ? "order-first flex w-20 shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-white"
            : "border-t border-slate-200 bg-white"
        }
        style={
          isRail
            ? { paddingLeft: "env(safe-area-inset-left, 0px)" }
            : { paddingBottom: "env(safe-area-inset-bottom, 0px)" }
        }
      >
        {/* Rail 顶部 FAB：大屏上底部右角离视线和手指都太远 */}
        {isRail && !hasOwnFab && (
          <button
            aria-label="新建"
            onClick={() => navigate("/quick-create")}
            className="mx-auto mt-3 mb-2 flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#1677FF] text-white shadow-[0_6px_16px_rgba(22,119,255,0.35)] active:scale-95 transition-transform"
          >
            <Plus size={24} strokeWidth={2.5} />
          </button>
        )}

        <div
          className={
            isRail
              ? "flex flex-col items-stretch gap-1 px-1.5 pb-3"
              : "flex h-16 items-stretch"
          }
        >
          {TABS.map((tab) => {
            const active = isTabActive(tab, location.pathname);
            const Icon = tab.icon;
            const activeColor =
              tab.activeColor === "accent" ? "#FA8C16" : "#1677FF";
            return (
              <button
                key={tab.key}
                onClick={() => navigate(tab.path)}
                className={
                  isRail
                    ? `flex flex-col items-center justify-center gap-1 rounded-2xl py-2.5 active:bg-slate-100 ${
                        active ? "bg-slate-100" : ""
                      }`
                    : "flex flex-1 flex-col items-center justify-center gap-0.5 py-1 active:bg-slate-100"
                }
                style={{
                  color: active ? activeColor : "#94A3B8",
                  minHeight: 44,
                }}
              >
                <Icon size={22} strokeWidth={active ? 2.5 : 2} />
                <span
                  className={
                    isRail
                      ? "text-[11px] leading-tight"
                      : "text-[10px] leading-tight"
                  }
                  style={{ fontWeight: active ? 600 : 400 }}
                >
                  {tab.label}
                </span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
