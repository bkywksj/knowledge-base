import { useEffect, useState } from "react";

/**
 * 移动端布局开关。
 *
 * 判定优先级（从高到低）：
 * 1. 真·移动端操作系统（UA 含 Android / iPhone / iPad）→ 强制移动端
 * 2. 运行在 Tauri 桌面壳里（Windows / macOS / Linux）→ 永远桌面端，
 *    **完全忽略窗口宽度**。竖屏显示器 / 双屏 / 分屏把窗口拉窄到 < 768px
 *    也不会误切移动布局——电脑端只能是电脑界面。
 * 3. 普通浏览器（vite dev 直接用 Chrome 打开）→ 按视口宽度兜底，
 *    方便开发期拉窄窗口模拟手机布局。
 *
 * 使用 matchMedia 而非 resize 事件：matchMedia 只在跨阈值时触发，远比 resize 高效。
 */
const MOBILE_BREAKPOINT = 768;

/** 是否运行在 Tauri 壳内（桌面或移动）。Tauri 2 在页面脚本执行前注入，首屏同步可读。 */
function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return "__TAURI_INTERNALS__" in w || "__TAURI__" in w;
}

function detectMobile(): boolean {
  if (typeof window === "undefined") return false;
  // 1. Tauri Mobile / 移动浏览器：navigator.userAgent 含 'Android' / 'iPhone' / 'iPad'
  const ua = navigator.userAgent || "";
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return true;
  // 2. Tauri 桌面壳：永远桌面界面，不受窗口宽度影响（修复竖屏/双屏误判为移动端）
  if (isTauriRuntime()) return false;
  // 3. 普通浏览器（开发态）：按视口宽度兜底
  return window.innerWidth < MOBILE_BREAKPOINT;
}

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(detectMobile);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const handler = () => setIsMobile(detectMobile());
    // Safari < 14 不支持 addEventListener('change'，回退 addListener
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", handler);
      return () => mql.removeEventListener("change", handler);
    }
    mql.addListener(handler);
    return () => mql.removeListener(handler);
  }, []);

  return isMobile;
}
