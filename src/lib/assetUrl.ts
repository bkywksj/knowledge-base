import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * 笔记 content 里素材的虚拟 scheme：
 *   `kb-asset://kb_assets/images/<note_id>/<file>.png`
 *   `kb-asset://pdfs/<note_id>/<file>.pdf`
 *   `kb-asset://kb_assets/videos/<note_id>/<file>.mp4`
 *   `kb-asset://kb_assets/attachments/<note_id>/<file>`
 *
 * `://` 后是相对当前 instance 数据目录的 POSIX 路径。
 *
 * 设计动机：数据目录可被用户在运行期更换（环境变量 / 设置页），如果笔记里硬编码绝对路径，
 * 迁移之后所有图片都会断。本 scheme 让 content 与具体 OS 路径解耦，
 * 渲染层运行时才 join data_dir 解析。
 */
export const KB_ASSET_SCHEME = "kb-asset://";

/** 把后端返回的相对路径拼成 `kb-asset://` URL，写入 Tiptap 节点 attrs.src */
export function toKbAsset(rel: string): string {
  // 防御：兼容意外传入了已带 scheme 的字符串
  if (rel.startsWith(KB_ASSET_SCHEME)) return rel;
  // 后端返回的是 POSIX，去掉可能的前导 / 防止双斜杠
  const clean = rel.replace(/^\/+/, "");
  return `${KB_ASSET_SCHEME}${clean}`;
}

/**
 * 附件**链接（link mark）**专用：拼一个已 percent-encode 的 `kb-asset://` URL，用作 markdown 链接 href。
 *
 * 为什么不能直接复用 `toKbAsset`：
 *   图片/视频是**节点**（attrs.src），markdown 序列化由各自的自定义 serializer（如 FigureExtension）
 *   负责编码；而附件是普通 **link mark**，序列化走 prosemirror-markdown 的 `state.esc()` —— 它只反斜杠
 *   转义 markdown 符号，**不 percent-encode、也不转义空格**。于是文件名含空格（如 `HDPE VD钙奶富邦`）时，
 *   序列化出的 `[..](kb-asset://.../HDPE VD..dwg)` 因 URL 含**裸空格**不符合 CommonMark 链接目标规范，
 *   重新打开/同步拉回时链接解析失败降级成纯文本；同时 Rust `attachment_scan` 的正则遇空白截断，
 *   导致该附件永远漏同步。
 *
 * 解法：在拼 href 时就逐段 percent-encode（空格→`%20`、圆括号→`%28/%29`、中文→`%E4..`，保留 `/`），
 * 落盘后是合法 URL。渲染/点击端 `parseKbAsset` 已做 `decodeURIComponent` 还原，Rust `extract_local_refs`
 * 也已 `url_decode` —— 与图片/视频既有的「序列化编码、消费端解码」约定完全一致。
 */
export function toKbAssetHref(rel: string): string {
  if (rel.startsWith(KB_ASSET_SCHEME)) return rel;
  const clean = rel.replace(/^\/+/, "");
  const encoded = clean
    .split("/")
    // encodeURIComponent 不编码 ()，但它们同样会破坏 markdown 链接目标 → 手动补编码
    .map((seg) =>
      encodeURIComponent(seg).replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29")),
    )
    .join("/");
  return `${KB_ASSET_SCHEME}${encoded}`;
}

/**
 * 解析 `kb-asset://...` 提取相对路径；非 kb-asset 协议返回 null。
 *
 * 必须 decodeURIComponent：tiptap-markdown 序列化时会把 `![](kb-asset://中文.png)` 编码成
 * `![](kb-asset://%E4%B8%AD%E6%96%87.png)` 写入 .md，重新加载后 attrs.src 是编码态。
 * 我们的 rel 表示磁盘上的字面 POSIX 路径（safe_filename 已经过滤了不安全字符），
 * 必须解码后再交给下游（resolveAssetSrc / 后端 resolve_asset_absolute / get_image_blob），
 * 否则会按字面值 `%E4...` 在磁盘里找文件 → 找不到。
 *
 * 解码失败（比如 rel 里有孤立的 `%`，理论上不应出现）→ 退回原值，避免崩溃。
 */
export function parseKbAsset(src: string | null | undefined): string | null {
  if (!src || !src.startsWith(KB_ASSET_SCHEME)) return null;
  const rel = src.slice(KB_ASSET_SCHEME.length);
  try {
    return decodeURIComponent(rel);
  } catch {
    return rel;
  }
}

/** 是否加密素材（按 .enc 后缀判定，兼容 image.rs 的 ENC_SUFFIX 约定） */
export function isEncryptedAsset(rel: string): boolean {
  return rel.endsWith(".enc");
}

/**
 * 把 `kb-asset://<rel>` 解析为可直接喂 `<img>/<video>/<iframe>` 的 URL。
 *
 * - 明文资产 → 拼 data_dir + rel → `convertFileSrc(abs)` → asset 协议 URL
 * - 加密资产（`.enc` 后缀）→ 返回 null（调用方需走 `imageApi.getBlob` + Blob URL）
 * - 非 kb-asset 协议（http/https/data:/blob:）→ 原样返回
 *
 * `dataDir` 必须传入：调用方一般从 `useAppStore.getState().instanceInfo?.dataDir` 取。
 * 拿不到 dataDir 时返回原 src，让浏览器自己降级处理（多半是裂图，提示意义大于显示）。
 */
export function resolveAssetSrc(src: string, dataDir: string | null | undefined): string {
  const rel = parseKbAsset(src);
  if (!rel) return src; // 不是 kb-asset：原样返回（外链 / data: / blob: / 旧绝对 URL）
  if (isEncryptedAsset(rel)) return src; // 加密走 Blob 通道，保留原 src 让 observer 拦截
  if (!dataDir) return src;
  // 拼绝对路径再交给 convertFileSrc。Windows 下 dataDir 是反斜杠，这里手动用 / 拼接，
  // convertFileSrc 内部会做平台无关的 URL 编码。
  const abs = joinPosix(dataDir, rel);
  return convertFileSrc(abs);
}

/** OS 无关的路径拼接：保持 dataDir 原样（可能含 \），rel 永远 / */
function joinPosix(dataDir: string, rel: string): string {
  const cleanRel = rel.replace(/^\/+/, "");
  // Windows 风格 dataDir 直接 + / 也能被 convertFileSrc 识别
  if (dataDir.endsWith("/") || dataDir.endsWith("\\")) {
    return `${dataDir}${cleanRel}`;
  }
  return `${dataDir}/${cleanRel}`;
}
