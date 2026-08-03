import React from "react";
import ReactDOM from "react-dom/client";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { error as logError } from "@tauri-apps/plugin-log";
import App from "./App";
import { RootErrorBoundary } from "@/components/ui/RootErrorBoundary";
import { loadThemeFromStore, useAppStore } from "@/store";
import "./styles/global.css";

// 只有主窗口才需要走"启动锁"门禁；子窗口（quick-add / 紧急提醒 / pop-out 等）
// 都是从已解锁的会话里派生出来的，不重复拦截。label 取不到时按主窗处理（保守不漏挡）。
const IS_MAIN_WINDOW = (() => {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return true;
  }
})();

// antd DatePicker 底层用 dayjs，默认英文；全局设成中文让月份 / 星期都本地化
dayjs.locale("zh-cn");

// 白板（Excalidraw）字体自托管根路径。
// 不设的话它会去 CDN（esm.sh）拉字体 —— 桌面应用离线场景直接失效，而且 CSP 的
// `font-src 'self' data:` 也会拦掉。字体由 vite.config.ts 的 kb-excalidraw-assets
// 插件同步到 public/excalidraw/fonts，这里指向它的父目录（内部会拼 `fonts/...`）。
// ⚠ 必须在 Excalidraw 模块被加载前赋值；白板组件是 React.lazy 动态引入的，
//   一定晚于本文件执行，所以放这里是安全的。
(window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH =
  "/excalidraw/";

// ── 全局错误兜底：捕获 React ErrorBoundary 抓不到的「同步全局错误」与「未处理的 Promise
//    rejection」，统一落后端日志（tauri-plugin-log）。让线上白屏 / 异常可远程取证，
//    而不是石沉大海。注册得越早越好（在任何业务代码与渲染之前）。
window.addEventListener("error", (e) => {
  const detail =
    e.error instanceof Error
      ? `${e.error.name}: ${e.error.message}\n${e.error.stack ?? ""}`
      : e.message;
  console.error("[window.onerror]", detail, `@ ${e.filename}:${e.lineno}:${e.colno}`);
  void logError(
    `[window.onerror] ${detail} @ ${e.filename}:${e.lineno}:${e.colno}`,
  ).catch(() => {});
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  const detail =
    r instanceof Error ? `${r.name}: ${r.message}\n${r.stack ?? ""}` : String(r);
  console.error("[unhandledrejection]", detail);
  void logError(`[unhandledrejection] ${detail}`).catch(() => {});
});

// 兜底拦截 OS 文件拖放 + 点击 file:// 链接跳转：tauri.conf.json 设了 dragDropEnabled=false，
// WebView 接管拖放；未保护区域松手 / 点到 file:// 链接时，浏览器默认"把文件当 URL 导航"，
// 被 CSP 拒绝后回退到 http://tauri.localhost/ (Tauri upstream bug #9725)。
//
// ⚠ dragover/drop 必须走 **bubble 阶段**（不能加 capture: true）。
// 因为 prosemirror-view 1.41.x 的 `eventBelongsToView` 第一行就检查
// `if (event.defaultPrevented) return false`，capture 阶段提前 preventDefault
// 会让 ProseMirror 跳过整个 drop dispatch（含 editorProps.handleDOMEvents.drop /
// handleDrop / Dropcursor），导致编辑器拖入文件完全无反应。bubble 阶段：
// 编辑器自己的 handleDOMEvents.drop 先跑并 preventDefault，再冒到这里时已是
// 编辑器外区域 → 兜底防导航；两边互不踩坑。
const isOsFileDrag = (e: DragEvent) =>
  !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");

window.addEventListener("dragover", (e) => {
  if (isOsFileDrag(e)) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  if (isOsFileDrag(e)) e.preventDefault();
});

// 点击 file:// 链接 → 业务层(TiptapEditor)应该已 preventDefault 并调 openPath；
// 这里做最外层兜底，阻止"链接没被处理时"浏览器默认导航到 file:// 而回退到 tauri.localhost
window.addEventListener(
  "click",
  (e) => {
    const a = (e.target as HTMLElement | null)?.closest?.("a") as HTMLAnchorElement | null;
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("file://")) e.preventDefault();
  },
  true,
);

