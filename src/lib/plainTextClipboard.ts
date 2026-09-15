import type { Fragment, Node as PMNode } from "@tiptap/pm/model";

/**
 * 编辑器「复制为纯文本」(text/plain 通道) 的拼接规则。
 *
 * 背景：原实现直接用 ProseMirror 的
 *   `fragment.textBetween(0, size, "\n\n", leafText)`
 * 一律以 `\n\n` 分隔**所有**块级节点。实测输出（prosemirror-model 真实行为）：
 *
 *   3 项有序列表           → "alpha\n\nbravo\n\ncharlie"  每项之间夹 1 个空行
 *   段落/空段落/空段落/段落 → "一\n\n\n\n\n\n二"            5 个空行
 *
 * 粘到 WPS / 微信 / 记事本就是用户反馈的「空行比较多」。
 *
 * 本模块**不改「抽哪些文字」**——仍旧逐块 textBetween，marks 全部剥离，
 * 不产生任何 Markdown 标记（保持"粘出来是「内容」而非「**内容**」"的既定诉求）。
 * 只改「块与块之间怎么接」，规则全部收敛在 `separatorBetween`：
 *   · 标题之前               → `\n\n`（标题是分节标记，紧贴上文会被读成正文）
 *   · 紧凑组与外部正文之间    → `\n\n`（列表 / 表格整体与正文分开）
 *   · 其余（含连续段落）      → 单 `\n`，跟随编辑器所见
 *   · 连续空块产生的多余空行  → 压到最多一个空行
 *
 * 🔴 连续段落用**单换行**是刻意的（第二轮修复）：编辑器里按 Enter 产生的是新段落，
 * 但 `.tiptap p` 的 margin 只有 0.45em，用户看到的就是"换了一行"。若段落间一律
 * `\n\n`，「我敲了空行」和「我没敲空行」粘出来一模一样 —— 空行信息反而丢了。
 * 现在纯文本里的空行只有两个来源：用户自己敲的空段落，以及标题前的分节。
 */

/** 一个待拼接的块 */
export interface PlainTextBlock {
  /** 该块抽出来的纯文字（可能为空串，表示空段落） */
  text: string;
  /**
   * 是否属于「紧凑块」——列表项、表格单元格这类天然连续的内容。
   * 只用来把「组内」和「组外」区分开：紧凑与非紧凑相邻时空一行，
   * 让列表 / 表格作为一个整体与正文分开。
   */
  tight?: boolean;
  /**
   * 是否是标题块。标题在纯文本里承担分节作用，前面固定空一行，
   * 否则粘出来会和上一段黏成一片、读不出层级。
   */
  heading?: boolean;
}

/**
 * 内容天然连续、其后代不该被空行拆开的容器。
 * 命中后其**所有后代块**都按紧凑处理。
 *
 * 注：taskList 的节点名在 tiptap 里是 bulletList + data-type，
 * 但 TaskList 扩展注册的节点名就是 `taskList`，两种都列上更保险。
 */
const TIGHT_CONTAINERS = new Set([
  "orderedList",
  "bulletList",
  "taskList",
  "table",
]);

/**
 * 判断一个节点是不是「块容器」——子节点仍是块级，需要继续往下走。
 * 段落 / 标题 / 代码块的子节点是 inline，不算容器。
 */
function isBlockContainer(node: PMNode): boolean {
  return (
    node.type.isBlock &&
    node.childCount > 0 &&
    (node.firstChild?.type.isBlock ?? false)
  );
}

/** 标题自动编号的取号器（按文档顺序逐个消费，与选区收集顺序一一对应） */
export interface HeadingLabelCursor {
  next(): string;
}

/** 用一个字符串数组构造取号器；数组用尽后返回空串 */
export function makeHeadingLabelCursor(labels: string[]): HeadingLabelCursor {
  let i = 0;
  return {
    next: () => labels[i++] ?? "",
  };
}

/**
 * 把 Fragment 摊平成待拼接的块序列。
 *
 * @param leafText 叶子节点（图片 / 公式 / hardBreak）的文本表示，与原实现一致
 * @param headings 标题编号取号器；没有编号时传 `makeHeadingLabelCursor([])`
 */
export function fragmentToPlainTextBlocks(
  fragment: Fragment,
  leafText: (node: PMNode) => string,
  headings: HeadingLabelCursor,
): PlainTextBlock[] {
  const out: PlainTextBlock[] = [];

  const walk = (frag: Fragment, tight: boolean) => {
    frag.forEach((node) => {
      const name = node.type.name;
      // 进入紧凑容器：其下所有块都按紧凑接
      const nextTight = tight || TIGHT_CONTAINERS.has(name);

      if (isBlockContainer(node)) {
        walk(node.content, nextTight);
        return;
      }

      // 叶子块（段落 / 标题 / 代码块 …）
      // 块内用单 `\n`：段落内部只有 hardBreak 会产生换行，本来就该是单换行
      const text = node.textBetween(0, node.content.size, "\n", leafText);

      if (name === "heading") {
        // 标题自动编号是 Decoration，不在 doc 里；这里补进 text/plain，
        // 让粘到 Word / 记事本 / 微信时编号跟着走（既有行为，保持不变）
        const label = headings.next();
        out.push({
          text: label ? `${label} ${text}` : text,
          tight: nextTight,
          heading: true,
        });
        return;
      }

      out.push({ text, tight: nextTight });
    });
  };

  walk(fragment, false);
  return out;
}

/**
 * 相邻两块之间该垫什么。默认单换行——「编辑器里换一行，纯文本就换一行」；
 * 只有两种需要视觉分节的位置才空一行。
 */
function separatorBetween(prev: PlainTextBlock, next: PlainTextBlock): string {
  // 标题前空一行。标题的视觉间距靠 CSS margin 撑，doc 里没有空段落承载，
  // 不补这一行的话粘出来就是"上一段末尾直接接标题"
  if (next.heading) return "\n\n";
  // 跨越紧凑组边界（正文 ↔ 列表 / 表格）空一行，保住"这是一组"的分组感；
  // 组内部（两边都 tight）和组外正文之间（两边都不 tight）都走单换行
  if (Boolean(prev.tight) !== Boolean(next.tight)) return "\n\n";
  return "\n";
}

/**
 * 把块序列拼成最终的 text/plain 内容。
 *
 * 空行不由这里凭空造（标题除外）：用户敲的空段落各自是一个空块，
 * 自己会贡献换行，`collapseBlankLines` 再兜底压到最多一个空行。
 */
export function joinPlainTextBlocks(blocks: PlainTextBlock[]): string {
  const parts: string[] = [];
  blocks.forEach((block, i) => {
    if (i > 0) parts.push(separatorBetween(blocks[i - 1], block));
    parts.push(block.text);
  });
  return collapseBlankLines(parts.join(""));
}

/**
 * 把 3 个以上连续换行压成 2 个（= 最多一个空行），并去掉首尾空白。
 *
 * 用户在编辑器里敲的空段落各自序列化成一个空块，连敲几下就摞出几个空行。
 * 纯文本保留「最多一个空行」的语义即可，更多没有信息量。
 */
export function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/** 一步到位：Fragment → text/plain 字符串 */
export function fragmentToPlainText(
  fragment: Fragment,
  leafText: (node: PMNode) => string,
  headingLabels: string[] = [],
): string {
  return joinPlainTextBlocks(
    fragmentToPlainTextBlocks(
      fragment,
      leafText,
      makeHeadingLabelCursor(headingLabels),
    ),
  );
}
