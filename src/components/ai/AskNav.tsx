/**
 * AI 会话「提问导航」：贴在消息区右边缘的一排细短线，一条 = 一次提问。
 *
 * - 平时只占右侧留白里十几像素，不挤内容（对话区刚放宽到 960，不想再被常驻栏挤回去）
 * - 悬停展开成提问列表（序号 + 首行），点一下平滑滚到那条提问并闪一下
 * - 当前所在的提问高亮（顶边越过可视区 1/3 的最后一条）
 * - Alt+↑ / Alt+↓ 跳上一条 / 下一条
 * - 只列用户提问：自己写的话短而好认，AI 回答太长没法扫读
 * - 少于 3 条不显示短线（短对话用不着导航），但 2 条时快捷键照样能用
 *
 * 定位靠提问外层的 data-ask-id（AI 页渲染 UserBubble 时挂上）。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { activeAskIndex, askLabel, stepAsk } from "@/lib/askNav";

export interface AskNavItem {
  id: number;
  content: string;
}

/** 少于这么多条不显示短线 */
const MIN_VISIBLE = 3;
/** 跳过去后提问顶边离可视区顶部留的距离 */
const JUMP_OFFSET = 16;

export function AskNav({
  scrollRef,
  items,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  items: AskNavItem[];
}) {
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const activeRef = useRef(active);
  activeRef.current = active;

  const findEl = useCallback(
    (id: number) => scrollRef.current?.querySelector<HTMLElement>(`[data-ask-id="${id}"]`) ?? null,
    [scrollRef],
  );

  // 当前所在提问：滚动 / 尺寸变化 / 提问增减时重算（rAF 合并同一帧的多次滚动）
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    let raf = 0;
    const compute = () => {
      raf = 0;
      const boxTop = box.getBoundingClientRect().top;
      const tops = items.map((it) => {
        const el = findEl(it.id);
        return el ? el.getBoundingClientRect().top - boxTop : Number.POSITIVE_INFINITY;
      });
      // 滚到底时最后几条可能永远越不过 1/3 锚线，改用「可视区内」判断，否则最后一条永远点不亮
      const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
      const anchor = atBottom ? box.clientHeight - 40 : box.clientHeight / 3;
      setActive(activeAskIndex(tops, anchor));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(compute);
    };
    compute();
    box.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(box);
    return () => {
      box.removeEventListener("scroll", schedule);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef, items, findEl]);

  const jump = useCallback(
    (index: number) => {
      const box = scrollRef.current;
      const item = items[index];
      if (!box || !item) return;
      const el = findEl(item.id);
      if (!el) return;
      const top = box.scrollTop + (el.getBoundingClientRect().top - box.getBoundingClientRect().top) - JUMP_OFFSET;
      box.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      // 闪一下：先摘掉再加，连续跳同一条也能重新播放
      el.classList.remove("kb-ask-flash");
      void el.offsetWidth;
      el.classList.add("kb-ask-flash");
      window.setTimeout(() => el.classList.remove("kb-ask-flash"), 1300);
    },
    [scrollRef, items, findEl],
  );

  // Alt+↑ / Alt+↓：输入框里也生效（Alt+方向键在文本框里没有默认用途）；输入法组字时不抢
  useEffect(() => {
    if (items.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      jump(stepAsk(activeRef.current, items.length, e.key === "ArrowUp" ? -1 : 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items.length, jump]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  if (items.length < MIN_VISIBLE) return null;

  const openNow = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  // 稍等再收：鼠标从短线挪到列表的路上会短暂离开
  const closeSoon = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 160);
  };

  return (
    <div className="kb-asknav" onMouseEnter={openNow} onMouseLeave={closeSoon}>
      <div className="kb-asknav-ticks" aria-hidden={open}>
        {items.map((it, i) => (
          <button
            key={it.id}
            type="button"
            className={"kb-asknav-tick" + (i === active ? " is-on" : "")}
            aria-label={`跳到第 ${i + 1} 条提问`}
            onClick={() => jump(i)}
          />
        ))}
      </div>
      {open && (
        <div className="kb-asknav-panel" role="navigation" aria-label="提问导航">
          <div className="kb-asknav-h">
            提问 {items.length} 条<span>Alt+↑ / ↓</span>
          </div>
          {items.map((it, i) => {
            const label = askLabel(it.content);
            return (
              <button
                key={it.id}
                type="button"
                className={"kb-asknav-item" + (i === active ? " is-on" : "")}
                // 只给可能被省略的长问题挂悬停全文：短的也挂会在划过时一路弹提示、挡住邻项
                title={label.length > 16 ? label : undefined}
                onClick={() => jump(i)}
              >
                <span className="n">{i + 1}</span>
                <span className="t">{label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
