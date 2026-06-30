import { create } from "zustand";
import { Store } from "@tauri-apps/plugin-store";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { taskApi, systemApi, folderApi, configApi, appLockApi } from "@/lib/api";

/**
 * 读取配置项；不存在时返回 null（避开 configApi.get 的 NotFound Err 抛出）。
 * 仅用于"无值是合法状态"的偏好类配置（默认文件夹 / 默认标签）。
 */
async function getConfigOrNull(key: string): Promise<string | null> {
  try {
    return await configApi.get(key);
  } catch {
    return null;
  }
}
import type { Folder, SystemInfo } from "@/types";
import type { ThemeMode, ThemeCategory } from "@/theme/tokens";
import { EDITOR_HIGHLIGHT_SHORTCUT_DEFAULT } from "@/lib/shortcuts/registry";
import {
  DEFAULT_MOBILE_TAB_KEYS,
  MOBILE_TAB_KEYS as ALL_MOBILE_TAB_KEYS,
  MOBILE_TAB_SLOT_COUNT,
  type MobileTabKey,
} from "@/lib/mobileTabRegistry";

export type { MobileTabKey };

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
  | "cards"
  | "graph"
  | "ai"
  | "prompts"
  | "push"
  | "about"
  | "trash"
  | "hidden";

/** SidePanel 宽度范围（px），避免用户拖到极端值 */
export const SIDE_PANEL_MIN_WIDTH = 200;
export const SIDE_PANEL_MAX_WIDTH = 480;
export const SIDE_PANEL_DEFAULT_WIDTH = 240;

/** 最近搜索历史保留条数 */
const RECENT_SEARCHES_MAX = 10;

/**
 * 隐藏笔记 PIN 解锁会话有效期（毫秒）。
 * 在此窗口内重复进 /hidden 不必再次输 PIN。
 * 故意短一点（10 分钟）：用户离开座位后回来，新一次访问要重新验证。
 */
export const HIDDEN_UNLOCK_TTL_MS = 10 * 60 * 1000;

/**
 * 编辑器字体族预设。
 * 值是稳定 ID，写入 store 持久化；实际 CSS font-family 链通过 EDITOR_FONT_STACKS 查表，
 * 包含若干 fallback，用户系统未装首选字体时自动退回下一项，不会变成"乱码方块"。
 */
export type EditorFontFamily = "system" | "sans" | "serif" | "kaiti" | "mono";

export const EDITOR_FONT_LABELS: Record<EditorFontFamily, string> = {
  system: "系统默认",
  sans: "无衬线（黑体）",
  serif: "衬线（宋体）",
  kaiti: "楷体（霞鹜文楷优先）",
  mono: "等宽（编程字体）",
};

export const EDITOR_FONT_STACKS: Record<EditorFontFamily, string> = {
  // system 留空 → 不写 CSS 变量，编辑器继承全局默认
  system: "",
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", "Source Han Sans SC", "Noto Sans SC", "Helvetica Neue", Arial, sans-serif',
  serif: '"Source Han Serif SC", "Noto Serif SC", "Songti SC", STSong, SimSun, Georgia, serif',
  kaiti: '"LXGW WenKai", "LXGW WenKai Screen", KaiTi, STKaiti, "Source Han Serif SC", serif',
  mono: '"JetBrains Mono", "Fira Code", "Cascadia Code", "Source Code Pro", Consolas, "Courier New", monospace',
};

export const EDITOR_FONT_SIZE_OPTIONS = [12, 13, 14, 15, 16, 18, 20, 22] as const;
export const EDITOR_LINE_HEIGHT_OPTIONS = [1.4, 1.5, 1.6, 1.8, 2.0] as const;

/**
 * 代码块字号预设（px）。仿语雀「代码块统一字号、一处设置全文生效」。
 * 0 = 跟随正文（保持相对正文 0.9em 的老行为，向后兼容）；> 0 = 绝对 px。
 * UI 把 0 单列成「跟随正文」选项。
 */
export const EDITOR_CODE_FONT_SIZE_OPTIONS = [0, 12, 13, 14, 15, 16, 18, 20] as const;

/**
 * 笔记自动保存防抖延迟选项（毫秒）。
 * 用户停止输入达到该时长后，触发一次静默保存（silent=true，不弹 toast）。
 * 1000ms 偏激进，5000ms 偏保守；默认 1500ms 接近 OneNote / Notion 的体感。
 */
export const AUTO_SAVE_DELAY_OPTIONS = [1000, 1500, 3000, 5000] as const;
export const AUTO_SAVE_DELAY_DEFAULT = 1500;

export const EDITOR_FONT_DEFAULTS = {
  family: "system" as EditorFontFamily,
  size: 15,
  lineHeight: 1.8,
  codeSize: 0, // 0 = 代码块字号跟随正文（相对 0.9em），保持老行为
};

/**
 * 编辑器版面（页面排版）偏好——区别于"字体偏好"，专治"书写手感像 txt"。
 *
 * - readingWidth: 正文阅读列宽（px）。0 = 不限制（铺满，老行为）；> 0 = 居中成一列，
 *   宽屏不再让一行横扫一大片。这是改善"像 txt"观感的头号开关。
 * - paper: 纸张卡片——正文列加白卡 + 阴影 + 圆角，外层垫浅灰底，营造"在纸上写"的实体感。
 * - ruleLines: 背景纹理（none / 横线 / 网格），还原 OneNote 招牌的笔记本质感。
 * - firstLineIndent: 顶层段落首行缩进 2 字符（中文写作习惯）。
 */
export type EditorRuleLines = "none" | "lines" | "grid";

/** 阅读列宽预设（px）。0 作为"不限制"哨兵值由 UI 单列出来。 */
export const EDITOR_READING_WIDTH_OPTIONS = [0, 720, 820, 960, 1080] as const;
export const EDITOR_READING_WIDTH_LABELS: Record<number, string> = {
  0: "不限制（铺满）",
  720: "紧凑 720",
  820: "舒适 820",
  960: "宽松 960",
  1080: "超宽 1080",
};

export const EDITOR_RULE_LABELS: Record<EditorRuleLines, string> = {
  none: "无",
  lines: "横线",
  grid: "网格",
};

export const EDITOR_LAYOUT_DEFAULTS = {
  readingWidth: 820,
  paper: true,
  ruleLines: "none" as EditorRuleLines,
  firstLineIndent: false,
  headingNumber: false,
};

/**
 * 布局预设：一键在「默认 / 专注写作 / 大纲优先」之间切换整体布局。
 * 每个预设是一组**结构性布局**字段的快照（侧栏 / 活动栏 / 大纲可见性 + 位置），
 * 故意不碰排版 / 字体偏好（阅读列宽 / 纸张 / 字号），避免覆盖用户精调。
 * 字段为可选：未列出的字段保持当前值（如专注写作不动大纲位置，因为大纲已隐藏）。
 */
export type LayoutPresetId = "default" | "focus" | "outline";

export interface LayoutPreset {
  id: LayoutPresetId;
  label: string;
  description: string;
  values: {
    sidePanelVisible?: boolean;
    autoHideActivityBar?: boolean;
    outlineVisible?: boolean;
    outlinePosition?: "left" | "right";
  };
}

export const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    id: "default",
    label: "默认",
    description: "笔记侧栏 + 大纲（右侧）全部显示，活动栏常驻",
    values: {
      sidePanelVisible: true,
      autoHideActivityBar: false,
      outlineVisible: true,
      outlinePosition: "right",
    },
  },
  {
    id: "focus",
    label: "专注写作",
    description: "隐藏笔记侧栏与大纲，活动栏自动收起，只留正文",
    values: {
      sidePanelVisible: false,
      autoHideActivityBar: true,
      outlineVisible: false,
    },
  },
  {
    id: "outline",
    label: "大纲优先",
    description: "大纲移到左侧、隐藏笔记侧栏，大纲成为主导航",
    values: {
      sidePanelVisible: false,
      autoHideActivityBar: false,
      outlineVisible: true,
      outlinePosition: "left",
    },
  },
];

/**
 * 界面缩放因子档位（持久化）。
 * 1.0 = 系统默认；< 1 紧凑、> 1 放大。仅作用于 UI（antd 组件 + 自定义 CSS 的 token），
 * 不动浏览器 root font-size，避免 Tailwind text-sm 等意外漂移。
 *
 * 建议默认值：1.0；首次启动会按显示器逻辑分辨率推荐一档（用户未手动改时生效）。
 */
export const UI_SCALE_OPTIONS = [0.85, 0.9, 1.0, 1.1, 1.25, 1.5] as const;
export const UI_SCALE_MIN = 0.75;
export const UI_SCALE_MAX = 2.0;
export const UI_SCALE_DEFAULT = 1.0;

/**
 * 根据当前显示器逻辑宽度推荐合适的 uiScale 档位。
 *
 * 桌面 Tauri 应用的 WebView 已跟随系统 DPI 缩放，所以 4K 屏 + 系统 200% 缩放后
 * 拿到的 `screen.width` 落到约 1920；这里只看"逻辑像素宽度"决定 UI 密度。
 *
 * - < 1400  : 0.9   （1366×768 笔记本紧凑屏）
 * - 1400~2047: 1.0  （1080p / 1440p 主流）
 * - 2048~2559: 1.1  （高 DPI 笔记本 / 2K 显示器系统缩放低）
 * - ≥ 2560  : 1.25  （大显示器原生 2K/4K 不缩放）
 */
