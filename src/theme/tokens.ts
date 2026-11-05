/**
 * 主题令牌定义
 * v4 界面重设计（见 docs/design/ui-v4）：亮色「淡紫」（默认）+ 暗色「暖炭」，
 * 另有同一套规矩配出来的亮色 4 套、暗色 3 套（2026-11-05 用户要求增加主题）。
 * 规矩：只有一个主色；亮色底色带主色调、内容区白纸、文字不用纯黑；按钮无投影。
 * 旧的 5 套主题（柔光毛玻璃 / 暖木书房 / 翡翠白瓷 / 星空沉浸 / 摩卡棕夜）已在 v4 下线，
 * 老用户保存的旧主题 id 由 normalizeThemeMode 映射到同分类的默认主题
 *
 * 每套主题的颜色写两处，改色时两边一起改：
 * - 本文件 PALETTES：给 antd（含 portal 出去的弹层）
 * - styles/themes.css 对应的 [data-theme] 变量块：给应用自己的样式
 */

/** 主题模式 */
export type ThemeMode =
  | "light-lilac"
  | "light-celadon"
  | "light-mist"
  | "light-peach"
  | "light-paper"
  | "dark-ember"
  | "dark-ocean"
  | "dark-forest"
  | "dark-black";

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

/** 所有主题列表（每类第一套是默认主题） */
export const themes: ThemeMeta[] = [
  {
    key: "light-lilac",
    label: "淡紫",
    category: "light",
    description: "淡紫渐变底 + 白纸内容区，柔和清晰",
    colors: ["#E9E4F8", "#7C63DC", "#B482E8", "#27233B"],
  },
  {
    key: "light-celadon",
    label: "青瓷",
    category: "light",
    description: "浅青灰底 + 青绿点缀，清爽安静",
    colors: ["#E2EFEC", "#258A7E", "#4FA9BD", "#1F3431"],
  },
  {
    key: "light-mist",
    label: "晨雾蓝",
    category: "light",
    description: "浅蓝灰底 + 雾蓝点缀，干净利落",
    colors: ["#E3EAF6", "#3D74D6", "#7A8FE6", "#1F2A3D"],
  },
  {
    key: "light-peach",
    label: "杏桃",
    category: "light",
    description: "米杏底 + 珊瑚橙点缀，温暖柔和",
    colors: ["#F6E9E1", "#C65F45", "#E0A23C", "#3A2925"],
  },
  {
    key: "light-paper",
    label: "素白",
    category: "light",
    description: "中性灰白底 + 石墨色点缀，几乎不带彩色",
    colors: ["#EDEDEB", "#4A5468", "#8A8F99", "#222326"],
  },
  {
    key: "dark-ember",
    label: "暖炭",
    category: "dark",
    description: "暖棕炭灰底 + 淡紫点缀，长时间写作不刺眼",
    colors: ["#1D1C1A", "#A992FA", "#E3B160", "#EFEBE4"],
  },
  {
    key: "dark-ocean",
    label: "深海",
    category: "dark",
    description: "藏青炭底 + 天蓝点缀，冷静沉稳",
    colors: ["#171D26", "#5AA9F0", "#6FD3C6", "#E6ECF3"],
  },
  {
    key: "dark-forest",
    label: "墨绿",
    category: "dark",
    description: "深松绿炭底 + 薄荷绿点缀，护眼",
    colors: ["#171D19", "#6FCF97", "#E3B160", "#E6EEE8"],
  },
  {
    key: "dark-black",
    label: "纯黑",
    category: "dark",
    description: "近黑底 + 淡紫点缀，对比最强，OLED 屏更省电",
    colors: ["#0F0F11", "#A992FA", "#E3B160", "#ECECEE"],
  },
];

const THEME_KEYS = new Set<string>(themes.map((t) => t.key));

/** 把持久化里读出的任意主题 id 归一成现有主题
 *  现有 id 原样返回；旧版本存的 light-glass / dark-starry 等已下线 id 按前缀落到同分类的默认主题；
 *  不认识的值返回 null（调用方保持默认值） */
