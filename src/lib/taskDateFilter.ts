/**
 * 待办列表的日期区间筛选（纯函数，方便单测）。
 *
 * 语义取舍：同一个区间对不同状态的任务问的问题不一样——
 * · 未完成 → "这几天要做什么"，看截止日期
 * · 已完成 / 已放弃 → "这几天做完了什么"，看完成日期
 * 所以这里按状态选参照日，而不是一律用 due_date。
 */
import { isAbandoned, type Task } from "@/types";

/** 从 due_date / completed_at（可能带时分）里取 YYYY-MM-DD 日期部分 */
function dayPart(v: string): string {
  return v.slice(0, 10);
}

/**
 * 任务参与日期筛选时的参照日；返回 null 表示这条任务没有可比较的日期。
 *
 * 已完成但缺 completed_at 的旧数据回落到 due_date，避免历史任务被整体筛掉。
 */
export function taskFilterDay(t: Pick<Task, "status" | "due_date" | "completed_at">): string | null {
  if (t.status === 1 || isAbandoned(t)) {
    const done = t.completed_at ? dayPart(t.completed_at) : null;
    if (done) return done;
  }
  return t.due_date ? dayPart(t.due_date) : null;
}

/**
 * 按日期区间过滤任务，含首尾两天；start / end 传 null 表示该端不限。
 *
 * 两端都为 null = 筛选未启用，原样返回。
 * 没有参照日的任务（既无截止日也无完成日）在筛选启用时一律排除：
 * 用户问的是"这段时间有什么"，把无日期任务塞进来会让结果失真。
 */
export function filterTasksByDateRange<
  T extends Pick<Task, "status" | "due_date" | "completed_at">,
>(tasks: T[], start: string | null, end: string | null): T[] {
  if (!start && !end) return tasks;
  return tasks.filter((t) => {
    const day = taskFilterDay(t);
    if (!day) return false;
    if (start && day < start) return false;
    if (end && day > end) return false;
    return true;
  });
}