export function suggestUiScale(): number {
  const w = typeof window !== "undefined" ? window.screen?.width ?? 1920 : 1920;
  if (w >= 2560) return 1.25;
  if (w >= 2048) return 1.1;
  if (w < 1400) return 0.9;
  return 1.0;
}

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
  /** 任务列表刷新触发器：提醒弹窗内动作 / 后台 reminder 触发 advance 后递增，
   * 任务列表页订阅它自动重拉，避免列表显示陈旧状态 */
  tasksListRefreshTick: number;
  /** 未完成 + 紧急的任务数（用于侧边栏红色 Badge） */
  urgentTodoCount: number;
  /** 窗口置顶状态（UI 真相源；托盘 CheckMenuItem 通过事件同步） */
  alwaysOnTop: boolean;
  /** 当前活动视图（Activity Bar 模式）；与 URL 双向同步 */
  activeView: ActiveView;
  /**
   * 用户启用的可选侧栏视图集合（持久化到 app_config 的 enabled_views）。
   *
   * 核心视图（home/notes/search/trash/about）始终显示，不在此集合内。
   * 此集合只跟踪可选项：daily / tasks / cards / tags / graph / ai / prompts / hidden。
   *
   * 默认值：除 cards 外全部启用（见 DEFAULT_ENABLED_VIEWS）。
   */
  enabledViews: Set<ActiveView>;
  /**
   * 移动端主页 Dashboard 显示项集合（仅移动端使用，持久化到 app_config 的 mobile_dashboard_items）。
   * 默认全部显示。用户在 /feature-toggle 「主页 Dashboard 显示」分组里可关闭某些卡片。
   */
  mobileDashboardItems: Set<MobileDashboardItem>;
  /**
   * 移动端底部前 4 格 Tab 顺序（最后一格"我的"固定，不在此数组）。
   * 持久化到 app_config.mobile_tab_keys。
   */
  mobileTabKeys: MobileTabKey[];
  /** SidePanel（Activity Bar 右侧主面板）宽度 */
  sidePanelWidth: number;
  /**
   * SidePanel 是否展开。
   * 折叠时只保留 48px ActivityBar，主区撑满。
   * VS Code 行为：点击当前高亮图标 = 折叠/展开 SidePanel。
   */
  sidePanelVisible: boolean;
  /**
   * ActivityBar 自动隐藏开关（持久化）。
   * 开启时 ActivityBar 不再占据布局宽度，鼠标移到屏幕左边缘 6px 热区时
   * 才以浮层形式弹出；离开后 150ms 自动收起。默认关闭=始终显示。
   */
  autoHideActivityBar: boolean;
  /** 搜索视图：最近搜索关键词（最新在前，最多 RECENT_SEARCHES_MAX 条，持久化） */
  recentSearches: string[];
  /** 编辑器字体族（持久化） */
  editorFontFamily: EditorFontFamily;
  /** 编辑器字号 px（持久化） */
  editorFontSize: number;
  /** 编辑器行距倍数（持久化） */
  editorLineHeight: number;
  /** 编辑器代码块字号 px（持久化）。0 = 跟随正文（相对 0.9em），> 0 = 绝对 px */
  editorCodeFontSize: number;
  /** 编辑器正文阅读列宽 px（持久化）。0 = 不限制（铺满） */
  editorReadingWidth: number;
  /** 编辑器纸张卡片观感开关（持久化） */
  editorPaper: boolean;
  /** 编辑器背景纹理：none / lines / grid（持久化） */
  editorRuleLines: EditorRuleLines;
  /** 编辑器顶层段落首行缩进 2 字符（持久化） */
  editorFirstLineIndent: boolean;
  /** 编辑器标题自动编号（1/1.1/1.1.1）+ 层级彩虹配色（持久化，纯显示层不写进 .md） */
  editorHeadingNumber: boolean;
  /**
   * 编辑器「高亮」快捷键（accelerator 字符串，如 "CommandOrControl+Shift+H"，持久化）。
   *
   * 编辑器内动作，但允许用户自定义键位。TiptapEditor 用 handleKeyDown 实时读此值匹配触发，
   * 并禁用了 Highlight 扩展内置的 Mod-Shift-h（避免双触发互相抵消）。空串 = 已禁用（不绑任何键）。
   */
  editorHighlightShortcut: string;
  /**
   * 全局界面缩放因子（持久化）。
   * 取值见 UI_SCALE_OPTIONS；默认 1.0（首启会被 suggestUiScale 推荐值覆盖一次）。
   * 通过 :root --ui-scale 变量 + AntD ConfigProvider token 联动到全 UI。
   */
  uiScale: number;
  /** 用户是否已经手动改过 uiScale（持久化）。
   *  false 时首启允许 suggestUiScale 自动推荐覆盖；true 则始终尊重用户选择。 */
  uiScaleUserSet: boolean;
  /**
   * 笔记自动保存开关（持久化）。
   * 开启后：编辑器内容变更后，停止输入 autoSaveDelay 毫秒触发静默保存，
   * 用户无需手动点保存按钮（OneNote / Notion 体感）。
   * 默认关闭，保留传统"必须手动保存"行为。
   */
  autoSaveEnabled: boolean;
  /** 自动保存防抖延迟（毫秒，持久化） */
  autoSaveDelay: number;
  /** 打开笔记时的默认查看模式（持久化）。'edit' = 编辑模式（默认），'read' = 阅读模式（隐藏工具栏，不可编辑） */
  defaultViewMode: "edit" | "read";
  /** 待办模块默认视图（列表/看板/四象限/日历/甘特）：打开待办页时的初始视图，持久化 */
  tasksDefaultView: "list" | "kanban" | "quadrant" | "calendar" | "gantt";
  /** 笔记编辑页：右侧大纲面板是否显示（持久化）。标题数 < 2 时由组件自动隐藏，与此独立 */
  outlineVisible: boolean;
  /** 笔记编辑页：大纲面板停靠位置（持久化）。'right'（默认）/ 'left' */
  outlinePosition: "left" | "right";
  /**
   * NotesPanel 文件夹树：被显式折叠的文件夹 id 集合（持久化）。
   * 存"折叠"而不是"展开"——新建文件夹默认展开，符合直觉；空集合 = 全部展开。
   * 用 string[] 存，运行时按需转 Set。
   */
  notesCollapsedFolderKeys: string[];
  /** NotesPanel 末尾"未分类"虚拟节点是否展开（持久化） */
  notesUncategorizedExpanded: boolean;
  /**
   * NotesPanel 视图开关：true = 只显示文件夹节点，隐藏笔记叶子 + 隐藏"未分类"虚拟根（持久化）。
   * 跳转到具体笔记（/notes/:id）时会被自动关闭，避免目标笔记被隐藏。
   */
  notesShowOnlyFolders: boolean;
  /**
   * "全局新建笔记"时套用的默认文件夹 id；null = 没设默认（新建到根目录）。
   * 由后端 app_config 持久化，应用启动时拉一次到 store。
   * 仅对"无上下文"的入口生效（顶部+号 / Ctrl+N / 命令面板 / 托盘等）；
   * 文件夹右键新建、?folder=X 列表内新建保留各自上下文，不被覆盖。
   */
  defaultFolderId: number | null;
  /** "全局新建笔记"时自动附加的默认标签 ids；空数组 = 不附加 */
  defaultTagIds: number[];
  /**
   * 每篇笔记被折叠的 heading anchors（按 noteId 分桶）。
   *
   * 业界主流（Obsidian）做法：折叠态是"视图偏好"，本机持久化但不写进笔记内容、
   * 不参与跨设备同步。anchor = slug + occurrence index（详见 components/editor/headingAnchor）。
   *
   * 整张表懒加载到 Map：noteId → Set<anchor>；持久化序列化为 Record<string, string[]>。
   */
  notesHeadingFolded: Record<number, string[]>;
  /**
   * NotesPanel 首次进入是否已执行"全部折叠初始化"（持久化）。
   * false = 用户从未打开过侧栏（或老版本升级），首次拿到 folders 时把全部 id 灌进 collapsed。
   * true = 已初始化，后续完全由用户操作驱动展开/折叠。
   */
  notesFoldersInitialCollapseDone: boolean;
  /**
   * NotesPanel「每次启动默认收起所有文件夹」开关（持久化，默认 true）。
   * 开启时：每次应用启动后首次拿到文件夹，就把全部文件夹折叠一次；
   *        之后由用户操作驱动展开/折叠（本次会话内记忆，重启再次收起）。
   * 关闭时：回到"跨重启记住上次展开/折叠状态"的行为。
   */
  notesCollapseFoldersOnStartup: boolean;
  /**
   * 会话级标志（不持久化、不参与 loadFromStore）：本次应用启动是否已执行过"启动收起"。
   * 应用重启（页面重载）后随 store 重建自动归 false，从而每次启动都收起一次。
   * 仅在 notesCollapseFoldersOnStartup 开启时有意义。
   */
  notesStartupCollapseApplied: boolean;
  /**
   * 主题自定义总开关（持久化）。
   * 关闭时所有 customAccent / customBgImage / customBgDim 都不生效，等同回到原始 4 套主题。
   */
  themeOverridesEnabled: boolean;
  /**
   * 自定义强调色（持久化，hex 形如 "#6366f1"）。
   * 启用时同时覆盖 :root 上的 --kb-primary（CSS 用）+ antd ConfigProvider colorPrimary（组件用）。
   * null = 跟随当前主题预设。
   */
  customAccent: string | null;
  /**
   * 自定义全屏背景图（持久化）。
   * 存原始本地路径（来自 dialog.open）；运行时用 convertFileSrc 转 webview 可访问的 asset URL，
   * 仅 themeOverridesEnabled=true 时生效。null = 不启用背景图。
   */
  customBgImage: string | null;
  /**
   * 背景图遮罩不透明度（持久化，0..1）。
   * 在背景图之上叠一层黑色（暗色主题）/白色（亮色主题）半透明，让文字保留对比度可读性。
   */
  customBgDim: number;
  /**
   * 背景图模糊半径（持久化，0..30，单位 px）。
   * 通过遮罩层 backdrop-filter: blur() 实现，对背景图本身做高斯模糊，
   * 不影响 #root 内容的清晰度。
   */
  customBgBlur: number;
  /**
   * 背景图适配模式（持久化）。
   * - cover: 拉伸填满窗口（默认，会裁剪）
   * - contain: 完整显示，可能留白
   * - center: 原始尺寸居中
   * - repeat: 平铺
   */
  customBgFit: "cover" | "contain" | "center" | "repeat";
  /**
   * 当前进程的系统信息（数据目录 / 版本 / 平台等）。
   * null = 启动时还没拉到；多处取 dataDir 拼接 kb-asset 资源路径。
   */
  instanceInfo: SystemInfo | null;
  /** 启动时拉一次后端 system_info；失败静默（不是关键路径） */
  loadInstanceInfo: () => Promise<void>;
  /**
   * 内置 in-memory MCP 是否允许 AI 调用写工具（create/update/delete/move 等 11 个）。
   * 默认 true（兼容旧版）。关闭后 AI 问答页里 LLM 调写工具会被后端拦截，返回友好错误。
   * 持久化在 app_config（key="ai_writable"），与外部 sidecar 的 --writable 互不影响。
   */
  aiWritable: boolean;
  /** 启动时从后端读取最新 ai_writable 标志（失败静默，保留默认 true） */
  loadAiWritable: () => Promise<void>;
  /** 切换 ai_writable：先写后端 + 再更 store（保证后端为真相源，刷新立即生效） */
  setAiWritable: (enabled: boolean) => Promise<void>;
  /** 切换主题自定义总开关（持久化） */
  setThemeOverridesEnabled: (on: boolean) => void;
  /** 设置/清除自定义强调色（hex 或 null） */
  setCustomAccent: (hex: string | null) => void;
  /** 设置/清除自定义背景图（原始本地路径或 null） */
  setCustomBgImage: (path: string | null) => void;
  /** 设置背景图遮罩不透明度（自动 clamp 到 [0, 1]） */
  setCustomBgDim: (dim: number) => void;
  /** 设置背景图模糊半径（自动 clamp 到 [0, 30] px） */
  setCustomBgBlur: (px: number) => void;
  /** 设置背景图适配模式 */
  setCustomBgFit: (fit: "cover" | "contain" | "center" | "repeat") => void;
  /** 一键重置所有主题自定义项（开关关 + 强调色清 + 背景清 + 遮罩归零 + 模糊归零 + 适配回 cover） */
  resetThemeOverrides: () => void;
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
  /** 触发任务列表页 / 看板 / 四象限重拉（提醒弹窗操作完任务后调用） */
  bumpTasksListRefresh: () => void;
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
  /** 切换某个可选视图启用/禁用，自动持久化到 app_config */
  toggleEnabledView: (view: ActiveView) => void;
  /** 启动期从 app_config 加载已保存的 enabled_views（无值时保留 default） */
  loadEnabledViews: () => Promise<void>;
  /** 切换某个移动端 Dashboard 项（持久化到 app_config.mobile_dashboard_items） */
  toggleMobileDashboardItem: (item: MobileDashboardItem) => void;
  /** 启动期从 app_config 加载 mobile_dashboard_items */
  loadMobileDashboardItems: () => Promise<void>;
  /** 替换底部 Tab 第 slot 格（0..3）的 key */
  setMobileTabKey: (slot: number, key: MobileTabKey) => void;
  /** 启动期加载 mobile_tab_keys */
  loadMobileTabKeys: () => Promise<void>;
  /** 设置 SidePanel 宽度（自动 clamp 到 [MIN, MAX]） */
  setSidePanelWidth: (width: number) => void;
  /** 设置 SidePanel 可见性 */
  setSidePanelVisible: (visible: boolean) => void;
  /** 切换 SidePanel 可见性（等价于 setSidePanelVisible(!visible)） */
  toggleSidePanel: () => void;
  /** 设置 ActivityBar 自动隐藏开关（持久化） */
  setAutoHideActivityBar: (on: boolean) => void;
  /** 推入一条最近搜索（去重、置顶、最多 RECENT_SEARCHES_MAX 条） */
  pushRecentSearch: (q: string) => void;
  /** 删除一条最近搜索 */
  removeRecentSearch: (q: string) => void;
  /** 清空最近搜索 */
  clearRecentSearches: () => void;
  /** 设置编辑器字体族 */
  setEditorFontFamily: (family: EditorFontFamily) => void;
  /** 设置编辑器字号（px） */
  setEditorFontSize: (size: number) => void;
  /** 设置编辑器行距倍数 */
  setEditorLineHeight: (lineHeight: number) => void;
  /** 设置代码块字号（px，0 = 跟随正文；非 0 会 clamp 到 [12, 20]） */
  setEditorCodeFontSize: (size: number) => void;
  /** 重置编辑器字体 + 版面到默认值 */
  resetEditorTypography: () => void;
  /** 设置正文阅读列宽（px，0 = 不限制；非 0 会 clamp 到 [480, 1600]） */
  setEditorReadingWidth: (w: number) => void;
  /** 切换纸张卡片观感 */
  setEditorPaper: (on: boolean) => void;
  /** 设置背景纹理（none / lines / grid） */
  setEditorRuleLines: (mode: EditorRuleLines) => void;
  /** 切换首行缩进 */
  setEditorFirstLineIndent: (on: boolean) => void;
  setEditorHeadingNumber: (on: boolean) => void;
  /** 设置编辑器高亮快捷键（accelerator 字符串；传空串 = 禁用高亮快捷键） */
  setEditorHighlightShortcut: (accel: string) => void;
  /** 设置全局界面缩放（自动 clamp 到 [UI_SCALE_MIN, UI_SCALE_MAX]，标记用户已手动设置） */
  setUiScale: (scale: number) => void;
  /** 重置 uiScale 为 suggestUiScale() 推荐值（一键回归"自动"） */
  resetUiScale: () => void;
  /** 切换/设置笔记自动保存开关 */
  setAutoSaveEnabled: (on: boolean) => void;
  /** 设置自动保存防抖延迟（毫秒，会 clamp 到 [500, 30000]） */
  setAutoSaveDelay: (ms: number) => void;
  /** 设置默认查看模式（edit / read） */
  setDefaultViewMode: (mode: "edit" | "read") => void;
  setTasksDefaultView: (
    v: "list" | "kanban" | "quadrant" | "calendar" | "gantt",
  ) => void;
  /** 切换大纲面板可见性（persist） */
  toggleOutline: () => void;
  /** 设置大纲面板可见性（persist） */
  setOutlineVisible: (visible: boolean) => void;
  /** 设置大纲面板停靠位置（左/右，persist） */
  setOutlinePosition: (pos: "left" | "right") => void;
  /** 应用布局预设（默认 / 专注写作 / 大纲优先），一次性切换一组布局字段（persist） */
  applyLayoutPreset: (id: LayoutPresetId) => void;
  /** 单个文件夹的折叠状态写入（true=收起 / false=展开） */
  setNotesFolderCollapsed: (key: string, collapsed: boolean) => void;
  /** 整体覆盖：把传入的 keys 设为"折叠"，其余视为展开（顶部"全部折叠"按钮用） */
  setNotesAllFoldersCollapsed: (keys: string[]) => void;
  /** 清空折叠集合 = 全部展开（顶部"全部展开"按钮用） */
  clearNotesCollapsedFolders: () => void;
  /**
   * 用现存文件夹 id 过滤折叠集合，删除已不存在的孤儿。
   * 在 loadFolders 拿到最新树后调用，避免删过的文件夹 id 在持久化里永远沉淀。
   */
  pruneNotesCollapsedFolders: (existingKeys: string[]) => void;
  /** 设置"未分类"展开/收起 */
  setNotesUncategorizedExpanded: (expanded: boolean) => void;
  /** 设置 NotesPanel "只显示文件夹"开关 */
  setNotesShowOnlyFolders: (only: boolean) => void;
  /** 标记 NotesPanel 已完成首次"全部折叠"初始化（一次性） */
  markNotesFoldersInitialCollapseDone: () => void;
  /** 设置"每次启动默认收起所有文件夹"开关 */
  setNotesCollapseFoldersOnStartup: (on: boolean) => void;
  /** 标记本次会话已执行过"启动收起"（会话级，一次性） */
  markNotesStartupCollapseApplied: () => void;
  /** 启动时从 app_config 拉默认文件夹 / 标签到 store（失败静默） */
  loadNoteDefaults: () => Promise<void>;
  /** 设置默认文件夹（null = 清除）+ 持久化到 app_config */
  setDefaultFolderId: (folderId: number | null) => Promise<void>;
  /** 设置默认标签集（空数组 = 清除）+ 持久化到 app_config */
  setDefaultTagIds: (tagIds: number[]) => Promise<void>;
  /** 切换某条笔记某个 heading anchor 的折叠态（toggle） */
  toggleNoteHeadingFold: (noteId: number, anchor: string) => void;
  /** 整体替换某条笔记的折叠 anchors（极少用，多用 toggle） */
  setNoteHeadingFolded: (noteId: number, anchors: string[]) => void;
  /**
   * 启动时预取的文件夹树缓存。
   * 让 NotesPanel 第一次 mount 时立即拿到种子数据，避免"点笔记 → 等 invoke"的空白闪烁。
   * Panel mount 后仍会后台 loadFolders 取最新数据替换。
   */
  prefetchedFolders: Folder[] | null;
  /** 启动时空闲调用：拉一次文件夹树写入缓存（失败静默） */
  prefetchFolders: () => Promise<void>;
  /**
   * 隐藏笔记 PIN 解锁时间戳（毫秒）。
   * null = 未解锁；与 HIDDEN_UNLOCK_TTL_MS 比对判定是否仍有效。
   * 故意不持久化：每次启动应用都要重新验证。
   */
  hiddenUnlockedAt: number | null;
  /** 标记隐藏笔记已解锁（PIN 校验通过后调用） */
  markHiddenUnlocked: () => void;
  /** 清除隐藏笔记解锁状态（用户主动锁定 / 修改 PIN 后调用） */
  clearHiddenUnlock: () => void;
  /** 当前是否在解锁有效期内 */
  isHiddenUnlocked: () => boolean;
  /**
   * 应用启动锁会话态（软锁 / 全局进入密码）。
   * 故意不持久化、不参与 loadFromStore：每次启动应用都要重新解锁。
   * - appLockEnabled: 是否已配置进入密码（镜像后端真相，供 UI 决定是否显示"立即锁定"）
   * - appLocked: 当前是否处于锁定（true = 必须输进入密码才能用）
   * - appLockAutoMinutes: 闲置自动锁定分钟数（0=关闭），从后端配置加载，仅供前端计时
   */
  appLockEnabled: boolean;
  appLocked: boolean;
  appLockAutoMinutes: number;
  /**
   * 启动时查询后端锁状态：已开启则置为锁定，并读出自动锁定分钟数。
   * 失败时静默置为"不锁"——软锁场景下宁可放行也不要因后端抖动把用户挡死在外面。
   */
  initAppLock: () => Promise<void>;
  /** 立即锁定（手动点"立即锁定" / 闲置自动锁触发）；仅在已配置时有意义 */
  lockAppNow: () => void;
  /** 解锁（进入密码校验通过后调用） */
  unlockApp: () => void;
  /**
   * 设置页设/关密码后调用，同步"是否已配置"标志。
   * 关闭（enabled=false）时顺带解锁，避免残留锁定态。
   * 注意：开启时不主动上锁——用户刚设完密码还在用，下次启动才需要解锁。
   */
  setAppLockEnabled: (enabled: boolean) => void;
  /** 更新前端记的自动锁定分钟数（设置页改动后即时生效；持久化在后端 app_config） */
  setAppLockAutoMinutes: (minutes: number) => void;
}

