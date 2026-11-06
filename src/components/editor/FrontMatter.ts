/**
 * YAML front-matter 节点：文档开头的 `---` 元数据块，显示为属性卡片，
 * 保存时按原文写回。
 *
 * 没有这个节点时，markdown-it 会把首行 `---` 解析成分割线、把「YAML + 第二条 ---」
 * 解析成二级标题，外部 .md 一保存就被改坏。
 *
 * 只能出现在文档第一个位置，靠两层保证：
 * - doc 的 content 表达式只在开头留了位置，不进 block 组，也就无法插到别处
 * - parse 规则带 `context: "doc/"`：只有整篇解析才命中。粘贴 / insertContent 走
 *   parseSlice 时不命中，<pre> 落回代码块规则 —— 内容变成代码块，不会被丢掉
 */
import { Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { matchFrontMatter } from "@/lib/frontMatter";
import { FrontMatterNodeView } from "./FrontMatterNodeView";

/**
 * 替换 StarterKit 的 Document。
 * block+ 必须写在前面：ProseMirror 补全空文档时按先后取第一个可用类型，
 * frontMatter 排前面的话，每篇空笔记都会被塞进一个空属性块。
 */
export const DocumentWithFrontMatter = Node.create({
  name: "doc",
  topNode: true,
  content: "(block+ | frontMatter block+)",
});

/** markdown-it 的最小结构签名，原因同 CodeBlockEnhanced 的 MarkdownItLike */
interface MarkdownItLike {
  block: {
    ruler: {
      before(
        beforeName: string,
        ruleName: string,
        rule: (state: BlockStateLike, startLine: number, endLine: number, silent: boolean) => boolean,
      ): void;
    };
  };
  renderer: {
    rules: Record<string, (tokens: { content: string }[], idx: number) => string>;
  };
  utils: { escapeHtml(text: string): string };
}

interface BlockStateLike {
  src: string;
  line: number;
  push(type: string, tag: string, nesting: number): { content: string; map: number[]; block: boolean };
}

/** parse.setup 每次解析都会被调用，同一实例只注册一次 */
const patched = new WeakSet<MarkdownItLike>();

export const FrontMatter = Node.create({
  name: "frontMatter",
  atom: true,
  selectable: false,
  draggable: false,
  // 要先于核心 keymap 拦截 Backspace
  priority: 1000,

  addAttributes() {
    return {
      raw: {
        default: "",
        parseHTML: (el) => (el as HTMLElement).textContent ?? "",
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [{ tag: "pre[data-front-matter]", context: "doc/", priority: 100 }];
  },

  renderHTML({ node }) {
    return [
      "pre",
      { "data-front-matter": "true" },
      ["code", { class: "language-yaml" }, String(node.attrs.raw ?? "")],
    ];
  },

  addNodeView() {
    // 卡片内的点击和拖选都归卡片自己，不交给 ProseMirror 改光标
    return ReactNodeViewRenderer(FrontMatterNodeView, { stopEvent: () => true });
  },

  addKeyboardShortcuts() {
    return {
      // 默认行为是在首段开头按一下退格就删掉前面的 atom。属性块会写回外部文件，
      // 这里挡住误删；要删就在卡片里清空内容。
      Backspace: () => {
        const { $from, empty } = this.editor.state.selection;
        return (
          empty &&
          $from.parentOffset === 0 &&
          $from.depth === 1 &&
          $from.index(0) === 1 &&
          this.editor.state.doc.child(0).type.name === this.name
        );
      },
    };
  },

  addStorage() {
    return {
      markdown: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serialize(state: any, node: any) {
          state.write(String(node.attrs.raw ?? ""));
          state.closeBlock(node);
        },
        parse: {
          setup(markdownit: MarkdownItLike) {
            if (patched.has(markdownit)) return;
            patched.add(markdownit);

            markdownit.block.ruler.before("table", "front_matter", (state, startLine, _endLine, silent) => {
              // blockquote / 列表的子解析 startLine 也可能是 0，但那时 src 开头不是 ---
              if (startLine !== 0) return false;
              const match = matchFrontMatter(state.src);
              if (!match) return false;
              if (silent) return true;
              const token = state.push("front_matter", "", 0);
              token.content = match.raw;
              token.map = [0, match.lineCount];
              token.block = true;
              state.line = match.lineCount;
              return true;
            });

            markdownit.renderer.rules.front_matter = (tokens, idx) =>
              `<pre data-front-matter="true"><code class="language-yaml">${markdownit.utils.escapeHtml(
                tokens[idx].content,
              )}</code></pre>`;
          },
        },
      },
    };
  },
});
