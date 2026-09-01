/**
 * 从混杂文本里提取网页 URL。
 *
 * 用户很少只粘一条干净的链接——从浏览器/微信/知乎「分享」出来的内容通常是
 * 「标题 - 站点名 - 作者 https://...」这种一整段。剪藏入口如果只认纯 URL，
 * 用户就得自己把链接抠出来，多一步纯属折腾。
 *
 * 设计取舍：
 * - **只认 http(s) 开头**，不猜裸域名（`example.com` 可能只是正文里提到的一个词，
 *   猜错了会去抓一个用户根本没想抓的站）。
 * - 文本里有多个链接时**取第一个**：分享文本的格式惯例是正文在前、链接在尾，
 *   而多链接的情况通常是「正文链接 + 推广/短链」，第一个才是用户想要的。
 * - 不做 URL 合法性深校验：那是后端 `url_safety::validate_url` 的职责，
 *   这里只负责「从文本里把它捞出来」，捞错了后端会拒。
 */

/**
 * URL 主体的匹配规则。
 *
 * 用 `[^\s<>"'）)】\]]+` 而非贪婪的 `\S+`：中文分享文本常把链接包在全角括号里
 * （`（https://x.com/a）`），或以 `】` 收尾，贪婪匹配会把这些收尾符号一起吃进去，
 * 导致抓取 404。空白、尖括号、引号同理——它们不可能是 URL 的一部分。
 *
 * 注意左括号也在排除列表里：URL 里合法的括号（如维基百科 `Rust_(编程语言)`）
 * 会被截断，但这是有意的取舍——比起放行全角右括号造成的高频 404，
 * 少数带括号的 URL 被截断更容易被用户一眼看出并手动修正。
 */
const URL_PATTERN = /https?:\/\/[^\s<>"'（）()【】\[\]、，。；！？]+/i;

/**
 * 结尾处应当剥离的标点。
 *
 * 即使正则已排除了成对括号，链接后面仍常紧跟句读：
 * `详见 https://x.com/a。` / `链接：https://x.com/a,` —— 这些标点不属于 URL。
 * 逐个从尾部剥，直到剩下合法字符为止。
 */
const TRAILING_PUNCT = /[.,;:!?、，。；：！？~"'`]+$/;

/**
 * 从任意文本中提取第一个 http(s) URL。
 *
 * @param text 用户粘贴的原始文本，可以是纯 URL，也可以是「标题 + 链接」的分享文本
 * @returns 提取到的 URL；文本里没有 http(s) 链接时返回 null
 *
 * @example
 * extractFirstUrl("https://example.com/a")                    // → "https://example.com/a"
 * extractFirstUrl("某作品-站酷（ZCOOL） https://x.com/w/1.html") // → "https://x.com/w/1.html"
 * extractFirstUrl("随便一段没有链接的文字")                      // → null
 */
export function extractFirstUrl(text: string): string | null {
  if (!text) return null;

  const matched = text.match(URL_PATTERN);
  if (!matched) return null;

  const url = matched[0].replace(TRAILING_PUNCT, "");

  // 剥完标点只剩协议头（如文本里孤零零一个 `https://`）→ 视为没找到
  if (/^https?:\/\/$/i.test(url)) return null;

  return url;
}

/**
 * 判断文本里是否含有可剪藏的 URL。
 *
 * 供 UI 做按钮禁用态判断，避免在提交前重复写一遍提取逻辑。
 */
export function hasUrl(text: string): boolean {
  return extractFirstUrl(text) !== null;
}
