/**
 * 粘贴纯文本时的「这段像不像代码」启发式判定。
 *
 * 背景：编辑器开了 tiptap-markdown 的 `transformPastedText`，粘贴的纯文本会先被当
 * Markdown 解析（同 lib/windowsPath.ts 那个坑）。终端日志 / 代码走这条链路会被改写：
 *
 *   *unofficial*        → 斜体，星号消失
 *   \------------/      → ------------/   （`\` + ASCII 标点被当转义序列吃掉）
 *   `|  text      |`    → 连续空格渲染时折叠，ASCII 对齐整个塌掉
 *   https://a.b         → 自动链接化
 *
 * 判为代码的内容由 handlePaste 直接包成代码块，绕开整条 Markdown 解析链路。
 *
 * 目标是**高精确率**：宁可漏判（当普通文本走默认粘贴），也不要把用户想要的 Markdown
 * 正文误判成代码块。判定顺序：
 *  1. 必须多行——单行一律不处理。
 *  2. 终端特征（ASCII 框图 / shell 提示符）→ 直接判是。这一步要**先于** markdown 排除：
 *     终端横幅整块以 `|` 起头，旧版被"行首 `|` = markdown 表格"规则拦下，日志因此
 *     被解析坏（vaultwarden 启动横幅粘进来星号和反斜杠全没了）。
 *  3. 强代码信号（缩进结构 / 代码 token 行占比高）→ 直接判是。同样要先于 markdown
 *     排除：C 注释横幅 ` * xxx` 会被 CommonMark 误当无序列表项。
 *  4. borderline：整体更像 markdown 文档（大量 #/>/表格/有序列表/围栏行）→ 判否，
 *     尊重 markdown 粘贴；否则按较弱的缩进/token 信号收尾判定。
 */

/**
 * 真·Markdown 表格分隔行：`|---|---|`、`| :-- | --: |`。
 * 关键是**有内部分隔**（≥2 列）——单列的 `|--------|` 在 Markdown 里本就不成表格，
 * 那是 ASCII 框线。
 */
const MD_TABLE_DELIM = /^\s{0,3}\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

/**
 * ASCII 框图 / 横幅的边框行：`|--------|`、`+----+----+`、`\--------/`、`/========\`。
 *
 * 与 Markdown 表格分隔行只差在列数，所以先把表格分隔行排掉——否则连着粘两张
 * Markdown 表格会凑够 2 条"边框"被当成框图。
 */
function isAsciiBorderLine(line: string): boolean {
  const s = line.trim();
  if (s.length < 6) return false;
  if (MD_TABLE_DELIM.test(s)) return false;
  return (
    /^[|+\\/]/.test(s) && // 以框角字符起
    /[|+\\/]$/.test(s) && // 以框角字符止
    /[-=_~*]{4,}/.test(s) && // 中间有一段够长的横线
    /^[-=_~*+|\\/\s]+$/.test(s) // 整行只由框线字符组成
  );
}

/**
 * Shell 提示符行：
 *   `[user@host ~]$ cmd`    bash 默认（用户实际踩坑的 NAS 终端）
 *   `user@host:~/dir$ cmd`  Ubuntu 默认
 *   `PS C:\Users\x> cmd`    PowerShell
 *   `C:\Users\x> cmd`       cmd.exe
 *   `$ cmd` / `>>> expr`    文档里的裸提示符 / Python REPL
 *
 * 故意**不**收裸 `# cmd`（root 提示符）——与 Markdown 一级标题无法区分，收了会把
 * 整篇文档的标题行当成终端输出。带 `[...]` / `user@host` 前缀的 `#` 无此歧义，照收。
 */