/**
 * 所有"可选"侧栏视图（不含核心 home/notes/search/trash/about）。
 * 改这个数组就同步改了"功能模块"开关清单 + ActivityBar 过滤标准。
 */
export const OPTIONAL_VIEWS: readonly ActiveView[] = [
  "daily",
  "tasks",
  "cards",
  "tags",
  "graph",
  "ai",
  "prompts",
  "push",
  "hidden",
] as const;

/**
 * 默认启用的可选视图集合：
 * 除 cards（卡片复习，新加功能，默认关闭让老用户不被打扰）外全部启用。
 */
const DEFAULT_ENABLED_VIEWS: Set<ActiveView> = new Set(
  OPTIONAL_VIEWS.filter((v) => v !== "cards"),
);

/**
 * 本次版本「新增」且需要对老用户自动补开的默认开启可选视图。
 *
 * 背景：`enabled_views` 只存"已启用"列表，新增可选视图对老用户不会自动出现（见 loadEnabledViews）。
 * 用 `known_views` 记录"settings 已对齐过的可选视图集合"做增量迁移；但老安装没有 known_views，
 * 无法区分"用户主动关掉的旧视图" vs "本次新增的视图"，故这里显式列出本次新增项作为一次性引导。
 * 迁移写入 known_views 后此列表即失效，后续新增视图靠 known_views 差量自动处理，无需再改这里。
 */
