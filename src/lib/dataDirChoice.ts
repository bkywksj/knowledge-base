import type { DataDirInspect } from "@/types";

/**
 * 切换数据目录的方式：
 * - 目标没有数据：auto（迁移过去）/ manual（只改路径，自己复制）
 * - 目标已有数据：useTarget（直接用目标的数据，不迁移）/ replace（用当前数据替换，目标留档）
 */
export type MoveChoice = "auto" | "manual" | "useTarget" | "replace";

/**
 * 默认选项。目标已有数据时绝不能默认迁移过去（2026-11-05 线上事故：空库覆盖了真实笔记）：
 * 只有明确读出 0 篇才默认替换（目标反正会留档）；读不出来按「可能有数据」保住目标。
 */
export function defaultMoveChoice(target: DataDirInspect): MoveChoice {
  if (!target.hasDb) return "auto";
  return target.noteCount === 0 ? "replace" : "useTarget";
}

/** 这个选择要不要走迁移；第二个值表示后端要放行覆盖目标 */
export function migrationOf(choice: MoveChoice): { migrate: boolean; replaceExisting: boolean } {
  return {
    migrate: choice === "auto" || choice === "replace",
    replaceExisting: choice === "replace",
  };
}

/** 概况的一句话描述：几篇笔记 · 多大 · 最后修改时间 */
export function describeInspect(i: DataDirInspect | null): string {
  if (!i?.hasDb) return "没有数据";
  const notes = i.noteCount == null ? "笔记数读取失败" : `${i.noteCount} 篇笔记`;
  const size =
    i.sizeBytes >= 1024 * 1024
      ? `${(i.sizeBytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(i.sizeBytes / 1024))} KB`;
  return [notes, size, i.modifiedAt && `最后修改于 ${i.modifiedAt}`].filter(Boolean).join(" · ");
}