export function normalizeThemeMode(raw: unknown): ThemeMode | null {
  if (typeof raw !== "string") return null;
  if (THEME_KEYS.has(raw)) return raw as ThemeMode;
  if (raw.startsWith("light")) return "light-lilac";
  if (raw.startsWith("dark")) return "dark-ember";
  return null;
}

/** 获取同类别的主题列表 */
export function getThemesByCategory(category: ThemeCategory): ThemeMeta[] {
  return themes.filter((t) => t.category === category);
}

/** 一套主题给 antd 用的颜色
 *  primaryRgb / hairRgb 写成「r,g,b」：派生半透明色用。
 *  亮色的填充 / 选中用主色调半透明，描边用 hairRgb；暗色的填充 / 描边都用 hairRgb（偏暖或偏冷的白），
 *  只有选中用主色——与淡紫 / 暖炭原来的取值规则一致 */
interface Palette {
  primary: string;
  link: string;
  success: string;
  warning: string;
  error: string;
  bgLayout: string;
  bgContainer: string;
  bgElevated: string;
  bgMask: string;
  text: string;
  text2: string;
  text3: string;
  text4: string;
  primaryRgb: string;
  hairRgb: string;
  /** 普通按钮 / 分段选中项底色 */
  raised: string;
  /** 悬停提示底色 */
  tooltip: string;
}

