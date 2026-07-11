import { useEffect, useState } from "react";

/**
 * 软键盘弹出时的底部内边距（像素）—— 移动端键盘回避。
 *
 * 原理：移动端软键盘弹出会压缩 `window.visualViewport`（可视视口），但布局视口
 * （`window.innerHeight`）不变。键盘高度 ≈ 布局视口高度 − 可视视口高度 − 可视视口顶部偏移。
 * 把这个值作为 `fixed` 底部输入/工具栏容器的 `paddingBottom`，即可让输入栏"顶"在键盘之上，
 * 不被遮挡。
 *
 * 安全降级：桌面 / 不支持 visualViewport 的环境恒返回 0，不影响原布局。
 *
 * 用法（fixed inset-0 的全屏页）：
 * ```tsx
 * const kb = useKeyboardInset();
 * <div className="fixed inset-0 flex flex-col" style={{ paddingBottom: kb }}>...</div>
 * ```
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const vv =
      typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;

    const update = () => {
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      // 阈值 60px：过滤浏览器地址栏收放等小幅抖动，避免误判为"键盘弹出"
      setInset(kb > 60 ? kb : 0);
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return inset;
}