const NEW_DEFAULT_ON_VIEWS: readonly ActiveView[] = ["push"] as const;

/** 移动端 Dashboard 可隐藏项（仅移动端用） */
export type MobileDashboardItem =
  | "today_words" // 今日字数卡（蓝渐变）
  | "due_cards" // 待复习闪卡卡（紫渐变）
  | "today_tasks_card" // 今日待办计数卡
  | "total_notes" // 笔记总数卡
  | "quick_actions" // 4 列快速操作
  | "today_tasks_list" // 今日待办速览列表
  | "heatmap" // 30 天写作热力图
  | "recent_notes"; // 最近编辑

export const MOBILE_DASHBOARD_ITEMS: readonly MobileDashboardItem[] = [
  "today_words",
  "due_cards",
  "today_tasks_card",
  "total_notes",
  "quick_actions",
  "today_tasks_list",
  "heatmap",
  "recent_notes",
] as const;

/** 默认全部显示 */
const DEFAULT_MOBILE_DASHBOARD_ITEMS: Set<MobileDashboardItem> = new Set(
  MOBILE_DASHBOARD_ITEMS,
);

export const useAppStore = create<AppStore>((set, get) => ({
  lightTheme: "light-glass",
  darkTheme: "dark-starry",
  themeCategory: "light",
  sidebarCollapsed: false,
  focusMode: false,
  notesRefreshTick: 0,
  foldersRefreshTick: 0,
  tagsRefreshTick: 0,
  tasksListRefreshTick: 0,
  urgentTodoCount: 0,
  alwaysOnTop: false,
  activeView: "notes",
  enabledViews: new Set(DEFAULT_ENABLED_VIEWS),
  mobileDashboardItems: new Set(DEFAULT_MOBILE_DASHBOARD_ITEMS),
  mobileTabKeys: [...DEFAULT_MOBILE_TAB_KEYS],
  sidePanelWidth: SIDE_PANEL_DEFAULT_WIDTH,
  sidePanelVisible: true,
  autoHideActivityBar: false,
  recentSearches: [],
  editorFontFamily: EDITOR_FONT_DEFAULTS.family,
  editorFontSize: EDITOR_FONT_DEFAULTS.size,
  editorLineHeight: EDITOR_FONT_DEFAULTS.lineHeight,
  editorCodeFontSize: EDITOR_FONT_DEFAULTS.codeSize,
  editorReadingWidth: EDITOR_LAYOUT_DEFAULTS.readingWidth,
  editorPaper: EDITOR_LAYOUT_DEFAULTS.paper,
  editorRuleLines: EDITOR_LAYOUT_DEFAULTS.ruleLines,
  editorFirstLineIndent: EDITOR_LAYOUT_DEFAULTS.firstLineIndent,
  editorHeadingNumber: EDITOR_LAYOUT_DEFAULTS.headingNumber,
  editorHighlightShortcut: EDITOR_HIGHLIGHT_SHORTCUT_DEFAULT,
  uiScale: UI_SCALE_DEFAULT,
  uiScaleUserSet: false,
  autoSaveEnabled: false,
  autoSaveDelay: AUTO_SAVE_DELAY_DEFAULT,
  defaultViewMode: "edit",
  tasksDefaultView: "list",
  outlineVisible: true,
  outlinePosition: "right",
  notesCollapsedFolderKeys: [],
  notesUncategorizedExpanded: false,
  notesShowOnlyFolders: false,
  notesFoldersInitialCollapseDone: false,
  notesCollapseFoldersOnStartup: true,
  notesStartupCollapseApplied: false,
  defaultFolderId: null,
  defaultTagIds: [],
  notesHeadingFolded: {},
  themeOverridesEnabled: false,
  customAccent: null,
  customBgImage: null,
  customBgDim: 0,
  customBgBlur: 0,
  customBgFit: "cover",
  instanceInfo: null,
  loadInstanceInfo: async () => {
    try {
      const info = await systemApi.getSystemInfo();
      set({ instanceInfo: info });
    } catch {
      // 静默：系统信息不是关键路径，拉失败就不更新
    }
  },
  aiWritable: true,
  loadAiWritable: async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const v = await invoke<boolean>("mcp_get_ai_writable");
      set({ aiWritable: v });
    } catch {
      // 启动早期或后端不可用 → 保持默认 true
    }
  },
  setAiWritable: async (enabled) => {
    const prev = get().aiWritable;
    // 乐观更新让 Switch 不卡顿；失败回滚
    set({ aiWritable: enabled });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("mcp_set_ai_writable", { enabled });
    } catch (e) {
      console.warn("[ai_writable] persist failed:", e);
      set({ aiWritable: prev });
      throw e;
    }
  },
  setThemeOverridesEnabled: (on) => set({ themeOverridesEnabled: on }),
  setCustomAccent: (hex) => set({ customAccent: hex }),
  setCustomBgImage: (path) => set({ customBgImage: path }),
  setCustomBgDim: (dim) => {
    const clamped = Math.max(0, Math.min(1, dim));
    set({ customBgDim: clamped });
  },
  setCustomBgBlur: (px) => {
    const clamped = Math.max(0, Math.min(30, px));
    set({ customBgBlur: clamped });
  },
  setCustomBgFit: (fit) => set({ customBgFit: fit }),
  resetThemeOverrides: () =>
    set({
      themeOverridesEnabled: false,
      customAccent: null,
      customBgImage: null,
      customBgDim: 0,
      customBgBlur: 0,
      customBgFit: "cover",
    }),
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
  bumpTasksListRefresh: () =>
    set((s) => ({ tasksListRefreshTick: s.tasksListRefreshTick + 1 })),
  refreshTaskStats: async () => {
    try {
      const stats = await taskApi.stats();
      set({ urgentTodoCount: stats.urgentTodo });
    } catch {
      // 静默失败：侧边栏 Badge 不是关键路径
    }
  },
  setActiveView: (view) => set({ activeView: view }),
  toggleEnabledView: (view) => {
    const cur = get().enabledViews;
    const next = new Set(cur);
    if (next.has(view)) next.delete(view);
    else next.add(view);
    set({ enabledViews: next });
    // 持久化（数组形式存 JSON）；失败静默：UI 已即时更新，下次启动可能丢失而已
    void configApi
      .set("enabled_views", JSON.stringify([...next]))
      .catch((e) => console.warn("[settings] persist enabled_views failed:", e));
  },
  loadEnabledViews: async () => {
    const raw = await getConfigOrNull("enabled_views");
    if (!raw) return; // 无值 → 全新用户，保留构造默认（含本次新增的默认开启视图）
    try {
      const list = JSON.parse(raw) as ActiveView[];
      if (!Array.isArray(list)) return;
      // 只保留仍在 OPTIONAL_VIEWS 内的，防止旧版本残留的脏数据
      const valid = list.filter((v) => OPTIONAL_VIEWS.includes(v as ActiveView));
      const enabled = new Set<ActiveView>(valid);

      // 增量迁移：新增的「默认开启」可选视图要对老用户自动出现，
      // 但不能把用户主动关掉的旧视图重新打开。known_views = settings 已对齐过的可选视图集合。
      const knownRaw = await getConfigOrNull("known_views");
      const known: ActiveView[] = knownRaw
        ? (JSON.parse(knownRaw) as ActiveView[])
        : // 老安装无 known_views：视为已对齐过"本次新增项之前"的全部可选视图
          OPTIONAL_VIEWS.filter((v) => !NEW_DEFAULT_ON_VIEWS.includes(v));
      // 仅对"从未对齐过 + 默认开启"的新视图补开
      let changed = false;
      for (const v of OPTIONAL_VIEWS) {
        if (DEFAULT_ENABLED_VIEWS.has(v) && !known.includes(v) && !enabled.has(v)) {
          enabled.add(v);
          changed = true;
        }
      }
      set({ enabledViews: enabled });

      // 回写：known_views 对齐到当前全量可选视图；若补开了视图，同步回写 enabled_views
      void configApi
        .set("known_views", JSON.stringify([...OPTIONAL_VIEWS]))
        .catch((e) => console.warn("[settings] persist known_views failed:", e));
      if (changed) {
        void configApi
          .set("enabled_views", JSON.stringify([...enabled]))
          .catch((e) =>
            console.warn("[settings] persist enabled_views failed:", e),
          );
      }
    } catch (e) {
      console.warn("[settings] parse enabled_views failed:", e);
    }
  },
  toggleMobileDashboardItem: (item) => {
    const cur = get().mobileDashboardItems;
    const next = new Set(cur);
    if (next.has(item)) next.delete(item);
    else next.add(item);
    set({ mobileDashboardItems: next });
    void configApi
      .set("mobile_dashboard_items", JSON.stringify([...next]))
      .catch((e) =>
        console.warn("[settings] persist mobile_dashboard_items failed:", e),
      );
  },
  loadMobileDashboardItems: async () => {
    const raw = await getConfigOrNull("mobile_dashboard_items");
    if (!raw) return;
    try {
      const list = JSON.parse(raw) as MobileDashboardItem[];
      if (Array.isArray(list)) {
        const valid = list.filter((v) =>
          MOBILE_DASHBOARD_ITEMS.includes(v as MobileDashboardItem),
        );
        set({ mobileDashboardItems: new Set(valid) });
      }
    } catch (e) {
      console.warn("[settings] parse mobile_dashboard_items failed:", e);
    }
  },
  setMobileTabKey: (slot, key) => {
    if (slot < 0 || slot >= MOBILE_TAB_SLOT_COUNT) return;
    const cur = get().mobileTabKeys;
    const next = [...cur];
    // 去重：如果新 key 已在其它槽里，把它和当前槽换位
    const dupIdx = next.indexOf(key);
    if (dupIdx >= 0 && dupIdx !== slot) {
      next[dupIdx] = next[slot];
    }
    next[slot] = key;
    set({ mobileTabKeys: next });
    void configApi
      .set("mobile_tab_keys", JSON.stringify(next))
      .catch((e) =>
        console.warn("[settings] persist mobile_tab_keys failed:", e),
      );
  },
  loadMobileTabKeys: async () => {
    const raw = await getConfigOrNull("mobile_tab_keys");
    if (!raw) return;
    try {
      const list = JSON.parse(raw) as MobileTabKey[];
      if (Array.isArray(list)) {
        const valid = list
          .filter((k) => ALL_MOBILE_TAB_KEYS.includes(k as MobileTabKey))
          .slice(0, MOBILE_TAB_SLOT_COUNT);
        // 不足 4 格用默认补齐
        while (valid.length < MOBILE_TAB_SLOT_COUNT) {
          const pick = DEFAULT_MOBILE_TAB_KEYS[valid.length];
          if (!valid.includes(pick)) valid.push(pick);
          else break;
        }
        if (valid.length === MOBILE_TAB_SLOT_COUNT) {
          set({ mobileTabKeys: valid });
        }
      }
    } catch (e) {
      console.warn("[settings] parse mobile_tab_keys failed:", e);
    }
  },
  setSidePanelWidth: (width) =>
    set({
      sidePanelWidth: Math.max(
        SIDE_PANEL_MIN_WIDTH,
        Math.min(SIDE_PANEL_MAX_WIDTH, Math.round(width)),
      ),
    }),
  setSidePanelVisible: (visible) => set({ sidePanelVisible: visible }),
  toggleSidePanel: () => set((s) => ({ sidePanelVisible: !s.sidePanelVisible })),
  setAutoHideActivityBar: (on) => set({ autoHideActivityBar: on }),
  pushRecentSearch: (q) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    // 太短的关键词不入历史（一两个字符通常是打字中间态，不是用户最终意图）
    if (trimmed.length < 2) return;
    set((s) => {
      const last = s.recentSearches[0];
      // 前缀合并：若新词与最近一条互为前缀（用户在持续敲字），用新词替换最近一条而非新增
      // → "a" → "ab" → "abc" 在历史里只留最终的 "abc"，不留"递进半成品"
      // 注意：不限时间窗口——同一个搜索 session 里的渐进输入都该合并；
      // 跨 session 用户主动改成更长/更短的词，前缀关系成立时也算"修正"，合并是合理的。
      if (
        last &&
        last !== trimmed &&
        (trimmed.startsWith(last) || last.startsWith(trimmed))
      ) {
        return {
          recentSearches: [trimmed, ...s.recentSearches.slice(1)].slice(
            0,
            RECENT_SEARCHES_MAX,
          ),
        };
      }
      const deduped = s.recentSearches.filter((x) => x !== trimmed);
      return { recentSearches: [trimmed, ...deduped].slice(0, RECENT_SEARCHES_MAX) };
    });
  },
  removeRecentSearch: (q) =>
    set((s) => ({ recentSearches: s.recentSearches.filter((x) => x !== q) })),
  clearRecentSearches: () => set({ recentSearches: [] }),
  setEditorFontFamily: (family) => set({ editorFontFamily: family }),
  setEditorFontSize: (size) => {
    // clamp 到合法预设范围 [12, 22]，防止外部 set 写脏数据
    const clamped = Math.max(12, Math.min(22, Math.round(size)));
    set({ editorFontSize: clamped });
  },
  setEditorLineHeight: (lineHeight) => {
    const clamped = Math.max(1.2, Math.min(2.5, Number(lineHeight) || 1.8));
    set({ editorLineHeight: clamped });
  },
  setEditorCodeFontSize: (size) => {
    // 0 = 跟随正文（保留 0.9em 老行为）；非 0 时 clamp 到合法预设范围 [12, 20]
    const n = Math.round(Number(size) || 0);
    const clamped = n <= 0 ? 0 : Math.max(12, Math.min(20, n));
    set({ editorCodeFontSize: clamped });
  },
  resetEditorTypography: () =>
    set({
      editorFontFamily: EDITOR_FONT_DEFAULTS.family,
      editorFontSize: EDITOR_FONT_DEFAULTS.size,
      editorLineHeight: EDITOR_FONT_DEFAULTS.lineHeight,
      editorCodeFontSize: EDITOR_FONT_DEFAULTS.codeSize,
      editorReadingWidth: EDITOR_LAYOUT_DEFAULTS.readingWidth,
      editorPaper: EDITOR_LAYOUT_DEFAULTS.paper,
      editorRuleLines: EDITOR_LAYOUT_DEFAULTS.ruleLines,
      editorFirstLineIndent: EDITOR_LAYOUT_DEFAULTS.firstLineIndent,
      editorHeadingNumber: EDITOR_LAYOUT_DEFAULTS.headingNumber,
    }),
  setEditorReadingWidth: (w) => {
    const n = Math.round(Number(w) || 0);
    // 0 = 不限制；非 0 时 clamp 到合理区间，防脏值
    set({ editorReadingWidth: n <= 0 ? 0 : Math.max(480, Math.min(1600, n)) });
  },
  setEditorPaper: (on) => set({ editorPaper: !!on }),
  setEditorRuleLines: (mode) =>
    set({ editorRuleLines: mode === "lines" || mode === "grid" ? mode : "none" }),
  setEditorFirstLineIndent: (on) => set({ editorFirstLineIndent: !!on }),
  setEditorHeadingNumber: (on) => set({ editorHeadingNumber: !!on }),
  setEditorHighlightShortcut: (accel) =>
    set({ editorHighlightShortcut: typeof accel === "string" ? accel.trim() : "" }),
  setUiScale: (scale) => {
    const clamped = Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, Number(scale) || UI_SCALE_DEFAULT));
    set({ uiScale: clamped, uiScaleUserSet: true });
  },
  resetUiScale: () => {
    set({ uiScale: suggestUiScale(), uiScaleUserSet: false });
  },
  setAutoSaveEnabled: (on) => set({ autoSaveEnabled: !!on }),
  setAutoSaveDelay: (ms) => {
    const clamped = Math.max(500, Math.min(30000, Math.round(Number(ms) || AUTO_SAVE_DELAY_DEFAULT)));
    set({ autoSaveDelay: clamped });
  },
  setDefaultViewMode: (mode) => set({ defaultViewMode: mode === "read" ? "read" : "edit" }),
  setTasksDefaultView: (v) => set({ tasksDefaultView: v }),
  toggleOutline: () => set((s) => ({ outlineVisible: !s.outlineVisible })),
  setOutlineVisible: (visible) => set({ outlineVisible: visible }),
  setOutlinePosition: (pos) => set({ outlinePosition: pos === "left" ? "left" : "right" }),
  applyLayoutPreset: (id) => {
    const preset = LAYOUT_PRESETS.find((p) => p.id === id);
    // 只 set 预设声明的字段；未声明的保持当前值。这些字段均已纳入持久化。
    if (preset) set({ ...preset.values });
  },
  setNotesFolderCollapsed: (key, collapsed) =>
    set((s) => {
      const has = s.notesCollapsedFolderKeys.includes(key);
      if (collapsed && !has) {
        return { notesCollapsedFolderKeys: [...s.notesCollapsedFolderKeys, key] };
      }
      if (!collapsed && has) {
        return {
          notesCollapsedFolderKeys: s.notesCollapsedFolderKeys.filter((k) => k !== key),
        };
      }
      return s;
    }),
  setNotesAllFoldersCollapsed: (keys) =>
    set({ notesCollapsedFolderKeys: Array.from(new Set(keys)) }),
  clearNotesCollapsedFolders: () => set({ notesCollapsedFolderKeys: [] }),
  pruneNotesCollapsedFolders: (existingKeys) =>
    set((s) => {
      const existing = new Set(existingKeys);
      const next = s.notesCollapsedFolderKeys.filter((k) => existing.has(k));
      // 长度相等 = 没有孤儿可清，避免触发不必要的 subscribe 持久化
      if (next.length === s.notesCollapsedFolderKeys.length) return s;
      return { notesCollapsedFolderKeys: next };
    }),
  setNotesUncategorizedExpanded: (expanded) =>
    set({ notesUncategorizedExpanded: expanded }),
  setNotesShowOnlyFolders: (only) => set({ notesShowOnlyFolders: only }),
  markNotesFoldersInitialCollapseDone: () =>
    set({ notesFoldersInitialCollapseDone: true }),
  setNotesCollapseFoldersOnStartup: (on) =>
    set({ notesCollapseFoldersOnStartup: on }),
  markNotesStartupCollapseApplied: () =>
    set({ notesStartupCollapseApplied: true }),
  loadNoteDefaults: async () => {
    try {
      const folderRaw = await getConfigOrNull("default_folder_id");
      const tagsRaw = await getConfigOrNull("default_tag_ids");
      const folderId = folderRaw ? Number(folderRaw) : null;
      let tagIds: number[] = [];
      if (tagsRaw) {
        try {
          const parsed = JSON.parse(tagsRaw);
          if (Array.isArray(parsed)) {
            tagIds = parsed
              .map((x) => Number(x))
              .filter((x) => Number.isFinite(x) && x > 0);
          }
        } catch {
          // 持久化损坏：当作空集合处理，下次保存会覆盖
        }
      }
      set({
        defaultFolderId: Number.isFinite(folderId) && folderId !== null && folderId > 0
          ? folderId
          : null,
        defaultTagIds: tagIds,
      });
    } catch {
      // 后端不可用 / 启动早期 → 不阻塞 UI
    }
  },
  setDefaultFolderId: async (folderId) => {
    set({ defaultFolderId: folderId });
    try {
      if (folderId == null) {
        await configApi.delete("default_folder_id").catch(() => {});
      } else {
        await configApi.set("default_folder_id", String(folderId));
      }
    } catch {
      // 失败时已写入 store，下次启动会从持久化读出真实值；这里保持轻量
    }
  },
  setDefaultTagIds: async (tagIds) => {
    const cleaned = Array.from(new Set(tagIds.filter((x) => Number.isFinite(x) && x > 0)));
    set({ defaultTagIds: cleaned });
    try {
      if (cleaned.length === 0) {
        await configApi.delete("default_tag_ids").catch(() => {});
      } else {
        await configApi.set("default_tag_ids", JSON.stringify(cleaned));
      }
    } catch {
      // 同上
    }
  },
  toggleNoteHeadingFold: (noteId, anchor) =>
    set((s) => {
      const current = s.notesHeadingFolded[noteId] ?? [];
      const next = current.includes(anchor)
        ? current.filter((a) => a !== anchor)
        : [...current, anchor];
      return { notesHeadingFolded: { ...s.notesHeadingFolded, [noteId]: next } };
    }),
  setNoteHeadingFolded: (noteId, anchors) =>
    set((s) => ({
      notesHeadingFolded: {
        ...s.notesHeadingFolded,
        [noteId]: Array.from(new Set(anchors)),
      },
    })),
  prefetchedFolders: null,
  prefetchFolders: async () => {
    try {
      const list = await folderApi.list();
      set({ prefetchedFolders: list });
    } catch {
      // 失败静默：NotesPanel 自己会再拉一次，预热只是优化
    }
  },
  hiddenUnlockedAt: null,
  markHiddenUnlocked: () => set({ hiddenUnlockedAt: Date.now() }),
  clearHiddenUnlock: () => set({ hiddenUnlockedAt: null }),
  isHiddenUnlocked: () => {
    const ts = get().hiddenUnlockedAt;
    return ts !== null && Date.now() - ts < HIDDEN_UNLOCK_TTL_MS;
  },
  appLockEnabled: false,
  appLocked: false,
  appLockAutoMinutes: 0,
  initAppLock: async () => {
    try {
      const st = await appLockApi.status();
      // 已开启 → 启动即锁定；未开启 → 不锁
      set({
        appLockEnabled: st.enabled,
        appLocked: st.enabled,
        appLockAutoMinutes: st.autoLockMinutes,
      });
    } catch {
      // 后端不可用 / 启动早期 → 不锁（失败开放），避免误把用户挡在外面
      set({ appLockEnabled: false, appLocked: false });
    }
  },
  lockAppNow: () => {
    // 仅在已配置进入密码时才允许锁定，避免没设密码却被锁死（解不开）
    if (get().appLockEnabled) set({ appLocked: true });
  },
  unlockApp: () => set({ appLocked: false }),
  setAppLockEnabled: (enabled) =>
    set(enabled ? { appLockEnabled: true } : { appLockEnabled: false, appLocked: false }),
  setAppLockAutoMinutes: (minutes) =>
    set({
      appLockAutoMinutes: Math.max(0, Math.min(240, Math.round(Number(minutes) || 0))),
    }),
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

