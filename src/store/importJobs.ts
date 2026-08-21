/**
 * 批量导入悬浮条的状态与纯变换。
 *
 * 单独成文件（而不是塞进 store/index.ts）是为了能测：index.ts 里挂着一串
 * `useAppStore.subscribe`，任何一次 `set` 都会去摸 `document`，而本仓库的
 * vitest 刻意跑在 `environment: "node"` 下。把真正有逻辑的部分抽成纯函数，
 * store 里只剩一行 `set(reducer(...))` 的接线。
 */

/**
 * 一次批量导入的实时状态。
 *
 * 之所以放全局 store 而不是各页面 useState：导 30 个 PDF 要跑好几分钟，
 * 用户不可能干等在导入那一页。状态在页面里 = 一切页就丢，回来看不到还剩几个。
 */
export interface ImportJob {
  /** 唯一 id。并发多批导入时靠它互不覆盖（PDF 那条还会追加一轮 OCR 重试） */
  id: string;
  /** 显示用类别名："Markdown / 文本" / "PDF" / "Word" / "OCR 识别" */
  kind: string;
  /** 总文件数 */
  total: number;
  /** 正在处理第几个（1 起；0 = 已登记但还没收到第一条进度） */
  current: number;
  /** 正在处理的文件名（不含目录，太长会截断显示） */
  fileName: string;
  /** 有值即表示已结束；悬浮条转为显示成败摘要并准备自动消失 */
  result?: { ok: number; failed: number };
}

/** 导入结束后悬浮条继续停留的毫秒数 —— 够看清"成功 22 / 失败 8"，又不至于赖着不走 */
export const IMPORT_JOB_LINGER_MS = 4000;

/** 生成一个新任务的初始状态 */
export function newImportJob(id: string, kind: string, total: number): ImportJob {
  return { id, kind, total, current: 0, fileName: "" };
}

/**
 * 推进某条任务的进度。
 *
 * 找不到 id 时原样返回 —— 用户点 x 关掉提示后，后台导入仍在跑、仍在发进度事件，
 * 这里若"顺手补一条"就会让关掉的悬浮条自己冒回来。
 */
export function patchImportJob(
  jobs: ImportJob[],
  id: string,
  patch: Partial<Pick<ImportJob, "current" | "total" | "fileName">>,
): ImportJob[] {
  return jobs.map((j) => (j.id === id ? { ...j, ...patch } : j));
}

/**
 * 给某条任务收尾：写入成败摘要，并把 current 补到 total。
 *
 * 补 current 是因为后端的进度 emit 是尽力而为的（`let _ = emitter.emit(...)`），
 * 掉一条事件就会出现"进度条停在 28/30、文字却写着导入完成"的别扭状态。
 */
export function finishImportJobIn(
  jobs: ImportJob[],
  id: string,
  result: { ok: number; failed: number },
): ImportJob[] {
  return jobs.map((j) => (j.id === id ? { ...j, current: j.total, result } : j));
}

/** 移除某条任务（异常收尾 / 用户手动关闭 / 停留计时到点） */
export function removeImportJob(jobs: ImportJob[], id: string): ImportJob[] {
  return jobs.filter((j) => j.id !== id);
}
