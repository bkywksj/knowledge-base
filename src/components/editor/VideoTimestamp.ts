/**
 * Tiptap VideoTimestamp 节点：内联可点 chip，点击跳转到对应视频的指定时间
 *
 * 设计要点：
 * - inline atom：和文字混排但作为整体不可编辑（只能整个删/选）
 * - attrs:
 *     videoId  绑定的视频节点 id（VideoNode.attrs.id 同源）
 *     seconds  跳转秒数（整数）
 *     label    显示文本（如 "📹 视频 1 · 01:40"）；保留是为了视频被删时仍能展示
 * - 序列化为 `<span data-video-ts data-video-id="x" data-seconds="N">label</span>`，
 *   依赖 tiptap-markdown `html: true` 透传到 markdown，反序列化由 parseHTML 接住。
 *
 * 跳转行为：
 *   1. 找 [data-video-id="<id>"] 节点（VideoNodeView 渲染时挂的）
 *   2. 找内部 <video>，scrollIntoView({behavior:smooth, block:center})
 *   3. video.currentTime = seconds; play().catch(无视)
 *   4. 给 video block 加 data-highlight="true"，1.2s 后移除（CSS 动画呼吸效果）
 *   5. 视频不存在 → message.error 提示
 */
import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer, type Editor } from "@tiptap/react";
import { VideoTimestampNodeView } from "./VideoTimestampNodeView";

export interface VideoTimestampOptions {
  HTMLAttributes: Record<string, unknown>;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    videoTimestamp: {
      setVideoTimestamp: (options: {
        videoId: string;
        seconds: number;
        label: string;
        /** 区间终点秒数；> seconds 时为「A→B 区间时间戳」，否则为单点 */
        endSeconds?: number;
      }) => ReturnType;
    };
  }
}

export const VideoTimestamp = Node.create<VideoTimestampOptions>({
  name: "videoTimestamp",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return {
      HTMLAttributes: { class: "video-ts-chip" },
    };
  },

  addAttributes() {
    return {
      videoId: {
        default: "",
        parseHTML: (el) => (el as HTMLElement).getAttribute("data-video-id") ?? "",
        renderHTML: (attrs) => ({
          "data-video-id": String(attrs.videoId ?? ""),
        }),
      },
      seconds: {
        default: 0,
        parseHTML: (el) => {
          const raw = (el as HTMLElement).getAttribute("data-seconds") ?? "0";
          const n = parseInt(raw, 10);
          return Number.isFinite(n) ? n : 0;
        },
        renderHTML: (attrs) => ({
          "data-seconds": String(attrs.seconds ?? 0),
        }),
      },
      // 区间终点秒数；> seconds 时为「A→B 区间」，0 表示单点（不写属性以保持旧数据兼容）
      endSeconds: {
        default: 0,
        parseHTML: (el) => {
          const raw = (el as HTMLElement).getAttribute("data-end-seconds") ?? "0";
          const n = parseInt(raw, 10);
          return Number.isFinite(n) ? n : 0;
        },
        renderHTML: (attrs) => {
          const n = Number(attrs.endSeconds ?? 0);
          return n > 0 ? { "data-end-seconds": String(n) } : {};
        },
      },
      label: {
        default: "",
        parseHTML: (el) => (el as HTMLElement).textContent ?? "",
        renderHTML: () => ({}), // label 由 textContent 承载，不重复写到属性
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-video-ts]",
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        "data-video-ts": "true",
      }),
      String(node.attrs.label ?? ""),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(VideoTimestampNodeView);
  },

  addCommands() {
    return {
      setVideoTimestamp:
        (options) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              videoId: options.videoId,
              seconds: options.seconds,
              endSeconds: options.endSeconds ?? 0,
              label: options.label,
            },
          }),
    };
  },
});

/** 工具栏 / VideoNode 调用：插入时间戳节点 + 后跟一个空格便于继续输入 */
export function insertVideoTimestamp(
  editor: Editor,
  options: { videoId: string; seconds: number; label: string; endSeconds?: number },
): void {
  editor
    .chain()
    .focus()
    .insertContent([
      {
        type: "videoTimestamp",
        attrs: { ...options, endSeconds: options.endSeconds ?? 0 },
      },
      { type: "text", text: " " },
    ])
    .run();
}

/**
 * 跳转到对应视频的指定时间（VideoTimestampNodeView 点击时调用）。
 *
 * 通过 [data-video-id] 选择器在 DOM 中定位 VideoNode 渲染的容器，
 * 然后操作其内部 <video> 元素。
 */
export function jumpToVideoTimestamp(
  videoId: string,
  seconds: number,
  rootEl: HTMLElement | Document = document,
  endSeconds = 0,
): { ok: boolean; reason?: string } {
  if (!videoId) return { ok: false, reason: "missing videoId" };
  const block = rootEl.querySelector<HTMLElement>(`[data-video-id="${cssEscape(videoId)}"]`);
  if (!block) return { ok: false, reason: "video not found" };
  const video = block.querySelector<HTMLVideoElement>("video");
  if (!video) return { ok: false, reason: "video element missing" };

  block.scrollIntoView({ behavior: "smooth", block: "center" });

  // 先清掉上一次可能残留的区间自动暂停监听（切换 chip / 单点跳转时避免旧监听误触发）
  clearRangeStop(video);
  // 区间模式：终点 > 起点时，装 timeupdate 监听，播到 B 自动暂停
  const isRange = endSeconds > seconds;
  if (isRange) installRangeStop(video, endSeconds);

  try {
    video.currentTime = Math.max(0, seconds);
    void video.play().catch(() => {
      // 自动播放被浏览器策略拦掉时静默
    });
  } catch {
    // currentTime 写入异常（视频还没加载元数据）→ 等 loadedmetadata 后重试一次
    video.addEventListener(
      "loadedmetadata",
      () => {
        try {
          video.currentTime = Math.max(0, seconds);
          void video.play().catch(() => {});
        } catch {
          /* ignore */
        }
      },
      { once: true },
    );
  }
  block.setAttribute("data-highlight", "true");
  window.setTimeout(() => block.removeAttribute("data-highlight"), 1200);
  return { ok: true };
}

/** 视频元素上挂载的区间自动暂停监听（挂在元素本身，供切换/单点跳转时清理，避免多监听叠加） */
interface RangeStopVideo extends HTMLVideoElement {
  __kbRangeStop?: (() => void) | null;
}

/** 移除该视频上已装的区间自动暂停监听（若有） */
function clearRangeStop(video: HTMLVideoElement): void {
  const v = video as RangeStopVideo;
  if (v.__kbRangeStop) {
    v.removeEventListener("timeupdate", v.__kbRangeStop);
    v.__kbRangeStop = null;
  }
}

/** 给视频装「播放到 endSeconds 自动暂停」监听：到点即 pause 并自我卸载 */
function installRangeStop(video: HTMLVideoElement, endSeconds: number): void {
  const v = video as RangeStopVideo;
  const stop = () => {
    if (v.currentTime >= endSeconds) {
      v.pause();
      clearRangeStop(v);
    }
  };
  v.__kbRangeStop = stop;
  v.addEventListener("timeupdate", stop);
}

/** 简易 CSS.escape polyfill（id 限定 base36，不含特殊字符；安全起见仍走一遍） */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}