/**
 * 把当前编辑器字体偏好同步到 :root 的 CSS 变量上，供 global.css 里的
 * `.tiptap-content .tiptap` 读取。
 *
 * - family=system 时清掉变量，让编辑器继承全局默认字体
 * - 其余 family 写入完整 fallback 链，避免用户没装首选字体时变成方块
 */
export function applyEditorTypography(state: {
  editorFontFamily: EditorFontFamily;
  editorFontSize: number;
  editorLineHeight: number;
  editorCodeFontSize: number;
}) {
  const root = document.documentElement;
  const stack = EDITOR_FONT_STACKS[state.editorFontFamily];
  if (stack) {
    root.style.setProperty("--editor-font-family", stack);
  } else {
    root.style.removeProperty("--editor-font-family");
  }
  root.style.setProperty("--editor-font-size", `${state.editorFontSize}px`);
  root.style.setProperty("--editor-line-height", String(state.editorLineHeight));
  // 代码块字号：> 0 写绝对 px（全文代码块统一生效）；0 → 移除变量，CSS 回退到相对正文的 0.9em
  if (state.editorCodeFontSize > 0) {
    root.style.setProperty("--editor-code-font-size", `${state.editorCodeFontSize}px`);
  } else {
    root.style.removeProperty("--editor-code-font-size");
  }
}

