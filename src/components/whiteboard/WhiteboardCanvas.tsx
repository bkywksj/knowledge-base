import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Excalidraw,
  serializeAsJSON,
  exportToBlob,
  exportToSvg,
} from "@excalidraw/excalidraw";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";

/**
 * 白板画布（Excalidraw 封装）。
 *
 * ⚠️ **这个文件必须始终经 React.lazy 动态引入**（见 pages/whiteboard/index.tsx）。
 * Excalidraw 的依赖树很重（roughjs / pica / jotai / radix-ui / mermaid-to-excalidraw…），
 * 一旦被静态 import 就会并进主 bundle，拖慢所有用户的冷启动 —— 哪怕他们从不画白板。
 *
 * 保存策略：`onChange` 触发极其频繁（拖动一次图形几十次回调），所以
 * 防抖 + 内容比对双保险，只有序列化结果真的变了才落库。
 * `serializeAsJSON(..., "local")` 内部会剔除 scrollX / scrollY / zoom 这类瞬时视口状态，
 * 因此纯粹平移 / 缩放画布不会产生无谓的保存请求。
 */

/** 防抖保存间隔。给到 800ms：连续画线时不打断，停手后又能很快落库 */
const SAVE_DEBOUNCE_MS = 800;

/**
 * 后端给画布里的 `[[双链]]` 挂的元素 link 前缀（对齐 services/whiteboard.rs 的
 * NOTE_LINK_PREFIX）。点击这类链接要走应用内路由，不能交给浏览器默认行为 ——
 * 在 Tauri WebView 里那会试图导航整个窗口，把应用顶掉。
 */
const NOTE_LINK_PREFIX = "#/notes/";

/**
 * 交给外层（页面顶栏按钮）用的导出能力。
 *
 * 为什么绕这一圈而不是让页面直接调 `exportToBlob`：
 * 页面组件是**静态** import 的，一旦它 import 任何 `@excalidraw/*` 符号，
 * 整个 Excalidraw 依赖树就会被打进主 bundle，前面做的 lazy 分包全白费。
 * 所以导出实现留在本文件（lazy 内），只把函数句柄递出去。
 */
export interface WhiteboardExportApi {
  /** 导出当前画布为图片，返回 base64（不含 data URL 前缀），供 writeBinaryFile 落盘 */
  exportImage: (format: "png" | "svg") => Promise<string>;
  /** 复制当前画布为 PNG 到系统剪贴板，可直接粘进笔记编辑器 */
  copyImageToClipboard: () => Promise<void>;
  /**
   * 立刻拿到当前画布的场景 JSON。
   *
   * 「确认才保存」的场景（内嵌白板弹窗）必须用它而不是等 `onSave`：
   * onSave 是 800ms 防抖的，用户画完最后一笔立刻点保存，那一笔还没来得及回调。
   */
  getSceneJson: () => string;
}

interface Props {
  /** 初始场景 JSON（来自 notes.content）。空串按空白板处理 */
  initialScene: string;
  /**
   * 内容变化且防抖结束后回调，参数是完整的场景 JSON。
   * 省略即「不自动保存」—— 内嵌白板弹窗走确认制，用 exportRef 的 getSceneJson 主动取。
   */
  onSave?: (sceneJson: string) => void;
  /** 跟随应用主题 */
  theme: "light" | "dark";
  /** 保存出错时通知外层（外层负责提示用户），避免本组件依赖 antd message */
  onError?: (e: unknown) => void;
  /** 点击画布里的 [[双链]] 角标：参数是目标笔记 id，由外层负责路由跳转 */
  onOpenNote?: (noteId: number) => void;
  /**
   * 外层用来接收导出能力的 ref 容器。挂载时填入，卸载时置 null ——
   * 页面据此判断按钮该不该可用（画布还没加载完时导出没有意义）。
   */
  exportRef?: React.MutableRefObject<WhiteboardExportApi | null>;
}

/** Blob → base64（去掉 `data:*;base64,` 前缀），配合 systemApi.writeBinaryFile 落盘 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const s = String(reader.result);
      const comma = s.indexOf(",");
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    reader.readAsDataURL(blob);
  });
}

/** 解析库里存的场景 JSON。坏数据不抛错，退化成空白板并交由上层提示 ——
 *  画布挂不出来比丢一次内容更糟（用户连"另存为"抢救的机会都没有）。*/
