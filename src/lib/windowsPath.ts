/**
 * 粘贴 Windows 路径时的「反斜杠保卫战」。
 *
 * 编辑器开了 tiptap-markdown 的 `transformPastedText`，粘贴的纯文本会先被当 Markdown 解析。
 * 而 Markdown 里 `\` + ASCII 标点是**转义序列**，解析完反斜杠就没了：
 *
 *   D:\111\.vscode                       → D:\111.vscode
 *   C:\Users\yecha\.claude\settings.json → C:\Users\yecha.claude\settings.json
 *   D:\proj\_private\a.txt               → D:\proj_private\a.txt
 *   \\NAS\share\.git                     → \NAS\share.git   （UNC 双反斜杠也塌成一个）
 *
 * 反斜杠后面跟字母/数字（`\Users` / `\111`）则毫发无伤 —— 所以这个坑时灵时不灵，
 * 用户很难意识到是编辑器改的，只会觉得"路径怎么复制错了"。
 *
 * 存盘方向没有这个问题：prosemirror-markdown 序列化时会把 `\` 转义成 `\\`，往返安全。
 * 纯粹是粘贴入口把「不是 Markdown 的东西」按 Markdown 解析导致的，所以在
 * `handlePaste` 里认出路径、走字面插入即可绕开。
 */

/**
 * 单行 Windows 路径：盘符起头（`D:\` / `C:/`）或 UNC 起头（`\\host`），且整行无空白。
 *
 * 故意不接受含空格的路径（如 `C:\Program Files\.vscode`）：那样就无法和
 * 「句子里顺带提到一个路径」区分开，会抢走正常的 Markdown 粘贴。判定从严，
 * 宁可漏判走默认逻辑，也不要误伤。
 */
const WINDOWS_PATH_LINE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/\s])\S*$/;

/**
 * 判断一段纯文本是不是**整段**都由 Windows 本地/UNC 路径构成（每行一条，允许多行）。
 *
 * 只在含反斜杠时才返回 true —— 纯正斜杠路径（`C:/a/b`）Markdown 本来就不会动它，
 * 没必要绕开解析。
 */
export function isWindowsPathText(text: string): boolean {
  if (!text.includes("\\")) return false;
  const nonEmpty = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return false;
  return nonEmpty.every((l) => WINDOWS_PATH_LINE.test(l.trim()));
}
