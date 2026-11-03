/**
 * AI 提示词的图标表：提示词库页（选图标）和编辑器 AI 写作菜单（显示图标）共用一份。
 *
 * 图标按 Lucide 名字存在 prompt_templates.icon 里；这里只放菜单能渲染的那几个，
 * 名字不在表里（或没填）一律显示 Wand2 —— 选图标的格子也只给这几个，免得选了却显示不出来。
 */
import type { ReactNode } from "react";
import {
  ArrowRight,
  Expand,
  FileText,
  Languages,
  RefreshCw,
  Shrink,
  Sparkles,
  Wand2,
} from "lucide-react";

export const PROMPT_ICON_MAP: Record<string, (size: number) => ReactNode> = {
  ArrowRight: (s) => <ArrowRight size={s} />,
  FileText: (s) => <FileText size={s} />,
  RefreshCw: (s) => <RefreshCw size={s} />,
  Languages: (s) => <Languages size={s} />,
  Expand: (s) => <Expand size={s} />,
  Shrink: (s) => <Shrink size={s} />,
  Sparkles: (s) => <Sparkles size={s} />,
  Wand2: (s) => <Wand2 size={s} />,
};

export const PROMPT_ICON_NAMES = Object.keys(PROMPT_ICON_MAP);

export function renderPromptIcon(name: string | null | undefined, size: number): ReactNode {
  if (name && PROMPT_ICON_MAP[name]) return PROMPT_ICON_MAP[name](size);
  return <Wand2 size={size} />; // 用户自定义没填图标时的默认占位
}
