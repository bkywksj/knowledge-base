/**
 * 主题令牌定义
 * 7 套主题：4 亮色 + 3 暗色
 * 淡紫 / 暖炭是 v4 界面重设计（docs/design/ui-v4）的主题，数值与原型的设计令牌一一对应
 */

/** 主题模式 */
export type ThemeMode =
  | "light-lilac"
  | "light-glass"
  | "light-warm"
  | "light-jade"
  | "dark-ember"
  | "dark-starry"
  | "dark-mocha";

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
    key: "light-lilac",
    label: "淡紫",
    category: "light",
    description: "淡紫渐变底 + 白纸内容区，柔和清晰",
    colors: ["#E9E4F8", "#7C63DC", "#B482E8", "#27233B"],
  },
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
    key: "light-jade",
    label: "翡翠白瓷",
    category: "light",
    description: "三栏浅灰 + 翡翠绿点缀",
    colors: ["#e2e3ea", "#e3e3e5", "#fafafa", "#07c160"],
  },
  {
    key: "dark-ember",
    label: "暖炭",
    category: "dark",
    description: "暖棕炭灰底 + 淡紫点缀，长时间写作不刺眼",
    colors: ["#1D1C1A", "#A992FA", "#E3B160", "#EFEBE4"],
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

/** Ant Design ConfigProvider token 映射
 *  老主题只派生主色 + 圆角；淡紫 / 暖炭把底色、文字、描边也一并给到 antd，
 *  否则 antd 组件（Modal / Dropdown / Select 下拉等 portal 出去的浮层）会落回默认白底灰字，跟主题对不上 */
export function getAntdTokens(mode: ThemeMode) {
  switch (mode) {
    case "light-lilac":
      return {
        colorPrimary: "#7C63DC",
        colorInfo: "#7C63DC",
        colorLink: "#7158D4",
        colorSuccess: "#3E9A72",
        colorWarning: "#C38D33",
        colorError: "#D65A6E",
        borderRadius: 8,
        colorBgLayout: "#E9E4F8",
        colorBgContainer: "#FFFFFF",
        colorBgElevated: "#FFFFFF",
        colorText: "#27233B",
        colorTextSecondary: "#6E6888",
        colorTextTertiary: "#9C96B4",
        colorTextQuaternary: "#BFBAD4",
        colorBorder: "rgba(110,85,200,0.24)",
        colorBorderSecondary: "rgba(110,85,200,0.14)",
        colorSplit: "rgba(110,85,200,0.12)",
        colorFillTertiary: "rgba(124,99,220,0.06)",
        colorFillQuaternary: "rgba(124,99,220,0.035)",
        controlItemBgHover: "rgba(124,99,220,0.055)",
        controlItemBgActive: "rgba(124,99,220,0.1)",
        boxShadowSecondary:
          "0 0 0 .5px rgba(110,85,200,.14),0 4px 12px rgba(110,85,200,.08),0 20px 44px -12px rgba(110,85,200,.26)",
      };
    case "dark-ember":
      return {
        colorPrimary: "#A992FA",
        colorInfo: "#A992FA",
        colorLink: "#B9A7FC",
        colorSuccess: "#62C79B",
        colorWarning: "#E3B160",
        colorError: "#F0808F",
        borderRadius: 8,
        colorBgLayout: "#161514",
        colorBgContainer: "#1D1C1A",
        colorBgElevated: "#2D2B28",
        colorText: "#EFEBE4",
        colorTextSecondary: "#C4BEB4",
        colorTextTertiary: "#958F85",
        colorTextQuaternary: "#68635C",
        colorBorder: "rgba(255,245,230,0.14)",
        colorBorderSecondary: "rgba(255,245,230,0.08)",
        colorSplit: "rgba(255,245,230,0.07)",
        colorFillTertiary: "rgba(255,245,230,0.06)",
        colorFillQuaternary: "rgba(255,245,230,0.035)",
        controlItemBgHover: "rgba(255,245,230,0.05)",
        controlItemBgActive: "rgba(169,146,250,0.16)",
        boxShadowSecondary:
          "0 0 0 .5px rgba(255,245,230,.12),0 6px 16px rgba(0,0,0,.4),0 24px 48px -12px rgba(0,0,0,.6)",
      };
    case "light-glass":
      return { colorPrimary: "#6366f1", borderRadius: 12 };
    case "light-warm":
      return { colorPrimary: "#c2713a", borderRadius: 8 };
    case "light-jade":
      return { colorPrimary: "#07c160", borderRadius: 6 };
    case "dark-starry":
      return { colorPrimary: "#a78bfa", borderRadius: 14 };
    case "dark-mocha":
      return { colorPrimary: "#f5bd69", borderRadius: 10 };
  }
}

/** Ant Design 组件级覆盖
 *  v4 设计规范：按钮一律无投影（淡紫 / 暖炭）；老主题保持 antd 默认，返回 undefined 不干预 */
export function getAntdComponents(mode: ThemeMode) {
  if (mode !== "light-lilac" && mode !== "dark-ember") return undefined;
  return {
    Button: { primaryShadow: "none", defaultShadow: "none", dangerShadow: "none" },
  };
}
