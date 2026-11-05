/**
 * SidePanel 的显示方式（纯函数，AppLayout / store 共用）
 *
 * 窗口够宽时面板占布局位置（docked），用户的开关偏好持久化；
 * 窗口窄时默认收起给内容区留空间，点按钮才以浮层盖在内容上（overlay）。
 * 窄窗口的开关单独记、不持久化：1366×768 + 125% 缩放这类屏幕永远够不到宽窗口，
 * 以前窄窗口连按钮都不显示，这些用户的文件夹树和标签面板根本打不开。
 */

/**
 * 自动收起的窗口宽度阈值（带迟滞，避免在边界拖动时来回闪）：
 * - 当前宽窗口 → 宽度 < HIDE_BELOW 时算窄
 * - 当前窄窗口 → 宽度 ≥ SHOW_ABOVE 时才算宽
 */
export const SIDE_PANEL_AUTO_HIDE_BELOW = 1180;
export const SIDE_PANEL_AUTO_SHOW_ABOVE = 1240;

export function nextIsNarrowWindow(prev: boolean, width: number): boolean {
  return prev ? width < SIDE_PANEL_AUTO_SHOW_ABOVE : width < SIDE_PANEL_AUTO_HIDE_BELOW;
}

export interface SidePanelLayoutInput {
  /** 当前路由是设置 / 关于这类自带导航的全页路由 */
  isStandalonePage: boolean;
  /** 当前视图本身有面板 */
  viewHasPanel: boolean;
  isNarrowWindow: boolean;
  /** 用户在宽窗口下的偏好 */
  sidePanelVisible: boolean;
  /** 窄窗口下浮层是否打开 */
  narrowPanelOpen: boolean;
}

export interface SidePanelLayout {
  /** 标题栏要不要显示折叠 / 展开按钮 */
  canToggle: boolean;
  /** 面板占布局位置（主区让出宽度） */
  docked: boolean;
  /** 面板以浮层盖在内容上 */
  overlay: boolean;
}

export function resolveSidePanelLayout(input: SidePanelLayoutInput): SidePanelLayout {
  const canToggle = !input.isStandalonePage && input.viewHasPanel;
  return {
    canToggle,
    docked: canToggle && !input.isNarrowWindow && input.sidePanelVisible,
    overlay: canToggle && input.isNarrowWindow && input.narrowPanelOpen,
  };
}
