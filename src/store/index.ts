import { create } from "zustand";
import { Store } from "@tauri-apps/plugin-store";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { taskApi, systemApi, folderApi, configApi } from "@/lib/api";

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

export const EDITOR_FONT_DEFAULTS = {
  family: "system" as EditorFontFamily,
  size: 15,
  lineHeight: 1.8,
};

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
  /** SidePanel（Activity Bar 右侧主面板）宽度 */
  sidePanelWidth: number;
  /**
   * SidePanel 是否展开。
   * 折叠时只保留 48px ActivityBar，主区撑满。
   * VS Code 行为：点击当前高亮图标 = 折叠/展开 SidePanel。
   */
  sidePanelVisible: boolean;
  /** 搜索视图：最近搜索关键词（最新在前，最多 RECENT_SEARCHES_MAX 条，持久化） */
  recentSearches: string[];
  /** 编辑器字体族（持久化） */
  editorFontFamily: EditorFontFamily;
  /** 编辑器字号 px（持久化） */
  editorFontSize: number;
  /** 编辑器行距倍数（持久化） */
  editorLineHeight: number;
  /** 笔记编辑页：右侧大纲面板是否显示（持久化）。标题数 < 2 时由组件自动隐藏，与此独立 */
  outlineVisible: boolean;
  /**
   * NotesPanel 文件夹树：被显式折叠的文件夹 id 集合（持久化）。
   * 存"折叠"而不是"展开"——新建文件夹默认展开，符合直觉；空集合 = 全部展开。
   * 用 string[] 存，运行时按需转 Set。
   */
  notesCollapsedFolderKeys: string[];
  /** NotesPanel 末尾"未分类"虚拟节点是否展开（持久化） */
  notesUncategorizedExpanded: boolean;
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
   * NotesPanel 首次进入是否已执行"全部折叠初始化"（持久化）。
   * false = 用户从未打开过侧栏（或老版本升级），首次拿到 folders 时把全部 id 灌进 collapsed。
   * true = 已初始化，后续完全由用户操作驱动展开/折叠。
   */
  notesFoldersInitialCollapseDone: boolean;
  /**
   * 当前进程的系统信息（含多开实例编号 + 数据目录）。
   * null = 启动时还没拉到；UI 据此渲染实例徽章
   */
  instanceInfo: SystemInfo | null;
  /** 启动时拉一次后端 system_info；失败静默（标识不是关键路径） */
  loadInstanceInfo: () => Promise<void>;
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
  /** 设置 SidePanel 宽度（自动 clamp 到 [MIN, MAX]） */
  setSidePanelWidth: (width: number) => void;
  /** 设置 SidePanel 可见性 */
  setSidePanelVisible: (visible: boolean) => void;
  /** 切换 SidePanel 可见性（等价于 setSidePanelVisible(!visible)） */
  toggleSidePanel: () => void;
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
  /** 重置编辑器字体到默认值 */
  resetEditorTypography: () => void;
  /** 切换大纲面板可见性（persist） */
  toggleOutline: () => void;
  /** 设置大纲面板可见性（persist） */
  setOutlineVisible: (visible: boolean) => void;
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
  /** 标记 NotesPanel 已完成首次"全部折叠"初始化（一次性） */
  markNotesFoldersInitialCollapseDone: () => void;
  /** 启动时从 app_config 拉默认文件夹 / 标签到 store（失败静默） */
  loadNoteDefaults: () => Promise<void>;
  /** 设置默认文件夹（null = 清除）+ 持久化到 app_config */
  setDefaultFolderId: (folderId: number | null) => Promise<void>;
  /** 设置默认标签集（空数组 = 清除）+ 持久化到 app_config */
  setDefaultTagIds: (tagIds: number[]) => Promise<void>;
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
  tasksListRefreshTick: 0,
  urgentTodoCount: 0,
  alwaysOnTop: false,
  activeView: "notes",
  sidePanelWidth: SIDE_PANEL_DEFAULT_WIDTH,
  sidePanelVisible: true,
  recentSearches: [],
  editorFontFamily: EDITOR_FONT_DEFAULTS.family,
  editorFontSize: EDITOR_FONT_DEFAULTS.size,
  editorLineHeight: EDITOR_FONT_DEFAULTS.lineHeight,
  outlineVisible: true,
  notesCollapsedFolderKeys: [],
  notesUncategorizedExpanded: false,
  notesFoldersInitialCollapseDone: false,
  defaultFolderId: null,
  defaultTagIds: [],
  instanceInfo: null,
  loadInstanceInfo: async () => {
    try {
      const info = await systemApi.getSystemInfo();
      set({ instanceInfo: info });
    } catch {
      // 静默：实例徽章不是关键路径，拉失败就不显示
    }
  },
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
  setSidePanelWidth: (width) =>
    set({
      sidePanelWidth: Math.max(
        SIDE_PANEL_MIN_WIDTH,
        Math.min(SIDE_PANEL_MAX_WIDTH, Math.round(width)),
      ),
    }),
  setSidePanelVisible: (visible) => set({ sidePanelVisible: visible }),
  toggleSidePanel: () => set((s) => ({ sidePanelVisible: !s.sidePanelVisible })),
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
  resetEditorTypography: () =>
    set({
      editorFontFamily: EDITOR_FONT_DEFAULTS.family,
      editorFontSize: EDITOR_FONT_DEFAULTS.size,
      editorLineHeight: EDITOR_FONT_DEFAULTS.lineHeight,
    }),
  toggleOutline: () => set((s) => ({ outlineVisible: !s.outlineVisible })),
  setOutlineVisible: (visible) => set({ outlineVisible: visible }),
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
  markNotesFoldersInitialCollapseDone: () =>
    set({ notesFoldersInitialCollapseDone: true }),
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
    const ov = await store.get<boolean>("outlineVisible");
    if (typeof ov === "boolean") {
      useAppStore.getState().setOutlineVisible(ov);
    }

    // 恢复 NotesPanel 折叠偏好
    const nck = await store.get<string[]>("notesCollapsedFolderKeys");
    if (Array.isArray(nck)) {
      useAppStore.setState({
        notesCollapsedFolderKeys: nck.filter((k) => typeof k === "string"),
      });
    }
    const nue = await store.get<boolean>("notesUncategorizedExpanded");
    if (typeof nue === "boolean") {
      useAppStore.getState().setNotesUncategorizedExpanded(nue);
    }
    const nficd = await store.get<boolean>("notesFoldersInitialCollapseDone");
    if (typeof nficd === "boolean") {
      useAppStore.setState({ notesFoldersInitialCollapseDone: nficd });
    }
  } catch {
    // 首次启动时 store 可能不存在
  } finally {
    // 不论加载成功失败，都把当前 store 值（可能是默认值，也可能是已恢复值）
    // 同步到 CSS 变量，确保首次渲染就用对字体而不是闪一下默认再切。
    applyEditorTypography(useAppStore.getState());
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
      recentSearches,
      editorFontFamily,
      editorFontSize,
      editorLineHeight,
      outlineVisible,
      notesCollapsedFolderKeys,
      notesUncategorizedExpanded,
      notesFoldersInitialCollapseDone,
    } = useAppStore.getState();
    const store = await Store.load(STORE_FILE);
    await store.set("lightTheme", lightTheme);
    await store.set("darkTheme", darkTheme);
    await store.set("themeCategory", themeCategory);
    await store.set("alwaysOnTop", alwaysOnTop);
    await store.set("sidePanelWidth", sidePanelWidth);
    await store.set("sidePanelVisible", sidePanelVisible);
    await store.set("recentSearches", recentSearches);
    await store.set("editorFontFamily", editorFontFamily);
    await store.set("editorFontSize", editorFontSize);
    await store.set("editorLineHeight", editorLineHeight);
    await store.set("outlineVisible", outlineVisible);
    await store.set("notesCollapsedFolderKeys", notesCollapsedFolderKeys);
    await store.set("notesUncategorizedExpanded", notesUncategorizedExpanded);
    await store.set(
      "notesFoldersInitialCollapseDone",
      notesFoldersInitialCollapseDone,
    );
    await store.save();
  } catch {
    // 静默失败
  }
}

// 监听主题 + 置顶 + SidePanel + 编辑器字体偏好变化自动保存
let _prevPersistKey = "";
useAppStore.subscribe((state) => {
  const key = `${state.lightTheme}|${state.darkTheme}|${state.themeCategory}|${state.alwaysOnTop}|${state.sidePanelWidth}|${state.sidePanelVisible}|${state.recentSearches.join(",")}|${state.editorFontFamily}|${state.editorFontSize}|${state.editorLineHeight}|${state.outlineVisible}|${state.notesCollapsedFolderKeys.join(",")}|${state.notesUncategorizedExpanded}|${state.notesFoldersInitialCollapseDone}`;
  if (key !== _prevPersistKey) {
    _prevPersistKey = key;
    saveThemeToStore();
  }
});

// 编辑器字体偏好变化时实时同步到 CSS 变量（无需刷新页面）
let _prevTypographyKey = "";
useAppStore.subscribe((state) => {
  const key = `${state.editorFontFamily}|${state.editorFontSize}|${state.editorLineHeight}`;
  if (key !== _prevTypographyKey) {
    _prevTypographyKey = key;
    applyEditorTypography(state);
  }
});
