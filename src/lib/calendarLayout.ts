/**
 * 日历月视图的跨天条布局 —— 纯计算层（不依赖 React / antd / DOM）
 *
 * 旧版月视图把任务按 `due_date` 塞进单个格子，一条跨半个月的任务只在截止那天
 * 露一行，看不出"它占了多久"。这里改成按周排条带：每周一行，任务在周内连成
 * 一条横条，跨周则在周边界截断并用箭头提示还有下文（滴答清单 / Google Calendar 同款）。
 *
 * 抽成独立文件是为了能单测：跑道分配和跨周截断是最容易写错的部分，
 * 而在组件里它们只能靠肉眼回归。
 */
import dayjs, { type Dayjs } from "dayjs";
import type { Task } from "@/types";

/** 每周最多并排显示几条；超出的折叠成 "+N" 提示 */
export const MAX_LANES = 3;

/** 一条任务在某一周里占据的横条 */
export interface Bar {
  task: Task;
  /** 本周内的起止列（0=周一 … 6=周日） */
  startCol: number;
  endCol: number;
  /** 第几条跑道（0 在最上面） */
  lane: number;
  /** 区间在本周之前就开始 / 在本周之后才结束 —— 用箭头提示"还有下文" */
  continuesLeft: boolean;
  continuesRight: boolean;
}

/**
 * 取任务在日历上占据的日期区间。
 * - start_date + due_date → 真区间（跨天条）
 * - 只有其中之一 → 当天一格（沿用"截止点"语义，与甘特图一致）
 * - 都没有 → null（不上日历，进"未安排"抽屉）
 *
 * 脏数据（开始晚于结束）自动交换，避免渲染出负宽度的条。
 */
export function taskRange(t: Task): { from: Dayjs; to: Dayjs } | null {
  const due = t.due_date ? dayjs(t.due_date.slice(0, 10)) : null;
  const start = t.start_date ? dayjs(t.start_date.slice(0, 10)) : null;
  if (!due && !start) return null;
  const a = start ?? (due as Dayjs);
  const b = due ?? (start as Dayjs);
  return a.isAfter(b, "day") ? { from: b, to: a } : { from: a, to: b };
}

/**
 * 把一条区间任务整体平移到目标日期：落点成为新的开始日，跨度保持不变。
 *
 * 拖动区间任务时如果只改 due_date，区间会被越拖越短，甚至出现"结束早于开始"的
 * 脏数据；所以这里同时算出新的 start_date / due_date。
 *
 * @param t 被拖动的任务（必须已有 start_date，否则返回 null 走单日逻辑）
 * @param targetYmd 落点日期 'YYYY-MM-DD'
 * @returns 新的起止日期；null = 该任务不是区间任务，或落点没变化（无需更新）
 */
export function shiftRangeTo(
  t: Task,
  targetYmd: string,
): { start_date: string; due_date: string } | null {
  if (!t.start_date) return null;
  const r = taskRange(t);
  if (!r) return null;
  const delta = dayjs(targetYmd).diff(r.from, "day");
  if (delta === 0) return null;
  return {
    start_date: r.from.add(delta, "day").format("YYYY-MM-DD"),
    due_date: r.to.add(delta, "day").format("YYYY-MM-DD"),
  };
}

/**
 * 给某一周里的任务分配跑道：按起始列排序后贪心塞进第一条空闲跑道。
 * 同列时长条优先、未完成优先、紧急优先，让重要信息稳定落在上面几行
 * （否则每次刷新顺序抖动，用户会觉得"条在乱跳"）。
 *
 * @param weekStart 该周第一天（周一）
 * @param tasks 全量任务；与本周无交集的会被跳过
 */
export function layoutWeek(weekStart: Dayjs, tasks: Task[]): Bar[] {
  const weekEnd = weekStart.add(6, "day");
  const raw: Omit<Bar, "lane">[] = [];
  for (const t of tasks) {
    const r = taskRange(t);
    if (!r) continue;
    if (r.to.isBefore(weekStart, "day") || r.from.isAfter(weekEnd, "day")) continue;
    raw.push({
      task: t,
      startCol: Math.max(0, r.from.diff(weekStart, "day")),
      endCol: Math.min(6, r.to.diff(weekStart, "day")),
      continuesLeft: r.from.isBefore(weekStart, "day"),
      continuesRight: r.to.isAfter(weekEnd, "day"),
    });
  }
  raw.sort((a, b) => {
    if (a.startCol !== b.startCol) return a.startCol - b.startCol;
    const alen = a.endCol - a.startCol;
    const blen = b.endCol - b.startCol;
    if (alen !== blen) return blen - alen;
    if (a.task.status !== b.task.status) return a.task.status - b.task.status;
    return a.task.priority - b.task.priority;
  });
  const laneEnd: number[] = [];
  return raw.map((b) => {
    let lane = 0;
    while (lane < laneEnd.length && laneEnd[lane] >= b.startCol) lane += 1;
    laneEnd[lane] = b.endCol;
    return { ...b, lane };
  });
}
