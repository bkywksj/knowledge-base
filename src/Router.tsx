import { lazy, Suspense, type ReactNode } from "react";
import { createHashRouter, RouterProvider } from "react-router-dom";
import { Spin } from "antd";
import { LayoutSwitch } from "@/components/layout/LayoutSwitch";
import { RouteErrorFallback } from "@/components/ui/ErrorBoundary";
// 首屏三件套保持静态导入：启动直接落在这几页，懒加载反而多一次往返
import HomePage from "@/pages/home";
import NoteListPage from "@/pages/notes";
import NoteEditorPage from "@/pages/notes/editor";

// 其余页面按需加载：图谱（@antv/g6）、AI、设置、白板等都很重，
// 原先全部静态导入导致主包 5.7MB，冷启动要先解析完所有页面的代码。
// 独立窗口（快速记一笔 / 紧急提醒 / 推送弹窗 …）也只加载自己那一页，起得更快。
const SearchPage = lazy(() => import("@/pages/search"));
const TagsPage = lazy(() => import("@/pages/tags"));
const TrashPage = lazy(() => import("@/pages/trash"));
const DailyPage = lazy(() => import("@/pages/daily"));
const SettingsPage = lazy(() => import("@/pages/settings"));
const AboutPage = lazy(() => import("@/pages/about"));
const GraphPage = lazy(() => import("@/pages/graph"));
const AiChatPage = lazy(() => import("@/pages/ai"));
const MobileAiChat = lazy(() =>
  import("@/pages/ai/MobileAiChat").then((m) => ({ default: m.MobileAiChat })),
);
const MobileTaskDetail = lazy(() =>
  import("@/pages/tasks/MobileTaskDetail").then((m) => ({ default: m.MobileTaskDetail })),
);
const MobileSync = lazy(() =>
  import("@/pages/sync/MobileSync").then((m) => ({ default: m.MobileSync })),
);
const TasksPage = lazy(() => import("@/pages/tasks"));
const CardsPage = lazy(() => import("@/pages/cards"));
const PromptsPage = lazy(() => import("@/pages/prompts"));
const PushPage = lazy(() => import("@/pages/push"));
const HiddenPage = lazy(() => import("@/pages/hidden"));
const QuickCreatePage = lazy(() => import("@/pages/quick-create"));
const QuickCapturePage = lazy(() => import("@/pages/quick-capture"));
const QuickAddPage = lazy(() => import("@/pages/quick-add"));
const FeatureTogglePage = lazy(() => import("@/pages/feature-toggle"));
const MigrationSplash = lazy(() => import("@/pages/migration-splash"));
const EmergencyReminderPage = lazy(() => import("@/pages/emergency-reminder"));
const MindMapPopoutPage = lazy(() => import("@/pages/mindmap-popout"));
const WhiteboardPage = lazy(() => import("@/pages/whiteboard"));
const PushPopupPage = lazy(() => import("@/pages/push-popup"));

/**
 * 懒加载页面的 Suspense 包装。逐个路由包而不是在 RouterProvider 外包一层：
 * 外层包的话一 suspend 整个布局（侧栏 / 标签栏）都会被 fallback 替换掉而闪一下；
 * 包在路由元素上只影响内容区。站内跳转走 startTransition，通常会停在旧页直到新页就绪，
 * fallback 只在首次直达（如独立窗口启动）时短暂出现。
 */
function page(node: ReactNode) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full min-h-[200px] w-full items-center justify-center">
          <Spin />
        </div>
      }
    >
      {node}
    </Suspense>
  );
}

// 路由级 errorElement：路由内任何同步渲染异常（如 TipTap 在老 WebView 上
// 的 lookbehind 正则解析失败）都会被 RouteErrorFallback 接管，给用户友好
// 提示而非 react-router v7 默认的"Hey developer"开发警告页。
const router = createHashRouter([
  // T-013 完整版：迁移 splash 独立 URL，不走 AppLayout（启动期 db 还没初始化）
  {
    path: "/migration-splash",
    element: page(<MigrationSplash />),
    errorElement: <RouteErrorFallback />,
  },
  // 紧急待办接管窗口：独立 URL，不挂 AppLayout，避免 Sider/Header 跑出来
  {
    path: "/emergency-reminder/:id",
    element: page(<EmergencyReminderPage />),
    errorElement: <RouteErrorFallback />,
  },
  // 定时推送居中弹窗：独立 URL，不挂 AppLayout（由 popout_window.rs::open_push_popup 加载）
  {
    path: "/push-popup/:logId",
    element: page(<PushPopupPage />),
    errorElement: <RouteErrorFallback />,
  },
  // 思维导图独立弹窗：纯导图视图，不挂 AppLayout（由 popout_window.rs::open_mindmap 加载）
  {
    path: "/mindmap-popout/:noteId",
    element: page(<MindMapPopoutPage />),
    errorElement: <RouteErrorFallback />,
  },
  // 移动端 AI 聊天页：独立全屏路由（不走 MobileLayout / AppLayout），
  // 没有底部 Tab、没有蓝色 + FAB，输入栏紧贴屏幕底部
  {
    path: "/ai-chat/:id",
    element: page(<MobileAiChat />),
    errorElement: <RouteErrorFallback />,
  },
  // 闪念捕获：沉浸式橙色全屏，独立路由（不显示底栏）
  {
    path: "/quick-capture",
    element: page(<QuickCapturePage />),
    errorElement: <RouteErrorFallback />,
  },
  // 快速记一笔：独立悬浮窗（quick-add 窗口，全局快捷键唤起），不挂 AppLayout
  {
    path: "/quick-add",
    element: page(<QuickAddPage />),
    errorElement: <RouteErrorFallback />,
  },
  // 任务详情：沉浸式全屏，独立路由
  {
    path: "/task-detail/:id",
    element: page(<MobileTaskDetail />),
    errorElement: <RouteErrorFallback />,
  },
  // 移动端云端同步：沉浸式全屏（独立顶层路由）
  {
    path: "/sync",
    element: page(<MobileSync />),
    errorElement: <RouteErrorFallback />,
  },
  {
    path: "/",
    element: <LayoutSwitch />,
    errorElement: <RouteErrorFallback />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "notes", element: <NoteListPage /> },
      { path: "notes/:id", element: <NoteEditorPage /> },
      // 白板：本质也是一条笔记（note_type='whiteboard'），只是换成画布编辑器。
      // 走错路由时页面会自行重定向到对应的另一个编辑器。
      { path: "whiteboard/:id", element: page(<WhiteboardPage />) },
      { path: "search", element: page(<SearchPage />) },
      { path: "tags", element: page(<TagsPage />) },
      { path: "trash", element: page(<TrashPage />) },
      { path: "hidden", element: page(<HiddenPage />) },
      { path: "daily", element: page(<DailyPage />) },
      { path: "graph", element: page(<GraphPage />) },
      { path: "ai", element: page(<AiChatPage />) },
      { path: "prompts", element: page(<PromptsPage />) },
      { path: "push", element: page(<PushPage />) },
      { path: "tasks", element: page(<TasksPage />) },
      { path: "cards", element: page(<CardsPage />) },
      { path: "settings", element: page(<SettingsPage />) },
      { path: "about", element: page(<AboutPage />) },
      { path: "quick-create", element: page(<QuickCreatePage />) },
      { path: "feature-toggle", element: page(<FeatureTogglePage />) },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
