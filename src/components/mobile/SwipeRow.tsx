import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * 列表行左滑露出操作（原型 02 屏「移动 / 删除」）。T-M022 遗留项。
 *
 * - 只认横向滑动：起手先判方向，纵向为主就放手交给页面滚动，不和列表滚动抢手势
 * - 松手时滑过操作区一半就停在展开位，否则弹回
 * - 展开状态下点内容区只收起、不触发进详情（拦截这一次 click）
 * - 同一时间只展开一行：展开时广播事件，其它行收到就收起
 * - 子元素上的 useLongPress 不受影响：它自己会在手指移动 > 10px 时取消长按
 *
 * 菜单项和长按面板用同一份数据（调用方从 ActionSheet 的 items 里挑最常用的 1~2 个传进来）。
 */
export interface SwipeAction {
  key: string;
  label: string;
  icon?: ReactNode;
  tone?: "info" | "bad" | "accent";
  onClick: () => void;
}

const ACTION_W = 68;
const OPEN_EVENT = "m-swipe-open";
/** 白字按钮的底色一律用固定深色：暗色主题的 --m-info / --m-bad 为了当文字用调亮了，压白字不够对比度 */
const TONE_BG: Record<NonNullable<SwipeAction["tone"]>, string> = {
  info: "var(--m-swipe-info)",
  bad: "var(--m-badge-bg)",
  accent: "var(--m-btn)",
};

let seq = 0;

export function SwipeRow({ actions, children }: { actions: SwipeAction[]; children: ReactNode }) {
  const idRef = useRef(++seq);
  const max = actions.length * ACTION_W;
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; base: number; dir: "h" | "v" | null } | null>(null);
  /** 本次手势是横滑或「展开时的收起点击」：吞掉随后那一次 click */
  const swallowClick = useRef(false);

  // 别的行展开时收起自己
  useEffect(() => {
    const onOpen = (e: Event) => {
      if ((e as CustomEvent<number>).detail !== idRef.current) setOffset(0);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  // 展开时点这一行以外的任何地方（页面标题、筛选、别的区域、滚动列表）都收起；
  // 只收起、不拦截那次点击，用户本来要点的东西照常生效（真机回归：原来只能点本行或滑别的行才收）
  const rootRef = useRef<HTMLDivElement | null>(null);
  const isOpen = offset !== 0 && !dragging;
  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOffset(0);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [isOpen]);

  const onPointerDown = (e: React.PointerEvent) => {
    start.current = { x: e.clientX, y: e.clientY, base: offset, dir: null };
    swallowClick.current = offset !== 0;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const s = start.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (s.dir === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      s.dir = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
      if (s.dir === "h") {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        setDragging(true);
        swallowClick.current = true;
      }
    }
    if (s.dir !== "h") return;
    setOffset(Math.max(-max, Math.min(0, s.base + dx)));
  };

  const onPointerUp = () => {
    const s = start.current;
    start.current = null;
    setDragging(false);
    if (!s || s.dir !== "h") return;
    setOffset((cur) => {
      const open = cur < -max / 2;
      if (open) window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: idRef.current }));
      return open ? -max : 0;
    });
  };

  return (
    <div ref={rootRef} className="relative overflow-hidden" style={{ touchAction: "pan-y" }}>
      {/* 静止时整层隐藏：外层圆角裁切的抗锯齿边会把按钮底色透出一道细边 */}
      <div
        className="absolute inset-y-0 right-0 flex"
        aria-hidden={offset === 0}
        style={{ visibility: offset === 0 ? "hidden" : "visible" }}
      >
        {actions.map((a) => (
          <button
            key={a.key}
            type="button"
            tabIndex={offset === 0 ? -1 : 0}
            className="flex flex-col items-center justify-center gap-1 text-[12px] font-semibold text-white"
            style={{ width: ACTION_W, background: TONE_BG[a.tone ?? "info"] }}
            onClick={() => {
              setOffset(0);
              a.onClick();
            }}
          >
            {a.icon}
            {a.label}
          </button>
        ))}
      </div>
      <div
        className="relative"
        style={{
          transform: `translateX(${offset}px)`,
          transition: dragging ? "none" : "transform 0.2s ease",
          background: "var(--m-surface)",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        // useLongPress 的「普通点击」是在 pointerup 里触发的，光拦 click 拦不住：
        // 展开状态下点内容区，要在捕获阶段截住 pointerup，子元素才不会顺势进详情
        // （截住后本元素自己的 onPointerUp 也不会再跑，所以收起在这里直接做）
        onPointerUpCapture={(e) => {
          const s = start.current;
          if (!s || s.base === 0 || s.dir === "h") return;
          e.stopPropagation();
          start.current = null;
          setOffset(0);
        }}
        onClickCapture={(e) => {
          if (!swallowClick.current) return;
          e.stopPropagation();
          e.preventDefault();
          swallowClick.current = false;
          setOffset(0);
        }}
      >
        {children}
      </div>
    </div>
  );
}
