import { createHashRouter, RouterProvider } from "react-router-dom";
import { LayoutSwitch } from "@/components/layout/LayoutSwitch";
import { RouteErrorFallback } from "@/components/ui/ErrorBoundary";
import HomePage from "@/pages/home";
import NoteListPage from "@/pages/notes";
import NoteEditorPage from "@/pages/notes/editor";
import SearchPage from "@/pages/search";
import TagsPage from "@/pages/tags";
import TrashPage from "@/pages/trash";
import DailyPage from "@/pages/daily";
import SettingsPage from "@/pages/settings";
import AboutPage from "@/pages/about";
import GraphPage from "@/pages/graph";
import AiChatPage from "@/pages/ai";
import { MobileAiChat } from "@/pages/ai/MobileAiChat";
import { MobileTaskDetail } from "@/pages/tasks/MobileTaskDetail";
import { MobileSync } from "@/pages/sync/MobileSync";
import TasksPage from "@/pages/tasks";
import CardsPage from "@/pages/cards";
import PromptsPage from "@/pages/prompts";
import PushPage from "@/pages/push";
import HiddenPage from "@/pages/hidden";
import QuickCreatePage from "@/pages/quick-create";
import QuickCapturePage from "@/pages/quick-capture";
import QuickAddPage from "@/pages/quick-add";
import FeatureTogglePage from "@/pages/feature-toggle";
import MigrationSplash from "@/pages/migration-splash";
import EmergencyReminderPage from "@/pages/emergency-reminder";
import MindMapPopoutPage from "@/pages/mindmap-popout";
import PushPopupPage from "@/pages/push-popup";

// 路由级 errorElement：路由内任何同步渲染异常（如 TipTap 在老 WebView 上
// 的 lookbehind 正则解析失败）都会被 RouteErrorFallback 接管，给用户友好
// 提示而非 react-router v7 默认的"Hey developer"开发警告页。
const router = createHashRouter([
  // T-013 完整版：迁移 splash 独立 URL，不走 AppLayout（启动期 db 还没初始化）
  {
    path: "/migration-splash",
    element: <MigrationSplash />,
    errorElement: <RouteErrorFallback />,
  },
  // 紧急待办接管窗口：独立 URL，不挂 AppLayout，避免 Sider/Header 跑出来
  {
    path: "/emergency-reminder/:id",
    element: <EmergencyReminderPage />,
    errorElement: <RouteErrorFallback />,
  },
  // 定时推送居中弹窗：独立 URL，不挂 AppLayout（由 popout_window.rs::open_push_popup 加载）
  {
    path: "/push-popup/:logId",
    element: <PushPopupPage />,
    errorElement: <RouteErrorFallback />,
  },
  // 思维导图独立弹窗：纯导图视图，不挂 AppLayout（由 popout_window.rs::open_mindmap 加载）
  {
    path: "/mindmap-popout/:noteId",
    element: <MindMapPopoutPage />,
    errorElement: <RouteErrorFallback />,
  },
  // 移动端 AI 聊天页：独立全屏路由（不走 MobileLayout / AppLayout），
  // 没有底部 Tab、没有蓝色 + FAB，输入栏紧贴屏幕底部
  {
    path: "/ai-chat/:id",
    element: <MobileAiChat />,
    errorElement: <RouteErrorFallback />,
  },
  // 闪念捕获：沉浸式橙色全屏，独立路由（不显示底栏）
  {
    path: "/quick-capture",
    element: <QuickCapturePage />,
    errorElement: <RouteErrorFallback />,
  },
  // 快速记一笔：独立悬浮窗（quick-add 窗口，全局快捷键唤起），不挂 AppLayout
  {
    path: "/quick-add",
    element: <QuickAddPage />,
    errorElement: <RouteErrorFallback />,
  },
  // 任务详情：沉浸式全屏，独立路由
  {
    path: "/task-detail/:id",
    element: <MobileTaskDetail />,
    errorElement: <RouteErrorFallback />,
  },
  // 移动端云端同步：沉浸式全屏（独立顶层路由）
  {
    path: "/sync",
    element: <MobileSync />,
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
      { path: "search", element: <SearchPage /> },
      { path: "tags", element: <TagsPage /> },
      { path: "trash", element: <TrashPage /> },
      { path: "hidden", element: <HiddenPage /> },
      { path: "daily", element: <DailyPage /> },
      { path: "graph", element: <GraphPage /> },
      { path: "ai", element: <AiChatPage /> },
      { path: "prompts", element: <PromptsPage /> },
      { path: "push", element: <PushPage /> },
      { path: "tasks", element: <TasksPage /> },
      { path: "cards", element: <CardsPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "about", element: <AboutPage /> },
      { path: "quick-create", element: <QuickCreatePage /> },
      { path: "feature-toggle", element: <FeatureTogglePage /> },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
