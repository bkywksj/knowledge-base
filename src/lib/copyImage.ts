import { writeImage } from "@tauri-apps/plugin-clipboard-manager";

/**
 * 把图片字节转成 PNG Blob。
 *
 * `createImageBitmap` 的 source 是 Blob（同源数据），canvas 不会被污染，
 * 所以 toBlob 不会抛 SecurityError。ClipboardItem 在 Chromium 上只稳定支持
 * image/png，统一转 PNG 最保险。
 */
export async function toPngBlob(bytes: Uint8Array): Promise<Blob> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D 上下文不可用");
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob 返回 null"))),
        "image/png",
      );
    });
  } finally {
    bitmap.close();
  }
}

/**
 * 把图片字节写进系统剪贴板。
 *
 * 先走 clipboard-manager 插件（Rust 侧写，不受 WebView「用户手势 5 秒过期」限制）；
 * 插件不可用（移动端 write_image 返回 Unsupported）再回退 Web Clipboard API。
 */
export async function copyImageBytes(bytes: Uint8Array): Promise<void> {
  const pngBlob = await toPngBlob(bytes);
  try {
    await writeImage(new Uint8Array(await pngBlob.arrayBuffer()));
  } catch {
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": pngBlob }),
    ]);
  }
}

/**
 * 按渲染地址复制图片：asset 协议地址（http://asset.localhost/…）、blob:、data: 都能 fetch。
 *
 * 不能拿 `<img>` 直接 drawImage：asset 地址与主窗口不同源，canvas 会被污染，toBlob 抛错。
 */
export async function copyImageFromUrl(url: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error("图片数据为空");
  await copyImageBytes(bytes);
}
