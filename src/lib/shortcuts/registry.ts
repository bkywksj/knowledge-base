/**
 * 快捷键注册中心：全应用唯一的快捷键真相源。
 *
 * - global scope：与 Rust 侧 `services/shortcut.rs::DEFAULT_BINDINGS` 1:1 对齐
 *   实际生效键位通过 `shortcutsApi.list()` 拿（用户可能改过键），不是这里的 defaultAccel
 * - app / editor scope：当前还是窗口内 keydown 监听，defaultAccel 仅用于显示
 */

export type ShortcutScope = "global" | "app" | "editor";

export interface ShortcutDef {
  /** 内部唯一 ID。global scope 必须与 Rust 侧 DEFAULT_BINDINGS 对齐 */
  id: string;
  scope: ShortcutScope;
  /** 默认 accelerator，e.g. 'CommandOrControl+Shift+N' */
  defaultAccel: string;
  group: string;
  desc: string;
}

/** 分组顺序（也决定 ShortcutsPanel 的渲染顺序） */
export const SHORTCUT_GROUPS = [
  "全局快捷键（系统级，后台也可用）",
  "应用内",
  "编辑器 - 文本格式",
  "编辑器 - 段落",
  "编辑器 - 操作",
] as const;

export const SHORTCUTS: ShortcutDef[] = [
  // ─── 全局热键（系统级 / global-shortcut 插件注册） ───
  {
    id: "global.quickCapture",
    scope: "global",
    defaultAccel: "CommandOrControl+Shift+N",
    group: "全局快捷键（系统级，后台也可用）",
    desc: "剪贴板内容 → 新笔记",
  },
  {
    id: "global.showWindow",
    scope: "global",
    defaultAccel: "CommandOrControl+Alt+K",
    group: "全局快捷键（系统级，后台也可用）",
    desc: "唤起主窗口",
  },
  {
    id: "global.openDaily",
    scope: "global",
    defaultAccel: "CommandOrControl+Alt+D",
    group: "全局快捷键（系统级，后台也可用）",
    desc: "打开今日笔记",
  },
  {
    id: "global.openSearch",
    scope: "global",
    defaultAccel: "CommandOrControl+Alt+F",
    group: "全局快捷键（系统级，后台也可用）",
    desc: "打开搜索面板",
  },

  // ─── 应用内（窗口聚焦时生效） ───
  { id: "app.palette", scope: "app", defaultAccel: "CommandOrControl+K", group: "应用内", desc: "打开命令面板" },
  { id: "app.newNote", scope: "app", defaultAccel: "CommandOrControl+N", group: "应用内", desc: "新建空白笔记" },
  { id: "app.save", scope: "app", defaultAccel: "CommandOrControl+S", group: "应用内", desc: "保存当前笔记" },
  { id: "app.help", scope: "app", defaultAccel: "F1", group: "应用内", desc: "查看快捷键帮助" },
  { id: "app.focusToggle", scope: "app", defaultAccel: "F11", group: "应用内", desc: "切换专注模式" },
  { id: "app.exitFocus", scope: "app", defaultAccel: "Escape", group: "应用内", desc: "退出专注模式" },
  { id: "app.back", scope: "app", defaultAccel: "Alt+ArrowLeft", group: "应用内", desc: "历史后退" },
  { id: "app.forward", scope: "app", defaultAccel: "Alt+ArrowRight", group: "应用内", desc: "历史前进" },

  // ─── 编辑器 - 文本格式 ───
  { id: "editor.bold", scope: "editor", defaultAccel: "CommandOrControl+B", group: "编辑器 - 文本格式", desc: "粗体" },
  { id: "editor.italic", scope: "editor", defaultAccel: "CommandOrControl+I", group: "编辑器 - 文本格式", desc: "斜体" },
  { id: "editor.underline", scope: "editor", defaultAccel: "CommandOrControl+U", group: "编辑器 - 文本格式", desc: "下划线" },
  { id: "editor.strike", scope: "editor", defaultAccel: "CommandOrControl+Shift+X", group: "编辑器 - 文本格式", desc: "删除线" },
  { id: "editor.highlight", scope: "editor", defaultAccel: "CommandOrControl+Shift+H", group: "编辑器 - 文本格式", desc: "高亮" },
  { id: "editor.code", scope: "editor", defaultAccel: "CommandOrControl+E", group: "编辑器 - 文本格式", desc: "行内代码" },

  // ─── 编辑器 - 段落 ───
  { id: "editor.h1", scope: "editor", defaultAccel: "CommandOrControl+Shift+1", group: "编辑器 - 段落", desc: "标题 1" },
  { id: "editor.h2", scope: "editor", defaultAccel: "CommandOrControl+Shift+2", group: "编辑器 - 段落", desc: "标题 2" },
  { id: "editor.h3", scope: "editor", defaultAccel: "CommandOrControl+Shift+3", group: "编辑器 - 段落", desc: "标题 3" },
  { id: "editor.ol", scope: "editor", defaultAccel: "CommandOrControl+Shift+7", group: "编辑器 - 段落", desc: "有序列表" },
  { id: "editor.ul", scope: "editor", defaultAccel: "CommandOrControl+Shift+8", group: "编辑器 - 段落", desc: "无序列表" },
  { id: "editor.task", scope: "editor", defaultAccel: "CommandOrControl+Shift+9", group: "编辑器 - 段落", desc: "任务列表" },
  { id: "editor.quote", scope: "editor", defaultAccel: "CommandOrControl+Shift+B", group: "编辑器 - 段落", desc: "引用" },
  { id: "editor.codeblock", scope: "editor", defaultAccel: "CommandOrControl+Alt+C", group: "编辑器 - 段落", desc: "代码块" },

  // ─── 编辑器 - 操作 ───
  { id: "editor.undo", scope: "editor", defaultAccel: "CommandOrControl+Z", group: "编辑器 - 操作", desc: "撤销" },
  { id: "editor.redo", scope: "editor", defaultAccel: "CommandOrControl+Shift+Z", group: "编辑器 - 操作", desc: "重做" },
  { id: "editor.selectAll", scope: "editor", defaultAccel: "CommandOrControl+A", group: "编辑器 - 操作", desc: "全选" },
  { id: "editor.indent", scope: "editor", defaultAccel: "Tab", group: "编辑器 - 操作", desc: "增加缩进" },
  { id: "editor.outdent", scope: "editor", defaultAccel: "Shift+Tab", group: "编辑器 - 操作", desc: "减少缩进" },
];