const SHELL_PROMPT =
  /^\s{0,3}(?:\[[^\]\n]{1,80}\]\s*[$#%]|[\w.-]+@[\w.-]+(?::\S*)?\s*[$#%]|PS\s+[A-Za-z]:\\|[A-Za-z]:\\[^\n]*>|\$\s|>>>\s)/;

/** 行首 `|` 的内容行（框图的竖边） */
const PIPE_LINE = /^\s{0,3}\|/;

export function looksLikeCode(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (lines.length < 2 || nonEmpty.length < 2) return false;

  // ── 1. 终端特征 ───────────────────────────────────────────────────────
  // 整段含 markdown 代码围栏 = 用户粘的本来就是 markdown 文档（里面出现命令行示例很
  // 正常），尊重原格式，不走终端分支
  const hasFence = nonEmpty.some((l) => /^\s*```/.test(l));
  if (!hasFence) {
    const borderLines = nonEmpty.filter(isAsciiBorderLine).length;
    const pipeLines = nonEmpty.filter((l) => PIPE_LINE.test(l)).length;
    // ASCII 框图 / 横幅：上下框线 + 中间竖线内容（程序启动横幅、mysql/docker 表格输出…）
    if (borderLines >= 2 && pipeLines >= 2) return true;

    // 终端会话：多条 shell 提示符。边框行一并计入占比——`docker logs` 这类
    // 「几条命令 + 一段框线输出」才不会因为输出太长把提示符比例稀释掉
    const promptLines = nonEmpty.filter((l) => SHELL_PROMPT.test(l)).length;
    if (
      promptLines >= 2 &&
      (promptLines + borderLines) / nonEmpty.length >= 0.2
    ) {
      return true;
    }
  }

  // ── 2. 强代码信号 ─────────────────────────────────────────────────────
  // 缩进行：制表符 或 ≥2 空格 起头且有实际内容
  const indented = nonEmpty.filter((l) => /^(\t| {2,})\S/.test(l)).length;
  // 代码符号：行尾分号 / 花括号、C 注释 /* */ //
  const codeSymbol = /[;{}]\s*$|[{}]|\/\*|\*\/|\/\//;
  // 代码关键字 / 运算符
  const codeKeyword =
    /=>|->|::|==|!=|>=|<=|&&|\|\||#include|#define|\bfunction\b|\breturn\b|\bdef\s|\bclass\s|\bconst\s|\blet\s|\bvar\s|\bimport\s|\bpublic\b|\bprivate\b|\bvoid\b|\bif\s*\(|\bfor\s*\(|\bwhile\s*\(|\bswitch\s*\(/;
  const tokenLines = nonEmpty.filter(
    (l) => codeSymbol.test(l) || codeKeyword.test(l),
  ).length;
  const indentRatio = indented / nonEmpty.length;
  const tokenRatio = tokenLines / nonEmpty.length;

  // 强代码：缩进结构明显 或 代码符号/关键字密集
  if (indentRatio >= 0.4 || tokenRatio >= 0.5) return true;

  // ── 3. markdown 文档特征 ──────────────────────────────────────────────
  // 标题/引用/表格/有序列表/围栏。故意不含无序列表 `* ` —— 会与 C 注释横幅 ` * `
  // 混淆；真无序列表本就缺代码信号，会在下面自然判否。
  //
  // 🔴 `|` 只认**真表格**：分隔行 `|---|---|`，或一行里有 ≥2 个内部分隔（`| a | b |`
  // 至少 3 根竖线）。旧版一律把行首 `|` 当表格行，终端框图 `| text   |` 只有两根竖线
  // 却被算成 markdown，整段日志因此被放去走 Markdown 解析——就是本次的 bug 根因。
  const isMdTableLine = (l: string) =>
    MD_TABLE_DELIM.test(l) ||
    (PIPE_LINE.test(l) && (l.match(/\|/g) ?? []).length >= 3);
  const mdDoc = nonEmpty.filter(
    (l) =>
      /^\s{0,3}(#{1,6}\s|>\s|\d+\.\s)/.test(l) ||
      /^\s*```/.test(l) ||
      isMdTableLine(l),
  ).length;
  if (mdDoc / nonEmpty.length >= 0.3) return false;

  return (
    indentRatio >= 0.25 ||
    tokenRatio >= 0.35 ||
    (indented >= 2 && tokenLines >= 2)
  );
}
