/**
 * 大纲 scrollspy 的选中判定（纯函数，便于单测）。
 *
 * 背景（真实 bug）：编辑器顶部有 sticky 工具栏（`.tiptap-toolbar`，flex-wrap 会换行，
 * 高度不是常量）。早期实现用 IntersectionObserver + "相交项里 top 最小的"当激活项，
 * 而 rootMargin 顶部为 0 —— 躲在工具栏底下、肉眼已经看不见的上一个标题 top 更小，
 * 会把高亮抢走。结果是：正文里两个标题挨得近（间距 < 工具栏高度）时，点击下面那条，
 * 高亮立刻被判回上面那条，用户看到的就是"这一条点不动"。
 *
 * 现在改成经典 scrollspy：判定线取工具栏下沿，**取最后一个已越过判定线的标题**。
 */

export interface OutlineProbe {
  /**
   * 标题元素在视口坐标系里的 top。
   * null = 没配对到 DOM，或被折叠隐藏（rect 全 0）——这类不参与判定，
   * 否则 top=0 会被当成"已越过判定线"污染结果。
   */
  top: number | null;
}

export interface ScrollSpyContext {
  /** 判定线（视口坐标）：滚动容器顶 + 工具栏高 + 呼吸距离 */
  lineY: number;
  /** 滚动容器底边（视口坐标），仅 atBottom 为 true 时参与判定 */
  bottomY: number;
  /** 容器是否已经滚到底（内容不足一屏、无滚动条时应传 false） */
  atBottom: boolean;
}

/**
 * 按滚动位置挑出应高亮的标题。
 *
 * @param probes 各标题的位置探针，顺序必须与文档顺序一致
 * @returns 命中项下标；没有任何可用标题时返回 -1
 */
export function pickActiveIndex(
  probes: OutlineProbe[],
  { lineY, bottomY, atBottom }: ScrollSpyContext,
): number {
  let active = -1;

  // 主规则：最后一个已越过判定线的标题
  for (let i = 0; i < probes.length; i += 1) {
    const top = probes[i].top;
    if (top === null) continue;
    if (top <= lineY) active = i;
  }

  // 滚到底：尾部标题受容器高度所限，可能永远越不过判定线（scrollTop 被 clamp 到 max），
  // 不特判的话最后几条永远点不亮。此时改取视野内最靠下的那条。
  if (atBottom) {
    for (let i = 0; i < probes.length; i += 1) {
      const top = probes[i].top;
      if (top === null) continue;
      if (top < bottomY) active = i;
    }
  }

  // 还在第一个标题上方（比如正文开头有大段引言）→ 高亮第一条，别留空
  if (active === -1) {
    active = probes.findIndex((p) => p.top !== null);
  }

  return active;
}
