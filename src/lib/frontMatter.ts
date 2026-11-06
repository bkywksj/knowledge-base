/**
 * YAML front-matter 的识别与拼装（纯函数，编辑器节点和单测共用）。
 *
 * 为什么不能只看「首行 --- 且后面还有一行 ---」：文档以分割线开头、后面又有一条分割线
 * 是合法的普通 Markdown，误判就会把正文收进属性块。所以这里要求块内容**看起来确实是
 * YAML**：首行必须是 `key:`，其余顶层行只能是 `key:` / 缩进续行 / `- ` 列表 / `#` 注释。
 *
 * 判定规则与 Rust 侧 services/markdown.rs 的 strip_front_matter 保持一致，改一边记得改另一边。
 */

const KEY_LINE = /^[^\s#:-][^:]*:(\s|$)/;

function isYamlBodyLine(line: string): boolean {
  return (
    !line.trim() ||
    /^\s/.test(line) ||
    line.startsWith("#") ||
    line.startsWith("- ") ||
    KEY_LINE.test(line)
  );
}

export interface FrontMatterMatch {
  /** 完整原文（含首尾分隔行，换行统一为 \n），保存时按此原样写回 */
  raw: string;
  /** 占用的行数 */
  lineCount: number;
}

/** 文本开头是 front-matter 则返回该块，否则返回 null */
export function matchFrontMatter(text: string): FrontMatterMatch | null {
  const lines = text.split(/\r?\n/);
  if (lines[0].trimEnd() !== "---") return null;
  // 首行空白或不是 key：多半是「分割线 + 正文」，不是元数据
  if (!KEY_LINE.test(lines[1] ?? "")) return null;

  for (let i = 2; i < lines.length; i++) {
    const trimmed = lines[i].trimEnd();
    if (trimmed === "---" || trimmed === "...") {
      return { raw: lines.slice(0, i + 1).join("\n"), lineCount: i + 1 };
    }
    if (!isYamlBodyLine(lines[i])) return null;
  }
  return null; // 没有闭合行
}

/** 取分隔行之间的 YAML 文本 */
export function frontMatterInner(raw: string): string {
  return raw.split("\n").slice(1, -1).join("\n");
}

/** 用户编辑后的 YAML 拼回完整块；内容不合法（重新解析不出同一个块）时返回 null */
export function buildFrontMatter(inner: string): string | null {
  const raw = `---\n${inner.replace(/\r\n/g, "\n").trimEnd()}\n---`;
  return matchFrontMatter(raw)?.raw === raw ? raw : null;
}

export interface FrontMatterEntry {
  key: string;
  value: string;
}

/** 去掉成对的 YAML 引号，只影响显示 */
function unquote(value: string): string {
  const match = /^(["'])(.*)\1$/.exec(value);
  return match ? match[2] : value;
}

/**
 * 拆成键值行用于显示（不是完整的 YAML 解析，原文始终以 raw 为准）。
 * 列表显示成 `a, b`；嵌套等其它结构不硬拆，保留 YAML 原文。
 */
export function frontMatterEntries(raw: string): FrontMatterEntry[] {
  const groups: { key: string; inline: string; children: string[] }[] = [];
  for (const line of frontMatterInner(raw).split("\n")) {
    if (KEY_LINE.test(line)) {
      const colon = line.indexOf(":");
      groups.push({
        key: unquote(line.slice(0, colon).trim()),
        inline: line.slice(colon + 1).trim(),
        children: [],
      });
    } else if (line.trim() && !line.startsWith("#")) {
      groups[groups.length - 1]?.children.push(line);
    }
  }

  return groups.map(({ key, inline, children }) => {
    if (children.length > 0) {
      const items = children.map((line) => /^\s*- (.*)$/.exec(line)?.[1]);
      const isSimpleList =
        !inline && items.every((item) => item !== undefined && !KEY_LINE.test(item));
      return {
        key,
        value: isSimpleList
          ? items.map((item) => unquote((item as string).trim())).join(", ")
          : [inline, ...children].filter(Boolean).join("\n"),
      };
    }
    const flowList = /^\[(.*)\]$/.exec(inline);
    return {
      key,
      value: flowList
        ? flowList[1].split(",").map((item) => unquote(item.trim())).join(", ")
        : unquote(inline),
    };
  });
}
