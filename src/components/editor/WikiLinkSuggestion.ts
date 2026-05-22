import { Extension, ReactRenderer } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { linkApi } from "@/lib/api";
import {
  WikiLinkSuggestionList,
  type WikiLinkSuggestionListRef,
  type WikiSuggestionItem,
} from "./WikiLinkSuggestionList";

/**
 * 检查光标位置前后是否构成 `【【…】】`(已配对) 或 `【【` 形态,
 * 返回应当 dispatch 的替换 transaction;否则返回 null。
 *
 * 同时被 appendTransaction(普通输入路径) 和 compositionend(IME 路径) 调用。
 */
function buildFullwidthBracketReplacement(
  state: EditorState,
): Transaction | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const { from } = selection;
  if (from < 2) return null;
  const before = state.doc.textBetween(from - 2, from, "\n", "\0");
  if (before !== "【【") return null;

  const docSize = state.doc.content.size;
  const lookAhead = Math.min(2, docSize - from);
  const after =
    lookAhead > 0
      ? state.doc.textBetween(from, from + lookAhead, "\n", "\0")
      : "";

  if (after === "】】") {
    // 已配对(IME 自动补右括号): 整段 `【【】】` → `[[]]`,光标停在中间
    const tr = state.tr.replaceWith(
      from - 2,
      from + 2,
      state.schema.text("[[]]"),
    );
    return tr.setSelection(TextSelection.create(tr.doc, from));
  }

  // 普通场景: 只替换光标前的 `【【` → `[[`
  return state.tr.replaceWith(from - 2, from, state.schema.text("[["));
}

export const WikiLinkSuggestion = Extension.create({
  name: "wikiLinkSuggestion",

  addProseMirrorPlugins() {
    return [
      // 中文全角双方括号 `【【` → `[[` 自动改写,复用同一条 Suggestion 触发链。
      // Why: 需要同时覆盖 3 类输入路径:
      //   ① 普通键盘输入 → appendTransaction 立即捕获
      //   ② IME 提交 `【` → ProseMirror 在 composition 期间会暂停应用外部
      //      transaction(防止打断输入法),appendTransaction 即使返回新 tr 也
      //      会被丢弃。必须在 compositionend DOM 事件后用 setTimeout 跳出本轮
      //      事件循环,等 ProseMirror 完成 IME 收尾,再主动 view.dispatch。
      //   ③ 部分输入法会把 `【` 自动配对成 `【】`,两次后变成 `【【】】`(光标在中间),
      //      buildFullwidthBracketReplacement 内部识别这种已配对形态,
      //      整段替换为 `[[]]` 并把光标放回中间。
      // 替换后 Suggestion plugin 自动检测光标前的 `[[` 触发候选浮层。
      new Plugin({
        key: new PluginKey("wikiLinkFullwidthBracketReplace"),
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          return buildFullwidthBracketReplacement(newState);
        },
        props: {
          handleDOMEvents: {
            compositionend: (view) => {
              // 等本轮事件循环结束: ProseMirror 内部 view.composing 才会清掉,
              // 否则 dispatch 出来的 tr 会被忽略。
              setTimeout(() => {
                const tr = buildFullwidthBracketReplacement(view.state);
                if (tr) view.dispatch(tr);
              }, 0);
              return false;
            },
          },
        },
      }),
      Suggestion<WikiSuggestionItem>({
        editor: this.editor,
        char: "[[",
        startOfLine: false,
        allowSpaces: true,
        // 关闭"前一字符必须是空格/行首"的限制；中英混排时常见的
        // `中文[[`、`word[[` 也应触发候选列表（对齐 Obsidian 行为）。
        // 默认 `allowedPrefixes = [' ']` 会把这些场景拒掉。
        allowedPrefixes: null,
        // 用户已经自己敲了 ]] 时应当退出
        allow: ({ state, range }) => {
          const before = state.doc.textBetween(
            Math.max(0, range.from - 2),
            range.to,
            "\n",
            "\0",
          );
          return !before.endsWith("]]");
        },
        items: async ({ query }: { query: string }) => {
          const keyword = query.trim();
          try {
            const results = await linkApi.searchTargets(keyword, 8);
            return results.map((r) => ({
              id: r.id,
              title: r.title,
              folderName: r.folderName,
            }));
          } catch {
            return [];
          }
        },
        // 插入「字面 ID 锚点」形式：`[[标题|ID]]`
        // ID 是稳定锚点，目标笔记改名/重名都不影响反链解析（详见
        // database/links.rs::extract_wiki_refs 的优先级注释）。
        // 编辑器里 WikiLinkDecoration 会用 CSS 把 `|ID` 段隐藏，视觉上仍是 `[[标题]]`。
        command: ({ editor, range, props }) => {
          const pickedItem = props as WikiSuggestionItem;
          editor
            .chain()
            .focus()
            .insertContentAt(range, `[[${pickedItem.title}|${pickedItem.id}]] `)
            .run();
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
