/**
 * 首页「随手记」的文本处理（纯函数，有单测）。
 */

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 随手记存成新笔记：第一行作标题（过长截断，截断时正文保留全文），其余每行一段 */
export function quickTextToNote(text: string): { title: string; content: string } {
  const lines = text.trim().split("\n");
  const first = lines[0].trim();
  const title = first.length > 60 ? `${first.slice(0, 60)}…` : first || "随手记";
  const bodyLines = first.length > 60 ? lines : lines.slice(1);
  const content = bodyLines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `<p>${escapeHtml(l)}</p>`)
    .join("");
  return { title, content };
}

/** 剪贴板里的图片文件（截图、复制的图片）；没有返回空数组 */
export function imageFilesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

/** 已存好的图片（相对 data_dir 的路径）拼成正文片段：每张一段，src 用 kb-asset:// 虚拟地址 */
export function quickImagesHtml(relPaths: string[]): string {
  return relPaths
    .map((rel) => `<p><img src="kb-asset://${escapeHtml(rel.replace(/^\/+/, "")).replace(/"/g, "&quot;")}"></p>`)
    .join("");
}

/** File → base64（不带 data: 前缀），imageApi.save 要这个格式 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
