import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

export interface WikiLinkOptions {
  /** Ctrl/Cmd + 点击 [[标题]] 时触发 */
  onClick: (title: string) => void;
}

const WIKI_LINK_REGEX = /\[\[([^\[\]\n]+)\]\]/g;

function buildDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text;
    WIKI_LINK_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WIKI_LINK_REGEX.exec(text)) !== null) {
      const from = pos + match.index;
      const to = from + match[0].length;
      const title = match[1].trim();
      if (!title) continue;
      decorations.push(
        Decoration.inline(from, to, {
          class: "wiki-link",
          "data-wiki-link": title,
          title: `Ctrl/Cmd + 点击跳转到「${title}」`,
        }),
      );
    }
  });
  return DecorationSet.create(doc, decorations);
}

export const WikiLinkDecoration = Extension.create<WikiLinkOptions>({
  name: "wikiLinkDecoration",

  addOptions() {
    return { onClick: () => {} };
  },

  addProseMirrorPlugins() {
    const pluginKey = new PluginKey<DecorationSet>("wikiLinkDecoration");
    const onClick = this.options.onClick;

    return [
      new Plugin({
        key: pluginKey,
        state: {
          init: (_, { doc }) => buildDecorations(doc),
          apply: (tr, oldSet) => {
            if (!tr.docChanged) return oldSet.map(tr.mapping, tr.doc);
            return buildDecorations(tr.doc);
          },
        },
        props: {
          decorations(state) {
            return pluginKey.getState(state) ?? DecorationSet.empty;
          },
          // 仅 Ctrl/Cmd + 点击触发跳转，保留普通点击的光标定位
          handleClick(_view, _pos, event) {
            if (!(event.ctrlKey || event.metaKey)) return false;
            const target = event.target as HTMLElement | null;
            const el = target?.closest("[data-wiki-link]") as HTMLElement | null;
            if (!el) return false;
            const title = el.getAttribute("data-wiki-link");
            if (!title) return false;
            event.preventDefault();
            onClick(title);
            return true;
          },
        },
      }),
    ];
  },
});
