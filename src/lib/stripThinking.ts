/**
 * 剥离推理模型混在「正文通道」里的思考过程。
 *
 * 背景：deepseek-r1 / qwq / qwen3 这类推理模型，只有一部分服务端会把思考放进
 * 独立的 `reasoning_content` 字段（后端 ai.rs 的聊天路径已按该字段单独发
 * `ai:reasoning` 事件）；本地 Ollama / LM Studio / 多数中转是直接把
 * `<think>…</think>` 塞在 `delta.content` 里的。笔记编辑器的 AI 写作辅助会把
 * 结果整段替换进正文，思考过程混进去等于污染笔记，必须在插入前摘出来。
 *
 * 为什么放前端而不是 Rust 侧：`AiWriteMenu` 手里的 `result` 是**累积后的完整
 * 字符串**，标签被 SSE 分片切成两半（"<thi" + "nk>"）的问题天然消失，不需要
 * 在流式循环里写跨 chunk 状态机。
 */

/** 常见的思考标签名（不同厂商/模板写法不一，统一收在这里） */
const TAG_NAMES = "think|thinking|reasoning|thought";

/** 成对出现的完整思考块：<think>…</think>（闭合标签允许和开标签错配，反正都要丢） */
const PAIRED_RE = new RegExp(
  `<\\s*(?:${TAG_NAMES})\\s*>([\\s\\S]*?)<\\s*/\\s*(?:${TAG_NAMES})\\s*>`,
  "gi",
);

/**
 * 孤立的闭合标签：只有 `</think>` 没有开标签。
 *
 * 真实存在的场景——R1 官方推荐的对话模板会在 assistant 回复里**预填** `<think>`，
 * 该 token 不走流式返回，用户侧只能看到思考正文 + 一个闭合标签。此时闭合标签
 * 之前的全部内容都是思考。
 */
const ORPHAN_CLOSE_RE = new RegExp(
  `^([\\s\\S]*?)<\\s*/\\s*(?:${TAG_NAMES})\\s*>`,
  "i",
);

/** 未闭合的开标签：流式还在思考阶段，`</think>` 尚未到达 */
const UNCLOSED_OPEN_RE = new RegExp(
  `<\\s*(?:${TAG_NAMES})\\s*>([\\s\\S]*)$`,
  "i",
);

/**
 * 结尾处「可能是标签正在到达」的半截片段，如 `<`、`</`、`<thi`。
 *
 * 流式逐 token 累积时，标签自己也是一个字符一个字符到的，不挂起就会在正文区
 * 闪一下 `<` → `<t` → `<th`。只在流式中挂起（非流式说明输出已完结，此时的
 * `<` 就是正文里真实存在的尖括号，不能吞）。
 */
const PARTIAL_TAIL_RE = /<\s*\/?\s*([a-zA-Z]*)$/;
const TAG_LIST = TAG_NAMES.split("|");

export interface ThinkingSplit {
  /** 去掉思考块后的正文——这才是可以替换/追加进笔记的内容 */
  content: string;
  /** 摘出来的思考过程（多段以空行连接），供 UI 折叠展示 */
  thinking: string;
  /** 是否正处于「思考中」（有开标签还没等到闭合），仅流式过程中为 true */
  thinkingOpen: boolean;
}

/**
 * 把 AI 原始输出拆成「正文」和「思考过程」两部分。
 *
 * 处理顺序有意为之：
 *   1. 先摘成对的完整块（最常见）
 *   2. 再摘孤立闭合标签之前的内容（开标签被模板吃掉的情况）
 *   3. 最后摘未闭合开标签之后的内容（流式进行中）
 *
 * 没有任何思考标签时原样返回（仅 trim），不会误伤正文里的普通尖括号。
 *
 * @param opts.streaming 输出仍在流式进行中。为 true 时额外挂起结尾的半截标签，
 *   避免正文区闪出 `<`/`<th` 这类碎片；输出完结后必须传 false（默认），否则
 *   正文里真实以 `<` 结尾的内容会被吞掉。
 */
export function splitThinking(
  raw: string,
  opts: { streaming?: boolean } = {},
): ThinkingSplit {
  if (!raw) {
    return { content: "", thinking: "", thinkingOpen: false };
  }

  const chunks: string[] = [];

  // 1. 成对块
  PAIRED_RE.lastIndex = 0;
  let rest = raw.replace(PAIRED_RE, (_m, inner: string) => {
    if (inner.trim()) chunks.push(inner.trim());
    return "";
  });

  // 2. 孤立闭合标签（走到这里说明它没有配对的开标签）
  const orphan = rest.match(ORPHAN_CLOSE_RE);
  if (orphan) {
    if (orphan[1].trim()) chunks.push(orphan[1].trim());
    rest = rest.slice(orphan[0].length);
  }

  // 3. 未闭合开标签 —— 之后的内容都还在思考中
  let thinkingOpen = false;
  const unclosed = rest.match(UNCLOSED_OPEN_RE);
  if (unclosed) {
    if (unclosed[1].trim()) chunks.push(unclosed[1].trim());
    rest = rest.slice(0, unclosed.index);
    thinkingOpen = true;
  }

  // 4. 流式中：挂起结尾正在到达的半截标签
  if (opts.streaming) {
    const partial = rest.match(PARTIAL_TAIL_RE);
    if (partial) {
      const letters = partial[1].toLowerCase();
      // letters 为空（只到了个 `<`）时 startsWith("") 恒真，同样挂起
      if (TAG_LIST.some((t) => t.startsWith(letters))) {
        rest = rest.slice(0, partial.index);
      }
    }
  }

  return {
    content: rest.trim(),
    thinking: chunks.join("\n\n").trim(),
    thinkingOpen,
  };
}
