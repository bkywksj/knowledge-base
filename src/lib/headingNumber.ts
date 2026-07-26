/**
 * 标题自动编号 —— 纯计算层（不依赖 React / Zustand / DOM / CSS）
 *
 * 背景：旧实现是纯 CSS counter（global.css 的 `h1::before { content: counter(kbh1) … }`），
 * 有四个绕不过去的先天缺陷：
 *   1. `::before` 内容不进选区、不进剪贴板 → 复制/导出丢编号
 *   2. `::before` 是 inline 盒 → 标题换行后第二行不悬挂对齐
 *   3. 编号只活在 DOM → JS（大纲面板）拿不到
 *   4. 折叠标题时 `.kb-heading-folded { display:none }` 会让被折叠的标题
 *      **不参与 counter-increment / counter-reset**（CSS 规范），于是折过一次之后
 *      下级编号不再随上级重置 —— 用户反馈的「2.1.9 之后是 2.2.10」正是此因
 *
 * 现改为基于 ProseMirror doc 计算：与 DOM 显示状态完全无关，折叠 / 隐藏都不影响。
 *
 * 分两层，便于单测：
 *   - `computeLabels(items, opts)`   纯数组进、纯数组出，无任何 PM 依赖 → 单测主战场
 *   - `computeHeadingNumbers(doc)`   扫 doc 收集 heading 后委托给上面那个
 *
 * ⚠️ 编号始终是**显示层**：不写进 markdown、不进 .md 文件、不参与同步，
 *    与旧 CSS 方案的语义保持一致（设置页那句"仅显示效果，不写入笔记内容"依然成立）。
 */
import type { Node as PMNode } from "@tiptap/pm/model";

/** 编号格式 */
export type HeadingNumberFormat =
  /** 累积式：1 / 1.1 / 1.1.1（默认，与旧 CSS 行为一致） */
  | "decimal"
  /** 中文公文式（非累积，每级独立符号）：一、/（一）/ 1. /（1） */
  | "chineseOutline";

export interface HeadingNumberOptions {
  /** 从第几级开始编号（1–6，默认 1）。设 2 时 H1 当封面标题不编号，H2 变成"1" */
  startLevel?: number;
  /** 编到第几级为止（1–6，默认 6） */
  maxLevel?: number;
  /** 编号格式，默认 decimal */
  format?: HeadingNumberFormat;
  /**
   * 标题正文里已经手写了编号时（常见于 AI 生成的文档："1.1 公司定位"），
   * 不再叠加自动编号，避免出现「1.1.1 1.1 公司定位」。默认 true。
   * 注意：跳过的只是**显示**，该标题仍然占一个计数位，后续标题编号不会错位。
   */
  skipManual?: boolean;
}

/** 单个标题的编号结果 */
export interface HeadingNumberEntry {
  /** heading 节点在 doc 里的起始位置（PM pos）；数组版计算时为 -1 */
  pos: number;
  /** 1–6 */
  level: number;
  /** 标题纯文本 */
  text: string;
  /** 计算出的编号；null = 该标题不显示编号（超出层级范围 / 已有手写编号） */
  label: string | null;
  /** 标题文本是否自带手写编号 */
  hasManual: boolean;
}

const MAX_DEPTH = 6;

/**
 * 「标题已自带编号」的识别规则。
 *
 * 刻意保守 —— 宁可漏判也不误判：单个数字加空格（如「2026 年度总结」「3 分钟看懂 X」）
 * **不算**手写编号，否则大量正常标题会被误当成已编号而丢掉自动编号。
 */
const MANUAL_NUMBER_PATTERNS: RegExp[] = [
  /^\s*\d+(\.\d+)+\s*[.、]?\s*/, // 1.1 / 1.2.3 （多级，最典型）
  /^\s*\d+\s*[、．]\s*/, // 1、概述（中文顿号 / 全角句点，习惯上不留空格）
  // 半角点必须后跟空白才算编号，否则「1.5 倍速播放」这类小数标题会被误当成 "1." 编号
  /^\s*\d+\s*\.\s+/,
  /^\s*[一二三四五六七八九十百零]+\s*[、.．]\s*/, // 一、现状分析
  /^\s*[(（]\s*[0-9一二三四五六七八九十百零]+\s*[)）]\s*/, // (1) / （一）
  /^\s*第\s*[0-9一二三四五六七八九十百零]+\s*[章节篇部讲]\s*/, // 第一章 / 第 2 节
];

/** 标题文本是否自带手写编号 */
export function hasManualNumber(text: string): boolean {
  const t = text ?? "";
  return MANUAL_NUMBER_PATTERNS.some((re) => re.test(t));
}

/**
 * 剥掉标题正文里的手写编号，返回剩余文本。
 * 供「清除标题内手写编号」批量命令使用；没有手写编号时原样返回。
 */
