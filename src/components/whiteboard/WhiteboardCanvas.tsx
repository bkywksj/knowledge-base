import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Excalidraw,
  serializeAsJSON,
  exportToBlob,
  exportToSvg,
  ROUNDNESS,
  newElementWith,
  CaptureUpdateAction,
  TTDDialog,
} from "@excalidraw/excalidraw";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  ExcalidrawImperativeAPI,
  LibraryItems,
} from "@excalidraw/excalidraw/types";
import { InputNumber, Slider, theme as antdTheme } from "antd";
import { whiteboardApi } from "@/lib/api";
import {
  buildNoteCard,
  collectCardNoteIds,
  refreshNoteCards,
} from "./noteCards";
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
 * 支持「自定义圆角半径」的元素类型 —— 与 Excalidraw 内部 `isUsingAdaptiveRadius` 保持一致。
 *
 * 菱形 / 线 / 箭头走的是**比例圆角**（恒定 25%，`roundness.value` 会被渲染层忽略），
 * 椭圆压根没有圆角概念 —— 所以圆角面板只对这几类矩形系图形出现，
 * 免得给用户一个拖了不生效的滑块。
 */
const ROUNDABLE_TYPES = new Set(["rectangle", "image", "iframe", "embeddable"]);

/**
 * Excalidraw 勾「圆角」时用的内置半径（其 DEFAULT_ADAPTIVE_RADIUS）。
 * 它自带的属性面板只有「尖角 / 圆角」两档，写进元素的是不带 value 的
 * `{ type: ADAPTIVE_RADIUS }`，渲染时按 `value ?? 32` 取值 —— 也就是圆角永远是 32px。
 * 本组件的圆角面板就是把这个 value 暴露出来让用户自己定。
 */
const DEFAULT_ADAPTIVE_RADIUS = 32;

/**
 * 圆角滑块上限。
 * 不必担心「半径比图形还大」画崩：渲染层对小图形会自动收敛
 * （边长 ≤ value/0.25 时退化成 25% 比例圆角），最圆也就是个胶囊形。
 */
const MAX_RADIUS = 100;

/**
 * Excalidraw 的 UIOptions 必须是稳定引用。
 * 组件现在会因为「选中态变化」重渲染，内联字面量会让 memo 化的 Excalidraw 跟着白白重渲染。
 */
const UI_OPTIONS = {
  canvasActions: {
    // 主题跟随应用全局设置，不给画布内单独切换（否则两处状态会打架）
    toggleTheme: false,
    // 单机知识库没有协作服务端，这两个入口点了只会让用户困惑
    loadScene: false,
    saveToActiveFile: false,
  },
};

/** 素材库落盘的防抖间隔。加素材是低频动作，给长一点没关系 */
const LIBRARY_SAVE_DEBOUNCE_MS = 1200;

/**
 * 读用户的素材库。
 *
 * Excalidraw 组件本身**不持久化**素材库 —— 宿主不接管的话，用户收藏的图形组件
 * 关掉应用就没了。`initialData.libraryItems` 接受 Promise，所以这里直接把
 * "去后端拿"这件事交给它，不必等画布挂载后再补一次 updateLibrary。
 *
 * 任何失败都退化成空库：素材库丢了是小事，因为它把画布打不开才是大事。
 */
async function loadLibraryItems(): Promise<LibraryItems> {
  try {
    const raw = await whiteboardApi.getLibrary();
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    return (parsed.libraryItems ?? []) as LibraryItems;
  } catch (e) {
    console.warn("[whiteboard] 读取素材库失败，按空库处理:", e);
    return [];
  }
}

/**
 * 打包成标准 `.excalidrawlib`。
 *
 * 存标准格式而不是裸数组：这个文件用户可以直接拿去导进 excalidraw.com 或分享给别人。
 * 加载与保存都走这一个函数，保证"刚加载的内容"和"即将保存的内容"字符串可直接比对。
 */
function serializeLibrary(items: LibraryItems): string {
  return JSON.stringify({
    type: "excalidrawlib",
    version: 2,
    source: "knowledge-base",
    libraryItems: items,
  });
}

/** 读元素当前的圆角半径（像素）。0 = 尖角 */
function readRadius(el: ExcalidrawElement): number {
  if (!el.roundness) return 0;
  return el.roundness.value ?? DEFAULT_ADAPTIVE_RADIUS;
}

