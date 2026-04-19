import { create } from "zustand";
import { Store } from "@tauri-apps/plugin-store";
import type { ThemeMode, ThemeCategory } from "@/theme/tokens";

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
  /** "新建笔记" Modal 全局开关 */
  createModalOpen: boolean;
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
  /** 打开"新建笔记" Modal */
  openCreateModal: () => void;
  /** 关闭"新建笔记" Modal */
  closeCreateModal: () => void;
}

export const useAppStore = create<AppStore>((set, get) => ({
  lightTheme: "light-glass",
  darkTheme: "dark-starry",
  themeCategory: "light",
  sidebarCollapsed: false,
  focusMode: false,
  createModalOpen: false,
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
  openCreateModal: () => set({ createModalOpen: true }),
  closeCreateModal: () => set({ createModalOpen: false }),
}));

/** 从 tauri-plugin-store 恢复主题设置 */
export async function loadThemeFromStore() {
  try {
    const store = await Store.load(STORE_FILE);
    const lt = await store.get<ThemeMode>("lightTheme");
    const dt = await store.get<ThemeMode>("darkTheme");
    const cat = await store.get<ThemeCategory>("themeCategory");
    if (lt) useAppStore.getState().setLightTheme(lt);
    if (dt) useAppStore.getState().setDarkTheme(dt);
    if (cat) useAppStore.getState().setThemeCategory(cat);
  } catch {
    // 首次启动时 store 可能不存在
  }
}

/** 保存主题设置到 tauri-plugin-store */
export async function saveThemeToStore() {
  try {
    const { lightTheme, darkTheme, themeCategory } = useAppStore.getState();
    const store = await Store.load(STORE_FILE);
    await store.set("lightTheme", lightTheme);
    await store.set("darkTheme", darkTheme);
    await store.set("themeCategory", themeCategory);
    await store.save();
  } catch {
    // 静默失败
  }
}

// 监听主题变化自动保存
let _prevThemeKey = "";
useAppStore.subscribe((state) => {
  const key = `${state.lightTheme}|${state.darkTheme}|${state.themeCategory}`;
  if (key !== _prevThemeKey) {
    _prevThemeKey = key;
    saveThemeToStore();
  }
});
