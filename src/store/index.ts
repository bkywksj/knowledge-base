import { create } from "zustand";
import { Store } from "@tauri-apps/plugin-store";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { taskApi } from "@/lib/api";
import type { ThemeMode, ThemeCategory } from "@/theme/tokens";

/**
 * 侧边栏当前活动视图（Activity Bar 模式）。
 * - 有主面板：notes / search / daily / tags / tasks —— 中间 SidePanel 展示对应内容
 * - 无主面板：home / graph / ai / prompts / about / trash —— 点图标直接切主区
 */
export type ActiveView =
  | "home"
  | "notes"
  | "search"
  | "daily"
  | "tags"
  | "tasks"
  | "graph"
  | "ai"
  | "prompts"
  | "about"
  | "trash";

/** SidePanel 宽度范围（px），避免用户拖到极端值 */
export const SIDE_PANEL_MIN_WIDTH = 200;
export const SIDE_PANEL_MAX_WIDTH = 480;
export const SIDE_PANEL_DEFAULT_WIDTH = 240;

// 开发/生产数据隔离：dev 用 dev-settings.json，prod 用 settings.json
// 与后端 cfg!(debug_assertions) 加 dev- 前缀对齐；旧文件由后端 migrate_to_dev_prefix 自动迁移
const STORE_FILE = import.meta.env.DEV ? "dev-settings.json" : "settings.json";

interface AppStore {
  /** 当前亮色主题 */
  lightTheme: ThemeMode;
  /** 当前暗色主题 */
  darkTheme: ThemeMode;
  /** 当前活跃分类（亮/暗） */
  themeCategory: ThemeCategory;
  /** 侧边栏是否折叠 */
  sidebarCollapsed: boolean;
  /** 专注模式 */
  focusMode: boolean;
  /** 笔记列表刷新触发器：递增即触发各页面重新拉数据 */
  notesRefreshTick: number;
  /** 文件夹列表刷新触发器：Sidebar CRUD 后递增，编辑器/列表/设置页自动重拉 */
  foldersRefreshTick: number;
  /** 标签列表刷新触发器：标签页/编辑器 CRUD 后递增，其他消费者自动重拉 */
  tagsRefreshTick: number;
  /** 未完成 + 紧急的任务数（用于侧边栏红色 Badge） */
  urgentTodoCount: number;
  /** 窗口置顶状态（UI 真相源；托盘 CheckMenuItem 通过事件同步） */
  alwaysOnTop: boolean;
  /** 当前活动视图（Activity Bar 模式）；与 URL 双向同步 */
  activeView: ActiveView;
  /** SidePanel（Activity Bar 右侧主面板）宽度 */
  sidePanelWidth: number;
  /**
   * SidePanel 是否展开。
   * 折叠时只保留 48px ActivityBar，主区撑满。
   * VS Code 行为：点击当前高亮图标 = 折叠/展开 SidePanel。
   */
  sidePanelVisible: boolean;
  /** 获取当前生效的主题 */
  activeTheme: () => ThemeMode;
  /** 切换亮/暗分类 */
  toggleTheme: () => void;
  /** 设置亮色主题 */
  setLightTheme: (theme: ThemeMode) => void;
  /** 设置暗色主题 */
  setDarkTheme: (theme: ThemeMode) => void;
  /** 设置主题分类 */
  setThemeCategory: (category: ThemeCategory) => void;
  /** 切换侧边栏 */
  toggleSidebar: () => void;
  /** 设置专注模式 */
  setFocusMode: (on: boolean) => void;
  /** 触发所有监听笔记列表的页面刷新（导入/创建后调用） */
  bumpNotesRefresh: () => void;
  /** 触发所有文件夹下拉/列表刷新（Sidebar 增删改/拖拽后调用） */
  bumpFoldersRefresh: () => void;
  /** 触发所有标签下拉/列表刷新（标签页或编辑器新建标签后调用） */
  bumpTagsRefresh: () => void;
  /** 重新拉取任务统计（任务变更后调用，用于刷新侧边栏 Badge） */
  refreshTaskStats: () => Promise<void>;
  /**
   * 设置窗口置顶。
   * - skipEmit=true：不再通知 Rust 侧（用于从 Rust 过来的事件回流，避免循环）
   * - 默认会 emit `ui:always-on-top-changed` 让托盘 CheckMenuItem 跟随
   */
  setAlwaysOnTop: (enabled: boolean, opts?: { skipEmit?: boolean }) => Promise<void>;
  /**
   * 设置活动视图（纯 setter，无副作用）。
   * "点同视图 = 折叠面板" 的 VS Code 行为由 ActivityBar 自己判断，
   * store 只负责保存状态，避免 navigate / URL 同步时误触发折叠。
   */
  setActiveView: (view: ActiveView) => void;
  /** 设置 SidePanel 宽度（自动 clamp 到 [MIN, MAX]） */
  setSidePanelWidth: (width: number) => void;
  /** 设置 SidePanel 可见性 */
  setSidePanelVisible: (visible: boolean) => void;
  /** 切换 SidePanel 可见性（等价于 setSidePanelVisible(!visible)） */
  toggleSidePanel: () => void;
}