const PALETTES: Record<ThemeMode, Palette> = {
  "light-lilac": {
    primary: "#7C63DC",
    link: "#7158D4",
    success: "#3E9A72",
    warning: "#C38D33",
    error: "#D65A6E",
    bgLayout: "#E9E4F8",
    bgContainer: "#FFFFFF",
    bgElevated: "#FFFFFF",
    // 弹窗 / 抽屉遮罩：淡紫半透明（原型 .mask），配合 global.css 的 backdrop 模糊
    bgMask: "rgba(233,228,248,0.62)",
    text: "#27233B",
    text2: "#6E6888",
    text3: "#9C96B4",
    text4: "#BFBAD4",
    primaryRgb: "124,99,220",
    hairRgb: "110,85,200",
    raised: "#FFFFFF",
    tooltip: "#27233B",
  },
  "light-celadon": {
    primary: "#258A7E",
    link: "#1D776C",
    success: "#3E9A5C",
    warning: "#C38D33",
    error: "#D65A6E",
    bgLayout: "#E2EFEC",
    bgContainer: "#FFFFFF",
    bgElevated: "#FFFFFF",
    bgMask: "rgba(226,239,236,0.62)",
    text: "#1F3431",
    text2: "#637875",
    text3: "#93A5A2",
    text4: "#B9C7C4",
    primaryRgb: "37,138,126",
    hairRgb: "40,110,100",
    raised: "#FFFFFF",
    tooltip: "#1F3431",
  },
  "light-mist": {
    primary: "#3D74D6",
    link: "#2F64C4",
    success: "#3E9A72",
    warning: "#C38D33",
    error: "#D65A6E",
    bgLayout: "#E3EAF6",
    bgContainer: "#FFFFFF",
    bgElevated: "#FFFFFF",
    bgMask: "rgba(227,234,246,0.62)",
    text: "#1F2A3D",
    text2: "#637089",
    text3: "#96A1B5",
    text4: "#BCC5D4",
    primaryRgb: "61,116,214",
    hairRgb: "60,95,170",
    raised: "#FFFFFF",
    tooltip: "#1F2A3D",
  },
  "light-peach": {
    // 珊瑚橙在白底上偏浅，主色压深到 #C65F45，链接 / 主色字才看得清
    primary: "#C65F45",
    link: "#AE4F37",
    success: "#3E9A72",
    warning: "#C08A2E",
    error: "#CF4D63",
    bgLayout: "#F6E9E1",
    bgContainer: "#FFFFFF",
    bgElevated: "#FFFFFF",
    bgMask: "rgba(246,233,225,0.62)",
    text: "#3A2925",
    text2: "#85695F",
    text3: "#B09A91",
    text4: "#D2C2BB",
    primaryRgb: "198,95,69",
    hairRgb: "170,100,75",
    raised: "#FFFFFF",
    tooltip: "#3A2925",
  },
  "light-paper": {
    primary: "#4A5468",
    link: "#3B4557",
    success: "#3E9A72",
    warning: "#C38D33",
    error: "#D65A6E",
    bgLayout: "#EDEDEB",
    bgContainer: "#FFFFFF",
    bgElevated: "#FFFFFF",
    bgMask: "rgba(237,237,235,0.62)",
    text: "#222326",
    text2: "#6B6E76",
    text3: "#9DA0A7",
    text4: "#C3C5CA",
    primaryRgb: "74,84,104",
    hairRgb: "60,64,72",
    raised: "#FFFFFF",
    tooltip: "#2A2C31",
  },
  "dark-ember": {
    primary: "#A992FA",
    link: "#B9A7FC",
    success: "#62C79B",
    warning: "#E3B160",
    error: "#F0808F",
    bgLayout: "#161514",
    bgContainer: "#1D1C1A",
    bgElevated: "#2D2B28",
    bgMask: "rgba(16,14,12,0.55)",
    text: "#EFEBE4",
    text2: "#C4BEB4",
    text3: "#958F85",
    text4: "#68635C",
    primaryRgb: "169,146,250",
    hairRgb: "255,245,230",
    raised: "#2D2B28",
    tooltip: "#3A3733",
  },
  "dark-ocean": {
    primary: "#5AA9F0",
    link: "#7DBCF4",
    success: "#5FC79A",
    warning: "#E3B160",
    error: "#F0808F",
    bgLayout: "#12171E",
    bgContainer: "#171D26",
    bgElevated: "#283140",
    bgMask: "rgba(8,12,18,0.55)",
    text: "#E6ECF3",
    text2: "#B4C0CE",
    text3: "#8492A3",
    text4: "#5E6A79",
    primaryRgb: "90,169,240",
    hairRgb: "200,225,255",
    raised: "#283140",
    tooltip: "#2C3644",
  },
  "dark-forest": {
    primary: "#6FCF97",
    link: "#8EDBAD",
    success: "#62C79B",
    warning: "#E3B160",
    error: "#F0808F",
    bgLayout: "#121714",
    bgContainer: "#171D19",
    bgElevated: "#28322B",
    bgMask: "rgba(8,12,10,0.55)",
    text: "#E6EEE8",
    text2: "#B6C4BA",
    text3: "#86968A",
    text4: "#5F6D63",
    primaryRgb: "111,207,151",
    hairRgb: "210,245,220",
    raised: "#28322B",
    tooltip: "#2C3730",
  },
  "dark-black": {
    primary: "#A992FA",
    link: "#B9A7FC",
    success: "#62C79B",
    warning: "#E3B160",
    error: "#F0808F",
    bgLayout: "#0A0A0B",
    bgContainer: "#0F0F11",
    bgElevated: "#222226",
    bgMask: "rgba(0,0,0,0.6)",
    text: "#ECECEE",
    text2: "#B8B8BE",
    text3: "#8A8A92",
    text4: "#5E5E66",
    primaryRgb: "169,146,250",
    hairRgb: "255,255,255",
    raised: "#222226",
    tooltip: "#2A2A2F",
  },
};

const rgba = (rgb: string, a: number) => `rgba(${rgb},${a})`;

/** Ant Design ConfigProvider token 映射
 *  底色、文字、描边也一并给到 antd，否则 portal 出去的浮层（Modal / Dropdown / Select 下拉等）
 *  会落回 antd 默认的白底灰字，跟主题对不上 */
