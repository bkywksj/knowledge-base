/**
 * Tiptap Video 节点
 *
 * 设计要点：
 * - 块级节点，渲染原生 `<video controls preload="metadata">`，借 WebView 自带解码器播放
 * - `preload="metadata"` 只下载首帧元数据，**不会**预加载完整视频，所以打开
 *   含多个视频的笔记不会卡（视频从磁盘流式喂给 WebView）
 * - markdown 序列化为 HTML 标签 `<video src="..." controls></video>`，
 *   依赖 tiptap-markdown 的 `html: true` 选项保留 HTML 节点
 * - parseHTML 同时接住单 src 和 `<video><source src=""></video>` 两种写法，
 *   让外部 .md 里的 HTML 视频引用能被识别成节点
 */
import { Node, mergeAttributes } from "@tiptap/core";

export interface VideoOptions {
  /** 透传给 <video> 元素的额外 HTML 属性 */
  HTMLAttributes: Record<string, unknown>;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    video: {
      /** 在光标处插入视频节点 */
      setVideo: (options: { src: string; poster?: string }) => ReturnType;
    };
  }
}

export const Video = Node.create<VideoOptions>({
  name: "video",

  group: "block",

  // draggable + selectable 让节点可被拖动 / 点选删除
  draggable: true,
  selectable: true,
  atom: true,

  addOptions() {
    return {
      HTMLAttributes: {
        class: "tiptap-video",
        controls: "true",
        preload: "metadata",
      },
    };
  },

  addAttributes() {
    return {
      src: {
        default: null,
        parseHTML: (el) => {
          // 优先取 <video src="...">，其次取首个 <source src="..."> 子元素
          const direct = (el as HTMLElement).getAttribute("src");
          if (direct) return direct;
          const source = (el as HTMLElement).querySelector("source");
          return source?.getAttribute("src") ?? null;
        },
        renderHTML: (attrs) => (attrs.src ? { src: attrs.src as string } : {}),
      },
      poster: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute("poster"),
        renderHTML: (attrs) =>
          attrs.poster ? { poster: attrs.poster as string } : {},
      },
      controls: {
        default: true,
        parseHTML: (el) => (el as HTMLElement).hasAttribute("controls"),
        renderHTML: (attrs) => (attrs.controls === false ? {} : { controls: "true" }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "video",
        // 让外部 .md 里 `<video><source src="x.mp4"></video>` 也能被识别
        getAttrs: (el) => {
          const node = el as HTMLElement;
          const src =
            node.getAttribute("src") ??
            node.querySelector("source")?.getAttribute("src") ??
            null;
          if (!src) return false;
          return { src };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "video",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
    ];
  },

  addCommands() {
    return {
      setVideo:
        (options) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { src: options.src, poster: options.poster ?? null },
          }),
    };
  },
});
