import { useCallback, useEffect, useState } from "react";
import { App as AntdApp, Checkbox } from "antd";
import { ListTodo } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { taskApi } from "@/lib/api";
import { useAppStore } from "@/store";
import { useFeatureEnabled } from "@/hooks/useFeatureEnabled";
import type { Task } from "@/types";

/**
 * 日记右侧栏「今日待办」（v4 原型 .ah 今日待办）：列出截止日期落在该日记日期的待办，可直接打勾。
 *
 * - 看的是**日记那一天**，不是系统今天：翻到 10-30 的日记就看 10-30 到期的待办，方便复盘
 * - 当天（isToday）的逾期未完成待办不逐条列（积压多的库能有几十条，会把当天的事淹掉），
 *   收成一行「另有 N 条逾期 →」跳待办页逾期筛选
 * - 已放弃（status=2）的不显示；已完成的留在列表里划掉，复盘时能看到当天做了什么
 * - 待办模块被关掉时整块不渲染
 */
export function DailyTasksAside({ date, isToday }: { date: string; isToday: boolean }) {
  const enabled = useFeatureEnabled("tasks");
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  // 待办页 / 首页改了待办会自增这两个 tick，这里跟着重拉，免得侧栏显示旧状态
  const listTick = useAppStore((s) => s.tasksListRefreshTick);
  const statsTick = useAppStore((s) => s.taskStatsTick);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [overdueCount, setOverdueCount] = useState(0);

  const load = useCallback(async () => {
    try {
      const all = await taskApi.list();
      const dayOf = (t: Task) => (t.due_date ?? "").slice(0, 10);
      const picked = all.filter((t) => t.status !== 2 && t.due_date && dayOf(t) === date);
      setOverdueCount(
        isToday ? all.filter((t) => t.status === 0 && t.due_date && dayOf(t) < date).length : 0,
      );
      // 未完成在前，已完成垫底；同组按截止时间
      picked.sort((a, b) => {
        if (a.status !== b.status) return a.status - b.status;
        return (a.due_date ?? "").localeCompare(b.due_date ?? "");
      });
      setTasks(picked);
    } catch {
      // 侧栏不是关键路径：拉失败就保持空，不弹错
      setTasks([]);
      setOverdueCount(0);
    }
  }, [date, isToday]);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load, listTick, statsTick]);

  if (!enabled) return null;

  async function toggle(t: Task) {
    try {
      await taskApi.toggleStatus(t.id);
      // 刷侧边栏紧急计数（同时会自增 taskStatsTick → 本组件重拉）
      useAppStore.getState().refreshTaskStats();
    } catch (e) {
      message.error(`操作失败: ${e}`);
    }
  }

  const openCount = tasks.filter((t) => t.status === 0).length;

  return (
    <div className="kb-aside-sec">
      <div className="kb-aside-head">
        <ListTodo size={13} />
        <span>{isToday ? "今日待办" : "当天待办"}</span>
        <span className="kb-aside-count">{openCount}</span>
      </div>
      {tasks.length === 0 ? (
        <div className="kb-aside-empty">这一天没有到期的待办</div>
      ) : (
        <div className="kb-day-tasks">
          {tasks.map((t) => (
            <div key={t.id} className={t.status === 1 ? "kb-day-task is-done" : "kb-day-task"}>
              <Checkbox checked={t.status === 1} onChange={() => void toggle(t)} />
              <span
                className="kb-day-task-title"
                title="在待办页打开"
                onClick={() => navigate(`/tasks?taskId=${t.id}`)}
              >
                {t.title}
              </span>
            </div>
          ))}
        </div>
      )}
      {overdueCount > 0 && (
        <a className="kb-day-task-overdue" onClick={() => navigate("/tasks?filter=overdue")}>
          另有 {overdueCount} 条逾期 →
        </a>
      )}
    </div>
  );
}