export function stripManualNumber(text: string): string {
  const t = text ?? "";
  for (const re of MANUAL_NUMBER_PATTERNS) {
    const m = t.match(re);
    if (m && m[0].length < t.length) {
      return t.slice(m[0].length).trimStart();
    }
  }
  return t;
}

/** 阿拉伯数字 → 中文数字（1–99 覆盖，超出回退阿拉伯数字） */
export function toChineseNumber(n: number): string {
  const CN = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (!Number.isFinite(n) || n <= 0) return String(n);
  if (n < 10) return CN[n];
  if (n < 20) return n === 10 ? "十" : `十${CN[n % 10]}`;
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const rest = n % 10;
    return `${CN[tens]}十${rest ? CN[rest] : ""}`;
  }
  return String(n);
}

/**
 * 把计数栈渲染成编号文本。
 * - decimal：累积，"1.2.3"
 * - chineseOutline：非累积，只用当前级的数字，按深度换符号
 */
function formatLabel(
  counters: number[],
  depth: number,
  format: HeadingNumberFormat,
): string {
  if (format === "chineseOutline") {
    const n = counters[depth];
    switch (depth) {
      case 0:
        return `${toChineseNumber(n)}、`;
      case 1:
        return `（${toChineseNumber(n)}）`;
      case 2:
        return `${n}.`;
      case 3:
        return `（${n}）`;
      default:
        return `${n})`;
    }
  }
  return counters.slice(0, depth + 1).join(".");
}

/**
 * 核心算法：给一串按文档顺序排列的标题算编号。
 *
 * 规则（对齐 Word / Obsidian 的直觉）：
 * - 同级递增，进入下级时下级从 1 开始
 * - 回到上级时，所有更深层级清零（这是旧 CSS 方案在折叠场景下失效的那条）
 * - **跳级容错**：H1 直接跟 H3 时，中间缺失的 H2 按 1 计（显示 1.1.1），
 *   而不是出现 "1..1" 这种空洞
 * - 层级范围外（< startLevel 或 > maxLevel）的标题不编号，也不打乱计数
 */
export function computeLabels(
  items: { level: number; text: string }[],
  opts: HeadingNumberOptions = {},
): HeadingNumberEntry[] {
  const startLevel = clampLevel(opts.startLevel ?? 1);
  const maxLevel = clampLevel(opts.maxLevel ?? MAX_DEPTH);
  const format = opts.format ?? "decimal";
  const skipManual = opts.skipManual ?? true;

  // counters[i] 对应"相对 startLevel 的第 i 层"，而不是绝对 H 级别，
  // 这样 startLevel=2 时 H2 就是第 0 层，编号从 "1" 起算而非 "0.1"
  const counters = new Array<number>(MAX_DEPTH).fill(0);
  const out: HeadingNumberEntry[] = [];

  for (const item of items) {
    const level = clampLevel(item.level);
    const text = item.text ?? "";
    const manual = hasManualNumber(text);

    if (level < startLevel || level > maxLevel) {
      out.push({ pos: -1, level, text, label: null, hasManual: manual });
      continue;
    }

    const depth = level - startLevel; // 0-based 层深
    counters[depth] += 1;
    for (let i = depth + 1; i < MAX_DEPTH; i += 1) counters[i] = 0;
    // 跳级：上层还没被任何标题递增过（仍为 0）时补 1，避免编号出现空段
    for (let i = 0; i < depth; i += 1) {
      if (counters[i] === 0) counters[i] = 1;
    }

    out.push({
      pos: -1,
      level,
      text,
      // 已手写编号的标题只跳过显示，计数位照占（后续标题编号才不会错位）
      label: skipManual && manual ? null : formatLabel(counters, depth, format),
      hasManual: manual,
    });
  }

  return out;
}

function clampLevel(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_DEPTH, Math.max(1, Math.floor(n)));
}

/**
 * 扫一份 ProseMirror doc，返回每个 heading 的编号。
 *
 * 收集范围与大纲面板（EditorOutline）保持一致：**所有** heading，
 * 包含嵌套在分栏 / 引用块等容器里的（旧 CSS 用后代选择器，行为相同，迁移零差异）。
 */
export function computeHeadingNumbers(
  doc: PMNode,
  opts: HeadingNumberOptions = {},
): HeadingNumberEntry[] {
  const found: { pos: number; level: number; text: string }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return true;
    found.push({
      pos,
      level: (node.attrs.level as number) ?? 1,
      text: node.textContent ?? "",
    });
    return false; // 不下钻标题内部
  });

  const labels = computeLabels(found, opts);
  return labels.map((entry, i) => ({ ...entry, pos: found[i].pos }));
}
