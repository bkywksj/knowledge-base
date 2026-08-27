import { describe, it, expect } from "vitest";
import {
  computeBubbleMenuLayout,
  MENU_HEIGHT,
  MENU_GAP,
} from "./bubbleMenuPosition";

/** 复刻真机实测环境：滚动容器视口 818px 高，sticky 工具栏 41px */
const ROOT = { top: 0, bottom: 818, left: 0 };
const TOOLBAR = 41;
/** 工具栏下沿 —— 菜单钉住时的位置 */
const PINNED = ROOT.top + TOOLBAR + MENU_GAP;

function layout(table: { top: number; bottom: number; left?: number }) {
  return computeBubbleMenuLayout({
    table: { top: table.top, bottom: table.bottom, left: table.left ?? 100 },
    scrollRoot: ROOT,
    toolbarHeight: TOOLBAR,
  });
}

describe("表格浮动菜单定位", () => {
  it("表格完整可见时贴在表格上方", () => {
    // 表格顶在 147，理想位置 147-38=109，高于工具栏下沿 → 不钳制
    const r = layout({ top: 147, bottom: 400 });
    expect(r.visible).toBe(true);
    expect(r.top).toBe(147 - MENU_HEIGHT);
  });

  it("长表格滚过一屏 → 钉在工具栏下沿，不再飞出视口（本次修复的核心）", () => {
    // 真机实测数据：滚到 1200 时表格顶为 -1053，底还有 1088 在屏幕上。
    // 修复前算出的 top 是 -1091（完全看不见），修复后应钉在 45。
    const r = layout({ top: -1053, bottom: 1088 });
    expect(r.visible).toBe(true);
    expect(r.top).toBe(PINNED);
    expect(r.top).toBeGreaterThan(0); // 关键：不再是负数
  });

  it("钉住状态在整个滚动过程中保持稳定", () => {
    // 表格底依次逼近，只要还没滚过去，菜单就一直钉在同一位置
    for (const [top, bottom] of [
      [-153, 1988],
      [-553, 1588],
      [-1053, 1088],
      [-1467, 674],
    ] as const) {
      const r = layout({ top, bottom });
      expect(r.visible, `top=${top}`).toBe(true);
      expect(r.top, `top=${top}`).toBe(PINNED);
    }
  });

  it("菜单底不越过表格底边 —— 表格快滚完时跟着表格走", () => {
    // 表格底只剩 60px 时，钉住位置(45)+菜单高(38)=83 会超出表格底，
    // 此时应让位给 maxTop = bottom - MENU_HEIGHT
    const r = layout({ top: -2000, bottom: 60 });
    expect(r.top).toBe(60 - MENU_HEIGHT);
    expect(r.top).toBeLessThan(PINNED);
  });

  it("表格还在下方没进入视口 → 隐藏", () => {
    // 真机实测：scrollTop=0 时表格顶 1654 > 容器底 818
    expect(layout({ top: 1654, bottom: 3795 }).visible).toBe(false);
    expect(layout({ top: 854, bottom: 2995 }).visible).toBe(false);
  });

  it("表格已完全滚过视口上方 → 隐藏", () => {
    // 表格底 = 60，低于 minTop+MENU_HEIGHT(83) → 不再值得显示
    expect(layout({ top: -3000, bottom: 60 }).visible).toBe(false);
  });

  it("表格刚进入视口下沿 → 显示", () => {
    const r = layout({ top: 54, bottom: 2195 });
    expect(r.visible).toBe(true);
  });

  it("没有工具栏（阅读 / 源码模式）时钉在容器顶部", () => {
    const r = computeBubbleMenuLayout({
      table: { top: -500, bottom: 900, left: 0 },
      scrollRoot: ROOT,
      toolbarHeight: 0,
    });
    expect(r.top).toBe(ROOT.top + MENU_GAP);
  });

  it("滚动容器不在视口顶部时（上方有 topbar）也按容器算", () => {
    // 编辑器顶栏占了 120px，容器从 120 起 —— 菜单不能钉到 45 那种"页面顶部"
    const r = computeBubbleMenuLayout({
      table: { top: -400, bottom: 900, left: 0 },
      scrollRoot: { top: 120, bottom: 900, left: 0 },
      toolbarHeight: TOOLBAR,
    });
    expect(r.top).toBe(120 + TOOLBAR + MENU_GAP);
  });

  it("left 始终跟随表格左边缘", () => {
    expect(layout({ top: 100, bottom: 500, left: 386.5 }).left).toBe(386.5);
    expect(layout({ top: -900, bottom: 500, left: 42 }).left).toBe(42);
  });
});
