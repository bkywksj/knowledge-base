/**
 * 「伪选区」高亮 —— 编辑器失焦期间仍让用户看得见自己选了哪段文字。
 *
 * 背景：浏览器只给**当前有焦点**的元素渲染原生 `::selection` 蓝底。工具栏里的
 * antd Select / ColorPicker 这类控件打开时会把焦点抢走（它们靠内部 focus 打开
 * popup，mousedown 上 preventDefault 拦不住），于是选区蓝底消失 —— ProseMirror
 * 的 `state.selection` 其实原封不动，命令照样作用于原选区，但用户看不到，
 * 常会以为"没选中"而回编辑器重点一下，那才真把选区弄丢了。
 *
 * 解法：用一条 inline decoration 画出同款高亮，它不依赖焦点，独立于浏览器
 * 原生 selection 渲染。
 *
 * 每个使用方传入自己的 PluginKey（AI 写作菜单一个、工具栏一个），互不干扰，
 * 也避免同 key 重复注册。同一段文字被两个装饰同时覆盖也无所谓 —— class 相同，
 * 视觉上就是一层高亮。
 */
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/react";

export type FakeSelectionRange = { from: number; to: number } | null;

/** 用同一个 key 创建装饰 plugin；注册 / 注销由调用方按组件生命周期管理 */
export function createFakeSelectionPlugin(
  key: PluginKey<DecorationSet>,
): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, deco) {
        const meta = tr.getMeta(key);
        if (meta === "clear") return DecorationSet.empty;
        if (meta && typeof meta === "object" && "from" in meta) {
          const { from, to } = meta as { from: number; to: number };
          if (from === to) return DecorationSet.empty;
          return DecorationSet.create(tr.doc, [
            Decoration.inline(from, to, { class: "kb-fake-selection" }),
          ]);
        }
        // 文档变化时同步映射坐标，避免编辑后高亮范围错位
        return deco.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return key.getState(state) ?? DecorationSet.empty;
      },
    },
  });
}

/** 设置 / 清除伪选区（传 null 清除） */
export function setFakeSelection(
  editor: Editor,
  key: PluginKey<DecorationSet>,
  range: FakeSelectionRange,
): void {
  editor.view.dispatch(editor.state.tr.setMeta(key, range ?? "clear"));
}