export const useAppStore = create<AppStore>((set, get) => ({
  lightTheme: "light-glass",
  darkTheme: "dark-starry",
  themeCategory: "light",
  sidebarCollapsed: false,
  focusMode: false,
  notesRefreshTick: 0,
  foldersRefreshTick: 0,
  tagsRefreshTick: 0,
  urgentTodoCount: 0,
  alwaysOnTop: false,
  activeView: "notes",
  sidePanelWidth: SIDE_PANEL_DEFAULT_WIDTH,
  sidePanelVisible: true,
  activeTheme: () => {
    const s = get();
    return s.themeCategory === "light" ? s.lightTheme : s.darkTheme;
  },
  toggleTheme: () =>
    set((s) => ({
      themeCategory: s.themeCategory === "light" ? "dark" : "light",
    })),
  setLightTheme: (theme) => set({ lightTheme: theme }),
  setDarkTheme: (theme) => set({ darkTheme: theme }),
  setThemeCategory: (category) => set({ themeCategory: category }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setFocusMode: (on) => set({ focusMode: on }),
  bumpNotesRefresh: () => set((s) => ({ notesRefreshTick: s.notesRefreshTick + 1 })),
  bumpFoldersRefresh: () => set((s) => ({ foldersRefreshTick: s.foldersRefreshTick + 1 })),
  bumpTagsRefresh: () => set((s) => ({ tagsRefreshTick: s.tagsRefreshTick + 1 })),
  refreshTaskStats: async () => {
    try {
      const stats = await taskApi.stats();
      set({ urgentTodoCount: stats.urgentTodo });
    } catch {
      // 静默失败：侧边栏 Badge 不是关键路径
    }
  },
  setActiveView: (view) => set({ activeView: view }),
  setSidePanelWidth: (width) =>
    set({
      sidePanelWidth: Math.max(
        SIDE_PANEL_MIN_WIDTH,
        Math.min(SIDE_PANEL_MAX_WIDTH, Math.round(width)),
      ),
    }),
  setSidePanelVisible: (visible) => set({ sidePanelVisible: visible }),
  toggleSidePanel: () => set((s) => ({ sidePanelVisible: !s.sidePanelVisible })),
  setAlwaysOnTop: async (enabled, opts) => {
    try {
      await getCurrentWindow().setAlwaysOnTop(enabled);
    } catch (e) {
      console.error("[alwaysOnTop] set window api failed:", e);
      return;
    }
    set({ alwaysOnTop: enabled });
    if (!opts?.skipEmit) {
      try {
        await emit("ui:always-on-top-changed", enabled);
      } catch {
        // emit 失败时托盘勾选会不同步，非关键
      }
    }
  },
}));

/** 从 tauri-plugin-store 恢复持久化的偏好（主题 + 窗口置顶） */
export async function loadThemeFromStore() {
  try {
    const store = await Store.load(STORE_FILE);
    const lt = await store.get<ThemeMode>("lightTheme");
    const dt = await store.get<ThemeMode>("darkTheme");
    const cat = await store.get<ThemeCategory>("themeCategory");
    if (lt) useAppStore.getState().setLightTheme(lt);
    if (dt) useAppStore.getState().setDarkTheme(dt);
    if (cat) useAppStore.getState().setThemeCategory(cat);

    // 恢复窗口置顶：走 setAlwaysOnTop 让 window API + 托盘 CheckMenuItem 同步生效
    const aot = await store.get<boolean>("alwaysOnTop");
    if (aot === true) {
      // 只在持久化值为 true 时调用，避免无意义的 emit
      await useAppStore.getState().setAlwaysOnTop(true);
    }

    // 恢复 SidePanel 宽度与可见性（Activity Bar 模式偏好）
    const spw = await store.get<number>("sidePanelWidth");
    if (typeof spw === "number" && Number.isFinite(spw)) {
      useAppStore.getState().setSidePanelWidth(spw);
    }
    const spv = await store.get<boolean>("sidePanelVisible");
    if (typeof spv === "boolean") {
      useAppStore.getState().setSidePanelVisible(spv);
    }
  } catch {
    // 首次启动时 store 可能不存在
  }
}

/** 保存主题 + 窗口置顶 + SidePanel 偏好到 tauri-plugin-store */
export async function saveThemeToStore() {
  try {
    const {
      lightTheme,
      darkTheme,
      themeCategory,
      alwaysOnTop,
      sidePanelWidth,
      sidePanelVisible,
    } = useAppStore.getState();
    const store = await Store.load(STORE_FILE);
    await store.set("lightTheme", lightTheme);
    await store.set("darkTheme", darkTheme);
    await store.set("themeCategory", themeCategory);
    await store.set("alwaysOnTop", alwaysOnTop);
    await store.set("sidePanelWidth", sidePanelWidth);
    await store.set("sidePanelVisible", sidePanelVisible);
    await store.save();
  } catch {
    // 静默失败
  }
}

// 监听主题 + 置顶 + SidePanel 偏好变化自动保存
let _prevPersistKey = "";
useAppStore.subscribe((state) => {
  const key = `${state.lightTheme}|${state.darkTheme}|${state.themeCategory}|${state.alwaysOnTop}|${state.sidePanelWidth}|${state.sidePanelVisible}`;
  if (key !== _prevPersistKey) {
    _prevPersistKey = key;
    saveThemeToStore();
  }
});