/**
 * 把编辑器版面偏好同步到 :root：阅读列宽写 CSS 变量，纸张 / 纹理 / 缩进写 data-* 属性。
 * global.css 里用 `:root[data-editor-paper="1"] .editor-content-area { ... }` 这类选择器消费。
 *
 * - readingWidth=0 时移除变量 → 退回老的"铺满 + 大屏 1600/1900 上限"行为
 * - 其余偏好用 data 属性而非 class，避免与组件自身 className 冲突，且方便纯 CSS 选择
 */
export function applyEditorLayout(state: {
  editorReadingWidth: number;
  editorPaper: boolean;
  editorRuleLines: EditorRuleLines;
  editorFirstLineIndent: boolean;
  editorHeadingNumber: boolean;
}) {
  const root = document.documentElement;
  if (state.editorReadingWidth > 0) {
    root.style.setProperty("--editor-reading-width", `${state.editorReadingWidth}px`);
  } else {
    root.style.removeProperty("--editor-reading-width");
  }
  root.setAttribute("data-editor-paper", state.editorPaper ? "1" : "0");
  root.setAttribute("data-editor-rule", state.editorRuleLines);
  root.setAttribute("data-editor-indent", state.editorFirstLineIndent ? "1" : "0");
  root.setAttribute(
    "data-editor-heading-number",
    state.editorHeadingNumber ? "1" : "0",
  );
}

/**
 * 把 uiScale 写到 :root 的 --ui-scale 变量上，供自定义 CSS 用 calc() 引用。
 *
 * 故意不动 root font-size：避免 Tailwind 的 text-sm/rem 工具类被意外整体放大或缩小。
 * antd 组件的缩放走 ConfigProvider token，自定义 CSS 由 P1 阶段把硬编码 px 收敛到
 * 用 calc(var(--kb-font-base) * var(--ui-scale)) 度量后才完整生效。
 */
export function applyUiScale(scale: number) {
  const root = document.documentElement;
  root.style.setProperty("--ui-scale", String(scale));
}

/**
 * hex(#rrggbb) → "r,g,b" 字符串，方便在 rgba(...) 里拼。
 * 只接受 #rrggbb / #rgb 两种短写；解析失败回退到空串（调用方会 removeProperty）。
 */
function hexToRgbTuple(hex: string): string {
  const m = hex.replace("#", "").trim();
  let r: number, g: number, b: number;
  if (m.length === 3) {
    r = parseInt(m[0] + m[0], 16);
    g = parseInt(m[1] + m[1], 16);
    b = parseInt(m[2] + m[2], 16);
  } else if (m.length === 6) {
    r = parseInt(m.slice(0, 2), 16);
    g = parseInt(m.slice(2, 4), 16);
    b = parseInt(m.slice(4, 6), 16);
  } else {
    return "";
  }
  if ([r, g, b].some((v) => Number.isNaN(v))) return "";
  return `${r},${g},${b}`;
}

