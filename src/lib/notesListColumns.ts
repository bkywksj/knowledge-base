/**
 * 笔记列表（列表视图）里用户可以控制显隐 / 宽度的列。
 *
 * 标题列和操作列固定显示：标题列自适应吃掉剩余宽度（其它列拖窄或隐藏，标题就显示得更全），
 * 操作列是删除 / 导出入口，隐藏了用户就没法操作。
 */
export type NotesColumnKey = "index" | "tags" | "folder" | "word_count" | "updated_at";

export const NOTES_COLUMN_LABELS: Record<NotesColumnKey, string> = {
  index: "序号",
  tags: "标签",
  folder: "目录",
  word_count: "字数",
  updated_at: "更新时间",
};

export const NOTES_COLUMN_KEYS = Object.keys(NOTES_COLUMN_LABELS) as NotesColumnKey[];

export const DEFAULT_NOTES_COLUMN_WIDTHS: Record<NotesColumnKey, number> = {
  index: 36,
  tags: 160,
  folder: 120,
  word_count: 70,
  updated_at: 110,
};

/** 允许拖动调宽的列（序号列太窄，拖它没有意义） */
export const RESIZABLE_NOTES_COLUMNS: NotesColumnKey[] = [
  "tags",
  "folder",
  "word_count",
  "updated_at",
];

export const MIN_COLUMN_WIDTH = 50;
export const MAX_COLUMN_WIDTH = 600;

export interface NotesColumnPrefs {
  /** 被隐藏的列 */
  hidden: NotesColumnKey[];
  /** 用户拖出来的列宽；没拖过的列用默认宽度 */
  widths: Partial<Record<NotesColumnKey, number>>;
  /** 是否显示表头。v4 原型是无表头的行列表，默认不显示；需要拖列宽时在「列」设置里打开 */
  showHeader: boolean;
}

/** v4 默认：序号 / 字数收起、不显示表头——外观对齐原型的行列表，用户可在「列」设置里逐项打开 */
export const DEFAULT_NOTES_COLUMN_PREFS: NotesColumnPrefs = {
  hidden: ["index", "word_count"],
  widths: {},
  showHeader: false,
};

export function clampColumnWidth(width: number): number {
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(width)));
}

/**
 * 校验从磁盘读回来的偏好。
 *
 * 持久化数据可能来自旧版本或被手改过：未知的列名、非数字的宽度、超出范围的宽度
 * 都不能让列表渲染出问题（宽度为 NaN / 0 会让整列消失）。
 */
export function sanitizeNotesColumnPrefs(raw: unknown): NotesColumnPrefs {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_NOTES_COLUMN_PREFS };
  const obj = raw as { hidden?: unknown; widths?: unknown; showHeader?: unknown };

  // hidden 缺失 / 类型不对 → 用默认隐藏列；是数组（哪怕是空数组 = 用户主动全部显示）就按它来
  const hidden: NotesColumnKey[] = Array.isArray(obj.hidden) ? [] : [...DEFAULT_NOTES_COLUMN_PREFS.hidden];
  if (Array.isArray(obj.hidden)) {
    for (const k of obj.hidden) {
      if (NOTES_COLUMN_KEYS.includes(k as NotesColumnKey) && !hidden.includes(k as NotesColumnKey)) {
        hidden.push(k as NotesColumnKey);
      }
    }
  }

  const widths: Partial<Record<NotesColumnKey, number>> = {};
  if (obj.widths && typeof obj.widths === "object") {
    const w = obj.widths as Record<string, unknown>;
    for (const key of RESIZABLE_NOTES_COLUMNS) {
      const v = w[key];
      if (typeof v === "number" && Number.isFinite(v)) widths[key] = clampColumnWidth(v);
    }
  }

  const showHeader = typeof obj.showHeader === "boolean" ? obj.showHeader : DEFAULT_NOTES_COLUMN_PREFS.showHeader;

  return { hidden, widths, showHeader };
}
