/**
 * 批量导入的「右下角悬浮进度条」接入层。
 *
 * 它取代的是各导入流程里那句 `message.loading("正在导入 N 个文件...", 0)`。
 * 换掉的三个理由：
 *   1. antd message 顶部居中，**挡正文**，一挂几分钟；
 *   2. 只有"正在导入 30 个"，**不知道到第几个了**，卡住和没卡住看不出区别；
 *   3. 状态在组件里，**切页面就没了** —— 而导 30 个 PDF 恰恰是最该去干别的的时候。
 */
import { listen } from "@tauri-apps/api/event";

import { useAppStore } from "@/store";
import type { ImportProgress } from "@/types";

/** 后端逐文件进度事件名。两条通路各用各的，避免两个导入同时跑时数字互相打架 */
export type ImportProgressEvent = "import:progress" | "pdf:import-progress";

export interface ImportJobHandle {
  /** 报告进度。`current` 是"正在处理第几个"（1 起） */
  report(current: number, fileName: string): void;
  /** 正常收尾：悬浮条转显成败摘要，几秒后自动消失 */
  finish(ok: number, failed: number): void;
  /** 异常收尾：直接撤掉悬浮条（错误由调用方的 message.error 呈现） */
  cancel(): void;
}

/**
 * 开一条导入悬浮条，返回的句柄与它取代的 `message.loading` 的 `hide` 同构：
 * **成功路径调 `finish`，失败路径调 `cancel`，两条路都别漏**。
 *
 * 漏掉收尾的表现是悬浮条永远停在 "3/30" —— 比压根没有进度条更让人犯嘀咕，
 * 所以每个 try 的 catch 分支都要有 `cancel()`，就像原来每个 catch 都有 `hide()`。
 *
 * 这个同步版给「循环在前端」的导入用（Word：mammoth 是 JS 库，直接把
 * `job.report` 传给 `importWordFiles` 即可）。循环在 Rust 侧的用
 * {@link beginTrackedImportJob}。
 */
export function beginImportJob(kind: string, total: number): ImportJobHandle {
  const id = useAppStore.getState().startImportJob(kind, total);
  return {
    report: (current, fileName) =>
      useAppStore.getState().updateImportJob(id, { current, fileName }),
    finish: (ok, failed) =>
      useAppStore.getState().finishImportJob(id, { ok, failed }),
    cancel: () => useAppStore.getState().dismissImportJob(id),
  };
}

/**
 * 同上，外加把后端的逐文件进度事件接到这条悬浮条上，用于循环在 Rust 侧的导入
 * （Markdown 走 `import:progress`，PDF 走 `pdf:import-progress`）。
 *
 * 监听在 `finish` / `cancel` 时**自动注销** —— 收尾本来就是两条路都必须做的事，
 * 挂在它上面就不必再额外记一个 `finally { unlisten() }`。全局常驻监听不行：
 * 多个导入入口各自监听同一事件，谁都会收到别人的数字。
 */
export async function beginTrackedImportJob(
  kind: string,
  total: number,
  event: ImportProgressEvent,
): Promise<ImportJobHandle> {
  const job = beginImportJob(kind, total);
  const unlisten = await listen<ImportProgress>(event, (e) => {
    job.report(e.payload.current, e.payload.file_name);
  });
  return {
    report: job.report,
    finish: (ok, failed) => {
      unlisten();
      job.finish(ok, failed);
    },
    cancel: () => {
      unlisten();
      job.cancel();
    },
  };
}
