/** 去除 HTML 标签，提取纯文本
 *
 * 用正则替代 DOMParser：DOMParser 对 50KB HTML 需 20-50ms，正则只需 1-5ms。
 * 笔记列表（50+ 条）+ PDF/Word 抽出的大 content 场景下显著优化。
 */
export function stripHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 笔记正文（Markdown / HTML）→ 纯文本预览（卡片 / 时间线 / 标签页摘要）。
 *
 * 为什么不能只用 {@link stripHtml}：笔记 content 以 Markdown 存储，`stripHtml` 只去 HTML 标签，
 * 于是图片语法 `![](kb-asset://…/x.webp)` 会把一长串图片地址原样留在预览里，挤占空间又毫无
 * 信息量（用户反馈：卡片模式全是图片地址）。这里先剥掉 Markdown 语法噪声（图片整段删除、
 * 链接只保留可读文字、wiki 双链取标题、去标题/列表/引用/强调符号），再交给 stripHtml 兜底
 * 处理内联 HTML 并折叠空白。
 *
 * 注意：Markdown 的行首规则（标题/列表/引用）依赖换行，必须在 stripHtml 折叠空白**之前**做。
 */
export function contentToPreview(content: string): string {
  if (!content) return "";
  const cleaned = content
    // 图片：整段删除（alt 多为空或文件名，无观察价值）
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    // 普通链接：保留 [文字]，丢弃 (url)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // wiki 双链 [[标题]] / [[标题|id]] → 标题
    .replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, "$1")
    // 行首标题 / 引用 / 无序列表 / 有序列表 标记
    .replace(/^[ \t]*#{1,6}\s+/gm, "")
    .replace(/^[ \t]*>\s?/gm, "")
    .replace(/^[ \t]*[-*+]\s+/gm, "")
    .replace(/^[ \t]*\d+\.\s+/gm, "")
    // 独占一行的分隔线 --- / *** / ___
    .replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, "")
    // 加粗 / 斜体 / 删除线 / 行内代码 标记符（保留 `_`，避免误伤 snake_case 与文件名）
    .replace(/[*~`]+/g, "");
  return stripHtml(cleaned);
}

/**
 * 从笔记正文（Markdown / HTML）中提取第一张图片的原始 URL，找不到返回 null。
 * 供卡片模式渲染缩略图用。支持 Markdown `![alt](url "title")` 与 HTML `<img src>`。
 */
export function extractFirstImageSrc(content: string): string | null {
  if (!content) return null;
  // Markdown 图片：括号内可能带 "title"，也可能是含空格的旧式绝对 URL，故整体捕获到 ) 再清洗
  const md = content.match(/!\[[^\]]*\]\(([^)]+)\)/);
  if (md?.[1]) {
    const url = md[1]
      .replace(/\s+["'][^"']*["']\s*$/, "") // 去掉尾部可选的 "title" / 'title'
      .trim()
      .replace(/^<|>$/g, ""); // 去掉可选的 <url> 尖括号
    if (url) return url;
  }
  // HTML <img src="...">
  const html = content.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i);
  if (html?.[1]) return html[1];
  return null;
}

/** 本地时区的 YYYY-MM-DD。
 *
 * 🔴 全前端「某天 → 日期串」的唯一真相源。严禁再用
 * `new Date().toISOString().slice(0,10)` —— 那取的是 UTC 日期，与后端
 * （daily 用 `chrono::Local`，统计用 `DATE(updated_at,'localtime')`）口径不一致：
 * 东八区本地 00:00–08:00 会差一天，导致同一个「今天」在不同入口被算成两条日记
 * （日记重复增殖），以及写作热力图/连续天数错位。前端必须对齐到本地。
 */
export function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 本地时区「今天」的 YYYY-MM-DD（见 {@link localYmd} 的口径说明）。 */
export function todayYmd(): string {
  return localYmd(new Date());
}

/** 相对时间格式化 */
export function relativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}天前`;
  return dateStr.slice(0, 10);
}
