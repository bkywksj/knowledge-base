import type { Task } from "@/types";

/**
 * 待办的创建 / 完成时间展示。
 *
 * 数据本来就有（`tasks` 表的 `created_at` NOT NULL、`completed_at` 完成时写入），
 * 只是此前没有任何界面展示 —— 用户反馈的「建议记录待办创建和完成时间」实际是
 * **只差展示**，不需要动 schema。
 *
 * 实测格式：`"2026-04-21 07:29:53"`（datetime('now','localtime')，非 ISO、无时区后缀）。
 * 未完成任务的 `completed_at` 为 null。
 */

/**
 * 把库里的时间戳格式化成紧凑展示形式。
 *
 * @param raw   形如 "2026-04-21 07:29:53"；null/空/不可解析一律返回 null
 * @param withYear 是否带年份（跨年内容需要，日历 Tooltip 里通常不需要）
 *
 * 刻意不引 dayjs 做解析：这个格式是后端固定生成的，字符串切片既快又不会
 * 因为本地化设置不同而漂移。
 */
export function formatTaskTime(
  raw: string | null | undefined,
  withYear = false,
): string | null {
  if (!raw) return null;
  // 期望 "YYYY-MM-DD HH:mm:ss"，宽松匹配（秒可缺省，分隔符允许 T）
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return withYear
    ? `${y}-${mo}-${d} ${h}:${mi}`
    : `${mo}-${d} ${h}:${mi}`;
}

/** Tooltip / 详情里展示的一条时间信息 */
export interface TaskTimeLine {
  label: string;
  value: string;
}

/**
 * 汇总一个任务要展示的时间行。
 *
 * 规则：
 *  - 创建时间：始终展示（数据必有）
 *  - 完成时间：仅已完成且有值时展示
 *  - 任一字段解析失败就跳过该行，绝不显示 "Invalid Date" 之类的脏值
 */
export function taskTimeLines(task: Task, withYear = false): TaskTimeLine[] {
  const out: TaskTimeLine[] = [];
  const created = formatTaskTime(task.created_at, withYear);
  if (created) out.push({ label: "创建", value: created });
  // status 1 = 已完成
  if (task.status === 1) {
    const done = formatTaskTime(task.completed_at, withYear);
    if (done) out.push({ label: "完成", value: done });
  }
  return out;
}
