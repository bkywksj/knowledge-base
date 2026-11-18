import { useCallback, useRef } from "react";

/**
 * 触屏长按 Hook —— 移动端「长按 = 桌面右键菜单」的通用替代。
 *
 * 背景：桌面端全项目 143 处 `onContextMenu` 在触屏上无法触发（手指没有"右键"），
 * 移动页要么丢失这些操作、要么塞一堆常驻按钮。统一改为"长按唤起底部
 * ActionSheet"，配套 `@/components/mobile/ActionSheet` 使用。
 *
 * 设计要点：
 * - 用 Pointer Events（Android WebView = Chromium，支持良好），一套代码覆盖触屏；
 * - 手指移动超过阈值即判定为"滚动/拖拽"→ 取消长按，且不误触发普通点击（避免
 *   滑动列表时误进入详情）；
 * - 长按已触发时抑制随后的 tap（onClick 不再触发），避免"长按完手一抬又进详情"；
 * - 🔴 轻点在浏览器的 click 事件里触发，不在 pointerup 里：pointerup 时就跳转的话，页面立即重绘，
 *   随后补发的 click 按坐标落到重绘后同一位置的新元素上。用户反馈：点进一个没有子文件夹的文件夹，
 *   原来那一行的位置变成「新建子文件夹」，紧跟着就弹出了新建框；
 * - 长按成功给一次轻微震动反馈（navigator.vibrate，Android 支持；iOS/桌面自动降级）；
 * - `onContextMenu` 一并返回并 preventDefault，压掉 Android WebView 长按弹出的
 *   文字选择/系统菜单。
 *
 * 用法：
 * ```tsx
 * const lp = useLongPress(() => openSheet(item), { onClick: () => openDetail(item) });
 * return <div {...lp} className="select-none">...</div>;
 * ```
 */
export interface UseLongPressOptions {
  /** 长按触发阈值（毫秒），默认 500 */
  delay?: number;
  /** 手指移动超过该像素数则取消长按（视为滚动/拖拽），默认 10 */
  moveTolerance?: number;
  /** 普通点击回调（长按未触发、且本次不是滑动时才触发） */
  onClick?: () => void;
  /** 长按触发时是否给震动反馈（Android 支持），默认 true */
  haptic?: boolean;
}

export interface LongPressHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerLeave: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onClick: (e: React.MouseEvent) => void;
}

/**
 * 长按触发后抬手：吞掉紧跟着的那一次 click（不管落在哪个元素上）。
 * 长按通常会弹出面板，面板的遮罩正好盖在手指下，浏览器补发的 click 落到遮罩上，刚打开的面板立刻又关了
 * （真机自动化测试里复现；系统长按手势一般会取消这次 click，但不能依赖）。行自己的 click 由 handleClick 拦。
 */
function swallowNextClick() {
  const swallow = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    cleanup();
  };
  const cleanup = () => {
    document.removeEventListener("click", swallow, true);
    window.clearTimeout(timer);
  };
  const timer = window.setTimeout(cleanup, 500);
  document.addEventListener("click", swallow, true);
}

export function useLongPress(
  onLongPress: (e: React.PointerEvent) => void,
  options: UseLongPressOptions = {},
): LongPressHandlers {
  const { delay = 500, moveTolerance = 10, onClick, haptic = true } = options;

  const timerRef = useRef<number | null>(null);
  const firedRef = useRef(false); // 长按是否已触发（抑制随后的 tap）
  const movedRef = useRef(false); // 本次按压是否发生过滚动/拖拽
  const startRef = useRef<{ x: number; y: number } | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // 只处理主按钮/触点；忽略鼠标右键、中键
      if (e.button !== 0) return;
      firedRef.current = false;
      movedRef.current = false;
      startRef.current = { x: e.clientX, y: e.clientY };
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        firedRef.current = true;
        if (
          haptic &&
          typeof navigator !== "undefined" &&
          "vibrate" in navigator
        ) {
          // 部分设备/系统会禁用震动，失败静默忽略
          try {
            navigator.vibrate(10);
          } catch {
            /* noop */
          }
        }
        onLongPress(e);
      }, delay);
    },
    [clearTimer, delay, haptic, onLongPress],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const s = startRef.current;
      if (!s) return;
      const dx = Math.abs(e.clientX - s.x);
      const dy = Math.abs(e.clientY - s.y);
      if (dx > moveTolerance || dy > moveTolerance) {
        movedRef.current = true; // 视为滚动/拖拽
        clearTimer();
      }
    },
    [clearTimer, moveTolerance],
  );

  // 抬手只收尾；普通点击交给下面的 onClick（原因见文件头）
  const onPointerUp = useCallback(() => {
    clearTimer();
    startRef.current = null;
    if (firedRef.current) swallowNextClick();
  }, [clearTimer]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // 长按已触发 或 本次是滑动 → 都不触发普通点击；也拦下冒泡，免得外层按钮把它当成点击
      if (firedRef.current || movedRef.current) {
        firedRef.current = false;
        movedRef.current = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      onClick?.();
    },
    [onClick],
  );

  const onPointerLeave = useCallback(() => {
    clearTimer();
    startRef.current = null;
  }, [clearTimer]);

  const onPointerCancel = useCallback(() => {
    clearTimer();
    startRef.current = null;
  }, [clearTimer]);

  // 压掉系统长按弹出的文字选择/上下文菜单（Android WebView）
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  return {
    onPointerDown,
    onPointerUp,
    onPointerMove,
    onPointerLeave,
    onPointerCancel,
    onContextMenu,
    onClick: handleClick,
  };
}
