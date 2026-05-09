/**
 * 在 @tiptap/extension-text-style 基础上补字号 / 行间距 / 段落缩进 attr。
 *
 * - 字号：作为 mark.attr.fontSize（写到 span style="font-size: 14px"）
 * - 行间距：作为 paragraph/heading 节点的 attr.lineHeight
 * - 缩进：作为 paragraph 节点的 attr.indent（数值，每级 24px padding-left）
 *
 * Markdown 序列化由 tiptap-markdown 走 prosemirror-markdown：
 * - mark 类型支持有限（粗体/斜体/code/link/strike），fontSize 等扩展属性会被忽略
 * - 字号/行距：只在编辑器内可视化，导出 md 不保留（Notion/语雀同款）
 * - 缩进：indent>0 时导出为 HTML <p data-indent="N">…</p>（依赖 Markdown 配置
 *   html: true），保证保存→重读后缩进还原；详见 ParagraphWithIndent / HeadingWithIndent
 */
import { Extension, getHTMLFromFragment } from "@tiptap/core";
import Paragraph from "@tiptap/extension-paragraph";
import Heading from "@tiptap/extension-heading";
import { Fragment } from "@tiptap/pm/model";
import { TextStyle } from "@tiptap/extension-text-style";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    fontSize: {
      setFontSize: (size: string) => ReturnType;
      unsetFontSize: () => ReturnType;
    };
    lineHeight: {
      setLineHeight: (lh: string) => ReturnType;
      unsetLineHeight: () => ReturnType;
    };
    indent: {
      indent: () => ReturnType;
      outdent: () => ReturnType;
    };
  }
}

/**
 * 字号 mark 扩展。
 *
 * 不另起新 mark name —— 直接继承 TextStyle 加 fontSize attr，复用 textStyle 这个
 * mark 名。这样 @tiptap/extension-color 默认配的 types: ["textStyle"] 仍然有效，
 * 一个 mark 同时承载 color + fontSize 两个 attr，schema 干净。
 */
export const FontSize = TextStyle.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      fontSize: {
        default: null,
        parseHTML: (el: HTMLElement) =>
          el.style.fontSize?.replace(/['"]+/g, "") || null,
        renderHTML: (attrs: { fontSize?: string | null }) =>
          attrs.fontSize ? { style: `font-size: ${attrs.fontSize}` } : {},
      },
    };
  },
  addCommands() {
    return {
      // 必须 spread 父 commands，否则会丢失父 TextStyle 的 removeEmptyTextStyle
      ...(this.parent?.() ?? {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setFontSize: (size: string) => ({ chain }: { chain: () => any }) =>
        chain().setMark("textStyle", { fontSize: size }).run(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      unsetFontSize: () => ({ chain }: { chain: () => any }) => {
        // 不依赖 removeEmptyTextStyle —— 单独清 fontSize attr 后让父扩展的
        // appendTransaction 自然清理空 mark；这样不论父 commands 是否齐全都安全。
        return chain().setMark("textStyle", { fontSize: null }).run();
      },
    };
  },
});

/** 行间距：节点级 attr，作用于 paragraph / heading */
export const LineHeight = Extension.create({
  name: "lineHeight",
  addOptions() {
    return {
      types: ["paragraph", "heading"] as string[],
      defaultLineHeight: null as string | null,
    };
  },
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          lineHeight: {
            default: this.options.defaultLineHeight,
            parseHTML: (el) => (el as HTMLElement).style.lineHeight || null,
            renderHTML: (attrs) =>
              attrs.lineHeight ? { style: `line-height: ${attrs.lineHeight}` } : {},
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setLineHeight:
        (lh: string) =>
        ({ commands }) => {
          // every 会要求所有 types 都返回 true，但当前 selection 只在某一种类型上
          // → 必有一种返回 false → 命令整体失败。改用 some：任一成功即视为成功。
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (this.options.types as string[]).some((t) =>
            (commands as any).updateAttributes(t, { lineHeight: lh }),
          );
        },
      unsetLineHeight:
        () =>
        ({ commands }) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (this.options.types as string[]).some((t) =>
            (commands as any).updateAttributes(t, { lineHeight: null }),
          );
        },
    };
  },
});

