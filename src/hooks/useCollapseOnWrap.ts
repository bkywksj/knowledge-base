import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * 一排按钮放不下时把其中一部分收起来（比如收进「⋯」菜单）。
 *
 * 判据用「这一排换行了」而不是写死窗口宽度阈值：按钮多少随状态变（有未保存改动才出现
 * 保存按钮、面包屑长短不一），写死的阈值总有一种状态不准。
 *
 * 回差：收起时记下容器宽度，宽度要回升到「收起时宽度 + 被收起部分的宽度」才展开，
 * 否则在临界宽度上「展开 → 换行 → 收起 → 不换行 → 展开」来回抖。
 *
 * @param rowRef 会换行的那一排（flex-wrap 容器）
 * @param extrasWidth 被收起的那部分大约占多宽（展开要多出的宽度）
 * @param rowHeight 单行高度；实际高度超过它的 1.5 倍即视为换行
 * @returns 是否应收起
 */
export function useCollapseOnWrap(
  rowRef: RefObject<HTMLElement | null>,
  extrasWidth: number,
  rowHeight = 30,
): boolean {
  const [collapsed, setCollapsed] = useState(false);
  const collapsedRef = useRef(false);
  const collapsedAtRef = useRef(0);

  useEffect(() => {
    const row = rowRef.current;
    const bar = row?.parentElement;
    if (!row || !bar) return;

    const check = () => {
      const width = bar.clientWidth;
      if (!collapsedRef.current) {
        if (row.offsetHeight > rowHeight * 1.5) {
          collapsedRef.current = true;
          collapsedAtRef.current = width;
          setCollapsed(true);
        }
      } else if (width >= collapsedAtRef.current + extrasWidth) {
        collapsedRef.current = false;
        setCollapsed(false);
      }
    };

    const ro = new ResizeObserver(check);
    ro.observe(bar);
    ro.observe(row);
    check();
    return () => ro.disconnect();
  }, [rowRef, extrasWidth, rowHeight]);

  return collapsed;
}