/**
 * 把用户的主题自定义项（强调色 / 背景图 / 遮罩）应用到 :root + body。
 *
 * 行为：
 * - themeOverridesEnabled=false 时清除所有覆盖，回到 themes.css 的预设
 * - customAccent: 直接 inline 覆盖 --kb-primary（inline 比 [data-theme] 选择器优先级高）
 *   同时给出 --kb-primary-light 的 rgba 14% 派生值，配合现有 hover/active 高亮
 * - customBgImage: 通过 convertFileSrc 转 webview 可访问 URL 后注入 body
 *   背景图存在时给 body 加 .has-custom-bg，由 global.css 接管 background-* 一组样式
 * - customBgDim: 注入 --kb-custom-bg-dim 用于 ::before 遮罩透明度
 */
export async function applyThemeOverrides(state: {
  themeOverridesEnabled: boolean;
  customAccent: string | null;
  customBgImage: string | null;
  customBgDim: number;
  customBgBlur: number;
  customBgFit: "cover" | "contain" | "center" | "repeat";
}) {
  const root = document.documentElement;
  const body = document.body;

  // ─── 强调色 ───
  if (state.themeOverridesEnabled && state.customAccent) {
    const tuple = hexToRgbTuple(state.customAccent);
    if (tuple) {
      root.style.setProperty("--kb-primary", state.customAccent);
      root.style.setProperty("--kb-primary-light", `rgba(${tuple},0.14)`);
    } else {
      root.style.removeProperty("--kb-primary");
      root.style.removeProperty("--kb-primary-light");
    }
  } else {
    root.style.removeProperty("--kb-primary");
    root.style.removeProperty("--kb-primary-light");
  }

  // ─── 背景图（异步：convertFileSrc 是同步函数但插件在 webview 启动后才 ready） ───
  // 加 path_exists 校验：用户切换 dev/prod 实例、或者文件被外部删掉时，store 里旧路径
  // 仍残留，convertFileSrc 转出来的 asset URL 加载会静默失败；主动清空 customBgImage
  // 让用户重新选图，避免"开关打开但图始终不显示"的诡异状态
  if (state.themeOverridesEnabled && state.customBgImage) {
    try {
      const { convertFileSrc, invoke } = await import("@tauri-apps/api/core");
      const exists = await invoke<boolean>("path_exists", {
        path: state.customBgImage,
      });
      if (!exists) {
        console.warn(
          "[theme] bg image missing, clearing store path:",
          state.customBgImage,
        );
        body.classList.remove("has-custom-bg");
        body.style.removeProperty("--kb-custom-bg-image");
        useAppStore.getState().setCustomBgImage(null);
      } else {
        const url = convertFileSrc(state.customBgImage);
        // CSS url() 里转义双引号，避免路径含双引号时把 url() 切断
        const safe = url.replace(/"/g, '\\"');
        body.style.setProperty("--kb-custom-bg-image", `url("${safe}")`);
        body.classList.add("has-custom-bg");
      }
    } catch (e) {
      console.warn("[theme] bg image apply failed:", e);
      body.classList.remove("has-custom-bg");
      body.style.removeProperty("--kb-custom-bg-image");
    }
  } else {
    body.classList.remove("has-custom-bg");
    body.style.removeProperty("--kb-custom-bg-image");
  }

  // ─── 遮罩不透明度（始终写，因为 .has-custom-bg::before 需要） ───
  root.style.setProperty(
    "--kb-custom-bg-dim",
    String(state.themeOverridesEnabled ? state.customBgDim : 0),
  );

  // ─── 模糊半径（注入 px 字符串供 backdrop-filter 用） ───
  root.style.setProperty(
    "--kb-custom-bg-blur",
    `${state.themeOverridesEnabled ? state.customBgBlur : 0}px`,
  );

  // ─── 适配模式：把 4 种模式翻译成 3 个 background-* CSS 变量 ───
  const fit = state.themeOverridesEnabled ? state.customBgFit : "cover";
  let bgSize = "cover";
  let bgRepeat = "no-repeat";
  let bgPosition = "center center";
  switch (fit) {
    case "contain":
      bgSize = "contain";
      break;
    case "center":
      bgSize = "auto";
      break;
    case "repeat":
      bgSize = "auto";
      bgRepeat = "repeat";
      break;
    case "cover":
    default:
      break;
  }
  root.style.setProperty("--kb-custom-bg-size", bgSize);
  root.style.setProperty("--kb-custom-bg-repeat", bgRepeat);
  root.style.setProperty("--kb-custom-bg-position", bgPosition);
}

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
    const ahab = await store.get<boolean>("autoHideActivityBar");
    if (typeof ahab === "boolean") {
      useAppStore.getState().setAutoHideActivityBar(ahab);
    }

    // 恢复最近搜索
    const rs = await store.get<string[]>("recentSearches");
    if (Array.isArray(rs)) {
      useAppStore.setState({
        recentSearches: rs
          .filter((x) => typeof x === "string" && x.trim())
          .slice(0, RECENT_SEARCHES_MAX),
      });
    }

    // 恢复编辑器字体偏好
    const ef = await store.get<EditorFontFamily>("editorFontFamily");
    if (ef && ef in EDITOR_FONT_STACKS) {
      useAppStore.getState().setEditorFontFamily(ef);
    }
    const fs = await store.get<number>("editorFontSize");
    if (typeof fs === "number" && Number.isFinite(fs)) {
      useAppStore.getState().setEditorFontSize(fs);
    }
    const lh = await store.get<number>("editorLineHeight");
    if (typeof lh === "number" && Number.isFinite(lh)) {
      useAppStore.getState().setEditorLineHeight(lh);
    }
    const cfs = await store.get<number>("editorCodeFontSize");
    if (typeof cfs === "number" && Number.isFinite(cfs)) {
      useAppStore.getState().setEditorCodeFontSize(cfs);
    }

    // 恢复编辑器版面偏好（阅读列宽 / 纸张 / 纹理 / 首行缩进）
    const erw = await store.get<number>("editorReadingWidth");
    if (typeof erw === "number" && Number.isFinite(erw)) {
      useAppStore.getState().setEditorReadingWidth(erw);
    }
    const ep = await store.get<boolean>("editorPaper");
    if (typeof ep === "boolean") {
      useAppStore.getState().setEditorPaper(ep);
    }
    const erl = await store.get<EditorRuleLines>("editorRuleLines");
    if (erl === "none" || erl === "lines" || erl === "grid") {
      useAppStore.getState().setEditorRuleLines(erl);
    }
    const efi = await store.get<boolean>("editorFirstLineIndent");
    if (typeof efi === "boolean") {
      useAppStore.getState().setEditorFirstLineIndent(efi);
    }
    const ehn = await store.get<boolean>("editorHeadingNumber");
    if (typeof ehn === "boolean") {
      useAppStore.getState().setEditorHeadingNumber(ehn);
    }
    // 恢复编辑器高亮快捷键（空串是合法值 = 用户主动禁用，故只校验类型不校验非空）
    const ehs = await store.get<string>("editorHighlightShortcut");
    if (typeof ehs === "string") {
      useAppStore.getState().setEditorHighlightShortcut(ehs);
    }

    // 恢复界面缩放：用户已手动设置过就尊重持久化值，否则用本机推荐值
    const uiScaleUserSet = await store.get<boolean>("uiScaleUserSet");
    const uiScalePersisted = await store.get<number>("uiScale");
    if (uiScaleUserSet === true && typeof uiScalePersisted === "number" && Number.isFinite(uiScalePersisted)) {
      const clamped = Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, uiScalePersisted));
      useAppStore.setState({ uiScale: clamped, uiScaleUserSet: true });
    } else {
      // 首启或老用户未设置过：套用屏幕推荐值（仅本次会话生效，等用户主动改时才标记 userSet）
      useAppStore.setState({ uiScale: suggestUiScale(), uiScaleUserSet: false });
    }

    const ov = await store.get<boolean>("outlineVisible");
    if (typeof ov === "boolean") {
      useAppStore.getState().setOutlineVisible(ov);
    }
    const op = await store.get<string>("outlinePosition");
    if (op === "left" || op === "right") {
      useAppStore.getState().setOutlinePosition(op);
    }

    // 恢复自动保存偏好（默认关闭，老用户升级后行为不变）
    const ase = await store.get<boolean>("autoSaveEnabled");
    if (typeof ase === "boolean") {
      useAppStore.getState().setAutoSaveEnabled(ase);
    }
    const asd = await store.get<number>("autoSaveDelay");
    if (typeof asd === "number" && Number.isFinite(asd)) {
      useAppStore.getState().setAutoSaveDelay(asd);
    }
    const dvm = await store.get<string>("defaultViewMode");
    if (dvm === "read" || dvm === "edit") {
      useAppStore.getState().setDefaultViewMode(dvm);
    }
    const tdv = await store.get<string>("tasksDefaultView");
    if (
      tdv === "list" ||
      tdv === "kanban" ||
      tdv === "quadrant" ||
      tdv === "calendar" ||
      tdv === "gantt"
    ) {
      useAppStore.getState().setTasksDefaultView(tdv);
    }

    // 先恢复"启动默认收起"开关（默认 true）。必须先读它，再决定是否恢复折叠集合：
    // 开启时启动要全部收起，恢复上次会话的折叠集合没意义且会与"启动收起"逻辑打架，直接跳过。
    const ncfos = await store.get<boolean>("notesCollapseFoldersOnStartup");
    const collapseOnStartup = typeof ncfos === "boolean" ? ncfos : true;
    if (typeof ncfos === "boolean") {
      useAppStore.setState({ notesCollapseFoldersOnStartup: ncfos });
    }
    // 恢复 NotesPanel 折叠偏好（仅"启动收起"关闭时恢复；开启时交给启动收起逻辑全部收起）
    const nck = await store.get<string[]>("notesCollapsedFolderKeys");
    if (!collapseOnStartup && Array.isArray(nck)) {
      useAppStore.setState({
        notesCollapsedFolderKeys: nck.filter((k) => typeof k === "string"),
      });
    }
    const nue = await store.get<boolean>("notesUncategorizedExpanded");
    if (typeof nue === "boolean") {
      useAppStore.getState().setNotesUncategorizedExpanded(nue);
    }
    const nsof = await store.get<boolean>("notesShowOnlyFolders");
    if (typeof nsof === "boolean") {
      useAppStore.getState().setNotesShowOnlyFolders(nsof);
    }
    const nficd = await store.get<boolean>("notesFoldersInitialCollapseDone");
    if (typeof nficd === "boolean") {
      useAppStore.setState({ notesFoldersInitialCollapseDone: nficd });
    }
    const nhf = await store.get<Record<string, string[]>>("notesHeadingFolded");
    if (nhf && typeof nhf === "object") {
      const cleaned: Record<number, string[]> = {};
      for (const [k, v] of Object.entries(nhf)) {
        const id = Number(k);
        if (Number.isFinite(id) && id > 0 && Array.isArray(v)) {
          cleaned[id] = v.filter((x) => typeof x === "string" && x.length > 0);
        }
      }
      useAppStore.setState({ notesHeadingFolded: cleaned });
    }

    // 恢复主题自定义偏好
    const toe = await store.get<boolean>("themeOverridesEnabled");
    if (typeof toe === "boolean") {
      useAppStore.setState({ themeOverridesEnabled: toe });
    }
    const ca = await store.get<string | null>("customAccent");
    if (typeof ca === "string" || ca === null) {
      useAppStore.setState({ customAccent: ca });
    }
    const cbi = await store.get<string | null>("customBgImage");
    if (typeof cbi === "string" || cbi === null) {
      useAppStore.setState({ customBgImage: cbi });
    }
    const cbd = await store.get<number>("customBgDim");
    if (typeof cbd === "number" && Number.isFinite(cbd)) {
      useAppStore.getState().setCustomBgDim(cbd);
    }
    const cbb = await store.get<number>("customBgBlur");
    if (typeof cbb === "number" && Number.isFinite(cbb)) {
      useAppStore.getState().setCustomBgBlur(cbb);
    }
    const cbf = await store.get<string>("customBgFit");
    if (cbf === "cover" || cbf === "contain" || cbf === "center" || cbf === "repeat") {
      useAppStore.getState().setCustomBgFit(cbf);
    }
  } catch {
    // 首次启动时 store 可能不存在
  } finally {
    // 不论加载成功失败，都把当前 store 值（可能是默认值，也可能是已恢复值）
    // 同步到 CSS 变量，确保首次渲染就用对字体而不是闪一下默认再切。
    applyEditorTypography(useAppStore.getState());
    applyEditorLayout(useAppStore.getState());
    applyUiScale(useAppStore.getState().uiScale);
    void applyThemeOverrides(useAppStore.getState());
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
      autoHideActivityBar,
      recentSearches,
      editorFontFamily,
      editorFontSize,
      editorLineHeight,
      editorCodeFontSize,
      editorReadingWidth,
      editorPaper,
      editorRuleLines,
      editorFirstLineIndent,
      editorHeadingNumber,
      editorHighlightShortcut,
      uiScale,
      uiScaleUserSet,
      autoSaveEnabled,
      autoSaveDelay,
      defaultViewMode,
      tasksDefaultView,
      outlineVisible,
      outlinePosition,
      notesCollapsedFolderKeys,
      notesUncategorizedExpanded,
      notesShowOnlyFolders,
      notesFoldersInitialCollapseDone,
      notesCollapseFoldersOnStartup,
      notesHeadingFolded,
      themeOverridesEnabled,
      customAccent,
      customBgImage,
      customBgDim,
      customBgBlur,
      customBgFit,
    } = useAppStore.getState();
    const store = await Store.load(STORE_FILE);
    await store.set("lightTheme", lightTheme);
    await store.set("darkTheme", darkTheme);
    await store.set("themeCategory", themeCategory);
    await store.set("alwaysOnTop", alwaysOnTop);
    await store.set("sidePanelWidth", sidePanelWidth);
    await store.set("sidePanelVisible", sidePanelVisible);
    await store.set("autoHideActivityBar", autoHideActivityBar);
    await store.set("recentSearches", recentSearches);
    await store.set("editorFontFamily", editorFontFamily);
    await store.set("editorFontSize", editorFontSize);
    await store.set("editorLineHeight", editorLineHeight);
    await store.set("editorCodeFontSize", editorCodeFontSize);
    await store.set("editorReadingWidth", editorReadingWidth);
    await store.set("editorPaper", editorPaper);
    await store.set("editorRuleLines", editorRuleLines);
    await store.set("editorFirstLineIndent", editorFirstLineIndent);
    await store.set("editorHeadingNumber", editorHeadingNumber);
    await store.set("editorHighlightShortcut", editorHighlightShortcut);
    await store.set("uiScale", uiScale);
    await store.set("uiScaleUserSet", uiScaleUserSet);
    await store.set("autoSaveEnabled", autoSaveEnabled);
    await store.set("autoSaveDelay", autoSaveDelay);
    await store.set("defaultViewMode", defaultViewMode);
    await store.set("tasksDefaultView", tasksDefaultView);
    await store.set("outlineVisible", outlineVisible);
    await store.set("outlinePosition", outlinePosition);
    await store.set("notesCollapsedFolderKeys", notesCollapsedFolderKeys);
    await store.set("notesUncategorizedExpanded", notesUncategorizedExpanded);
    await store.set("notesShowOnlyFolders", notesShowOnlyFolders);
    await store.set(
      "notesFoldersInitialCollapseDone",
      notesFoldersInitialCollapseDone,
    );
    await store.set(
      "notesCollapseFoldersOnStartup",
      notesCollapseFoldersOnStartup,
    );
    await store.set("notesHeadingFolded", notesHeadingFolded);
    await store.set("themeOverridesEnabled", themeOverridesEnabled);
    await store.set("customAccent", customAccent);
    await store.set("customBgImage", customBgImage);
    await store.set("customBgDim", customBgDim);
    await store.set("customBgBlur", customBgBlur);
    await store.set("customBgFit", customBgFit);
    await store.save();
  } catch {
    // 静默失败
  }
}

