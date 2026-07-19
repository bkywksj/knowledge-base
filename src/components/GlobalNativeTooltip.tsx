import { useEffect, useRef, useState } from "react";
import { Tooltip } from "antd";

/**
 * 全局「原生 title 提示」统一器 —— 把整站任意 HTML 元素的浏览器原生 `title` 悬停黄条，
 * 统一替换成与侧边栏一致的 AntD Tooltip 深色圆角气泡。一处挂载即全站生效（含以后新写的 title）。
 *
 * 机制：
 *  1. 捕获阶段监听 document 的 mouseover，找到最近带 `title`（或已被借走的 `data-native-title`）的祖先元素；
 *  2. 首次遇到就把它的 `title`「借走」存到 `data-native-title`（从此浏览器不再弹原生黄条），
 *     并补一个 `aria-label` 保住无障碍可达性；
 *  3. 用一个**受控** AntD Tooltip，在该元素的矩形位置渲染同款气泡（跟随主题）。
 *
 * 安全性：只作用于「带 title 特性的 DOM 元素」。AntD 自己的 Tooltip/Modal/Drawer 等把标题放在
 * 组件 overlay 里、触发器 DOM 上并没有 `title` 特性，故本拦截器完全不碰它们，零冲突、零布局改动。
 */
export default function GlobalNativeTooltip() {
  const [data, setData] = useState<{ title: string; rect: DOMRect } | null>(null);
  const curRef = useRef<Element | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const clearTimer = () => { if (timerRef.current != null) { window.clearTimeout(timerRef.current); timerRef.current = null; } };
    const hide = () => { clearTimer(); curRef.current = null; setData(null); };

    const onOver = (e: MouseEvent) => {
      const target = e.target as Element | null;
      const el = target?.closest?.("[title], [data-native-title]") as HTMLElement | null;
      if (el === curRef.current) return;   // 仍在同一元素（或其子节点）上 → 不动
      curRef.current = el;
      clearTimer();
      setData(null);                        // 换元素/离开 → 先收起当前气泡
      if (!el) return;
      // 首次遇到：把原生 title 借走（防浏览器再弹黄条），补 aria-label 保无障碍
      if (el.hasAttribute("title")) {
        const tt = el.getAttribute("title") ?? "";
        el.setAttribute("data-native-title", tt);
        if (tt && !el.hasAttribute("aria-label")) el.setAttribute("aria-label", tt);
        el.removeAttribute("title");
      }
      const tt = (el.getAttribute("data-native-title") ?? "").trim();
      if (!tt) return;                      // 空 title 不弹（仍记为 current，避免反复处理）
      const rect = el.getBoundingClientRect();
      // 轻微延迟再显示（对齐侧边栏 mouseEnterDelay），避免鼠标扫过一排图标时气泡狂闪
      timerRef.current = window.setTimeout(() => setData({ title: tt, rect }), 150);
    };

    // 离开窗口 / 滚动 / 滚轮 / 按下 → 收起，避免气泡停在旧位置
    const onOut = (e: MouseEvent) => { if (!e.relatedTarget) hide(); };
    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("mouseout", onOut, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("wheel", hide, { capture: true, passive: true });
    window.addEventListener("mousedown", hide, true);
    return () => {
      clearTimer();
      document.removeEventListener("mouseover", onOver, true);
      document.removeEventListener("mouseout", onOut, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("wheel", hide, true as unknown as EventListenerOptions);
      window.removeEventListener("mousedown", hide, true);
    };
  }, []);

  if (!data) return null;
  const { rect, title } = data;
  return (
    <Tooltip
      // key 随位置变 → 换元素时重挂载 Tooltip，确保重新对齐到新矩形
      key={`${Math.round(rect.left)}:${Math.round(rect.top)}`}
      open
      title={title}
      placement="top"
      trigger={[]}
    >
      {/* 0 尺寸锚点：固定定位到目标元素矩形上，Tooltip 据此定位；不拦鼠标、不占层级 */}
      <span
        aria-hidden
        style={{
          position: "fixed",
          left: rect.left,
          top: rect.top,
          width: rect.width || 1,
          height: rect.height || 1,
          pointerEvents: "none",
          zIndex: -1,
        }}
      />
    </Tooltip>
  );
}
