import type { EditorState, Plugin } from "@tiptap/pm/state";

/**
 * 还原笔记编辑态快照前，把快照的插件集合对齐到编辑器「此刻存活」的插件集合。
 *
 * 为什么必须对齐：快照存的是整份 EditorState，连 plugins 数组一起冻住了。但有些插件是
 * 随组件生命周期动态 register/unregister 的（AiWriteMenu / EditorToolbar 的伪选区插件，
 * 阅读模式下组件不挂载 → 插件被摘掉）。若直接 updateState(快照)：
 *   - 快照里带着、而当前已被摘掉的插件会「复活」，没有任何组件持有它，也没人注销；
 *     之后组件重新挂载再 registerPlugin 同 key 的新实例 → ProseMirror 抛
 *     "Adding different instances of a keyed plugin"。
 *   - 反过来，快照里没有、而当前组件已挂载的插件会悄悄缺失（伪选区高亮失效）。
 *
 * reconfigure 按 plugin key 复用快照里的 state 字段（撤销栈 / 光标等原样保留），
 * 只是插件实例与集合改为当前存活的那一套，两边自然一致。
 */
export function alignSnapshotPlugins(
  snapshot: EditorState,
  livePlugins: readonly Plugin[],
): EditorState {
  return snapshot.reconfigure({ plugins: [...livePlugins] });
}
