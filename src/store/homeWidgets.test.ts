import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 首页卡片隐藏偏好的持久化行为。
 *
 * 重点盯两件容易回归的事：
 *   1. **写盘门闩** —— hydrate 完成前绝不落盘，否则副窗启动瞬间会用空 Set 抹掉主窗的偏好；
 *   2. **脏键过滤** —— 旧存档里已删除 / 改名的 widget key 不该复活。
 */

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  save: vi.fn(),
  get: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  Store: {
    load: vi.fn(async () => ({
      set: mocks.set,
      save: mocks.save,
      get: mocks.get,
    })),
  },
}));

/**
 * 每个用例都要一份全新的模块实例 —— `hydrated` 门闩和 zustand store 都是模块级状态，
 * 跨用例复用会互相污染。
 */
async function freshModule() {
  vi.resetModules();
  return await import("./homeWidgets");
}

beforeEach(() => {
  mocks.set.mockReset();
  mocks.save.mockReset();
  mocks.get.mockReset();
});

describe("写盘门闩：hydrate 之前不许落盘", () => {
  it("没 hydrate 就 toggle —— 一次都不写盘", async () => {
    const m = await freshModule();
    m.useHomeWidgetsStore.getState().toggleBlur("todo");
    // persistBlurred 的门闩判断是同步的，走不到 Store.load
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    // 但内存状态要立刻生效，UI 不能等落盘
    expect(m.useHomeWidgetsStore.getState().blurred.has("todo")).toBe(true);
  });

  it("hydrate 之后 toggle 才落盘，且写的是完整集合", async () => {
    const m = await freshModule();
    mocks.get.mockResolvedValue([]);
    await m.loadHomeWidgetPrefs();

    m.useHomeWidgetsStore.getState().toggleBlur("todo");
    await vi.waitFor(() => {
      expect(mocks.set).toHaveBeenCalledWith("homeBlurredWidgets", ["todo"]);
    });

    m.useHomeWidgetsStore.getState().toggleBlur("askAi");
    await vi.waitFor(() => {
      expect(mocks.set).toHaveBeenLastCalledWith("homeBlurredWidgets", [
        "todo",
        "askAi",
      ]);
    });
    expect(mocks.save).toHaveBeenCalled();
  });

  it("落盘失败不抛给调用方（顶多下次重点一次眼睛）", async () => {
    const m = await freshModule();
    mocks.get.mockResolvedValue([]);
    await m.loadHomeWidgetPrefs();
    mocks.set.mockRejectedValueOnce(new Error("disk full"));

    expect(() =>
      m.useHomeWidgetsStore.getState().toggleBlur("todo"),
    ).not.toThrow();
    // 内存态仍然生效
    expect(m.useHomeWidgetsStore.getState().blurred.has("todo")).toBe(true);
  });
});

describe("hydrate：读回旧存档", () => {
  it("过滤掉未知 / 非字符串键 —— 改名或删掉的卡片不该复活", async () => {
    const m = await freshModule();
    mocks.get.mockResolvedValue(["todo", "已删除的卡", 123, null, "askAi"]);
    await m.loadHomeWidgetPrefs();

    expect([...m.useHomeWidgetsStore.getState().blurred]).toEqual([
      "todo",
      "askAi",
    ]);
  });

  it("存档不是数组（损坏 / 老格式）时按「都不隐藏」兜底", async () => {
    const m = await freshModule();
    mocks.get.mockResolvedValue("garbage");
    await m.loadHomeWidgetPrefs();

    expect(m.useHomeWidgetsStore.getState().blurred.size).toBe(0);
  });

  it("读盘抛错也要放行门闩，否则之后所有 toggle 都静默不落盘", async () => {
    const m = await freshModule();
    mocks.get.mockRejectedValue(new Error("store unavailable"));
    await expect(m.loadHomeWidgetPrefs()).resolves.toBeUndefined();

    m.useHomeWidgetsStore.getState().toggleBlur("pinned");
    await vi.waitFor(() => {
      expect(mocks.set).toHaveBeenCalledWith("homeBlurredWidgets", ["pinned"]);
    });
  });
});

describe("isWidgetBlurred：隐私模式优先于单卡偏好", () => {
  it("单卡隐藏只影响自己", async () => {
    const m = await freshModule();
    const state = { privacyMode: false, blurred: new Set(["todo" as const]) };
    expect(m.isWidgetBlurred(state, "todo")).toBe(true);
    expect(m.isWidgetBlurred(state, "recentNotes")).toBe(false);
  });

  it("隐私模式一开，没被单独隐藏的卡也要遮住", async () => {
    const m = await freshModule();
    const state = { privacyMode: true, blurred: new Set<never>() };
    expect(m.isWidgetBlurred(state, "recentNotes")).toBe(true);
  });

  it("退出隐私模式后，单卡偏好原样还在（不被顺手清掉）", async () => {
    const m = await freshModule();
    mocks.get.mockResolvedValue(["todo"]);
    await m.loadHomeWidgetPrefs();
    const store = m.useHomeWidgetsStore.getState();

    store.togglePrivacyMode();
    expect(m.useHomeWidgetsStore.getState().privacyMode).toBe(true);
    m.useHomeWidgetsStore.getState().togglePrivacyMode();

    const after = m.useHomeWidgetsStore.getState();
    expect(after.privacyMode).toBe(false);
    expect(m.isWidgetBlurred(after, "todo")).toBe(true);
    expect(m.isWidgetBlurred(after, "recentNotes")).toBe(false);
  });

  it("privacyMode 不落盘 —— 它是应急开关，重启不该还遮着", async () => {
    const m = await freshModule();
    mocks.get.mockResolvedValue([]);
    await m.loadHomeWidgetPrefs();

    m.useHomeWidgetsStore.getState().togglePrivacyMode();
    // 给异步写盘留出机会，确认确实没人去写
    await Promise.resolve();
    expect(mocks.set).not.toHaveBeenCalled();
  });
});

describe("toggleBlur：幂等", () => {
  it("连点两次回到原状态", async () => {
    const m = await freshModule();
    mocks.get.mockResolvedValue([]);
    await m.loadHomeWidgetPrefs();

    m.useHomeWidgetsStore.getState().toggleBlur("todo");
    m.useHomeWidgetsStore.getState().toggleBlur("todo");
    expect(m.useHomeWidgetsStore.getState().blurred.size).toBe(0);
  });
});