export function getAntdTokens(mode: ThemeMode) {
  const p = PALETTES[mode];
  const light = getThemeCategory(mode) === "light";
  return {
    colorPrimary: p.primary,
    colorInfo: p.primary,
    colorLink: p.link,
    colorSuccess: p.success,
    colorWarning: p.warning,
    colorError: p.error,
    borderRadius: 8,
    colorBgLayout: p.bgLayout,
    colorBgContainer: p.bgContainer,
    colorBgElevated: p.bgElevated,
    colorBgMask: p.bgMask,
    colorText: p.text,
    colorTextSecondary: p.text2,
    colorTextTertiary: p.text3,
    colorTextQuaternary: p.text4,
    colorBorder: rgba(p.hairRgb, light ? 0.24 : 0.14),
    colorBorderSecondary: rgba(p.hairRgb, light ? 0.14 : 0.08),
    colorSplit: rgba(p.hairRgb, light ? 0.12 : 0.07),
    colorFillTertiary: rgba(light ? p.primaryRgb : p.hairRgb, 0.06),
    colorFillQuaternary: rgba(light ? p.primaryRgb : p.hairRgb, 0.035),
    controlItemBgHover: rgba(light ? p.primaryRgb : p.hairRgb, light ? 0.055 : 0.05),
    controlItemBgActive: rgba(p.primaryRgb, light ? 0.1 : 0.16),
    boxShadowSecondary: light
      ? `0 0 0 .5px rgba(${p.hairRgb},.14),0 4px 12px rgba(${p.hairRgb},.08),0 20px 44px -12px rgba(${p.hairRgb},.26)`
      : `0 0 0 .5px rgba(${p.hairRgb},.12),0 6px 16px rgba(0,0,0,.4),0 24px 48px -12px rgba(0,0,0,.6)`,
  };
}

/** Ant Design 组件级覆盖（v4 设计规范，原型 kit.css 的通用组件）
 *  - 按钮一律无投影；普通按钮白底细描边，悬停浅主色底
 *  - 分段切换选中项：白底（暗色为抬升色）+ 主色字
 *  - 下拉 / 菜单圆角 11、菜单项圆角 6；弹窗圆角 16；卡片圆角 14
 *  - 悬停提示用深色主题墨（亮色不出现纯黑）
 *  渐变类效果（主按钮、开关、勾选框、当前页码）antd token 表达不了，在 themes.css 里补 */
export function getAntdComponents(mode: ThemeMode) {
  const p = PALETTES[mode];
  const light = getThemeCategory(mode) === "light";
  const raised = p.raised;
  const hoverBg = rgba(light ? p.primaryRgb : p.hairRgb, 0.06);
  const accent = p.primary;
  const selectedBg = rgba(p.primaryRgb, light ? 0.1 : 0.16);
  const softFill = rgba(light ? p.primaryRgb : p.hairRgb, light ? 0.07 : 0.06);
  return {
    Button: {
      primaryShadow: "none",
      defaultShadow: "none",
      dangerShadow: "none",
      defaultBg: raised,
      defaultBorderColor: rgba(p.hairRgb, light ? 0.24 : 0.14),
      defaultHoverBg: hoverBg,
      defaultHoverBorderColor: rgba(p.primaryRgb, light ? 0.4 : 0.45),
      defaultHoverColor: accent,
      textHoverBg: hoverBg,
      fontWeight: 500,
    },
    Segmented: {
      trackBg: softFill,
      itemSelectedBg: raised,
      itemSelectedColor: accent,
      itemHoverBg: hoverBg,
      trackPadding: 3,
    },
    Checkbox: { borderRadiusSM: 4 },
    Dropdown: { borderRadiusLG: 11, borderRadiusSM: 6, paddingBlock: 6 },
    Menu: {
      itemBorderRadius: 6,
      itemSelectedBg: selectedBg,
      itemSelectedColor: accent,
      itemHoverBg: hoverBg,
    },
    Select: {
      borderRadiusLG: 11,
      optionSelectedBg: selectedBg,
      optionSelectedColor: accent,
    },
    Modal: { borderRadiusLG: 16 },
    Card: { borderRadiusLG: 14 },
    Tooltip: { colorBgSpotlight: p.tooltip },
    Pagination: { itemActiveBg: "transparent" },
    Tabs: { inkBarColor: accent, itemSelectedColor: accent, itemHoverColor: accent },
    Tag: { defaultBg: softFill },
  };
}
