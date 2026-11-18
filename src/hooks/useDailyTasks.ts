import { useCallback, useEffect, useState } from "react";
import { taskApi } from "@/lib/api";
import { useAppStore } from "@/store";
import type { Task } from "@/types";

/**
 * 日记页「当天待办」的数据（桌面右侧栏 / 手机日记页共用）。
 *
 * - `tasks`：截止在这天的 + 这天完成的（没设截止、当天顺手做完的也算）——
 *   翻到哪天的日记就看到那天做了什么，不用另外手写
 * - `overdue`：只在看今天时给，截止早于今天还没完成的；调用方决定逐条列还是收成一行
 * - 已放弃的后端已过滤；未完成在前、已完成垫底
 * - 待办页 / 首页改了待办会自增 tick，这里跟着重拉
 */
export function useDailyTasks(date: string, isToday: boolean, enabled = true) {
  const listTick = useAppStore((s) => s.tasksListRefreshTick);
  const statsTick = useAppStore((s) => s.taskStatsTick);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [overdue, setOverdue] = useState<Task[]>([]);

  const load = useCallback(async () => {
    try {
      const all = await taskApi.list({ day: date, include_overdue: isToday });
      const isOverdue = (t: Task) => t.status === 0 && !!t.due_date && t.due_date.slice(0, 10) < date;
      const picked = all.filter((t) => !isOverdue(t));
      picked.sort((a, b) => {
        if (a.status !== b.status) return a.status - b.status;
        return (a.due_date ?? a.completed_at ?? "").localeCompare(b.due_date ?? b.completed_at ?? "");
      });
      setTasks(picked);
      setOverdue(all.filter(isOverdue));
    } catch {
      // 不是关键路径：拉失败就保持空，不弹错
      setTasks([]);
      setOverdue([]);
    }
  }, [date, isToday]);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load, listTick, statsTick]);

  /** 勾选 / 取消勾选；循环任务勾选 = 完成本次（与待办页一致） */
  const toggle = useCallback(async (t: Task) => {
    if (t.status === 0 && t.repeat_kind !== "none") {
      await taskApi.completeOccurrence(t.id);
    } else {
      await taskApi.toggleStatus(t.id);
    }
    // 刷侧边栏紧急计数（同时自增 taskStatsTick → 本 hook 重拉）
    useAppStore.getState().refreshTaskStats();
  }, []);

  /** 新建一条截止在这天的待办（全天，不设时刻） */
  const add = useCallback(
    async (title: string) => {
      await taskApi.create({ title, due_date: date });
      useAppStore.getState().refreshTaskStats();
    },
    [date],
  );

  return { tasks, overdue, toggle, add, reload: load };
}
