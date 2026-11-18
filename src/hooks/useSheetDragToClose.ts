import { useEffect, useRef } from "react";

/** 手指移动多少像素才判定方向（小于它当作点击，不接管） */
const DIRECTION_SLOP = 8;
/** 松手时下拉超过面板高度的这个比例就关闭 */
const CLOSE_RATIO = 0.25;
/** 下拉距离不够但甩得快（px/ms）也关闭 */
const FLICK_VELOCITY = 0.6;
const ANIM_MS = 180;

/**
 * 底部面板「下滑收起」：把返回的 ref 挂到 `.m-sheet` 上。
 *
 * 用户反馈：长按菜单 / 「…」菜单只能点遮罩关闭，按住小横条或面板往下拉没反应。
 * - 只在面板内容已滚到顶、手指向下拉时接管；内容没到顶或往上滑，照常滚动面板里的列表
 * - 横向滑动不接管
 * - 面板跟手下移、遮罩跟着变淡；松手时拉过高度的 1/4 或甩得快就关闭，否则弹回
 *
 * 用原生监听而不是 React 的 onTouchMove：React 把 touchmove 注册成 passive，preventDefault 不生效，
 * 拦不住下拉时 WebView 自己的滚动 / 回弹。
 */
export function useSheetDragToClose<T extends HTMLElement = HTMLDivElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T | null>(null);
  // 回调放 ref：调用方每次渲染都传新函数，不能因此重绑监听
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const sheet = ref.current;
    if (!open || !sheet) return;
    const backdrop = sheet.parentElement?.querySelector<HTMLElement>(".m-sheet-backdrop") ?? null;

    let startX = 0;
    let startY = 0;
    let startAtTop = false;
    /** null = 还没判定方向；true = 我们在拖面板；false = 交给原生滚动 */
    let dragging: boolean | null = null;
    let lastY = 0;
    let lastT = 0;
    let velocity = 0;
    let closing = false;

    const setOffset = (dy: number, animate: boolean) => {
      const t = animate ? `transform ${ANIM_MS}ms ease` : "none";
      sheet.style.transition = t;
      sheet.style.transform = dy > 0 ? `translateY(${dy}px)` : "";
      if (backdrop) {
        backdrop.style.transition = animate ? `opacity ${ANIM_MS}ms ease` : "none";
        backdrop.style.opacity = dy > 0 ? String(Math.max(0, 1 - dy / sheet.offsetHeight)) : "";
      }
    };

    const onStart = (e: TouchEvent) => {
      if (closing || e.touches.length !== 1) return;
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      lastY = t.clientY;
      lastT = e.timeStamp;
      velocity = 0;
      startAtTop = sheet.scrollTop <= 0;
      dragging = null;
    };

    const onMove = (e: TouchEvent) => {
      if (closing || e.touches.length !== 1 || dragging === false) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (dragging === null) {
        if (Math.abs(dx) < DIRECTION_SLOP && Math.abs(dy) < DIRECTION_SLOP) return;
        // 只有「内容在顶部 + 主要往下拉」才接管
        dragging = startAtTop && dy > 0 && Math.abs(dy) > Math.abs(dx);
        if (!dragging) return;
      }
      e.preventDefault();
      if (e.timeStamp > lastT) velocity = (t.clientY - lastY) / (e.timeStamp - lastT);
      lastY = t.clientY;
      lastT = e.timeStamp;
      setOffset(Math.max(0, dy), false);
    };

    const onEnd = () => {
      if (!dragging) {
        dragging = null;
        return;
      }
      dragging = null;
      const dy = Math.max(0, lastY - startY);
      if (dy > sheet.offsetHeight * CLOSE_RATIO || velocity > FLICK_VELOCITY) {
        closing = true;
        setOffset(sheet.offsetHeight, true);
        window.setTimeout(() => {
          onCloseRef.current();
          // 调用方没卸载面板（比如关闭被拦下）时恢复原位，别留一个看不见的面板
          closing = false;
          setOffset(0, false);
        }, ANIM_MS);
      } else {
        setOffset(0, true);
      }
    };

    sheet.addEventListener("touchstart", onStart, { passive: true });
    sheet.addEventListener("touchmove", onMove, { passive: false });
    sheet.addEventListener("touchend", onEnd);
    sheet.addEventListener("touchcancel", onEnd);
    return () => {
      sheet.removeEventListener("touchstart", onStart);
      sheet.removeEventListener("touchmove", onMove);
      sheet.removeEventListener("touchend", onEnd);
      sheet.removeEventListener("touchcancel", onEnd);
      setOffset(0, false);
    };
  }, [open]);

  return ref;
}
