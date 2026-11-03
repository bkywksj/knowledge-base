/**
 * 主题令牌定义
 * 2 套主题：亮色「淡紫」+ 暗色「暖炭」（v4 界面重设计，见 docs/design/ui-v4）
 * 数值与原型的设计令牌一一对应；旧的 5 套主题（柔光毛玻璃 / 暖木书房 / 翡翠白瓷 / 星空沉浸 / 摩卡棕夜）
 * 已在 v4 下线，老用户保存的旧主题 id 由 normalizeThemeMode 映射到同分类的新主题
 */

/** 主题模式 */
export type ThemeMode = "light-lilac" | "dark-ember";

/** 主题分类 */
export type ThemeCategory = "light" | "dark";

/** 判断主题分类 */
export function getThemeCategory(mode: ThemeMode): ThemeCategory {
  return mode.startsWith("light") ? "light" : "dark";
}

/** 把持久化里读出的任意主题 id 归一成现有主题
 *  旧版本存的是 light-glass / dark-starry 等已下线 id：按前缀落到同分类的新主题，
 *  不认识的值返回 null（调用方保持默认值） */
export function normalizeThemeMode(raw: unknown): ThemeMode | null {
  if (typeof raw !== "string") return null;
  if (raw.startsWith("light")) return "light-lilac";
  if (raw.startsWith("dark")) return "dark-ember";
  return null;
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
    key: "dark-ember",
    label: "暖炭",
    category: "dark",
    description: "暖棕炭灰底 + 淡紫点缀，长时间写作不刺眼",
    colors: ["#1D1C1A", "#A992FA", "#E3B160", "#EFEBE4"],
  },
];

/** 获取同类别的主题列表 */
export function getThemesByCategory(category: ThemeCategory): ThemeMeta[] {
  return themes.filter((t) => t.category === category);
}

/** Ant Design ConfigProvider token 映射
 *  底色、文字、描边也一并给到 antd，否则 portal 出去的浮层（Modal / Dropdown / Select 下拉等）
 *  会落回 antd 默认的白底灰字，跟主题对不上 */
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
        // 弹窗 / 抽屉遮罩：淡紫半透明（原型 .mask），配合 global.css 的 backdrop 模糊
        colorBgMask: "rgba(233,228,248,0.62)",
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
        colorBgMask: "rgba(16,14,12,0.55)",
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
  }
}

/** Ant Design 组件级覆盖（v4 设计规范，原型 kit.css 的通用组件）
 *  - 按钮一律无投影；普通按钮白底细描边，悬停浅紫底
 *  - 分段切换选中项：白底（暗色为抬升色）+ 主色字
 *  - 下拉 / 菜单圆角 11、菜单项圆角 6；弹窗圆角 16；卡片圆角 14
 *  - 悬停提示用深紫灰（亮色不出现纯黑）
 *  渐变类效果（主按钮、开关、勾选框、当前页码）antd token 表达不了，在 themes.css 里补 */
export function getAntdComponents(mode: ThemeMode) {
  const light = mode === "light-lilac";
  const raised = light ? "#FFFFFF" : "#2D2B28";
  const hoverBg = light ? "rgba(124,99,220,0.06)" : "rgba(255,245,230,0.06)";
  const accent = light ? "#7C63DC" : "#A992FA";
  return {
    Button: {
      primaryShadow: "none",
      defaultShadow: "none",
      dangerShadow: "none",
      defaultBg: raised,
      defaultBorderColor: light ? "rgba(110,85,200,0.24)" : "rgba(255,245,230,0.14)",
      defaultHoverBg: hoverBg,
      defaultHoverBorderColor: light ? "rgba(124,99,220,0.4)" : "rgba(169,146,250,0.45)",
      defaultHoverColor: accent,
      textHoverBg: hoverBg,
      fontWeight: 500,
    },
    Segmented: {
      trackBg: light ? "rgba(124,99,220,0.07)" : "rgba(255,245,230,0.06)",
      itemSelectedBg: raised,
      itemSelectedColor: accent,
      itemHoverBg: hoverBg,
      trackPadding: 3,
    },
    Checkbox: { borderRadiusSM: 4 },
    Dropdown: { borderRadiusLG: 11, borderRadiusSM: 6, paddingBlock: 6 },
    Menu: {
      itemBorderRadius: 6,
      itemSelectedBg: light ? "rgba(124,99,220,0.1)" : "rgba(169,146,250,0.16)",
      itemSelectedColor: accent,
      itemHoverBg: hoverBg,
    },
    Select: {
      borderRadiusLG: 11,
      optionSelectedBg: light ? "rgba(124,99,220,0.1)" : "rgba(169,146,250,0.16)",
      optionSelectedColor: accent,
    },
    Modal: { borderRadiusLG: 16 },
    Card: { borderRadiusLG: 14 },
    Tooltip: { colorBgSpotlight: light ? "#27233B" : "#3A3733" },
    Pagination: { itemActiveBg: "transparent" },
    Tabs: { inkBarColor: accent, itemSelectedColor: accent, itemHoverColor: accent },
    Tag: { defaultBg: light ? "rgba(124,99,220,0.07)" : "rgba(255,245,230,0.06)" },
  };
}
