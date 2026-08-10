import { create } from "zustand";
import { Store } from "@tauri-apps/plugin-store";

/**
 * 首页卡片的「隐藏（模糊遮盖）」偏好。
 *
 * 为什么单开一个 store 而不并进 `@/store/index.ts`：
 * 主 store 的 `collectPersistPayload` / `loadThemeFromStore` 是一对必须手工同步的
 * 长清单（`store/persist.test.ts` 会校验两边一致），首页这种局部 UI 偏好挤进去
 * 只会让清单继续膨胀。这里仍写同一份 settings.json，但用**独立键** —— 两条链路
 * 都只 `store.set(自己的键)` 再 `save()`，插件侧共用同一个 store 实例，
 * 各自的键不会被对方抹掉。
 */

/** 与 `@/store/index.ts` 的 STORE_FILE 同口径（dev / prod 数据隔离） */
const STORE_FILE = import.meta.env.DEV ? "dev-settings.json" : "settings.json";

/** 持久化键名。主 store 的 payload 里没有同名键，两边不会互相覆盖 */
const PERSIST_KEY = "homeBlurredWidgets";

/** 可被眼睛按钮遮盖的首页卡片 */
export type HomeWidgetKey = "todo" | "recentNotes" | "pinned" | "askAi";

/** 合法键集合 —— 用来过滤旧存档里已被重命名 / 删除的残留键 */
const ALL_KEYS: ReadonlySet<string> = new Set([
  "todo",
  "recentNotes",
  "pinned",
  "askAi",
] satisfies HomeWidgetKey[]);

interface HomeWidgetsStore {
  /** 被用户单独隐藏的卡片（持久化） */
  blurred: Set<HomeWidgetKey>;
  /**
   * 全局隐私模式：一键遮住首页所有卡片（Ctrl/⌘+Shift+H）。
   *
   * **刻意不持久化** —— 这是「有人走过来了」的应急开关；重启后还遮着只会让人
   * 以为数据丢了。需要长期遮住某张卡请用单卡眼睛（那个才持久化）。
   */
  privacyMode: boolean;
  /** 切换单张卡片的隐藏状态（立即落盘） */
  toggleBlur: (key: HomeWidgetKey) => void;
  /** 切换全局隐私模式（仅内存） */
  togglePrivacyMode: () => void;
}

export const useHomeWidgetsStore = create<HomeWidgetsStore>((set, get) => ({
  blurred: new Set(),
  privacyMode: false,
  toggleBlur: (key) => {
    const next = new Set(get().blurred);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    set({ blurred: next });
    void persistBlurred(next);
  },
  togglePrivacyMode: () => set((s) => ({ privacyMode: !s.privacyMode })),
}));

/**
 * 某张卡当前是否该被遮住 —— 全局隐私模式优先，其次看单卡偏好。
 *
 * 抽成纯函数（而不是只写在 hook 里）是为了能单测：vitest 跑在 `environment: node`，
 * 没有 React 运行时，hook 调不动。
 */
export function isWidgetBlurred(
  state: Pick<HomeWidgetsStore, "privacyMode" | "blurred">,
  key: HomeWidgetKey,
): boolean {
  return state.privacyMode || state.blurred.has(key);
}

/** {@link isWidgetBlurred} 的 hook 包装 */
export function useWidgetBlurred(key: HomeWidgetKey): boolean {
  return useHomeWidgetsStore((s) => isWidgetBlurred(s, key));
}

/**
 * 写盘门闩：hydrate 完成前不落盘。
 *
 * 否则副窗启动瞬间（内存里还是空 Set）任意一次 toggle 都会把主窗刚存的隐藏项抹掉
 * —— 和主 store `_settingsHydrated` 挡的是同一个坑。
 */
let hydrated = false;

async function persistBlurred(blurred: Set<HomeWidgetKey>): Promise<void> {
  if (!hydrated) return;
  try {
    const store = await Store.load(STORE_FILE);
    await store.set(PERSIST_KEY, [...blurred]);
    await store.save();
  } catch {
    // 静默失败：偏好丢了顶多下次重点一次眼睛，不值得打断用户
  }
}

/**
 * 启动时恢复隐藏偏好。
 *
 * 在 `main.tsx` 里必须 **await**：那边 `renderApp()` 挂在 `.finally()` 上，
 * 等这次读取完再渲染，本该遮住的内容就不会先明文闪一帧 —— 对隐私开关来说
 * 那一帧正是它要防的东西。
 */
export async function loadHomeWidgetPrefs(): Promise<void> {
  try {
    const store = await Store.load(STORE_FILE);
    const saved = await store.get<unknown>(PERSIST_KEY);
    if (Array.isArray(saved)) {
      const valid = saved.filter(
        (k): k is HomeWidgetKey => typeof k === "string" && ALL_KEYS.has(k),
      );
      useHomeWidgetsStore.setState({ blurred: new Set(valid) });
    }
  } catch {
    // 读不到就按「都不隐藏」走，不影响首页可用
  } finally {
    hydrated = true;
  }
}
