import React from "react";
import ReactDOM from "react-dom/client";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import App from "./App";
import { loadThemeFromStore, useAppStore } from "@/store";
import "./styles/global.css";

// antd DatePicker 底层用 dayjs，默认英文；全局设成中文让月份 / 星期都本地化
dayjs.locale("zh-cn");

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

loadThemeFromStore().then(() => {
  // 启动后台拉一次实例信息（多开标识 / 数据目录），不阻塞首屏
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

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