function clampRadius(v: number): number {
  return Math.min(MAX_RADIUS, Math.max(0, Math.round(v)));
}

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
  /**
   * 放弃尚未落库的改动。
   *
   * 用在"这块白板已经被别的途径改写了"的场合 —— 典型是回滚到历史版本：
   * 页面拿到新场景后会换 key 重建画布，而**旧实例卸载时会兜底保存一次**
   * （见下面 pagehide/卸载那段），不打断的话刚恢复的版本立刻被旧内容覆盖回去。
   *
   * 实现上是把"已保存基准"对齐到当前内容，于是后续 flush 会因内容无变化而跳过。
   */
  discardPendingSave: () => void;
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
  /**
   * 只读模式：能看能缩放，不能改。历史版本预览用。
   *
   * 注意只读**不等于**不会触发 onChange（视口移动照样触发），所以调用方
   * 该不该传 onSave 仍要自己决定 —— 预览场景一律别传。
   */
  readOnly?: boolean;
  /**
   * 外层用来接收「打开 Mermaid 转图对话框」能力的 ref。
   *
   * 与 exportRef 同理：入口按钮画在页面顶栏（静态 import），但要打开的对话框
   * 归 Excalidraw 管，只能由本组件（lazy 内）用 imperative API 触发。
   */
  mermaidRef?: React.MutableRefObject<(() => void) | null>;
  /**
   * 外层用来接收「插入笔记卡片」能力的 ref。
   *
   * 与 exportRef / mermaidRef 同理：选笔记的弹窗画在页面里（静态 import），
   * 但把卡片放进画布这件事只能由本组件（lazy 内）做。
   */
  insertCardRef?: React.MutableRefObject<((noteId: number) => Promise<void>) | null>;
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
  readOnly = false,
  mermaidRef,
  insertCardRef,
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

  /** Excalidraw 命令式句柄，圆角面板靠它读选中态、写回场景 */
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  /** 素材库的防抖定时器与"已落盘内容"基准 */
  const libraryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLibraryRef = useRef<string | null>(null);
  /**
   * 圆角面板的显示状态。null = 当前没选中任何可调圆角的图形，面板收起。
   * `selKey` 只是「选中了哪些元素」的廉价指纹（个数 + 首尾 id），用来挡掉 onChange 的空转 ——
   * 拖动图形时 onChange 逐帧触发，但选中集和圆角值都没变，不该引发重渲染。
   */
  const [roundSel, setRoundSel] = useState<{ selKey: string; radius: number } | null>(null);
  /**
   * 用户最近一次设定的圆角半径，>0 时自动套用到之后新画的矩形（省得一个个调）。
   * null = 不干预，保持 Excalidraw 的默认行为。
   */
  const customRadiusRef = useRef<number | null>(null);
  /** 已登记过的元素 id，用来认出「刚画出来的」图形。初始场景的元素会在首次 onChange 一次性登记 */
  const seenIdsRef = useRef<Set<string>>(new Set());

  /**
   * 把圆角半径写进匹配到的元素。
   *
   * 关于「向 api 现取元素」：文件开头那条「保存时绝不能回头问 Excalidraw 要数据」说的是
   * **组件卸载途中**（那时拿回来的是空数组）。这里只在用户交互期间同步调用，画布活得好好的，
   * 而 `updateScene` 本来就要求一份完整的元素列表（含已删除的，否则会把删除记录抹掉）。
   *
   * @param commit true = 记进撤销历史。拖动滑块时必须传 false，
   *               否则拖一次就往撤销栈里塞几十条记录，用户想撤回上一步得按穿手指。
   */
  const applyRadius = useCallback(
    (radius: number, match: (id: string) => boolean, commit: boolean) => {
      const api = apiRef.current;
      if (!api) return;
      const roundness =
        radius <= 0 ? null : { type: ROUNDNESS.ADAPTIVE_RADIUS, value: radius };
      const next = api.getSceneElementsIncludingDeleted().map((el) =>
        match(el.id) && ROUNDABLE_TYPES.has(el.type)
          ? // 用不可变更新而非 mutateElement：新对象会让 roughjs 的形状缓存自然失效，重绘拿到新圆角
            newElementWith(el, { roundness })
          : el,
      );
      api.updateScene({
        elements: next,
        captureUpdate: commit
          ? CaptureUpdateAction.IMMEDIATELY
          : CaptureUpdateAction.NEVER,
      });
    },
    [],
  );

  /** 面板改动 → 作用于当前选中的图形 */
  const applyToSelection = useCallback(
    (radius: number, commit: boolean) => {
      const api = apiRef.current;
      if (!api) return;
      const selected = api.getAppState().selectedElementIds;
      applyRadius(radius, (id) => !!selected[id], commit);
      if (!commit) return;
      // 0 = 尖角：连记忆一起清掉。否则用户调完尖角后新画的圆角矩形会莫名其妙变尖，
      // 明明属性面板里勾的是「圆角」
      customRadiusRef.current = radius > 0 ? radius : null;
    },
    [applyRadius],
  );

  /**
   * 每次 onChange 同步一遍圆角相关状态：
   * ① 选中了哪些矩形系图形 → 决定面板显不显示、显示什么值
   * ② 新画出来的矩形补上记住的自定义圆角
   */
  const syncRoundness = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState) => {
      const selected = appState.selectedElementIds;
      // 正在拖拽创建中的图形先放过：这一帧它还没定型，改它容易打断绘制手感，
      // 等下一帧（画完了）再登记补值
      const pendingId = appState.newElement?.id;
      const remembered = customRadiusRef.current;
      const seen = seenIdsRef.current;

      let first: ExcalidrawElement | null = null;
      let lastId = "";
      let count = 0;
      const fresh: string[] = [];

      for (const el of elements) {
        if (!el.isDeleted && selected[el.id] && ROUNDABLE_TYPES.has(el.type)) {
          if (!first) first = el;
          lastId = el.id;
          count++;
        }

        if (seen.has(el.id) || el.id === pendingId) continue;
        seen.add(el.id);
        if (remembered === null || el.isDeleted) continue;
        if (!ROUNDABLE_TYPES.has(el.type)) continue;
        // 只认「勾了圆角但没自己调过半径」的新图形：
        // 用户手动调过的（value 有值）、或本来就画的尖角（roundness 为 null）都不该被覆盖
        if (el.roundness?.type !== ROUNDNESS.ADAPTIVE_RADIUS) continue;
        if (el.roundness.value !== undefined) continue;
        fresh.push(el.id);
      }

      const nextSel = first
        ? { selKey: `${count}:${first.id}:${lastId}`, radius: readRadius(first) }
        : null;
      setRoundSel((prev) => {
        if (prev === null && nextSel === null) return prev;
        if (prev && nextSel && prev.selKey === nextSel.selKey && prev.radius === nextSel.radius) {
          return prev;
        }
        return nextSel;
      });

      if (fresh.length > 0 && remembered !== null) {
        const ids = new Set(fresh);
        // 推到微任务里执行：别在 Excalidraw 自己的 onChange 调用栈里回头改它的场景。
        // 不进撤销历史（false）—— 撤销时用户想撤掉的是「刚画的这个矩形」，
        // 而不是先撤一次圆角、再撤一次矩形
        queueMicrotask(() => applyRadius(remembered, (id) => ids.has(id), false));
      }
    },
    [applyRadius],
  );

  /** 把快照序列化成场景 JSON。导出、保存、比对都从这一条路走，口径统一 */
  const serializeCurrent = useCallback((): string | null => {
    const snap = latestRef.current;
    if (!snap) return null;
    return serializeAsJSON(snap.elements, snap.appState, snap.files, "local");
  }, []);

  // 只在首次挂载时解析：Excalidraw 的 initialData 是非受控的，
  // 后续 props 变化不会（也不应该）覆盖用户正在画的内容
  const libraryPromise = useMemo(() => loadLibraryItems(), []);
  const initialData = useMemo(
    () => {
      const scene = parseInitialScene(initialScene, onError);
      // 素材库与场景无关（空白板也该有自己收藏的图形），单独挂上去。
      // `libraryItems` 接受 Promise，Excalidraw 会等它 resolve 再填充，
      // 省掉"挂载后再 updateLibrary 补一次"的那圈时序处理
      return {
        elements: scene?.elements ?? [],
        appState: scene?.appState ?? {},
        files: scene?.files ?? {},
        scrollToContent: scene?.scrollToContent ?? true,
        libraryItems: libraryPromise,
      };
    },
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
      syncRoundness(elements, appState);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
    [flush, syncRoundness],
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
      discardPendingSave: () => {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        const json = serializeCurrent();
        if (json !== null) lastSavedRef.current = json;
      },
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

  const handleApi = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
  }, []);

  /**
   * 打开白板时把卡片刷成笔记的最新内容。
   *
   * 这是卡片区别于"贴一段死文字"的关键：笔记在别处改了，下次打开白板就能看到新的。
   * 只读模式跳过 —— 历史版本预览要的是"那一版当时的样子"，
   * 拿今天的笔记内容去刷新它是错的。
   */
  useEffect(() => {
    if (readOnly) return;
    let cancelled = false;

    // 等画布挂载：excalidrawAPI 回调可能晚于本 effect
    const timer = setTimeout(() => {
      void (async () => {
        const api = apiRef.current;
        if (!api || cancelled) return;
        const elements = api.getSceneElementsIncludingDeleted();
        const ids = collectCardNoteIds(elements);
        if (ids.length === 0) return;
        try {
          const excerpts = await whiteboardApi.noteExcerpts(ids);
          if (cancelled) return;
          const next = refreshNoteCards(
            api.getSceneElementsIncludingDeleted(),
            excerpts,
          );
          // null = 所有卡片内容都没变，跳过 updateScene
          if (!next) return;
          api.updateScene({
            elements: next,
            // 不进撤销栈：这是"同步笔记最新内容"，不是用户的编辑动作，
            // 撤销它没有意义反而会让画布和笔记对不上
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        } catch (e) {
          // 刷新失败就让卡片保持上次的内容 —— 比让整个白板打不开好
          console.warn("[whiteboard] 刷新笔记卡片失败:", e);
        }
      })();
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [readOnly]);

  /** 把「插入笔记卡片」交给外层 */
  useEffect(() => {
    if (!insertCardRef) return;
    insertCardRef.current = async (noteId: number) => {
      const api = apiRef.current;
      if (!api) return;
      const [ex] = await whiteboardApi.noteExcerpts([noteId]);
      if (!ex) return;

      // 放在当前视口中心：画布可能已经滚到别处，固定坐标会把卡片扔到看不见的地方
      const { scrollX, scrollY, zoom, width, height } = api.getAppState();
      const card = buildNoteCard(ex, {
        x: -scrollX + width / 2 / zoom.value - 130,
        y: -scrollY + height / 2 / zoom.value - 80,
        width: 260,
        height: 160,
      });

      api.updateScene({
        elements: [...api.getSceneElementsIncludingDeleted(), ...card],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    };
    return () => {
      insertCardRef.current = null;
    };
  }, [insertCardRef]);

  /**
   * 把「打开 Mermaid 转图」交给外层顶栏。
   *
   * 直接改 appState.openDialog 而不是挂 `<TTDDialogTrigger>`：后者会往
   * Excalidraw 自己的工具栏里塞一个入口，且默认打开需要联网的 text-to-diagram 页签。
   * 这里指定 tab: "mermaid" 直达离线可用的那一页。
   */
  useEffect(() => {
    if (!mermaidRef) return;
    mermaidRef.current = () => {
      apiRef.current?.updateScene({
        appState: { openDialog: { name: "ttd", tab: "mermaid" } },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    };
    return () => {
      mermaidRef.current = null;
    };
  }, [mermaidRef]);

  /**
   * 素材库变更 → 防抖落盘。
   *
   * 首次把库注入画布时 Excalidraw 也会回调一次，靠内容比对挡掉（下面的 effect 会把
   * 加载到的内容先写进基准）—— 不能靠"跳过第一次回调"，因为空库用户加的第一个素材
   * 恰好就是第一次回调，跳过就等于丢了。
   */
  const handleLibraryChange = useCallback((items: LibraryItems) => {
    const payload = serializeLibrary(items);
    if (payload === lastLibraryRef.current) return;
    lastLibraryRef.current = payload;
    if (libraryTimerRef.current) clearTimeout(libraryTimerRef.current);
    libraryTimerRef.current = setTimeout(() => {
      whiteboardApi
        .saveLibrary(payload)
        .catch((e) => console.warn("[whiteboard] 素材库保存失败:", e));
    }, LIBRARY_SAVE_DEBOUNCE_MS);
  }, []);

  // 把"刚从磁盘读到的库"设为比对基准，这样注入触发的那次回调不会原样回写一遍
  useEffect(() => {
    let cancelled = false;
    libraryPromise.then((items) => {
      if (!cancelled && lastLibraryRef.current === null) {
        lastLibraryRef.current = serializeLibrary(items);
      }
    });
    return () => {
      cancelled = true;
      if (libraryTimerRef.current) clearTimeout(libraryTimerRef.current);
    };
  }, [libraryPromise]);

  return (
    <div className="h-full w-full relative">
      <Excalidraw
        excalidrawAPI={handleApi}
        initialData={initialData}
        onChange={handleChange}
        onLibraryChange={handleLibraryChange}
        onLinkOpen={handleLinkOpen}
        theme={theme}
        langCode="zh-CN"
        viewModeEnabled={readOnly}
        UIOptions={UI_OPTIONS}
      >
        {/*
          Mermaid → 可编辑图形。转换在本地完成（mermaid-to-excalidraw 是 Excalidraw
          自带的依赖），不联网。

          `__fallback` 是官方的「没有 AI 后端」模式：只保留 Mermaid 这一页，
          隐藏需要调远端的「文本转图」。单机知识库没有那个服务端，
          留着入口只会让用户点了报错。
        */}
        <TTDDialog __fallback />
      </Excalidraw>
      {/* 只读时不给圆角面板：view mode 下本来就选不中图形，留个操作不了的面板只会误导 */}
      {!readOnly && roundSel && (
        // key 绑选中指纹：换一批选中图形时让面板重建，把拖动中的临时值一并丢掉
        <RadiusPanel
          key={roundSel.selKey}
          radius={roundSel.radius}
          onPreview={(v) => applyToSelection(v, false)}
          onCommit={(v) => applyToSelection(v, true)}
        />
      )}
    </div>
  );
}

/**
 * 圆角调节面板（Excalidraw 原生只有「尖角 / 圆角」两档，这里把半径开放到 0–100）。
 *
 * 放右下角：左下角被 Excalidraw 的缩放 / 撤销控件占了，顶部中间是工具条，
 * 右上角是菜单与库 —— 右下角只有一个帮助按钮，抬高一点就能错开。
 */
function RadiusPanel({
  radius,
  onPreview,
  onCommit,
}: {
  radius: number;
  onPreview: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  const { token } = antdTheme.useToken();
  /**
   * 拖动 / 输入过程中的临时值。
   * 显示以它为准，保证滑块跟手；场景值追上来后（radius 变化）就撤下，回到单一数据源。
   */
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? radius;

  useEffect(() => {
    setDraft(null);
  }, [radius]);

  function preview(v: number) {
    const next = clampRadius(v);
    setDraft(next);
    onPreview(next);
  }

  return (
    <div
      className="absolute right-3 bottom-16 z-10 flex items-center gap-2 rounded-lg px-3 py-2"
      style={{
        background: token.colorBgElevated,
        border: `1px solid ${token.colorBorderSecondary}`,
        boxShadow: token.boxShadowSecondary,
      }}
      title="选中矩形的圆角半径（0 = 尖角）。调过之后，新画的矩形会沿用这个值"
      // Excalidraw 的快捷键挂在 document 上：不拦住的话，滑块的方向键会顺带把画布里的图形挪走；
      // 指针事件同理，别让点面板被当成点画布
      onKeyDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span style={{ color: token.colorTextSecondary, fontSize: 12, whiteSpace: "nowrap" }}>
        圆角
      </span>
      <Slider
        min={0}
        max={MAX_RADIUS}
        value={shown}
        onChange={preview}
        onChangeComplete={(v) => onCommit(clampRadius(v))}
        tooltip={{ open: false }}
        style={{ width: 120, margin: 0 }}
      />
      <InputNumber
        size="small"
        min={0}
        max={MAX_RADIUS}
        value={shown}
        // 输入 / 点步进按钮时只预览，失焦或回车才记进撤销历史，
        // 免得连点几下箭头就往撤销栈里塞一串
        onChange={(v) => typeof v === "number" && preview(v)}
        onBlur={() => onCommit(shown)}
        onPressEnter={() => onCommit(shown)}
        style={{ width: 62 }}
      />
    </div>
  );
}
