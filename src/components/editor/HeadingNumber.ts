/**
 * HeadingNumber —— 标题自动编号（Decoration 版，替代原来的 CSS counter 实现）
 *
 * 为什么从 CSS counter 换成 ProseMirror Decoration，见 `@/lib/headingNumber` 的文件头注释。
 * 一句话：CSS counter 的编号取不出来（复制/大纲拿不到）、不能悬挂对齐，
 * 且折叠标题时 `display:none` 会让计数器失效导致下级编号不重置。
 *
 * 实现要点：
 * - 计算全部委托给纯函数 `computeHeadingNumbers(doc)`，本文件只负责"算完挂 widget"
 * - plugin state 同时缓存 entries / byPos，供**大纲面板**和**复制序列化**直接读，
 *   保证三处显示的编号永远是同一份数据（用户反馈的"正文有编号、大纲没有"由此根治）
 * - widget 放在 `pos + 1`（heading 节点内部第一个位置），side 取 -0.5：
 *   排在折叠 chevron（side -1，挂在标题左侧外）之后、标题文字之前
 * - 编号是**纯显示层**：不进 doc、不进 markdown、不写 .md、不参与同步
 */
import { Extension } from "@tiptap/react";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import {
  computeHeadingNumbers,
  type HeadingNumberEntry,
  type HeadingNumberOptions,
} from "@/lib/headingNumber";

export interface HeadingNumberExtOptions {
  /** 是否启用编号（跟随设置页开关；关闭时不产生任何 widget） */
  getEnabled: () => boolean;
  /** 编号参数（格式 / 起始层级 / 是否跳过手写编号），跟随设置页 */
  getOptions: () => HeadingNumberOptions;
}

interface HeadingNumberPluginState {
  entries: HeadingNumberEntry[];
  /** heading 的 PM pos → 编号文本；没编号的标题不在表里 */
  byPos: Map<number, string>;
  deco: DecorationSet;
}

const HEADING_NUMBER_KEY = new PluginKey<HeadingNumberPluginState>("kb-heading-number");

/** 外部 dispatch 这条 meta 即可强制重算（设置项变化时用） */
export const HEADING_NUMBER_REFRESH = "refresh";

const EMPTY_STATE: HeadingNumberPluginState = {
  entries: [],
  byPos: new Map(),
  deco: DecorationSet.empty,
};

function build(
  doc: import("@tiptap/pm/model").Node,
  enabled: boolean,
  opts: HeadingNumberOptions,
): HeadingNumberPluginState {
  if (!enabled) return EMPTY_STATE;

  const entries = computeHeadingNumbers(doc, opts);
  const byPos = new Map<number, string>();
  const decorations: Decoration[] = [];

  for (const e of entries) {
    if (!e.label) continue; // 层级范围外 / 已有手写编号
    byPos.set(e.pos, e.label);
    decorations.push(
      Decoration.widget(
        e.pos + 1,
        () => {
          const span = document.createElement("span");
          span.className = "kb-hnum";
          span.setAttribute("data-level", String(e.level));
          span.contentEditable = "false";
          span.textContent = e.label as string;
          return span;
        },
        {
          // -1 是折叠 chevron 的位置（挂在标题左侧外），编号要排在它之后、文字之前
          side: -0.5,
          ignoreSelection: true,
          // key 带上 label：编号变了才重建 DOM，滚动/输入时不做无谓重绘
          key: `hnum-${e.level}-${e.label}`,
        },
      ),
    );
  }

  return { entries, byPos, deco: DecorationSet.create(doc, decorations) };
}

export const HeadingNumber = Extension.create<HeadingNumberExtOptions>({
  name: "kbHeadingNumber",

  addOptions() {
    return {
      getEnabled: () => false,
      getOptions: () => ({}),
    };
  },

  addProseMirrorPlugins() {
    const opts = this.options;

    return [
      new Plugin<HeadingNumberPluginState>({
        key: HEADING_NUMBER_KEY,
        state: {
          init: (_cfg, { doc }) => build(doc, opts.getEnabled(), opts.getOptions()),
          apply(tr, prev) {
            const refresh = tr.getMeta(HEADING_NUMBER_KEY);
            if (refresh === HEADING_NUMBER_REFRESH || tr.docChanged) {
              return build(tr.doc, opts.getEnabled(), opts.getOptions());
            }
            // doc 没变（只是选区/meta 变化）：位置不动，直接沿用上次结果
            return prev;
          },
        },
        props: {
          decorations(state) {
            return HEADING_NUMBER_KEY.getState(state)?.deco ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

/**
 * 读当前文档的「heading pos → 编号」表。
 * 给大纲面板 / 复制序列化用；编号关闭或插件未注册时返回空表。
 */
export function getHeadingNumberMap(state: EditorState): Map<number, string> {
  return HEADING_NUMBER_KEY.getState(state)?.byPos ?? new Map();
}

/** 读当前文档的完整编号条目（含未编号的标题） */
export function getHeadingNumberEntries(state: EditorState): HeadingNumberEntry[] {
  return HEADING_NUMBER_KEY.getState(state)?.entries ?? [];
}

export { HEADING_NUMBER_KEY };
