import { create } from "zustand";

interface AppStore {
  /** 主题模式 */
  theme: "light" | "dark";
  /** 侧边栏是否折叠 */
  sidebarCollapsed: boolean;
  /** 专注模式 */
  focusMode: boolean;
  /** 切换主题 */
  toggleTheme: () => void;
  /** 设置主题 */
  setTheme: (theme: "light" | "dark") => void;
  /** 切换侧边栏 */
  toggleSidebar: () => void;
  /** 设置专注模式 */
  setFocusMode: (on: boolean) => void;
}

export const useAppStore = create<AppStore>((set) => ({
  theme: "light",
  sidebarCollapsed: false,
  focusMode: false,
  toggleTheme: () =>
    set((s) => ({ theme: s.theme === "light" ? "dark" : "light" })),
  setTheme: (theme) => set({ theme }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setFocusMode: (on) => set({ focusMode: on }),
}));
