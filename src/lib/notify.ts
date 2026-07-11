import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

/**
 * 发送系统通知（跨桌面/移动）——用于"发完切走"的场景，让用户在别的 App 里也能看到结果。
 *
 * 设计：
 * - 首次调用会 `requestPermission()`（Android 13+ / iOS 需运行时授权）；用户拒绝则静默跳过。
 * - **永不抛错**：通知只是锦上添花，失败绝不能影响调用方主流程（如同步完成）。调用方无需 try-catch。
 * - 权限查询结果不缓存：交给系统层，避免与用户在系统设置里改权限不同步。
 *
 * 用法：
 * ```ts
 * await notifySystem("同步完成", "上传 3 · 下载 5");
 * ```
 */
export async function notifySystem(title: string, body: string): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      const perm = await requestPermission();
      granted = perm === "granted";
    }
    if (granted) {
      sendNotification({ title, body });
    }
  } catch (e) {
    // 通知能力缺失 / 被拒 / 平台不支持 —— 静默降级，不打断调用方
    console.warn("[notify] system notification failed:", e);
  }
}
