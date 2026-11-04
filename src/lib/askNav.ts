/**
 * AI 会话「提问导航」的纯逻辑（组件见 components/ai/AskNav.tsx）。
 * 抽出来是为了能单测：哪条提问算「当前」、上下跳到哪条、列表里显示什么文字。
 */

/** 附件提问的开头（后端 services/ai.rs build_message_with_attachments 拼的） */
const ATTACHMENT_PREFIX = "📎 用户附带了";
/** 附件区与真正问题之间的分隔（同上，问题在最后一个分隔之后） */
const ATTACHMENT_SEP = "\n---\n\n";

/**
 * 提问在导航列表里显示的文字：首个非空行。
 * 带附件的提问前面是几万字的附件内容，只取真正的问题并加 📎 标识。
 */
export function askLabel(content: string): string {
  let text = content;
  let prefix = "";
  if (content.startsWith(ATTACHMENT_PREFIX)) {
    const at = content.lastIndexOf(ATTACHMENT_SEP);
    text = at >= 0 ? content.slice(at + ATTACHMENT_SEP.length) : "";
    prefix = "📎 ";
  }
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return prefix + (line ?? (prefix ? "附件提问" : "（空）"));
}

/**
 * 当前所在的提问：顶边已经越过「锚线」的最后一条。
 *
 * @param tops 各提问相对滚动区可视顶部的位置（按出现顺序，单位 px，可为负 = 已滚出上方）
 * @param anchor 锚线位置（可视区内，通常取可视高度的 1/3）
 * @returns 下标；一条都没越过时取第 0 条；没有提问返回 -1
 */
export function activeAskIndex(tops: number[], anchor: number): number {
  if (tops.length === 0) return -1;
  let idx = 0;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] <= anchor) idx = i;
    else break;
  }
  return idx;
}

/** 上一条 / 下一条（到头不循环，停在两端） */
export function stepAsk(active: number, total: number, dir: -1 | 1): number {
  if (total <= 0) return -1;
  const cur = active < 0 ? 0 : active;
  return Math.min(total - 1, Math.max(0, cur + dir));
}