/** 段落缩进：indent 数值（0/1/2...），渲染为 padding-left * 24px */
export const Indent = Extension.create({
  name: "indent",
  addOptions() {
    return {
      types: ["paragraph", "heading"] as string[],
      maxLevel: 8,
    };
  },
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          indent: {
            default: 0,
            parseHTML: (el) => {
              const raw = (el as HTMLElement).getAttribute("data-indent");
              const n = raw ? parseInt(raw, 10) : 0;
              return Number.isFinite(n) ? n : 0;
            },
            renderHTML: (attrs) => {
              const n = Number(attrs.indent || 0);
              if (!n) return {};
              return {
                "data-indent": String(n),
                style: `padding-left: ${n * 1.5}em`,
              };
            },
          },
        },
      },
    ];
  },
  addCommands() {
    const max = this.options.maxLevel;
    const types = this.options.types as string[];
    return {
      indent:
        () =>
        ({ state, commands }) => {
          const { $from } = state.selection;
          for (let d = $from.depth; d > 0; d--) {
            const node = $from.node(d);
            if (types.includes(node.type.name)) {
              const cur = Number(node.attrs.indent || 0);
              if (cur >= max) return false;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              return (commands as any).updateAttributes(node.type.name, {
                indent: cur + 1,
              });
            }
          }
          return false;
        },
      outdent:
        () =>
        ({ state, commands }) => {
          const { $from } = state.selection;
          for (let d = $from.depth; d > 0; d--) {
            const node = $from.node(d);
            if (types.includes(node.type.name)) {
              const cur = Number(node.attrs.indent || 0);
              if (cur <= 0) return false;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              return (commands as any).updateAttributes(node.type.name, {
                indent: cur - 1,
              });
            }
          }
          return false;
        },
    };
  },
  // Tab / Shift-Tab：扩展加载顺序里 Indent 在 StarterKit 之后，addKeyboardShortcuts
  // 后注册的会覆盖先注册的；如果直接走 indent()，列表里按 Tab 只会给 listItem 内
  // 的 paragraph 加 padding-left，而不会 sink 嵌套层级。所以这里先嗅探光标是否在
  // listItem / taskItem 里：是 → 走 sinkListItem / liftListItem；否 → fallback 到
  // 段落 / 标题的 indent / outdent。
  addKeyboardShortcuts() {
    const inListItem = (typeName: "listItem" | "taskItem"): boolean => {
      const { $from } = this.editor.state.selection;
      for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type.name === typeName) return true;
      }
      return false;
    };
    return {
      Tab: () => {
        if (inListItem("listItem"))
          return this.editor.commands.sinkListItem("listItem");
        if (inListItem("taskItem"))
          return this.editor.commands.sinkListItem("taskItem");
        return this.editor.commands.indent();
      },
      "Shift-Tab": () => {
        if (inListItem("listItem"))
          return this.editor.commands.liftListItem("listItem");
        if (inListItem("taskItem"))
          return this.editor.commands.liftListItem("taskItem");
        return this.editor.commands.outdent();
      },
    };
  },
});

/**
 * paragraph / heading 的 markdown 序列化：当节点带"非默认"属性（缩进 indent>0
 * 或对齐 textAlign 非 left）时输出 HTML 块，让 Markdown 文件保留这些可视格式
 * （依赖 `html: true` + 各属性 parseHTML 闭环）；都为默认时退回 prosemirror-markdown
 * 默认序列化（普通段落 / # 标题），保持 .md 可读性。
 *
 * 必须把 StarterKit 的 paragraph / heading 关掉换成这两个，否则会和我们这里的
 * addStorage 重名冲突 —— 详见 TiptapEditor.tsx 的 StarterKit.configure。
 */
function makeIndentMarkdownStorage(parentStorage: Record<string, unknown>) {
  return {
    ...parentStorage,
    markdown: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      serialize(state: any, node: any) {
        const indent = Number(node.attrs?.indent || 0);
        const textAlign = node.attrs?.textAlign as string | null | undefined;
        const hasAlign = !!textAlign && textAlign !== "left";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const editor = (this as any).editor;
        const htmlAllowed = !!editor?.storage?.markdown?.options?.html;

        if ((indent > 0 || hasAlign) && htmlAllowed) {
          // 走 HTML：renderHTML 会同时合并 data-indent / style:padding-left /
          // style:text-align（TextAlign / Indent 各自的 addGlobalAttributes
          // 注入），解析端 markdown-it 把 HTML 块原样保留 → ProseMirror 重建时
          // paragraph/heading 的 parseHTML 把这些属性还原。
          const html = getHTMLFromFragment(Fragment.from(node), node.type.schema);
          state.write(html);
          state.closeBlock(node);
          return;
        }

        // 退回原版：paragraph → 行内 + 空行；heading → '#' * level + 空格 + 行内 + 空行
        const name = node.type.name;
        if (name === "heading") {
          const level = Math.max(1, Number(node.attrs?.level || 1));
          state.write("#".repeat(level) + " ");
          state.renderInline(node);
          state.closeBlock(node);
          return;
        }
        // 空段落：Markdown 没有"空段落"概念，markdown-it 会把多个连续空行折叠成
        // 单个段落分隔符，导致用户按 Enter 留出的视觉空行保存后丢失。改写为
        // <p><br></p> HTML 块（依赖 html: true），markdown-it 原样保留 HTML 块，
        // 重读时解析回带 hardBreak 的段落，视觉空行被保留。
        if (name === "paragraph" && node.content.size === 0 && htmlAllowed) {
          state.write("<p><br></p>");
          state.closeBlock(node);
          return;
        }
        // paragraph / 默认
        state.renderInline(node);
        state.closeBlock(node);
      },
      parse: {},
    },
  };
}

export const ParagraphWithIndent = Paragraph.extend({
  addStorage() {
    return makeIndentMarkdownStorage(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((this as any).parent?.() ?? {}) as Record<string, unknown>,
    );
  },
});

export const HeadingWithIndent = Heading.extend({
  addStorage() {
    return makeIndentMarkdownStorage(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((this as any).parent?.() ?? {}) as Record<string, unknown>,
    );
  },
});
