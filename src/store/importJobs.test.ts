import { describe, it, expect } from "vitest";
import {
  IMPORT_JOB_LINGER_MS,
  finishImportJobIn,
  newImportJob,
  patchImportJob,
  removeImportJob,
  type ImportJob,
} from "./importJobs";

/**
 * 右下角导入悬浮条的任务状态变换。
 *
 * 这里盯的是三类"只有并发 / 异常时才现形"的问题：
 *   · 两批导入同时跑，进度互相串号（Word 的 3/5 被 PDF 的 12/30 冲掉）
 *   · 用户手动关掉悬浮条后，后台仍在跑的导入把它又"喂"回来
 *   · 掉了进度事件 → 停在 28/30 却写着"导入完成"
 */
describe("导入任务状态变换", () => {
  const word = newImportJob("w1", "Word", 5);
  const pdf = newImportJob("p1", "PDF", 30);

  it("新任务从 0/total 起步，无结果", () => {
    expect(pdf).toEqual({
      id: "p1",
      kind: "PDF",
      total: 30,
      current: 0,
      fileName: "",
    });
    expect(pdf.result).toBeUndefined();
  });

  it("两批并发各自记账，进度不串号", () => {
    // 真实触发路径：设置页点了 Word 导入，切到笔记页又点了 PDF 导入
    let jobs: ImportJob[] = [word, pdf];
    jobs = patchImportJob(jobs, "w1", { current: 3, fileName: "年报.docx" });
    jobs = patchImportJob(jobs, "p1", { current: 12, fileName: "论文.pdf" });

    const byId = Object.fromEntries(jobs.map((j) => [j.id, j]));
    expect(byId.w1.current).toBe(3);
    expect(byId.w1.fileName).toBe("年报.docx");
    expect(byId.p1.current).toBe(12);
    expect(byId.p1.fileName).toBe("论文.pdf");
  });

  it("推进进度不改动别的字段", () => {
    const [only] = patchImportJob([pdf], "p1", { current: 7, fileName: "a.pdf" });
    expect(only.kind).toBe("PDF");
    expect(only.total).toBe(30);
    expect(only.result).toBeUndefined();
  });

  it("对已移除的任务报进度是空操作，不会把它复活", () => {
    // 用户点了 x 关掉提示，但后台导入还在跑、还在发进度事件 ——
    // 若这里"顺手补一条"，关掉的悬浮条就会自己冒回来
    const afterClose = removeImportJob([pdf], "p1");
    expect(afterClose).toHaveLength(0);
    expect(patchImportJob(afterClose, "p1", { current: 9, fileName: "x.pdf" })).toEqual([]);
  });

  it("移除只动指定那条", () => {
    expect(removeImportJob([word, pdf], "w1").map((j) => j.id)).toEqual(["p1"]);
  });

  it("收尾把 current 补到 total —— 丢过进度事件也不会停在 28/30 却写着完成", () => {
    // 后端 emit 是 `let _ =` 尽力而为的，掉一条进度事件并非不可能
    const stalled = patchImportJob([pdf], "p1", {
      current: 28,
      fileName: "倒数第二个.pdf",
    });
    const [done] = finishImportJobIn(stalled, "p1", { ok: 22, failed: 8 });
    expect(done.current).toBe(30);
    expect(done.result).toEqual({ ok: 22, failed: 8 });
    // 文件名保留，收尾时不清空（悬浮条此刻改显摘要，但不该顺手抹掉别的字段）
    expect(done.fileName).toBe("倒数第二个.pdf");
  });

  it("收尾只影响指定那条，并发的另一条仍在跑", () => {
    const jobs = finishImportJobIn([word, pdf], "p1", { ok: 30, failed: 0 });
    const byId = Object.fromEntries(jobs.map((j) => [j.id, j]));
    expect(byId.p1.result).toBeDefined();
    expect(byId.w1.result).toBeUndefined();
    expect(byId.w1.current).toBe(0);
  });

  it("停留时长是有限正数 —— 设成 0 会一闪而过，设成 Infinity 会赖着不走", () => {
    expect(IMPORT_JOB_LINGER_MS).toBeGreaterThan(1000);
    expect(Number.isFinite(IMPORT_JOB_LINGER_MS)).toBe(true);
  });
});
