/**
 * 移动端底部 Tab 候选池。
 *
 * 用户可在「功能模块 → 底部 Tab」选 4 个填到前 4 格；
 * 第 5 格永远是「我的」（通向 /settings 移动版），不可关闭。
 *
 * 与 MobileLayout 约定的契约：v4 起所有 Tab 统一用主题主色高亮（跟随 9 套主题），
 * activeColor 字段保留但不再读取。
 * matchPrefixes 决定"哪些路由在该 tab 上时高亮"——比如 /notes/123 也算在 notes tab 上。
 */

export type MobileTabKey =
  | "home"
  | "notes"
  | "ai"
  | "tasks"
  | "daily"
  | "tags"
  | "cards"
  | "prompts"
  | "hidden"
  | "graph"
  | "search"
  | "trash";

export interface MobileTabMeta {
  key: MobileTabKey;
  /** Lucide 图标名（小写），渲染时由 MobileLayout 取出对应组件 */
  icon: MobileTabKey;
  label: string;
  path: string;
  matchPrefixes: string[];
  activeColor?: "primary" | "accent";
}

export const MOBILE_TAB_REGISTRY: Record<MobileTabKey, MobileTabMeta> = {
  home: {
    key: "home",
    icon: "home",
    label: "首页", // 与 PC 活动栏、原型一致（原「主页」）
    path: "/",
    matchPrefixes: ["/"],
  },
  notes: {
    key: "notes",
    icon: "notes",
    label: "笔记",
    path: "/notes",
    matchPrefixes: ["/notes"],
  },
  ai: {
    key: "ai",
    icon: "ai",
    label: "AI",
    path: "/ai",
    matchPrefixes: ["/ai", "/prompts"],
    activeColor: "accent",
  },
  tasks: {
    key: "tasks",
    icon: "tasks",
    label: "待办",
    path: "/tasks",
    matchPrefixes: ["/tasks"],
  },
  daily: {
    key: "daily",
    icon: "daily",
    label: "日记",
    path: "/daily",
    matchPrefixes: ["/daily"],
  },
  tags: {
    key: "tags",
    icon: "tags",
    label: "标签",
    path: "/tags",
    matchPrefixes: ["/tags"],
  },
  cards: {
    key: "cards",
    icon: "cards",
    label: "闪卡",
    path: "/cards",
    matchPrefixes: ["/cards"],
  },
  prompts: {
    key: "prompts",
    icon: "prompts",
    label: "提示词", // 与 PC 活动栏一致（原「Prompt」）
    path: "/prompts",
    matchPrefixes: ["/prompts"],
  },
  hidden: {
    key: "hidden",
    icon: "hidden",
    label: "隐藏",
    path: "/hidden",
    matchPrefixes: ["/hidden"],
  },
  graph: {
    key: "graph",
    icon: "graph",
    label: "图谱",
    path: "/graph",
    matchPrefixes: ["/graph"],
  },
  search: {
    key: "search",
    icon: "search",
    label: "搜索",
    path: "/search",
    matchPrefixes: ["/search"],
  },
  trash: {
    key: "trash",
    icon: "trash",
    label: "回收站",
    path: "/trash",
    matchPrefixes: ["/trash"],
  },
};

export const MOBILE_TAB_KEYS: readonly MobileTabKey[] = Object.keys(
  MOBILE_TAB_REGISTRY,
) as MobileTabKey[];

/** 默认前 4 格（最后一格固定「我的」由 MobileLayout 单独画）。顺序同原型：首页 · 笔记 · 待办 · AI
 *  只影响新装 / 没改过 Tab 的用户：已存的 mobileTabKeys 原样保留 */
export const DEFAULT_MOBILE_TAB_KEYS: readonly MobileTabKey[] = [
  "home",
  "notes",
  "tasks",
  "ai",
];

export const MOBILE_TAB_SLOT_COUNT = 4;
