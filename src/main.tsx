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
// 使用 capture 阶段 + 只对 OS 文件拖放生效，避免干扰 antd Tree / DOM 内部拖拽。
// 对 click 的拦截走 capture，比 ProseMirror / React 合成事件更早处理。
const isOsFileDrag = (e: DragEvent) =>
  !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");

window.addEventListener(
  "dragover",
  (e) => { if (isOsFileDrag(e)) e.preventDefault(); },
  true,
);
window.addEventListener(
  "drop",
  (e) => { if (isOsFileDrag(e)) e.preventDefault(); },
  true,
);

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

loadThemeFromStore().then(() => {
  // 启动后台拉一次实例信息（多开标识 / 数据目录），不阻塞首屏
  useAppStore.getState().loadInstanceInfo();
  // 拉一次"全局新建笔记"的默认文件夹 / 标签偏好，便于第一次按 Ctrl+N 就能用
  useAppStore.getState().loadNoteDefaults();

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
