import { describe, expect, it } from "vitest";
import { nextIsNarrowWindow, resolveSidePanelLayout } from "./sidePanelLayout";

const base = {
  isStandalonePage: false,
  viewHasPanel: true,
  isNarrowWindow: false,
  sidePanelVisible: true,
  narrowPanelOpen: false,
  narrowPanelPinned: false,
};

describe("resolveSidePanelLayout", () => {
  it("宽窗口按用户偏好占布局位置", () => {
    expect(resolveSidePanelLayout(base)).toEqual({ canToggle: true, docked: true, overlay: false });
    expect(resolveSidePanelLayout({ ...base, sidePanelVisible: false })).toEqual({
      canToggle: true,
      docked: false,
      overlay: false,
    });
  });

  it("窄窗口默认收起，但按钮还在（用户反馈没有展开图标的根因）", () => {
    expect(resolveSidePanelLayout({ ...base, isNarrowWindow: true })).toEqual({
      canToggle: true,
      docked: false,
      overlay: false,
    });
  });

  it("窄窗口打开后是浮层，不占布局位置", () => {
    expect(
      resolveSidePanelLayout({ ...base, isNarrowWindow: true, narrowPanelOpen: true }),
    ).toEqual({ canToggle: true, docked: false, overlay: true });
  });

  it("窄窗口的开关和宽窗口偏好互不影响", () => {
    expect(
      resolveSidePanelLayout({
        ...base,
        isNarrowWindow: true,
        sidePanelVisible: false,
        narrowPanelOpen: true,
      }).overlay,
    ).toBe(true);
    expect(resolveSidePanelLayout({ ...base, narrowPanelOpen: true }).overlay).toBe(false);
  });

  it("固定后窄窗口也按宽窗口规则占位，浮层开关不再起作用", () => {
    const pinned = { ...base, isNarrowWindow: true, narrowPanelPinned: true };
    expect(resolveSidePanelLayout(pinned)).toEqual({ canToggle: true, docked: true, overlay: false });
    expect(resolveSidePanelLayout({ ...pinned, sidePanelVisible: false, narrowPanelOpen: true })).toEqual({
      canToggle: true,
      docked: false,
      overlay: false,
    });
    // 宽窗口里固定与否没有区别
    expect(resolveSidePanelLayout({ ...base, narrowPanelPinned: true })).toEqual(resolveSidePanelLayout(base));
  });

  it("没有面板的视图和全页路由不显示按钮，也不显示面板", () => {
    for (const extra of [{ viewHasPanel: false }, { isStandalonePage: true }]) {
      expect(
        resolveSidePanelLayout({ ...base, isNarrowWindow: true, narrowPanelOpen: true, ...extra }),
      ).toEqual({ canToggle: false, docked: false, overlay: false });
    }
  });
});

describe("nextIsNarrowWindow", () => {
  it("带迟滞：收起后要拉宽过 1240 才恢复", () => {
    expect(nextIsNarrowWindow(false, 1180)).toBe(false);
    expect(nextIsNarrowWindow(false, 1179)).toBe(true);
    expect(nextIsNarrowWindow(true, 1239)).toBe(true);
    expect(nextIsNarrowWindow(true, 1240)).toBe(false);
  });
});
