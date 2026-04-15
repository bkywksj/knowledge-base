/**
 * 主题令牌定义
 * 4 套主题：2 亮色 + 2 暗色
 */

/** 主题模式 */
export type ThemeMode = "light-glass" | "light-warm" | "dark-starry" | "dark-mocha";

/** 主题分类 */
export type ThemeCategory = "light" | "dark";

/** 判断主题分类 */
export function getThemeCategory(mode: ThemeMode): ThemeCategory {
  return mode.startsWith("light") ? "light" : "dark";
}

/** 主题元信息 */
export interface ThemeMeta {
  key: ThemeMode;
  label: string;
  category: ThemeCategory;
  description: string;
  colors: [string, string, string, string]; // 预览色块
}

/** 所有主题列表 */
export const themes: ThemeMeta[] = [
  {
    key: "light-glass",
    label: "柔光毛玻璃",
    category: "light",
    description: "紫蓝渐变底 + 毛玻璃卡片",
    colors: ["#ede9fe", "#6366f1", "#ec4899", "#1e1b4b"],
  },
  {
    key: "light-warm",
    label: "暖木书房",
    category: "light",
    description: "奶油底色 + 棕橙暖色调",
    colors: ["#faf8f5", "#c2713a", "#6b8e5e", "#e6a849"],
  },
  {
    key: "dark-starry",
    label: "星空沉浸",
    category: "dark",
    description: "深空黑 + 紫青渐变 + 粒子",
    colors: ["#0a0a12", "#a78bfa", "#67e8f9", "#f472b6"],
  },
  {
    key: "dark-mocha",
    label: "摩卡棕夜",
    category: "dark",
    description: "深紫棕 + 琥珀金 + 彩色标签",
    colors: ["#1e1e2e", "#f5bd69", "#cba6f7", "#94e2d5"],
  },
];

/** 获取同类别的主题列表 */
export function getThemesByCategory(category: ThemeCategory): ThemeMeta[] {
  return themes.filter((t) => t.category === category);
}

/** Ant Design ConfigProvider token 映射 */
export function getAntdTokens(mode: ThemeMode) {
  switch (mode) {
    case "light-glass":
      return { colorPrimary: "#6366f1", borderRadius: 12 };
    case "light-warm":
      return { colorPrimary: "#c2713a", borderRadius: 8 };
    case "dark-starry":
      return { colorPrimary: "#a78bfa", borderRadius: 14 };
    case "dark-mocha":
      return { colorPrimary: "#f5bd69", borderRadius: 10 };
  }
}