const IS_MAC = typeof navigator !== "undefined" && /Mac OS X|Macintosh/.test(navigator.userAgent);

const KEY_RENDER_MAC: Record<string, string> = {
  CommandOrControl: "⌘",
  Cmd: "⌘",
  Command: "⌘",
  CmdOrCtrl: "⌘",
  Ctrl: "⌃",
  Control: "⌃",
  Alt: "⌥",
  Option: "⌥",
  Shift: "⇧",
  Meta: "⌘",
  Super: "⌘",
  Escape: "Esc",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
};

const KEY_RENDER_WIN: Record<string, string> = {
  CommandOrControl: "Ctrl",
  Cmd: "Win",
  Command: "Win",
  CmdOrCtrl: "Ctrl",
  Control: "Ctrl",
  Ctrl: "Ctrl",
  Alt: "Alt",
  Option: "Alt",
  Shift: "Shift",
  Meta: "Win",
  Super: "Win",
  Escape: "Esc",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
};

/**
 * 把 accelerator 字符串转成显示用 keys 数组。
 * - macOS：CommandOrControl → ⌘，Alt → ⌥，Shift → ⇧
 * - Win/Linux：CommandOrControl → Ctrl
 * - 空字符串 → ['—']（已禁用）
 */
export function accelToKeys(accel: string): string[] {
  if (!accel) return ["—"];
  const map = IS_MAC ? KEY_RENDER_MAC : KEY_RENDER_WIN;
  return accel.split("+").map((p) => {
    const trimmed = p.trim();
    return map[trimmed] ?? trimmed;
  });
}

/** 当前平台是否为 macOS（设置页录键 UI / 文案用） */
export function isMacPlatform(): boolean {
  return IS_MAC;
}

/**
 * 把 KeyboardEvent 转成 Tauri accelerator 字符串。
 * 用于设置页的「按下任意键位」录键交互。
 *
 * - macOS：metaKey → CommandOrControl；ctrlKey → Control
 * - Win/Linux：ctrlKey → CommandOrControl；metaKey → Meta
 * - 主键：字母数字大写化；F1-F12 / Arrow* / Tab / Enter 等保留原名
 * - 必须包含至少一个修饰键 + 一个主键，否则返回 null
 */
export function keyboardEventToAccel(e: KeyboardEvent): string | null {
  const parts: string[] = [];
  if (IS_MAC) {
    if (e.metaKey) parts.push("CommandOrControl");
    if (e.ctrlKey) parts.push("Control");
  } else {
    if (e.ctrlKey) parts.push("CommandOrControl");
    if (e.metaKey) parts.push("Meta");
  }
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  // 跳过单独按下修饰键的事件
  const k = e.key;
  if (
    k === "Control" || k === "Shift" || k === "Alt" || k === "Meta" ||
    k === "CapsLock" || k === "Dead" || k === "Process"
  ) {
    return null;
  }

  // 标准化主键名：单字母大写化，其他保留
  const main =
    k.length === 1 ? k.toUpperCase() :
    k === " " ? "Space" :
    k;
  parts.push(main);

  // 必须有至少一个修饰键（避免误录单字母吞键盘）
  // F1-F12 / Escape 例外允许无修饰
  const isFunctionKey = /^F\d+$/.test(main) || main === "Escape";
  const hasMod = parts.length >= 2;
  if (!isFunctionKey && !hasMod) return null;

  return parts.join("+");
}

/** 按 group 字段把 SHORTCUTS 切成有序数组，给 UI 直接消费 */
export function groupShortcuts(): { title: string; items: ShortcutDef[] }[] {
  const map = new Map<string, ShortcutDef[]>();
  for (const s of SHORTCUTS) {
    const arr = map.get(s.group) ?? [];
    arr.push(s);
    map.set(s.group, arr);
  }
  return SHORTCUT_GROUPS.filter((g) => map.has(g)).map((g) => ({
    title: g,
    items: map.get(g)!,
  }));
}

/** 通过 ID 查询单条定义 */
export function findShortcut(id: string): ShortcutDef | undefined {
  return SHORTCUTS.find((s) => s.id === id);
}
