/**
 * 「切回笔记再切到编辑模式报 Adding different instances of a keyed plugin」的回归测试。
 *
 * 成因：笔记编辑态快照（整份 EditorState）里带着随组件动态注册的伪选区插件；切回笔记时
 * 默认进阅读模式 → 组件卸载、插件被摘掉 → 快照原样还原让插件「复活」→ 再切编辑模式，
 * 组件重新 registerPlugin 同 key 的新实例 → ProseMirror 抛错。
 *
 * 这里用最小 schema 复刻 Tiptap registerPlugin / unregisterPlugin 的核心（都是 reconfigure），
 * 直接测被抽出来的 alignSnapshotPlugins。
 */
import { describe, it, expect } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, PluginKey, type Plugin } from "@tiptap/pm/state";
import type { DecorationSet } from "@tiptap/pm/view";
import { history, undo, undoDepth } from "@tiptap/pm/history";
import { createFakeSelectionPlugin } from "./fakeSelection";
import { alignSnapshotPlugins } from "./alignSnapshotPlugins";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
});

const KEY = new PluginKey<DecorationSet>("test-fake-selection");

function createState(): EditorState {
  return EditorState.create({
    doc: schema.node("doc", null, [schema.node("paragraph", null, [schema.text("A")])]),
    plugins: [history()],
  });
}

/** 等价于 editor.registerPlugin(plugin) */
function register(state: EditorState, plugin: Plugin): EditorState {
  return state.reconfigure({ plugins: [...state.plugins, plugin] });
}

/** 等价于 editor.unregisterPlugin(key)：按 key 前缀过滤 */
function unregister(state: EditorState, key: PluginKey): EditorState {
  const k = (key as unknown as { key: string }).key;
  return state.reconfigure({
    plugins: state.plugins.filter(
      (p) => !((p as unknown as { key: string }).key ?? "").startsWith(k),
    ),
  });
}

function countKeyed(state: EditorState, key: PluginKey): number {
  const k = (key as unknown as { key: string }).key;
  return state.plugins.filter((p) => (p as unknown as { key: string }).key === k).length;
}

describe("快照还原时对齐插件集合", () => {
  it("复现：快照里带着已被摘掉的插件，原样还原后再注册同 key 会抛错", () => {
    // 编辑模式：组件已挂载，插件 P1 在 state 里
    let state = register(createState(), createFakeSelectionPlugin(KEY));
    const snapshot = state; // 切走笔记时存档

    // 切回时默认阅读模式 → 组件卸载 → 插件被摘掉
    state = unregister(state, KEY);
    expect(countKeyed(state, KEY)).toBe(0);

    // 旧做法：原样还原快照 → P1 复活，没人持有
    state = snapshot;
    expect(countKeyed(state, KEY)).toBe(1);

    // 用户切回编辑模式：组件注册新实例 P2 → 抛错
    expect(() => register(state, createFakeSelectionPlugin(KEY))).toThrow(
      /Adding different instances of a keyed plugin/,
    );
  });

  it("修复：对齐到存活插件集合后，还原的 state 不含已卸载的插件，重新注册不抛错", () => {
    let state = register(createState(), createFakeSelectionPlugin(KEY));
    const snapshot = state;
    state = unregister(state, KEY); // 阅读模式，组件已卸载

    state = alignSnapshotPlugins(snapshot, state.plugins);
    expect(countKeyed(state, KEY)).toBe(0);

    expect(() => {
      state = register(state, createFakeSelectionPlugin(KEY));
    }).not.toThrow();
    expect(countKeyed(state, KEY)).toBe(1);
  });

  it("反向：快照里没有、而当前组件已挂载的插件，对齐后补齐", () => {
    // 阅读态切走 → 快照没有伪选区插件
    const snapshot = createState();
    // 切回时是编辑模式，组件已挂载并注册了插件
    const live = register(createState(), createFakeSelectionPlugin(KEY));

    const restored = alignSnapshotPlugins(snapshot, live.plugins);
    expect(countKeyed(restored, KEY)).toBe(1);
  });

  it("对齐不丢快照里的撤销栈与文档", () => {
    let state = register(createState(), createFakeSelectionPlugin(KEY));
    state = state.apply(state.tr.insertText("：改了一笔", state.doc.content.size - 1));
    expect(undoDepth(state)).toBeGreaterThan(0);
    const snapshot = state;

    // 当前 state：插件已摘掉、历史是空的（模拟切到别的笔记后的现场）
    const live = unregister(createState(), KEY);
    expect(undoDepth(live)).toBe(0);

    let restored = alignSnapshotPlugins(snapshot, live.plugins);
    expect(restored.doc.textContent).toBe("A：改了一笔");
    expect(undoDepth(restored)).toBeGreaterThan(0);

    undo(restored, (tr) => {
      restored = restored.apply(tr);
    });
    expect(restored.doc.textContent).toBe("A");
  });
});
