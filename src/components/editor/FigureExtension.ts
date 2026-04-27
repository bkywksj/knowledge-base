import ImageResize from "tiptap-extension-resize-image";

/**
 * 图片节点扩展：在 ImageResize 之上叠加 `caption`（图注）和 `alt`（替代文本）
 *
 * 设计原则：
 *   1. **不动 ImageResize 的 NodeView**——保留原拖拽缩放手柄，避免重写 200+ 行
 *      原生 NodeView。caption/alt 编辑入口由外部（EditorToolbar 的 "图注" 按钮 +
 *      Modal）提供，比侵入 NodeView 风险低得多。
 *   2. **存储兼容**：无 caption 的图片走标准 markdown `![alt](url)`；只有当 caption
 *      非空时才落 raw HTML `<figure><img.../><figcaption>...</figcaption></figure>`。
 *      这样旧笔记不破坏，导出成 .md 也兼容（CommonMark 允许 raw HTML，主流 markdown
 *      渲染器能识别 figure）。
 *   3. **解析回填**：粘贴含 `<figure>` 的 HTML 或加载历史 figure 笔记时，能把
 *      caption / alt 还原到 attrs。
 *
 * 与"表格自定义列宽 → HTML 兜底"采用同一思路（见 TiptapEditor.tsx 的
 * TableWithMarkdown）。
 */
export const FigureImage = ImageResize.extend({
  addAttributes() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parent = (this as any).parent?.() ?? {};
    return {
      ...parent,
      // ImageResize 的基础 attrs 里 alt 通常已有；这里显式声明确保 parseHTML/renderHTML
      // 都能拿到，并提供安全 fallback
      alt: {
        default: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parseHTML: (el: any) => el.getAttribute("alt") || null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        renderHTML: (attrs: any) => (attrs.alt ? { alt: attrs.alt } : {}),
      },
      caption: {
        default: null,
        // 从 figure 的 figcaption 文本读出（parseHTML 钩子在 figure 那条规则里）；
        // 也接受 img 上的 data-caption / title 兜底（某些 paste 路径会先经过 img 规则）
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parseHTML: (el: any) =>
          el.getAttribute("data-caption") || el.getAttribute("title") || null,
        // 同时输出 title，让编辑器 live view 鼠标 hover 也能看到图注；data-caption
        // 是给搜索/调试看的稳定 attr。
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        renderHTML: (attrs: any) =>
          attrs.caption
            ? { "data-caption": attrs.caption, title: attrs.caption }
            : {},
      },
    };
  },

  parseHTML() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parentRules = ((this as any).parent?.() ?? []) as any[];
    return [
      // 优先匹配 figure，把 figcaption 文本提到 caption attr，避免落到 img 规则
      // 后丢掉 caption 信息
      {
        tag: "figure",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getAttrs: (node: any) => {
          const el = node as HTMLElement;
          const img = el.querySelector("img");
          if (!img) return false; // 不是 figure(img) 就不匹配
          const figcap = el.querySelector("figcaption");
          return {
            src: img.getAttribute("src"),
            alt: img.getAttribute("alt") || null,
            width: img.getAttribute("width") || null,
            height: img.getAttribute("height") || null,
            caption: figcap?.textContent?.trim() || null,
          };
        },
      },
      ...parentRules,
    ];
  },

  renderHTML({ HTMLAttributes }) {
    // 有 caption → 包成 figure；没有 → 走原 img 渲染（让 ImageResize 的 NodeView 接管）
    const caption = HTMLAttributes.caption;
    if (caption) {
      const { caption: _drop, ...imgAttrs } = HTMLAttributes;
      void _drop;
      return [
        "figure",
        { class: "tiptap-figure" },
        ["img", imgAttrs],
        ["figcaption", {}, caption],
      ];
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parent = (this as any).parent?.bind(this) as
      | ((arg: { HTMLAttributes: Record<string, unknown> }) => unknown)
      | undefined;
    if (parent) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return parent({ HTMLAttributes }) as any;
    }
    return ["img", HTMLAttributes];
  },

  // tiptap-markdown 的 storage 注入：override 默认的 image markdown 序列化
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
          const { src, alt, caption } = node.attrs;
          // 有 caption → 走 raw HTML（前提是 markdown plugin 配 html: true，已开启）
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const editor = (this as any).editor;
          const htmlAllowed = editor?.storage?.markdown?.options?.html;
          if (caption && htmlAllowed) {
            const safeAlt = String(alt ?? "")
              .replace(/&/g, "&amp;")
              .replace(/"/g, "&quot;");
            const safeCap = String(caption)
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;");
            const safeSrc = String(src ?? "").replace(/&/g, "&amp;");
            state.write(
              `<figure>\n<img src="${safeSrc}" alt="${safeAlt}">\n<figcaption>${safeCap}</figcaption>\n</figure>`,
            );
            state.closeBlock(node);
            return;
          }
          // 普通 markdown 图片（与 tiptap-markdown 默认实现一致）
          const altText = (alt ?? "").replace(/[\[\]]/g, "");
          const url = (src ?? "").replace(/[()]/g, (c: string) =>
            c === "(" ? "%28" : "%29",
          );
          state.write(`![${altText}](${url})`);
          // image 在普通 markdown 里是 inline，不需要 closeBlock
        },
        parse: {
          // markdown 解析由 markdown-it 处理：标准 ![alt](url) 自动还原；
          // figure HTML 块走 raw HTML 通路 → 走上面的 parseHTML figure 规则
        },
      },
    };
  },
});
