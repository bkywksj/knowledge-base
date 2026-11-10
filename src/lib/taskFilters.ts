import { isAbandoned, TASK_STATUS_ABANDONED, type Task, type TaskStatus } from "@/types";

/**
 * 待办的筛选 / 分组 / 日期文案（纯函数）。
 *
 * 原来写在 PC 待办页（pages/tasks/index.tsx）里，2026-11 手机端 v4 重构时原样挪到这里：
 * 手机待办页的「标题下拉 = PC 待办侧栏」要用同一套筛选口径，两边各写一份迟早跑偏。
 */

/** 列表视图形态（applySmartFilter 据此决定已放弃任务的去留） */
export type TaskViewMode = "list" | "kanban" | "quadrant" | "calendar" | "gantt";

/** 本地日期 YYYY-MM-DD */
export function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 从 due_date（可能带时分）中提取 YYYY-MM-DD 日期部分 */
export function dueDateOnly(due: string): string {
  return due.slice(0, 10);
}

export function groupTasks(tasks: Task[]) {
  const today = ymdLocal(new Date());
  const weekEnd = ymdLocal(new Date(Date.now() + 7 * 86400000));
  const overdue: Task[] = [];
  const todayGroup: Task[] = [];
  const upcoming: Task[] = [];
  const noDate: Task[] = [];
  const done: Task[] = [];
  for (const t of tasks) {
    // 已完成与已放弃都归到底部折叠区：都不再"待办"，不该混在逾期/今天里
    if (t.status === 1 || isAbandoned(t)) {
      done.push(t);
      continue;
    }
    if (!t.due_date) {
      noDate.push(t);
      continue;
    }
    const dueDay = dueDateOnly(t.due_date);
    if (dueDay < today) {
      overdue.push(t);
    } else if (dueDay === today) {
      todayGroup.push(t);
    } else if (dueDay <= weekEnd) {
      upcoming.push(t);
    } else {
      upcoming.push(t);
    }
  }
  return { overdue, today: todayGroup, tomorrow: [] as Task[], upcoming, noDate, done };
}

export function describeDueDate(
  due: string | null,
  done = false,
): { text: string; overdue: boolean } {
  if (!due) return { text: "", overdue: false };
  // 已完成任务：不再算"逾期"，徽章退化为中性日期 tag。
  // Why: "逾期"是给未完成任务的醒目提醒，完成后这个语义已消失，
  //      继续红色标红只是噪音。保留日期文本但 overdue=false 让调用方走灰色样式。
  const today = ymdLocal(new Date());
  const dueDay = dueDateOnly(due);
  const timeSuffix = due.length > 10 ? ` ${due.slice(11, 16)}` : "";
  if (done) return { text: `${dueDay}${timeSuffix}`, overdue: false };
  if (dueDay === today) return { text: `今天${timeSuffix}`, overdue: false };
  if (dueDay < today) {
    const diff = Math.floor(
      (new Date(today).getTime() - new Date(dueDay).getTime()) / 86400000,
    );
    return { text: `逾期 ${diff} 天${timeSuffix}`, overdue: true };
  }
  const diff = Math.floor(
    (new Date(dueDay).getTime() - new Date(today).getTime()) / 86400000,
  );
  if (diff === 1) return { text: `明天${timeSuffix}`, overdue: false };
  return { text: `${dueDay}（${diff} 天后）${timeSuffix}`, overdue: false };
}

/**
 * 行右侧「截止时间列」的短文案（v4 原型 .tk .due）：
 * 今天 → 时分（没时分写「今天」）；昨天 / 明天；一周内 → 周几；其余 → MM-DD（跨年带年份）。
 * 逾期标红交给调用方（describeDueDate().overdue），完整的「逾期 N 天」放在悬停提示里。
 */
export function dueShortText(due: string | null): string {
  if (!due) return "";
  const today = ymdLocal(new Date());
  const day = dueDateOnly(due);
  const time = due.length > 10 ? due.slice(11, 16) : "";
  const diff = Math.round(
    (new Date(day + "T00:00:00").getTime() - new Date(today + "T00:00:00").getTime()) / 86400000,
  );
  if (diff === 0) return time || "今天";
  if (diff === -1) return "昨天";
  if (diff === 1) return time ? `明天 ${time}` : "明天";
  if (diff > 1 && diff < 7) return "周" + "日一二三四五六"[new Date(day + "T00:00:00").getDay()];
  return day.slice(0, 4) === today.slice(0, 4) ? day.slice(5) : day;
}

