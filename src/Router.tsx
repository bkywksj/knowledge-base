import { createHashRouter, RouterProvider } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
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
import TasksPage from "@/pages/tasks";
import CardsPage from "@/pages/cards";
import PromptsPage from "@/pages/prompts";
import HiddenPage from "@/pages/hidden";
import MigrationSplash from "@/pages/migration-splash";
import EmergencyReminderPage from "@/pages/emergency-reminder";

const router = createHashRouter([
  // T-013 完整版：迁移 splash 独立 URL，不走 AppLayout（启动期 db 还没初始化）
  { path: "/migration-splash", element: <MigrationSplash /> },
  // 紧急待办接管窗口：独立 URL，不挂 AppLayout，避免 Sider/Header 跑出来
  { path: "/emergency-reminder/:id", element: <EmergencyReminderPage /> },
  {
    path: "/",
    element: <AppLayout />,
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
      { path: "tasks", element: <TasksPage /> },
      { path: "cards", element: <CardsPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "about", element: <AboutPage /> },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
