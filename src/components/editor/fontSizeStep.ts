/**
 * 字号档位 + 「放大 / 缩小一档」（同 Word 的 A+ / A-、Ctrl+Shift+> / <）。
 *
 * 顶部工具栏的字号下拉、选中文字浮条的 A+ / A-、快捷键共用同一套档位，
 * 免得三处各跳各的。
 */
import type { Editor } from "@tiptap/react";

export const FONT_SIZE_OPTIONS = [
  { value: "12px", label: "12" },
  { value: "13px", label: "13" },
  { value: "14px", label: "14" },
  { value: "15px", label: "15" },
  { value: "16px", label: "16" },
  { value: "18px", label: "18" },
  { value: "20px", label: "20" },
  { value: "24px", label: "24" },
  { value: "30px", label: "30" },
  { value: "36px", label: "36" },
  { value: "48px", label: "48" },
];

const SIZES = FONT_SIZE_OPTIONS.map((o) => parseFloat(o.value));

/**
 * 从当前字号跳到下一档（dir=1 放大 / -1 缩小），已到头返回 null。
 * 当前值不在档位上（如正文默认 15.5px、粘贴来的 17px）时跳到最近的一档，而不是原地不动。
 */
export function nextFontSize(currentPx: number, dir: 1 | -1): string | null {
  const target =
    dir > 0 ? SIZES.find((s) => s > currentPx) : [...SIZES].reverse().find((s) => s < currentPx);
  return target === undefined ? null : `${target}px`;
}

/**
 * 选区起点的字号（px）。没设过字号的文字取实际渲染值：正文、各级标题默认字号不同，
 * 正文字号用户还能在设置里改，写死一个默认值会让第一下 A+ 跳错档。
 */
function currentFontSizePx(editor: Editor): number {
  const attr = editor.getAttributes("textStyle").fontSize as string | undefined;
  const fromAttr = attr ? parseFloat(attr) : NaN;
  if (Number.isFinite(fromAttr)) return fromAttr;
  const { node } = editor.view.domAtPos(editor.state.selection.from);
  const el = node instanceof HTMLElement ? node : node.parentElement;
  const rendered = el ? parseFloat(getComputedStyle(el).fontSize) : NaN;
  return Number.isFinite(rendered) ? rendered : 16;
}

/** 选区字号放大 / 缩小一档；已到头返回 false */
export function stepFontSize(editor: Editor, dir: 1 | -1): boolean {
  const next = nextFontSize(currentFontSizePx(editor), dir);
  if (!next) return false;
  return editor.chain().focus().setFontSize(next).run();
}