function parseInitialScene(raw: string, onError?: (e: unknown) => void) {
  if (!raw.trim()) return null;
  try {
    const data = JSON.parse(raw);
    return {
      elements: (data.elements ?? []) as ExcalidrawElement[],
      appState: (data.appState ?? {}) as Partial<AppState>,
      files: (data.files ?? {}) as BinaryFiles,
      // 打开时把视口对准已有内容。
      // 存场景用的 serializeAsJSON(..., "local") 会**刻意剔除** scrollX/scrollY/zoom
      // （不然平移一下画布就算内容变更、白白触发保存），代价是重新打开时视口回到原点，
      // 而图形往往画在别处 —— 用户看到的是一张空画布加一个"滚动回到内容"按钮，
      // 每次都得手动点一下。交给 Excalidraw 自己定位。
      scrollToContent: true,
    };
  } catch (e) {
    onError?.(e);
    return null;
  }
}

export default function WhiteboardCanvas({
  initialScene,
  onSave,
  theme,
  onError,
  onOpenNote,
  exportRef,
}: Props) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 上一次「已交给上层保存」的 JSON。用来挡掉 onChange 的空转（选中、hover、
  // 视口移动都会触发 onChange，但序列化结果不变）
  const lastSavedRef = useRef(initialScene);
  /**
   * 最近一次 onChange 给到的场景快照。
   *
   * 🔴 **保存必须走这个快照，绝不能在保存时回头去问 Excalidraw 要数据。**
   * 踩过的坑：卸载回调里调 `api.getSceneElements()`，此时组件已在销毁过程中，
   * 拿回来的是**空数组** → 序列化成空场景 → 存库把用户整块画布覆盖没了。
   * onChange 的参数是 Excalidraw 给的不可变快照，与组件生命周期无关，随时可安全序列化。
   */
  const latestRef = useRef<{
    elements: readonly ExcalidrawElement[];
    appState: AppState;
    files: BinaryFiles;
  } | null>(null);
  // onSave 来自外层闭包，用 ref 兜住，避免它变化时把防抖定时器逻辑重建一遍
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  /** 把快照序列化成场景 JSON。导出、保存、比对都从这一条路走，口径统一 */
  const serializeCurrent = useCallback((): string | null => {
    const snap = latestRef.current;
    if (!snap) return null;
    return serializeAsJSON(snap.elements, snap.appState, snap.files, "local");
  }, []);

  // 只在首次挂载时解析：Excalidraw 的 initialData 是非受控的，
  // 后续 props 变化不会（也不应该）覆盖用户正在画的内容
  const initialData = useMemo(
    () => parseInitialScene(initialScene, onError),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /** 把最近一次快照序列化后交给上层保存（内容没变则跳过）。返回是否真的保存了 */
  const flush = useCallback(() => {
    // 没有 onSave = 调用方走「确认才保存」，这里不该偷偷落盘
    if (!onSaveRef.current) return false;
    // 从未编辑过（没有任何 onChange）→ 无事可做。
    // 这一条同时兜住了"刚打开就退出"的情况：不会拿空场景去覆盖库里的内容。
    const json = serializeCurrent();
    if (json === null) return false;
    if (json === lastSavedRef.current) return false;
    lastSavedRef.current = json;
    onSaveRef.current(json);
    return true;
  }, [serializeCurrent]);

  const handleChange = useCallback(
    (
      elements: readonly ExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
    ) => {
      // 只存引用不序列化：onChange 在拖动时逐帧触发，
      // 每次都 serializeAsJSON 会让大画布卡顿。真正序列化推迟到 flush。
      latestRef.current = { elements, appState, files };
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  // 关窗 / 切走时兜底存一次：防抖窗口内直接关掉应用会丢掉最后 800ms 的编辑。
  // pagehide 比 beforeunload 在 WebView 里更可靠，visibilitychange 覆盖切到别的标签页/最小化。
  useEffect(() => {
    const onHide = () => flush();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      // 卸载（切路由 / 关标签）前把待保存的改动落库，并清掉定时器防止泄漏
      if (timerRef.current) clearTimeout(timerRef.current);
      flush();
    };
  }, [flush]);

  /**
   * 取当前画布数据。优先用最近一次 onChange 快照；从未编辑过就退回初始场景 ——
   * 「打开就直接导出」是很常见的用法，不能因为没编辑过就导出一张空图。
   */
  const currentScene = useCallback(() => {
    const snap = latestRef.current;
    if (snap) {
      return {
        elements: snap.elements,
        appState: snap.appState as Partial<AppState>,
        files: snap.files,
      };
    }
    return {
      elements: (initialData?.elements ?? []) as readonly ExcalidrawElement[],
      appState: (initialData?.appState ?? {}) as Partial<AppState>,
      files: (initialData?.files ?? {}) as BinaryFiles,
    };
  }, [initialData]);

  // 把导出能力交给外层顶栏。依赖 currentScene，画布数据变了不用重挂。
  useEffect(() => {
    if (!exportRef) return;
    exportRef.current = {
      exportImage: async (format) => {
        const { elements, appState, files } = currentScene();
        // exportBackground: 带上画布底色导出，否则 PNG 是透明底，
        // 贴进浅色文档还行，贴进深色背景就糊成一团
        const exportAppState = { ...appState, exportBackground: true };
        if (format === "png") {
          const blob = await exportToBlob({
            elements: elements as never,
            appState: exportAppState,
            files,
            mimeType: "image/png",
          });
          return blobToBase64(blob);
        }
        const svg = await exportToSvg({
          elements: elements as never,
          appState: exportAppState,
          files,
        });
        const text = new XMLSerializer().serializeToString(svg);
        // SVG 里有中文，必须按 UTF-8 编码再 base64；直接 btoa(text) 会抛
        // "InvalidCharacterError"，这是最容易踩的一步
        const bytes = new TextEncoder().encode(text);
        let binary = "";
        bytes.forEach((b) => {
          binary += String.fromCharCode(b);
        });
        return btoa(binary);
      },
      // 没编辑过就返回初始场景：用户「打开→什么都没动→保存」不该把画布清空
      getSceneJson: () => serializeCurrent() ?? initialScene,
      copyImageToClipboard: async () => {
        const { elements, appState, files } = currentScene();
        const blob = await exportToBlob({
          elements: elements as never,
          appState: { ...appState, exportBackground: true },
          files,
          mimeType: "image/png",
        });
        // 走标准 Web API：WebView 自己写系统剪贴板，不需要额外的 Tauri 权限，
        // 写进去的格式编辑器 paste 时也认
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": blob }),
        ]);
      },
    };
    return () => {
      exportRef.current = null;
    };
  }, [exportRef, currentScene, serializeCurrent, initialScene]);

  /**
   * 拦截元素链接的打开。
   *
   * `#/notes/<id>` 是我们给 [[双链]] 挂的，走应用内路由；
   * 其他（用户手填的 http 外链）保持 Excalidraw 默认行为，不越俎代庖。
   */
  const handleLinkOpen = useCallback(
    (
      element: { link?: string | null },
      event: { preventDefault: () => void },
    ) => {
      const link = element.link ?? "";
      if (!link.startsWith(NOTE_LINK_PREFIX)) return;
      const id = Number(link.slice(NOTE_LINK_PREFIX.length));
      if (!Number.isFinite(id) || id <= 0) return;
      // 必须 preventDefault：否则 WebView 会真的去导航这个 URL
      event.preventDefault();
      // 跳走前先落一次盘，别把最后几百毫秒的编辑丢在半路
      flush();
      onOpenNote?.(id);
    },
    [flush, onOpenNote],
  );

  return (
    <div className="h-full w-full">
      <Excalidraw
        initialData={initialData}
        onChange={handleChange}
        onLinkOpen={handleLinkOpen}
        theme={theme}
        langCode="zh-CN"
        UIOptions={{
          canvasActions: {
            // 主题跟随应用全局设置，不给画布内单独切换（否则两处状态会打架）
            toggleTheme: false,
            // 单机知识库没有协作服务端，这两个入口点了只会让用户困惑
            loadScene: false,
            saveToActiveFile: false,
          },
        }}
      />
    </div>
  );
}