/** SidePanel 的 TasksPanel 和主区共享的筛选键 */
export type SmartFilter =
  | "todo"
  | "done"
  | "abandoned"
  | "all"
  | "overdue"
  | "today"
  | "week"
  | "no-date"
  | "urgent"
  | "normal"
  | "low"
  | "recurring"
  | "linked";

/** URL `?filter=` → 传给 taskApi.list 的 status 参数 */
export function filterToStatusArg(filter: SmartFilter): TaskStatus | undefined {
  if (filter === "done") return 1;
  if (filter === "abandoned") return TASK_STATUS_ABANDONED;
  if (filter === "all") return undefined;
  // 其他维度都基于未完成
  return 0;
}

/** 本地再过滤：基于 URL 的智能筛选，对 taskApi 返回的 Task[] 二次过滤
 *
 * 重要：除 "todo" / "done" / "all" 外，所有维度都强制 status === 0（仅未完成）。
 * 因为"已完成的逾期"、"已完成的紧急"在用户语义里都不成立——完成了就不是逾期了。
 * 日历视图为支持"已完成置灰显示"会拉全部任务进来，依靠这里的过滤把非 todo 维度
 * 收敛为"未完成"；不加这个限制，会出现 filter=overdue 日历里冒出大量历史已完成
 * 任务的 bug。
 */
export function applySmartFilter(
  tasks: Task[],
  filter: SmartFilter,
  viewMode: TaskViewMode = "list",
): Task[] {
  const today = ymdLocal(new Date());
  const weekEnd = ymdLocal(new Date(Date.now() + 7 * 86400000));
  switch (filter) {
    case "overdue":
      return tasks.filter(
        (t) =>
          t.status === 0 && t.due_date && dueDateOnly(t.due_date) < today,
      );
    case "today":
      return tasks.filter(
        (t) =>
          t.status === 0 && t.due_date && dueDateOnly(t.due_date) === today,
      );
    case "week":
      return tasks.filter((t) => {
        if (t.status !== 0 || !t.due_date) return false;
        const day = dueDateOnly(t.due_date);
        return day > today && day <= weekEnd;
      });
    case "no-date":
      return tasks.filter((t) => t.status === 0 && !t.due_date);
    case "urgent":
      return tasks.filter((t) => t.status === 0 && t.priority === 0);
    case "normal":
      return tasks.filter((t) => t.status === 0 && t.priority === 1);
    case "low":
      return tasks.filter((t) => t.status === 0 && t.priority === 2);
    case "recurring":
      return tasks.filter(
        (t) => t.status === 0 && t.repeat_kind && t.repeat_kind !== "none",
      );
    case "linked":
      return tasks.filter(
        (t) => t.status === 0 && t.links && t.links.length > 0,
      );
    case "abandoned":
      // 后端已按 status=2 过滤，这里原样返回
      return tasks;
    default: {
      // todo / done / all：保持后端 status 过滤的结果（todo 拉全部用于日历回顾）。
      //
      // 「已放弃」的去留分两种：
      // · 日历 / 甘特：保留（组件内会灰显），这样能看到"这段时间原本安排了什么"，
      //   时间线不会莫名其妙断一截。
      // · 列表 / 看板 / 四象限：摘掉。todo 视图拉的是全量，不摘的话放弃的任务会
      //   落进底部「已完成」折叠区，标题就对不上了；要看请走「已放弃」筛选。
      const keepAbandoned = viewMode === "calendar" || viewMode === "gantt";
      return keepAbandoned ? tasks : tasks.filter((t) => !isAbandoned(t));
    }
  }
}

/** 动态标题：和 SidePanel 选中项呼应，给用户"看的是什么"的反馈 */
export function filterTitle(filter: SmartFilter): string {
  switch (filter) {
    case "done": return "已完成";
    case "abandoned": return "已放弃";
    case "all": return "全部任务";
    case "overdue": return "逾期任务";
    case "today": return "今天的任务";
    case "week": return "本周到期";
    case "no-date": return "无日期任务";
    case "urgent": return "紧急任务";
    case "normal": return "普通任务";
    case "low": return "低优先级";
    case "recurring": return "循环任务";
    case "linked": return "有关联任务";
    default: return "全部任务";
  }
}
