import { useEffect, useState } from "react";

/**
 * 窗口尺寸档位（Material 3 Window Size Class）。
 *
 * 与 {@link useIsMobile} 是**互不干扰的两件事**，别混用：
 * - `useIsMobile()` 决定「走哪套组件树」（Mobile* 组件 vs 桌面组件），只看操作系统；
 *   平板/折叠屏展开时它**依然是 true** —— 平板用的仍是移动端 UI，只是排布更宽。
 * - `useWindowSizeClass()` 决定「移动 UI 内部怎么排布」（底部 Tab vs 侧边 Rail、
 *   卡片几列、热力图多大）。桌面壳恒为 expanded，但桌面组件树根本不读它。
 *
 * 之所以要拆开：如果让 useIsMobile 跟着宽度翻转，平板一超过 600dp 就会整体跳到桌面
 * 组件树，而桌面 UI 是按 hover / 右键 / 窗口控制设计的，触屏上会连环踩坑。
 *
 * 断点取 Android 官方 Window Size Class（单位 dp，CSS px 在移动 WebView 上等价）：
 * - compact  : < 600  手机竖屏、折叠屏折叠态
 * - medium   : 600–839 平板竖屏、折叠屏展开、大部分分屏
 * - expanded : ≥ 840  平板横屏、DeX / WSA 大窗口、Chromebook
 */
export type SizeClass = "compact" | "medium" | "expanded";

const MEDIUM_MIN = 600;
const EXPANDED_MIN = 840;

/** 是否运行在 Tauri 壳内（桌面或移动）。Tauri 2 在页面脚本执行前注入，首屏同步可读。 */
function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return "__TAURI_INTERNALS__" in w || "__TAURI__" in w;
}

/** 纯按视口宽度分档 */
function classifyByWidth(width: number): SizeClass {
  if (width >= EXPANDED_MIN) return "expanded";
  if (width >= MEDIUM_MIN) return "medium";
  return "compact";
}

function detectSizeClass(): SizeClass {
  if (typeof window === "undefined") return "expanded";

  // 1. 真·移动 OS：按宽度分三档（手机 / 平板 / 折叠屏展开 / WSA 大窗口）
  const ua = navigator.userAgent || "";
  if (/Android|iPhone|iPad|iPod/i.test(ua)) {
    return classifyByWidth(window.innerWidth);
  }

  // 2. Tauri 桌面壳：恒 expanded，**完全忽略窗口宽度**。
  //    与 useIsMobile 同款保护——竖屏显示器 / 双屏 / 分屏把窗口拉窄也绝不变手机版。
  if (isTauriRuntime()) return "expanded";

  // 3. 普通浏览器（vite dev 用 Chrome 打开）：按宽度兜底，方便开发期拉窄模拟平板/手机
  return classifyByWidth(window.innerWidth);
}

export function useWindowSizeClass(): SizeClass {
  const [sizeClass, setSizeClass] = useState<SizeClass>(detectSizeClass);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    // 用 matchMedia 而非 resize：只在跨阈值时触发，折叠屏展开/平板旋转都能实时响应
    const queries = [MEDIUM_MIN, EXPANDED_MIN].map((bp) =>
      window.matchMedia(`(min-width: ${bp}px)`),
    );
    const handler = () => setSizeClass(detectSizeClass());
    queries.forEach((mql) => {
      // Safari < 14 不支持 addEventListener('change')，回退 addListener
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", handler);
      } else {
        mql.addListener(handler);
      }
    });
    return () => {
      queries.forEach((mql) => {
        if (typeof mql.removeEventListener === "function") {
          mql.removeEventListener("change", handler);
        } else {
          mql.removeListener(handler);
        }
      });
    };
  }, []);

  return sizeClass;
}
