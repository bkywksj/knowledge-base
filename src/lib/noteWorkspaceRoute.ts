/**
 * 「笔记工作区」路由判定 —— 决定顶部笔记标签栏（TabBar）该不该出现。
 *
 * 背景：标签栏原本在 AppLayout 里无条件渲染，只要开过一篇笔记，切到日记 /
 * 待办 / 设置 / 图谱任何模块，顶上都还顶着一条笔记标签栏（用户反馈的 BUG）。
 *
 * 判定放在这里而不是内联进组件，是为了能被单测锁住 —— 尤其是白板那条边界，
 * 光看 AppLayout 很容易被后人"顺手清理"掉。
 */

/**
 * 当前路由是否属于笔记工作区。
 *
 * 放行的三类路径：
 *  - `/notes`        笔记列表（标签栏在此仍有意义：可直接切回已开笔记）
 *  - `/notes/:id`    笔记编辑器，标签的唯一来源
 *  - `/whiteboard/:id` 白板
 *
 * 白板为什么算：白板本质是一条 `note_type='whiteboard'` 的笔记，从
 * `/notes/:id` 进入时 editor 会 replace 跳到 `/whiteboard/:id`（见
 * pages/notes/editor.tsx 的入口重定向）。若不放行，用户从笔记点进白板就会
 * 丢掉切回其他已开笔记的入口。
 *
 * 注意白板自身**不会**产生标签：那次重定向发生在 openTab 之前，所以这里只是
 * "保留标签栏"，不会冒出白板 tab。
 */
export function isNoteWorkspacePath(pathname: string): boolean {
  return (
    pathname === "/notes" ||
    pathname.startsWith("/notes/") ||
    pathname.startsWith("/whiteboard/")
  );
}
