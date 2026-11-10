/**
 * 安卓系统栏跟随应用主题（导航栏留白底色 + 状态栏 / 导航栏图标深浅）。
 *
 * 原生侧在 MainActivity.onWebViewCreate 里注册了 `window.KbSystemBars`；桌面端和浏览器里没有这个对象，
 * 调用直接跳过。底色取手机令牌 --m-surface（底部 Tab 栏、编辑页的底色），让导航栏留白和 Tab 栏连成一片。
 */

interface KbSystemBarsBridge {
  set: (colorHex: string, dark: boolean) => void;
}

/** 把任意 CSS 颜色（含 color-mix / oklab）转成 #RRGGBB；转不了返回 null */
export function cssColorToHex(color: string): string | null {
  if (typeof document === "undefined") return null;
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#000";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** 主题切换后调用（App.tsx 写完 data-theme 之后）；非安卓环境无操作 */
export function syncSystemBars(dark: boolean): void {
  const bridge = (window as unknown as { KbSystemBars?: KbSystemBarsBridge }).KbSystemBars;
  if (!bridge) return;
  // 新主题的 CSS 变量要等这一帧样式重算后才读得到
  requestAnimationFrame(() => {
    const surface = getComputedStyle(document.documentElement).getPropertyValue("--m-surface").trim();
    const hex = cssColorToHex(surface || (dark ? "#1f1f1f" : "#ffffff"));
    try {
      bridge.set(hex ?? (dark ? "#1f1f1f" : "#ffffff"), dark);
    } catch (e) {
      console.warn("[systemBars] 同步系统栏失败:", e);
    }
  });
}
