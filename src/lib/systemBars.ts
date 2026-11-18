/**
 * 安卓系统栏跟随应用主题（导航栏留白底色 + 状态栏 / 导航栏图标深浅）。
 *
 * 原生侧在 MainActivity.onWebViewCreate 里注册了 `window.KbSystemBars`；桌面端和浏览器里没有这个对象，
 * 调用直接跳过。底色取手机令牌 --m-surface（底部 Tab 栏、编辑页的底色），让导航栏留白和 Tab 栏连成一片。
 */

interface KbSystemBarsBridge {
  set: (colorHex: string, dark: boolean) => void;
  /** 状态栏（含刘海）高度，CSS 像素；旧版安装包没有这个方法 */
  statusBarTop?: () => number;
}

function getBridge(): KbSystemBarsBridge | undefined {
  return (window as unknown as { KbSystemBars?: KbSystemBarsBridge }).KbSystemBars;
}

/**
 * 把原生报告的状态栏高度写进 `--kb-native-sat`，供 `--kb-safe-top`（mobile.css）取 max(env, 原生值)。
 *
 * env(safe-area-inset-top) 在旧版 Android WebView 上只算刘海不算状态栏，澎湃 OS 3 还会受系统刘海设置影响，
 * 取到 0 时页面头部压在状态栏上（用户反馈）。原生值在 insets 变化时也会直接推过来（MainActivity），
 * 这里管页面刚加载、原生那次推送已经错过的情况。启动时和窗口尺寸变化时各调一次；非安卓环境无操作。
 */
export function applyNativeSafeTop(): void {
  const bridge = getBridge();
  if (typeof bridge?.statusBarTop !== "function") return;
  try {
    // 必须挂在 bridge 上调用：@JavascriptInterface 方法单独取出来再调会抛异常（真机实测，值一直没写进去）
    const top = Number(bridge.statusBarTop());
    if (Number.isFinite(top) && top >= 0) {
      document.documentElement.style.setProperty("--kb-native-sat", `${top}px`);
    }
  } catch (e) {
    console.warn("[systemBars] 读取状态栏高度失败:", e);
  }
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
  const bridge = getBridge();
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
