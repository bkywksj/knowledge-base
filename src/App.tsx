import { useEffect } from "react";
import { ConfigProvider, theme, App as AntdApp, message } from "antd";
import zhCN from "antd/locale/zh_CN";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { useAppStore } from "@/store";
import { AppRouter } from "@/Router";
import { getAntdTokens } from "@/theme/tokens";
import { TaskReminderListener } from "@/components/tasks/TaskReminderListener";

// 紧急提醒窗口 / 迁移 splash 等子窗口共用同一个 React bundle，
// 但只有 main 窗口才需要挂全局提醒监听器，否则子窗口也会响应 task:reminder
// 重复弹 Modal，且子窗口没有 antd App context 会异常
const IS_MAIN_WINDOW = (() => {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return true;
  }
})();

function App() {
  const themeCategory = useAppStore((s) => s.themeCategory);
  const lightTheme = useAppStore((s) => s.lightTheme);
  const darkTheme = useAppStore((s) => s.darkTheme);
  const activeTheme = themeCategory === "light" ? lightTheme : darkTheme;
  const tokens = getAntdTokens(activeTheme);

  // 同步主题到 DOM，供 CSS 选择器使用
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", activeTheme);
    document.documentElement.setAttribute("data-theme-category", themeCategory);
  }, [activeTheme, themeCategory]);

  // 监听 db:reloaded：从 zip 导入快照后 Rust 侧会热重载 Connection 并 emit 此事件，
  // 前端收到后批量 bump 各 refresh tick，让所有视图（笔记列表 / 文件夹 / 标签 / 任务）
  // 自动重拉数据。无需重启应用。
  useEffect(() => {
    if (!IS_MAIN_WINDOW) return;
    // listen() 返回 Promise，async cleanup 必须用"取消标志 + then 内判断"模式，
    // 否则 React 严格模式 / 快速 remount 时第一次的 listener 永远不被 unlisten
    // （cleanup 跑时 unlisten 还没 resolve），导致重复注册 → 事件触发两次。
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen("db:reloaded", () => {
      const s = useAppStore.getState();
      s.bumpNotesRefresh();
      s.bumpFoldersRefresh();
      s.bumpTagsRefresh();
      s.bumpTasksListRefresh();
      s.refreshTaskStats();
      message.success("数据已重载");
    }).then((fn) => {
      if (cancelled) {
        fn(); // 已 unmount，立即解绑避免泄漏
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // 紧急窗口（独立 webview）改完任务后通过 Tauri 事件通知主窗刷新列表/角标。
  // Zustand store 是 per-webview 的，子窗口 set state 主窗拿不到，所以必须走事件桥。
  useEffect(() => {
    if (!IS_MAIN_WINDOW) return;
    let unlisten: (() => void) | undefined;
    listen("tasks:list-refresh", () => {
      const s = useAppStore.getState();
      s.bumpTasksListRefresh();
      void s.refreshTaskStats();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm:
          themeCategory === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: tokens,
      }}
    >
      <AntdApp style={{ height: "100%" }}>
        <ErrorBoundary>
          <AppRouter />
          {IS_MAIN_WINDOW && <TaskReminderListener />}
        </ErrorBoundary>
      </AntdApp>
    </ConfigProvider>
  );
}

export default App;
