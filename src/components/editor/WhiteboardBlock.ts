/**
 * 笔记内嵌白板块：在正文里嵌一块可编辑的画布，平时显示成预览图。
 *
 * 形态对齐飞书文档的「画板」：块在笔记里是一张图，点开进画布编辑，
 * 存完回到笔记还是一张图 —— 但数据是活的，随时能再改。
 *
 * 设计（与同目录的 DataviewBlock 一脉相承）：
 * - **叶子节点**（atom=true）：内部没有可编辑子内容，整块交给 NodeView 渲染
 * - **数据存文件、节点只存引用**：
 *   - `scene`：`kb-asset://…/wb-xxx.excalidraw`，Excalidraw 场景 JSON
 *   - `preview`：`kb-asset://…/wb-xxx.png`，渲染好的预览图
 *   画布 JSON 动辄几百 KB，内联进节点属性会让 `.md` 没法看、每次保存都搬一遍数据。
 *   两个引用都是 `kb-asset://` 形式 → 自动被 Rust 侧 `attachment_scan` 认成本地资产
 *   → 跟着既有的附件同步走，不用另写规则。
 * - **Markdown 兼容**：靠 tiptap-markdown 的 `html: true` 原样透传 div；
 *   外部 md 工具看到的是一个带 data 属性的空 div，导回应用时 parseHTML 重新识别
 */
import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { WhiteboardBlockNodeView } from "./WhiteboardBlockNodeView";

export interface WhiteboardBlockOptions {
  HTMLAttributes: Record<string, unknown>;
  /**
   * 取当前笔记 id —— 保存场景文件和预览图都要按笔记归目录。
   *
   * 必须是函数而不是值：`useEditor` 只在挂载时执行一次，闭包捕获的 noteId
   * 会永远停在第一次的值，切到别的笔记后白板资源就存错目录了。
   * 与 SlashCommand 的 `getNoteId` 同一约定。
   */
  getNoteId: () => number | undefined;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    whiteboardBlock: {
      /** 插入一块空白板；插入后 NodeView 会提示用户点击开始绘制 */
      insertWhiteboard: () => ReturnType;
    };
  }
}

export const WhiteboardBlock = Node.create<WhiteboardBlockOptions>({
  name: "whiteboardBlock",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return {
      HTMLAttributes: { class: "tiptap-whiteboard" },
      getNoteId: () => undefined,
    };
  },

  addAttributes() {
    return {
      /** 场景文件引用；null = 还没画过（空块） */
      scene: {
        default: null as string | null,
        parseHTML: (el) => (el as HTMLElement).getAttribute("data-wb-scene"),
        renderHTML: (attrs) =>
          attrs.scene ? { "data-wb-scene": attrs.scene } : {},
      },
      /** 预览图引用；null = 还没画过 */
      preview: {
        default: null as string | null,
        parseHTML: (el) => (el as HTMLElement).getAttribute("data-wb-preview"),
        renderHTML: (attrs) =>
          attrs.preview ? { "data-wb-preview": attrs.preview } : {},
      },
      /**
       * 预览图的真实像素尺寸。存下来是为了让块在图片**加载完成前**就占住正确高度，
       * 否则每次打开笔记，白板块都会从 0 高度撑开，把下方内容顶得跳一下。
       */
      width: {
        default: null as number | null,
        parseHTML: (el) => {
          const v = (el as HTMLElement).getAttribute("data-wb-w");
          return v ? Number(v) : null;
        },
        renderHTML: (attrs) => (attrs.width ? { "data-wb-w": attrs.width } : {}),
      },
      height: {
        default: null as number | null,
        parseHTML: (el) => {
          const v = (el as HTMLElement).getAttribute("data-wb-h");
          return v ? Number(v) : null;
        },
        renderHTML: (attrs) =>
          attrs.height ? { "data-wb-h": attrs.height } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-kb-whiteboard]" }];
  },

  renderHTML({ HTMLAttributes }) {
    // 始终带上 data-kb-whiteboard 标记位，parseHTML 靠它认回来。
    // 属性值由 addAttributes 的 renderHTML 逐个合并进来。
    return [
      "div",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        "data-kb-whiteboard": "",
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(WhiteboardBlockNodeView);
  },

  /**
   * Markdown 序列化。
   *
   * 🔴 **不写这个，白板块保存一次就没了。** 实测：插入块 → 保存 → `notes.content`
   * 里只剩一个空 `<p></p>`。`Markdown.configure({ html: true })` 只保证**已有的**
   * HTML 片段原样透传，它管不到「ProseMirror 节点该序列化成什么」——
   * 自定义 atom 节点没有注册 serializer 时，prosemirror-markdown 直接把它跳过。
   *
   * 输出的 div 与 `renderHTML` / `parseHTML` 三者必须对齐，
   * 这样「存成 md → 下次打开解析回来」才是无损往返。
   */
  addStorage() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parentStorage = ((this as any).parent?.() ?? {}) as Record<
      string,
      unknown
    >;
    return {
      ...parentStorage,
      markdown: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serialize(state: any, node: any) {
          const { scene, preview, width, height } = node.attrs;
          const esc = (v: unknown) =>
            String(v ?? "")
              .replace(/&/g, "&amp;")
              .replace(/"/g, "&quot;");
          const attrs = [
            "data-kb-whiteboard",
            scene ? `data-wb-scene="${esc(scene)}"` : "",
            preview ? `data-wb-preview="${esc(preview)}"` : "",
            width ? `data-wb-w="${esc(width)}"` : "",
            height ? `data-wb-h="${esc(height)}"` : "",
          ]
            .filter(Boolean)
            .join(" ");
          state.write(`<div ${attrs}></div>`);
          state.closeBlock(node);
        },
      },
    };
  },

  addCommands() {
    return {
      insertWhiteboard:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: {} }),
    };
  },
});
