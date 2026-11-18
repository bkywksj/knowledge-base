import { useState } from "react";
import { App as AntdApp, Checkbox, Input } from "antd";
import { ListTodo } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useFeatureEnabled } from "@/hooks/useFeatureEnabled";
import { useDailyTasks } from "@/hooks/useDailyTasks";
import type { Task } from "@/types";

/**
 * 日记右侧栏「今日待办」（v4 原型 .ah 今日待办）：列出截止在该日记日期、或在那天完成的待办，可直接打勾。
 *
 * - 看的是**日记那一天**，不是系统今天：翻到 10-30 的日记就看 10-30 到期 / 完成的待办，方便复盘
 * - 当天（isToday）的逾期未完成待办不逐条列（积压多的库能有几十条，会把当天的事淹掉），
 *   收成一行「另有 N 条逾期 →」跳待办页逾期筛选
 * - 已放弃的不显示；已完成的留在列表里划掉，复盘时能看到当天做了什么
 * - 底部输入框回车 = 新建一条截止在这天的待办
 * - 待办模块被关掉时整块不渲染
 */
export function DailyTasksAside({ date, isToday }: { date: string; isToday: boolean }) {
  const enabled = useFeatureEnabled("tasks");
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const { tasks, overdue, toggle, add } = useDailyTasks(date, isToday, enabled);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  if (!enabled) return null;

  async function onToggle(t: Task) {
    try {
      await toggle(t);
    } catch (e) {
      message.error(`操作失败: ${e}`);
    }
  }

  async function onAdd() {
    const title = draft.trim();
    if (!title || adding) return;
    setAdding(true);
    try {
      await add(title);
      setDraft("");
    } catch (e) {
      message.error(`添加失败: ${e}`);
    } finally {
      setAdding(false);
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
        <div className="kb-aside-empty">这一天没有到期或完成的待办</div>
      ) : (
        <div className="kb-day-tasks">
          {tasks.map((t) => (
            <div key={t.id} className={t.status === 1 ? "kb-day-task is-done" : "kb-day-task"}>
              <Checkbox checked={t.status === 1} onChange={() => void onToggle(t)} />
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
      <Input
        size="small"
        variant="filled"
        className="kb-day-task-add"
        placeholder="+ 添加待办，回车保存"
        value={draft}
        disabled={adding}
        onChange={(e) => setDraft(e.target.value)}
        onPressEnter={(e) => {
          if (!e.nativeEvent.isComposing) void onAdd();
        }}
      />
      {overdue.length > 0 && (
        <a className="kb-day-task-overdue" onClick={() => navigate("/tasks?filter=overdue")}>
          另有 {overdue.length} 条逾期 →
        </a>
      )}
    </div>
  );
}
