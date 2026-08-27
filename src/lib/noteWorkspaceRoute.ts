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

/**
 * 当前路由是否是「撑满型」页面 —— 页面根节点用 `.editor-page`
 * （`position:absolute; inset:0`）铺满整个 Content。
 *
 * 目前只有两处：`/daily`（日记）与 `/notes/:id`（笔记编辑器）。
 *
 * 为什么需要单独判定：Content 上挂了 `scrollbar-gutter: stable both-edges`，
 * 它会在**左右各预留一个滚动条宽度（实测 8px）**，并把 padding box 一并缩小。
 * 而 `.editor-page` 是绝对定位撑满 padding box 的，于是跟着缩进 8px ——
 * 表现为「侧栏与正文之间、以及正文右侧各露出一条紫色竖缝」（用户反馈），
 * 且这一条正文比上方 Header 窄了 16px，左右都对不齐。
 *
 * 这类页面**自己**在 `.editor-body` 里 `overflow-y:auto` 处理滚动，
 * Content 这一层永远不会滚动，所以 gutter 纯属浪费 —— 关掉即可两侧归零。
 *
 * ⚠️ 其余页面（首页 / 待办 / 设置…）内容直接在 Content 里流动、确实会滚，
 * 必须保留 gutter，否则「内容变长冒出滚动条时整页横向抖一下」会回来。
 * 所以这里只放行这两条路径，不要图省事扩大范围。
 */
export function isFullBleedPath(pathname: string): boolean {
  return pathname === "/daily" || pathname.startsWith("/notes/");
}
