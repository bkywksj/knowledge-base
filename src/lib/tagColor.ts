/**
 * 标签色点：PC 与手机端统一存十六进制（TagColorPicker 的 TAG_COLORS），
 * 旧版手机端存的是 blue / green 这类颜色名，读的时候两种都认。
 */

/** 旧版手机端存的颜色名 → 对应的 PC 色值 */
const LEGACY_COLOR: Record<string, string> = {
  blue: "#1677ff",
  green: "#52c41a",
  orange: "#fa8c16",
  purple: "#722ed1",
  pink: "#eb2f96",
  yellow: "#faad14",
  red: "#f5222d",
  cyan: "#13c2c2",
  slate: "#8c8c8c",
};

/** 标签色点用的 CSS 颜色；没设颜色时用中性灰（手机令牌） */
export function tagDot(color: string | null): string {
  if (!color) return "var(--m-ink4)";
  return LEGACY_COLOR[color] ?? color;
}
