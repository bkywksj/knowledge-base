/**
 * Columns / 分栏布局节点（语雀 / Notion 风：一行并排 2–5 列，每列可放任意块）
 *
 * 结构：
 *   - columns:  容器节点（group=block），content = "column+"，CSS flex 横排
 *   - column:   单列节点（无 group，只能出现在 columns 内），content = "block+"
 *
 * schema 上只要求 ≥1 列（用 "column+" 而非 "column{2,}"）—— 否则删到只剩 2 列
 * 时再删一列会因违反 schema 而失败，用户感觉「最后的分栏删不掉」。剩 1 列时由
 * addProseMirrorPlugins 里的 appendTransaction 自动把这唯一一列的内容拆出来、
 * 去掉空壳的 columns 包裹（即「分栏自动解散」）。插入命令仍固定给 2–5 列。
 *
 * 典型用法「左图右文」：第一列放图片，第二列放段落。
 *
 * 列宽：column.attrs.width 为 0–1 的弹性占比（默认 null → 各列等宽 flex:1）。
 * v1 暂不做拖拽分隔条，等宽即可；保留 width 属性供后续扩展。
 *
 * Markdown 兼容：渲染为 `<div data-columns><div data-column>…</div>…</div>` HTML，
 * 依赖 tiptap-markdown `html:true` 透传（与 Callout / Toggle 同策略）；外部 md
 * 工具看到嵌套 div（无样式但内容保留），导回应用时 parseHTML 重新识别。
 */
import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { ColumnsNodeView } from "./ColumnsNodeView";
import { ColumnNodeView } from "./ColumnNodeView";

export interface ColumnsOptions {
  HTMLAttributes: Record<string, unknown>;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    columns: {
      /** 在当前位置插入一个 count 列（2–5）的分栏块，每列一个空段落 */
      setColumns: (count?: number) => ReturnType;
    };
  }
}

/** 单列节点：只能作为 columns 的子节点 */
export const Column = Node.create({
  name: "column",
  content: "block+",
  isolating: true,
  defining: true,

  addAttributes() {
    return {
      // 0–1 的弹性占比；null 表示与兄弟列等宽
      width: {
        default: null as number | null,
        parseHTML: (el) => {
          const raw = (el as HTMLElement).getAttribute("data-width");
          const n = raw ? Number(raw) : NaN;
          return Number.isFinite(n) && n > 0 ? n : null;
        },
        renderHTML: (attrs) => {
          const w = attrs.width as number | null;
          if (!w || !Number.isFinite(w)) return {};
          return { "data-width": String(w), style: `flex: ${w} 1 0;` };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-column]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-column": "true", class: "tiptap-column" }),
      0,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ColumnNodeView);
  },
});

export const Columns = Node.create<ColumnsOptions>({
  name: "columns",
  group: "block",
  // 只要求 ≥1 列：让"删到剩一列"能成立，剩 1 列时 appendTransaction 自动解散
  content: "column+",
  defining: true,

  addOptions() {
    return {
      HTMLAttributes: { class: "tiptap-columns" },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-columns]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        "data-columns": "true",
      }),
      0,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ColumnsNodeView);
  },

  // 分栏自动解散：任何改动后，若某个 columns 只剩 1 列 → 用那一列的内容替换掉
  // 整个 columns 节点（删空一列、删到剩一列、外部导入畸形结构等都能自愈）。
  addProseMirrorPlugins() {
    const type = this.type;
    return [
      new Plugin({
        key: new PluginKey("columnsAutoDissolve"),
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          const targets: Array<{ pos: number; node: PMNode }> = [];
          newState.doc.descendants((node, pos) => {
            if (node.type === type && node.childCount <= 1) {
              targets.push({ pos, node });
            }
            return true;
          });
          if (targets.length === 0) return null;
          const tr = newState.tr;
          // 从后往前改：高位的替换不影响低位 pos，无需 mapping
          for (const { pos, node } of targets.sort((a, b) => b.pos - a.pos)) {
            const only = node.firstChild;
            if (only) {
              // 拆出唯一一列的内容，替换掉整个 columns 空壳
              tr.replaceWith(pos, pos + node.nodeSize, only.content);
            } else {
              // childCount===0（理论上 column+ 不会出现）：兜底删空壳
              tr.delete(pos, pos + node.nodeSize);
            }
          }
          return tr.docChanged ? tr : null;
        },
      }),
    ];
  },

  addCommands() {
    return {
      setColumns:
        (count?: number) =>
        ({ commands }) => {
          const n = Math.min(5, Math.max(2, Math.trunc(count ?? 2)));
          return commands.insertContent({
            type: this.name,
            content: Array.from({ length: n }, () => ({
              type: "column",
              content: [{ type: "paragraph" }],
            })),
          });
        },
    };
  },

  // column.isolating=true 时光标无法用 Backspace 跨出列，普通按键删不掉整块。
  // 这里在「列首段开头按 Backspace」时兜底：整块全空 → 直接删除；否则 → 选中
  // 整个 columns 节点（再按一次 Backspace/Delete 即删，PM 默认行为）。
  addKeyboardShortcuts() {
    const name = this.name;
    return {
      Backspace: ({ editor }) => {
        const { selection } = editor.state;
        if (!selection.empty) return false;
        const { $from } = selection;
        if ($from.parentOffset !== 0) return false;
        if ($from.parent.type.name !== "paragraph") return false;

        // 必须站在某一列的第一个段落开头
        const colDepth = $from.depth - 1;
        if (colDepth < 1) return false;
        const colNode = $from.node(colDepth);
        if (colNode.type.name !== "column") return false;
        if (colNode.firstChild !== $from.parent) return false;

        const columnsDepth = colDepth - 1;
        const columnsNode = $from.node(columnsDepth);
        if (columnsNode.type.name !== name) return false;
        // 只在「首列首段」拦截，其它列的列首交给默认行为（什么都不做也无妨）
        if (columnsNode.firstChild !== colNode) return false;

        let allEmpty = true;
        columnsNode.forEach((col) => {
          if (
            col.childCount !== 1 ||
            col.firstChild?.type.name !== "paragraph" ||
            (col.firstChild?.content.size ?? 0) !== 0
          ) {
            allEmpty = false;
          }
        });

        const pos = $from.before(columnsDepth);
        if (allEmpty) {
          return editor
            .chain()
            .focus()
            .deleteRange({ from: pos, to: pos + columnsNode.nodeSize })
            .run();
        }
        // 非空：选中整块，提示用户再按一次删除（同 horizontalRule 等的默认体验）
        return editor.chain().focus().setNodeSelection(pos).run();
      },
    };
  },
});
