/**
 * 撤销历史隔离的回归测试 —— 对应「在 A 笔记改了东西，切到 B 按 Ctrl+Z，B 的正文变成
 * A 撤销前的内容」这个数据丢失 bug。
 *
 * 为什么不直接测 TiptapEditor：Tiptap 的 Editor 必须有 EditorView，而 EditorView 要真实
 * DOM；本项目 vitest 跑在 node 环境（见 vitest.config.ts），没有 jsdom。所以这里退一步，
 * 用最小 schema 把那条路径的**核心机制**复刻出来：
 *   - 「切笔记」= 一条整篇 replaceWith 事务（@tiptap/core 的 setContent 就是这么做的，
 *     它只设了 preventUpdate，没设 addToHistory:false）
 *   - 「清空历史」= 把 history 插件换成新实例后 reconfigure（TiptapEditor 里的
 *     resetEditorHistory 通过 editor.unregisterPlugin/registerPlugin 走的正是这条路）
 *
 * 用例 1 复现 bug 的成因，用例 2 锁住修复后的行为。
 */
import { describe, it, expect } from "vitest";
import { Schema, type Node as PMNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { closeHistory, history, undo, undoDepth } from "@tiptap/pm/history";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
});

/** 造一个只含单段文字的段落节点 */
function paragraphOf(text: string): PMNode {
  return schema.node("paragraph", null, text ? [schema.text(text)] : []);
}

function createState(text: string): EditorState {
  return EditorState.create({
    doc: schema.node("doc", null, [paragraphOf(text)]),
    plugins: [history()],
  });
}

/** 模拟用户敲字：在段落末尾追加文本 */
function typeText(state: EditorState, text: string): EditorState {
  return state.apply(state.tr.insertText(text, state.doc.content.size - 1));
}

/**
 * 模拟切笔记：整篇替换正文（等价于 editor.commands.setContent）。
 *
 * 先 closeHistory 关掉上一个 history group —— 真实场景里，用户在 A 笔记编辑和切到 B 之间
 * 必然停顿超过 newGroupDelay（默认 500ms），这两步天然是两组；而测试里事务是瞬间连发的，
 * 不显式关组就会被并进同一组，一次 undo 把两步一起撤掉，反而看不出「撤销掉的正是加载 B
 * 这一步」这个关键现象。
 */
function replaceWholeDoc(state: EditorState, text: string): EditorState {
  const tr = closeHistory(state.tr);
  return state.apply(tr.replaceWith(0, state.doc.content.size, paragraphOf(text)));
}

/**
 * 模拟 resetEditorHistory：把 history 插件摘掉，再装一个全新实例回原位。
 *
 * 🔴 必须**分两次 reconfigure**，不能一步 splice 换掉。EditorState.reconfigure 是按
 * plugin key 复用旧字段的（`this.hasOwnProperty(key) ? 旧值 : field.init()`），而
 * prosemirror-history 的 PluginKey 是模块级常量 —— 新 history() 实例的 key 仍是
 * "history$"，一步替换会被判定成同一个插件，直接沿用旧的 undo 栈，等于没清。
 * 先摘掉（新 state 上不再有 history 字段）再装回去，init 才会跑，栈才是空的。
 * TiptapEditor 里 unregisterPlugin → registerPlugin 走的正是这两步。
 */
function resetHistory(state: EditorState): EditorState {
  const index = state.plugins.findIndex((p) =>
    ((p as { key?: string }).key ?? "").startsWith("history$"),
  );
  const without = state.plugins.filter((_, i) => i !== index);
  const stripped = state.reconfigure({ plugins: without });
  const plugins = [...without];
  plugins.splice(index, 0, history());
  return stripped.reconfigure({ plugins });
}

/** 取出文档纯文本，断言用 */
function textOf(state: EditorState): string {
  return state.doc.textContent;
}

describe("编辑器撤销历史", () => {
  it("整篇替换正文默认会进 undo 栈 —— 这正是撤销串笔记的成因", () => {
    // 在 A 笔记里编辑
    let state = createState("A 笔记");
    state = typeText(state, "：改了一笔");
    expect(textOf(state)).toBe("A 笔记：改了一笔");

    // 切到 B 笔记（整篇替换）
    state = replaceWholeDoc(state, "B 笔记");
    expect(textOf(state)).toBe("B 笔记");
    expect(undoDepth(state)).toBeGreaterThan(0);

    // 在 B 里按 Ctrl+Z：撤销掉的是「加载 B」这一步，正文倒退成 A 撤销前的内容
    undo(state, (tr) => {
      state = state.apply(tr);
    });
    expect(textOf(state)).toBe("A 笔记：改了一笔");
  });

  it("替换后清空历史 —— 撤销不再倒灌上一篇的内容", () => {
    let state = createState("A 笔记");
    state = typeText(state, "：改了一笔");
    state = replaceWholeDoc(state, "B 笔记");

    // 修复点：整篇内容换掉之后清空撤销历史
    state = resetHistory(state);
    expect(undoDepth(state)).toBe(0);

    // 此时 Ctrl+Z 无事可做，B 的正文原样保留
    const handled = undo(state, (tr) => {
      state = state.apply(tr);
    });
    expect(handled).toBe(false);
    expect(textOf(state)).toBe("B 笔记");
  });

  it("切走前存档、切回来还原 —— 回到原笔记仍能撤销自己的编辑", () => {
    // 锁住「按笔记存档 EditorState」这个方案成立的前提：EditorState 是不可变的，
    // 存档之后在它之上做的整篇替换、清空历史，都只产生新实例，动不到手里这份快照。
    let state = createState("A 笔记");
    state = typeText(state, "：改了一笔");

    // 切走 A —— 连 doc、撤销栈、光标一起存档（组件里还会记一份 markdown 指纹）
    const snapshot = { state, markdown: textOf(state) };

    // 去 B：整篇替换 + 清空历史，B 里撤销不会碰到 A 的东西
    state = replaceWholeDoc(state, "B 笔记");
    state = resetHistory(state);
    expect(undoDepth(state)).toBe(0);

    // 切回 A：正文与存档时逐字一致 → 整份 state 原样还原
    expect(snapshot.markdown).toBe("A 笔记：改了一笔");
    state = snapshot.state;
    expect(undoDepth(state)).toBeGreaterThan(0);

    // A 自己的撤销历史回来了
    undo(state, (tr) => {
      state = state.apply(tr);
    });
    expect(textOf(state)).toBe("A 笔记");
  });

  it("清空历史后，在当前笔记里的编辑仍可正常撤销", () => {
    let state = createState("A 笔记");
    state = replaceWholeDoc(state, "B 笔记");
    state = resetHistory(state);

    // 切过来之后才做的编辑，属于 B 自己的历史
    state = typeText(state, "：在 B 里写的");
    expect(textOf(state)).toBe("B 笔记：在 B 里写的");
    expect(undoDepth(state)).toBe(1);

    undo(state, (tr) => {
      state = state.apply(tr);
    });
    expect(textOf(state)).toBe("B 笔记");
  });
});
