/**
 * 表格浮动菜单（TableBubbleMenu）的定位计算。
 *
 * 抽成纯函数是为了能被单测锁住 —— 这里的边界条件（长表格、sticky 工具栏遮挡、
 * 表格滚出视口）在真实 DOM 里很难回归，靠矩形数值测最省事。
 *
 * 坐标系：全部使用**视口坐标**（getBoundingClientRect 口径）。
 * 调用方把菜单 portal 到 body 并用 position:fixed 渲染，两者同源。
 *
 * ⚠️ 不要改回 `window.scrollY + rect.top` 的写法：编辑器的滚动容器是
 * `.editor-body`（overflow-y:auto），window 本身从不滚动，`window.scrollY`
 * 恒为 0，加它没有意义，还会误导后人以为菜单是文档流坐标。
 */

/** 菜单条自身高度（含边框内边距，实测 ~38px）。与组件里的实际渲染高度保持一致。 */
export const MENU_HEIGHT = 38;
/** 菜单与 sticky 工具栏之间留的呼吸距离 */
export const MENU_GAP = 4;

/** 一个矩形的最小描述（DOMRect 的子集，方便测试构造） */
export interface Rect {
  top: number;
  bottom: number;
  left: number;
}

export interface BubbleMenuLayoutInput {
  /** 表格元素的视口矩形 */
  table: Rect;
  /** 滚动容器（.editor-body）的视口矩形 */
  scrollRoot: Rect;
  /** sticky 工具栏实测高度；没有工具栏（阅读模式 / 源码模式）传 0 */
  toolbarHeight: number;
}

export interface BubbleMenuLayout {
  /** 是否应当渲染菜单 */
  visible: boolean;
  /** 视口坐标 top（visible 为 false 时无意义） */
  top: number;
  /** 视口坐标 left */
  left: number;
}

/**
 * 计算菜单位置。
 *
 * 规则：
 *  1. 理想位置是表格上边缘的正上方（贴着表格，视觉归属最清晰）。
 *  2. 表格顶部滚出视口后，把菜单**钉**在 sticky 工具栏下沿 —— 这是修复的核心：
 *     原实现只用理想位置，长表格滚一屏后菜单 top 变负数飞出视口，
 *     表现为"编辑到表格中部时工具条不见了"（用户反馈的"编辑工具不跟随"）。
 *  3. 但不能钉过头：菜单底不得越过表格底边，否则表格快滚完时菜单还浮在
 *     后续正文上，指向不明。
 *  4. 表格完全离开视口（在下方还没进来 / 在上方已经滚过）时隐藏。
 */
export function computeBubbleMenuLayout({
  table,
  scrollRoot,
  toolbarHeight,
}: BubbleMenuLayoutInput): BubbleMenuLayout {
  // 可见区上沿：滚动容器顶部 + sticky 工具栏高度 + 呼吸距离
  const minTop = scrollRoot.top + toolbarHeight + MENU_GAP;
  // 菜单底不越过表格底边
  const maxTop = table.bottom - MENU_HEIGHT;
  // 理想位置：表格上方
  const ideal = table.top - MENU_HEIGHT;

  // 表格得在可见区里还留着「至少一个菜单高度」的余量才值得显示菜单：
  //  - table.bottom > minTop + MENU_HEIGHT → 表格没被完全滚过去
  //  - table.top < scrollRoot.bottom       → 表格已经进入视口（不是还在下方）
  const visible =
    table.bottom > minTop + MENU_HEIGHT && table.top < scrollRoot.bottom;

  // maxTop 可能小于 minTop（表格矮于菜单+工具栏时）——此时以 maxTop 优先，
  // 保证菜单不脱离表格；visible 判定已经挡掉了真正不该显示的情况。
  const top = Math.min(Math.max(ideal, minTop), maxTop);

  return { visible, top, left: table.left };
}