// 禁用页面刷新快捷键（F5 / Ctrl+R / Ctrl+Shift+R / Ctrl+F5）。
// 桌面应用不是浏览器，刷新会丢失未保存的编辑器状态、Zustand 内存状态、未落库的草稿，
// 用户一不小心按到就丢草稿（尤其是 F5 单键）。capture 阶段拦截在所有业务监听之前。
window.addEventListener(
  "keydown",
  (e) => {
    const isF5 = e.key === "F5";
    const isCtrlR = (e.ctrlKey || e.metaKey) && (e.key === "r" || e.key === "R");
    if (isF5 || isCtrlR) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true,
);

// 真正挂载 React。抽成函数：无论前面的主题 / 启动锁初始化成功与否都必须执行，避免任一
// 步骤失败导致整页白屏（历史上 then 链无 .catch，初始化 reject 就永不渲染 → 看似闪退）。
function renderApp() {
  try {
    const rootEl = document.getElementById("root");
    if (!rootEl) throw new Error("根节点 #root 不存在，无法挂载应用");
    ReactDOM.createRoot(rootEl, {
      // React 19：渲染期未捕获 / 已恢复错误也落后端日志，便于"够不到机器"时远程定位
      onUncaughtError: (err) => {
        void logError(`[react onUncaughtError] ${String(err)}`).catch(() => {});
      },
      onRecoverableError: (err) => {
        void logError(`[react onRecoverableError] ${String(err)}`).catch(() => {});
      },
    }).render(
      <React.StrictMode>
        <RootErrorBoundary>
          <App />
        </RootErrorBoundary>
      </React.StrictMode>,
    );
  } catch (e) {
    // 连 React 都挂不上（极端情况）：直接写 DOM，保证不白屏并给出重启入口。
    console.error("[main] React 挂载失败", e);
    void logError(`[main] React 挂载失败: ${String(e)}`).catch(() => {});
    showFatalDomFallback(e);
  }
}

// 不依赖任何框架的最终兜底页（连 React 都挂不上时用）。
function showFatalDomFallback(e: unknown) {
  const host = document.getElementById("root") ?? document.body;
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const msg = raw.replace(
    /[<>&]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] ?? c,
  );
  host.innerHTML =
    '<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    "font-family:system-ui,'Microsoft YaHei',sans-serif;background:#1e1e1e;color:#e6e6e6;padding:24px;\">" +
    '<div style="max-width:520px;">' +
    '<div style="font-size:40px;margin-bottom:12px;">⚠️</div>' +
    '<h1 style="font-size:20px;margin:0 0 8px;">应用启动失败</h1>' +
    '<p style="color:#b0b0b0;font-size:13px;margin:0 0 16px;">界面无法加载，错误已记录到日志文件。</p>' +
    '<pre style="background:#2a2a2a;border:1px solid #3a3a3a;border-radius:6px;padding:12px;' +
    'font-size:12px;color:#ff9c9c;white-space:pre-wrap;word-break:break-word;">' +
    msg +
    "</pre>" +
    '<button onclick="window.location.reload()" style="margin-top:16px;padding:8px 18px;font-size:14px;' +
    'border:none;border-radius:6px;background:#1677ff;color:#fff;cursor:pointer;">重新加载</button>' +
    "</div></div>";
}

loadThemeFromStore()
  .then(async () => {
    // 应用启动锁：仅主窗在渲染前查询后端锁状态，已开启则首帧即进入锁屏，
    // 避免笔记内容在锁屏出现前闪现一下。失败开放（不锁），不阻塞启动。
    if (IS_MAIN_WINDOW) {
      await useAppStore.getState().initAppLock();
    }
    // 启动后台拉一次系统信息（数据目录 / 版本等），不阻塞首屏
    useAppStore.getState().loadInstanceInfo();
    // 拉一次"全局新建笔记"的默认文件夹 / 标签偏好，便于第一次按 Ctrl+N 就能用
    useAppStore.getState().loadNoteDefaults();
    // 拉一次"启用的侧栏视图"配置（用户在设置里勾选的功能模块开关）
    void useAppStore.getState().loadEnabledViews();
    // 拉一次移动端 Dashboard 显示项偏好（仅移动端用，桌面端无害）
    void useAppStore.getState().loadMobileDashboardItems();
    // 拉一次移动端底部 Tab 配置
    void useAppStore.getState().loadMobileTabKeys();
    // 拉一次内置 MCP 的"允许 AI 修改"开关，让设置页/AI 问答页 UI 与后端真相对齐
    void useAppStore.getState().loadAiWritable();

    // 预热文件夹树：让 NotesPanel 第一次打开时直接命中缓存，避免"点笔记"时的等待
    // 用 requestIdleCallback 在浏览器空闲时跑，不和首屏渲染抢线程
    const winIdle = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
    };
    const triggerPrefetch = () => useAppStore.getState().prefetchFolders();
    // 顺便 prefetch 最常用的 NotesPanel chunk —— SidePanel 已 React.lazy 化，
    // 这里主动把 chunk 拉下来，首次点笔记图标时 Suspense fallback 几乎不会显示。
    const prefetchNotesPanelChunk = () =>
      import("@/components/layout/panels/NotesPanel").catch(() => {});
    if (typeof winIdle.requestIdleCallback === "function") {
      winIdle.requestIdleCallback(triggerPrefetch, { timeout: 1000 });
      winIdle.requestIdleCallback(prefetchNotesPanelChunk, { timeout: 2000 });
    } else {
      setTimeout(triggerPrefetch, 100);
      setTimeout(prefetchNotesPanelChunk, 300);
    }
  })
  .catch((e) => {
    // 启动初始化失败也绝不能白屏：记日志后继续渲染（用默认主题 / 不锁屏）。
    console.error("[main] 启动初始化失败，降级渲染", e);
    void logError(`[main] 启动初始化失败，降级渲染: ${String(e)}`).catch(() => {});
  })
  .finally(() => {
    renderApp();
  });
