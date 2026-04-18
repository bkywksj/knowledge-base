import { Extension, ReactRenderer } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { linkApi, noteApi } from "@/lib/api";
import {
  WikiLinkSuggestionList,
  type WikiLinkSuggestionListRef,
  type WikiSuggestionItem,
} from "./WikiLinkSuggestionList";

export interface WikiLinkSuggestionOptions {
  /** 选中项后的回调（例如创建新笔记时弹提示） */
  onPicked?: (item: WikiSuggestionItem, createdId: number | null) => void;
}

export const WikiLinkSuggestion = Extension.create<WikiLinkSuggestionOptions>({
  name: "wikiLinkSuggestion",

  addOptions() {
    return { onPicked: undefined };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<WikiSuggestionItem>({
        editor: this.editor,
        char: "[[",
        startOfLine: false,
        allowSpaces: true,
        // 只匹配开头为 [[ 的场景，结尾出现 ]] 时应当退出
        allow: ({ state, range }) => {
          // 若用户已经自己敲了 ]]，则关闭
          const before = state.doc.textBetween(
            Math.max(0, range.from - 2),
            range.to,
            "\n",
            "\0",
          );
          if (before.endsWith("]]")) return false;
          return true;
        },
        items: async ({ query }: { query: string }) => {
          const keyword = query.trim();
          try {
            const results = keyword
              ? await linkApi.searchTargets(keyword, 8)
              : await linkApi.searchTargets("", 8);
            const items: WikiSuggestionItem[] = results.map(([id, title]) => ({
              id,
              title,
            }));
            // 无完全同名时允许创建
            if (keyword && !items.some((i) => i.title === keyword)) {
              items.push({ id: null, title: keyword });
            }
            return items;
          } catch {
            return [];
          }
        },
        command: async ({ editor, range, props }) => {
          const pickedItem = props as WikiSuggestionItem;
          let insertTitle = pickedItem.title;
          let createdId: number | null = null;

          // 创建新笔记：落库后再插入 [[title]]
          if (pickedItem.id === null) {
            try {
              const created = await noteApi.create({
                title: pickedItem.title,
                content: "",
                folder_id: null,
              });
              insertTitle = created.title;
              createdId = created.id;
            } catch {
              // 创建失败：保持插入文本即可，不阻断
            }
          }

          editor
            .chain()
            .focus()
            .insertContentAt(range, `[[${insertTitle}]] `)
            .run();

          this.options.onPicked?.(pickedItem, createdId);
        },
        render: () => {
          let component: ReactRenderer<WikiLinkSuggestionListRef> | null = null;
          let popup: TippyInstance[] | null = null;

          return {
            onStart: (props) => {
              component = new ReactRenderer(WikiLinkSuggestionList, {
                props,
                editor: props.editor,
              });
              if (!props.clientRect) return;
              popup = tippy("body", {
                getReferenceClientRect: () =>
                  props.clientRect?.() ?? new DOMRect(0, 0, 0, 0),
                appendTo: () => document.body,
                content: component.element,
                showOnCreate: true,
                interactive: true,
                trigger: "manual",
                placement: "bottom-start",
                theme: "wiki-suggestion",
                arrow: false,
                offset: [0, 4],
              });
            },
            onUpdate: (props) => {
              component?.updateProps(props);
              if (!props.clientRect) return;
              popup?.[0].setProps({
                getReferenceClientRect: () =>
                  props.clientRect?.() ?? new DOMRect(0, 0, 0, 0),
              });
            },
            onKeyDown: (props) => {
              if (props.event.key === "Escape") {
                popup?.[0].hide();
                return true;
              }
              return component?.ref?.onKeyDown(props) ?? false;
            },
            onExit: () => {
              popup?.[0].destroy();
              component?.destroy();
              popup = null;
              component = null;
            },
          };
        },
      }),
    ];
  },
});