// 监听主题 + 置顶 + SidePanel + 编辑器字体偏好变化自动保存
let _prevPersistKey = "";
useAppStore.subscribe((state) => {
  // notesHeadingFolded 摘要：用 entries 数 + 总 anchor 数 简化对比，避免每次 stringify 大对象
  const headingFoldEntries = Object.entries(state.notesHeadingFolded);
  const headingFoldKey = `${headingFoldEntries.length}:${headingFoldEntries.reduce((acc, [, v]) => acc + v.length, 0)}:${headingFoldEntries.map(([k, v]) => `${k}=${v.join(",")}`).join("|")}`;
  const key = `${state.lightTheme}|${state.darkTheme}|${state.themeCategory}|${state.alwaysOnTop}|${state.sidePanelWidth}|${state.sidePanelVisible}|${state.autoHideActivityBar}|${state.recentSearches.join(",")}|${state.editorFontFamily}|${state.editorFontSize}|${state.editorLineHeight}|${state.editorCodeFontSize}|${state.editorReadingWidth}|${state.editorPaper}|${state.editorRuleLines}|${state.editorFirstLineIndent}|${state.editorHeadingNumber}|${state.editorHighlightShortcut}|${state.uiScale}|${state.uiScaleUserSet}|${state.autoSaveEnabled}|${state.autoSaveDelay}|${state.outlineVisible}|${state.outlinePosition}|${state.notesCollapsedFolderKeys.join(",")}|${state.notesUncategorizedExpanded}|${state.notesShowOnlyFolders}|${state.notesFoldersInitialCollapseDone}|${state.notesCollapseFoldersOnStartup}|${headingFoldKey}|${state.themeOverridesEnabled}|${state.customAccent ?? ""}|${state.customBgImage ?? ""}|${state.customBgDim}|${state.customBgBlur}|${state.customBgFit}`;
  if (key !== _prevPersistKey) {
    _prevPersistKey = key;
    saveThemeToStore();
  }
});

// 编辑器字体偏好变化时实时同步到 CSS 变量（无需刷新页面）
let _prevTypographyKey = "";
useAppStore.subscribe((state) => {
  const key = `${state.editorFontFamily}|${state.editorFontSize}|${state.editorLineHeight}|${state.editorCodeFontSize}`;
  if (key !== _prevTypographyKey) {
    _prevTypographyKey = key;
    applyEditorTypography(state);
  }
});

// 编辑器版面偏好变化时实时同步到 :root（变量 + data 属性），无需刷新
let _prevLayoutKey = "";
useAppStore.subscribe((state) => {
  const key = `${state.editorReadingWidth}|${state.editorPaper}|${state.editorRuleLines}|${state.editorFirstLineIndent}|${state.editorHeadingNumber}`;
  if (key !== _prevLayoutKey) {
    _prevLayoutKey = key;
    applyEditorLayout(state);
  }
});

// uiScale 变化时实时同步 :root --ui-scale，让自定义 CSS 立即响应
let _prevUiScale = NaN;
useAppStore.subscribe((state) => {
  if (state.uiScale !== _prevUiScale) {
    _prevUiScale = state.uiScale;
    applyUiScale(state.uiScale);
  }
});

// 主题覆盖变化时实时把 --kb-primary / 背景图 / 遮罩同步到 DOM
let _prevThemeOverrideKey = "";
useAppStore.subscribe((state) => {
  const key = `${state.themeOverridesEnabled}|${state.customAccent ?? ""}|${state.customBgImage ?? ""}|${state.customBgDim}|${state.customBgBlur}|${state.customBgFit}`;
  if (key !== _prevThemeOverrideKey) {
    _prevThemeOverrideKey = key;
    void applyThemeOverrides(state);
  }
});
