import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

/**
 * 横向标签条容器（移植自 tauri-cc 的同名组件）—— 藏掉横向滚动条，改用
 * 「鼠标滚轮横滚 + 两端按需浮出圆箭头」。
 *
 * 为什么要补这两条路：滚动条藏掉后，标签一多被切掉的部分就没法访问了。
 *   ① 滚轮直接横滚（鼠标停在标签栏上滚 = 翻标签，与浏览器 / IDE 的直觉一致）
 *   ② 两端浮出圆箭头，点一次滚 stepRatio 屏；只在**该方向确有内容被遮挡**时才浮出
 *
 * 箭头与淡出遮罩都不占布局宽度（箭头绝对定位、淡出用 mask 画在滚动容器自身上），
 * 所以它们的显隐不会反过来改变滚动区尺寸，不存在 ResizeObserver 回环。
 *
 * 调用方给每个子项加 `data-strip-key={key}`，并传 activeKey，激活项变化时自动滚进视野。
 * 样式在 global.css 的 .kb-tabstrip
 */

/** 「还能不能继续往这个方向滚」的像素容差。非 100% 系统缩放下 scrollWidth / clientWidth
 *  带亚像素误差，不留容差会出现「已经滚到底了箭头还亮着、点下去纹丝不动」 */
const EDGE_TOLERANCE = 1;

/** 边缘淡出宽度（px），也是自动滚动时给激活标签留的余量——与 CSS 的 --kb-tabstrip-fade 一致。
 *  贴着边缘停会正好停在圆箭头下面，看着像被切了一半 */
const FADE_WIDTH = 36;

interface ScrollableTabStripProps {
  children: ReactNode;
  /** 当前激活项的 key —— 变化时自动把它滚进视野 */
  activeKey?: string | number | null;
  /** 点一次箭头滚动的距离占可视宽度的比例。不取满屏，留一段重叠区作视觉参照 */
  stepRatio?: number;
  className?: string;
}

export function ScrollableTabStrip({
  children,
  activeKey,
  stepRatio = 0.8,
  className = "",
}: ScrollableTabStripProps) {
  const elRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  /** 重算两端是否还有被遮挡的内容（决定箭头与淡出遮罩的显隐） */
  const updateEdges = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setCanLeft(scrollLeft > EDGE_TOLERANCE);
    setCanRight(scrollLeft + clientWidth < scrollWidth - EDGE_TOLERANCE);
  }, []);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      // 没溢出就不拦截，滚轮照常交给外层
      if (el.scrollWidth <= el.clientWidth + EDGE_TOLERANCE) return;
      // 触控板横向手势给 deltaX，鼠标滚轮给 deltaY —— 取绝对值大的那个
      const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (raw === 0) return;
      // deltaMode: 0=像素 1=行 2=页；行 / 页模式不换算的话一格只挪几个像素
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1;
      e.preventDefault();
      el.scrollLeft += raw * unit;
    };

    // 🔴 必须手动 addEventListener 且 passive:false：React 的 onWheel 是被动监听，
    //    里面 preventDefault() 不生效
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", updateEdges);

    // 缩窗口 / 增删标签都不触发 scroll 事件，靠 ResizeObserver 补齐，否则箭头停在过期状态
    const ro = new ResizeObserver(() => updateEdges());
    ro.observe(el);
    if (contentRef.current) ro.observe(contentRef.current);
    updateEdges();

    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", updateEdges);
      ro.disconnect();
    };
  }, [updateEdges]);

  // 激活项变化 → 滚进视野。
  // 🔴 用 scrollLeft 手算而不是 scrollIntoView：后者会连带滚动所有祖先滚动容器
  useEffect(() => {
    if (activeKey == null) return;
    const el = elRef.current;
    if (!el) return;
    const target = el.querySelector<HTMLElement>(
      `[data-strip-key="${window.CSS.escape(String(activeKey))}"]`,
    );
    if (!target) return;
    const left = target.offsetLeft;
    const right = left + target.offsetWidth;
    if (left < el.scrollLeft + FADE_WIDTH) {
      el.scrollTo({ left: Math.max(0, left - FADE_WIDTH), behavior: "smooth" });
    } else if (right > el.scrollLeft + el.clientWidth - FADE_WIDTH) {
      el.scrollTo({ left: right - el.clientWidth + FADE_WIDTH, behavior: "smooth" });
    }
    // 依赖只放 activeKey：用户手动滚开去看别的标签时，无关的重渲染不应把视口吸回激活标签
  }, [activeKey]);

  function step(dir: -1 | 1) {
    const el = elRef.current;
    if (!el) return;
    el.scrollTo({ left: el.scrollLeft + dir * el.clientWidth * stepRatio, behavior: "smooth" });
  }

  // 淡出用 mask 而不是纯色渐变遮罩：标题栏是透明底叠在主题背景上，纯色遮罩会显出色差
  const fade = canLeft && canRight ? "both" : canLeft ? "left" : canRight ? "right" : "none";

  return (
    <div className={`kb-tabstrip ${className}`}>
      <button
        type="button"
        className="kb-tabstrip-arrow is-left"
        data-visible={canLeft}
        // 不可用时移出 Tab 键序列，避免焦点落到看不见的按钮上
        tabIndex={canLeft ? 0 : -1}
        title="向左滚动标签"
        aria-label="向左滚动标签"
        onClick={() => step(-1)}
      >
        <ChevronLeft size={13} />
      </button>
      <button
        type="button"
        className="kb-tabstrip-arrow is-right"
        data-visible={canRight}
        tabIndex={canRight ? 0 : -1}
        title="向右滚动标签"
        aria-label="向右滚动标签"
        onClick={() => step(1)}
      >
        <ChevronRight size={13} />
      </button>

      <div ref={elRef} className="kb-tabstrip-scroller" data-fade={fade}>
        <div ref={contentRef} className="kb-tabstrip-row">
          {children}
        </div>
      </div>
    </div>
  );
}
