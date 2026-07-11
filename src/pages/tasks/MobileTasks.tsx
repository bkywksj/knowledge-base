import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Modal, message } from "antd";
import {
  Search,
  Filter,
  Flame,
  Calendar,
  Plus,
  CheckCircle2,
  Circle,
  Pencil,
  Trash2,
} from "lucide-react";
import { taskApi } from "@/lib/api";
import type { Task } from "@/types";
import { useLongPress } from "@/hooks/useLongPress";
import { ActionSheet, type ActionSheetItem } from "@/components/mobile/ActionSheet";

/**
 * 移动端待办（设计稿：08-tasks.html）
 *
 * 结构：
 * - 顶栏：标题 + 统计 + 搜索/过滤
 * - 分类 chips（暂用静态：全部/今日/本周/已完成）
 * - 今日组（红色高亮）+ 本周组 + 已完成组
 * - 每条任务：checkbox + 标题 + 元信息（截止时间、优先级标识）
 *
 * 暂不实现：子任务展开、详情弹窗、批量编辑
 * 这些走 T-M010 任务详情页（独立路由 /tasks/:id 后续做）
 */

type GroupKey = "today" | "week" | "done";

export function MobileTasks() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<GroupKey | "all">("all");
  // 长按唤起的动作面板
  const [sheetTask, setSheetTask] = useState<Task | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // status=0 todo + status=1 done 都拉，前端按时间分组
      const [todo, done] = await Promise.all([
        taskApi.list({ status: 0 }).catch(() => [] as Task[]),
        taskApi.list({ status: 1 }).catch(() => [] as Task[]),
      ]);
      setTasks([...todo, ...done.slice(0, 20)]); // 已完成只取最近 20 条
    } catch (e) {
      console.error("[MobileTasks] load failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 分组
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  const next7End = new Date(todayEnd);
  next7End.setDate(next7End.getDate() + 7);

  const todoTasks = tasks.filter((t) => t.status === 0);
  const doneTasks = tasks.filter((t) => t.status === 1);
  const todayTasks = todoTasks.filter((t) => {
    if (!t.due_date) return false;
    return new Date(t.due_date).getTime() <= todayEnd.getTime();
  });
  const weekTasks = todoTasks.filter((t) => {
    if (!t.due_date) return false;
    const d = new Date(t.due_date).getTime();
    return d > todayEnd.getTime() && d <= next7End.getTime();
  });
  const noDateTasks = todoTasks.filter((t) => !t.due_date);

  const stats = {
    today: todayTasks.length,
    week: weekTasks.length,
    done: doneTasks.length,
    all: todoTasks.length,
  };

  // 切换状态
  async function toggleTask(task: Task) {
    try {
      await taskApi.toggleStatus(task.id);
      await load();
    } catch (e) {
      console.error("toggle task failed:", e);
    }
  }

  // 删除任务（永久，无回收站 → 二次确认）
  function confirmDeleteTask(task: Task) {
    Modal.confirm({
      title: `删除「${task.title}」？`,
      content: "任务删除后不可恢复。",
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        try {
          await taskApi.delete(task.id);
          message.success("已删除");
          await load();
        } catch (e) {
          message.error(String(e));
        }
      },
    });
  }

  // 长按动作面板操作项
  const sheetItems: ActionSheetItem[] = sheetTask
    ? [
        {
          key: "toggle",
          label: sheetTask.status === 1 ? "标记为未完成" : "标记为完成",
          icon:
            sheetTask.status === 1 ? (
              <Circle size={20} />
            ) : (
              <CheckCircle2 size={20} />
            ),
          onClick: () => toggleTask(sheetTask),
        },
        {
          key: "edit",
          label: "编辑详情",
          icon: <Pencil size={20} />,
          onClick: () => navigate(`/task-detail/${sheetTask.id}`),
        },
        {
          key: "delete",
          label: "删除",
          icon: <Trash2 size={20} />,
          danger: true,
          onClick: () => confirmDeleteTask(sheetTask),
        },
      ]
    : [];

  return (
    <div className="text-slate-800">
      {/* 顶栏 */}
      <div className="bg-white px-4 pt-3 pb-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">待办</h1>
            <div className="mt-0.5 text-xs text-slate-400">
              今日 {stats.today} 项 · 本周 {stats.week} 项 · 已完成 {stats.done}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              aria-label="搜索"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 active:bg-slate-200"
            >
              <Search size={18} className="text-slate-700" />
            </button>
            <button
              aria-label="筛选"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 active:bg-slate-200"
            >
              <Filter size={18} className="text-slate-700" />
            </button>
          </div>
        </div>

        {/* 分类 chips */}
        <div className="mt-3 flex gap-2 overflow-x-auto -mx-4 px-4 pb-1 scrollbar-none">
          <Chip
            active={activeTab === "all"}
            onClick={() => setActiveTab("all")}
            label={`所有 ${stats.all}`}
          />
          <Chip
            active={activeTab === "today"}
            onClick={() => setActiveTab("today")}
            label={`⏰ 今日 ${stats.today}`}
            activeColor="bg-red-100 text-red-700"
          />
          <Chip
            active={activeTab === "week"}
            onClick={() => setActiveTab("week")}
            label={`📅 本周 ${stats.week}`}
            activeColor="bg-orange-100 text-orange-700"
          />
          <Chip
            active={activeTab === "done"}
            onClick={() => setActiveTab("done")}
            label={`✅ 已完成 ${stats.done}`}
            activeColor="bg-green-100 text-green-700"
          />
        </div>
      </div>

      {/* 列表 */}
      <div className="bg-slate-50 pb-24">
        {loading && tasks.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-slate-400">
            加载中...
          </div>
        ) : todoTasks.length === 0 && doneTasks.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-slate-400">
            <Plus size={40} className="text-slate-300" />
            <span className="text-sm">暂无待办，享受当下 ✨</span>
          </div>
        ) : (
          <>
            {/* 今日 */}
            {(activeTab === "all" || activeTab === "today") &&
              todayTasks.length > 0 && (
                <>
                  <SectionHeader
                    icon={<Flame size={14} className="text-red-500" />}
                    text={`今日 · ${todayTasks.length} 项`}
                    color="text-red-600"
                  />
                  <Group tasks={todayTasks} onToggle={toggleTask} onOpen={(t) => navigate(`/task-detail/${t.id}`)} onLongPress={setSheetTask} />
                </>
              )}

            {/* 本周 */}
            {(activeTab === "all" || activeTab === "week") &&
              weekTasks.length > 0 && (
                <>
                  <SectionHeader
                    icon={<Calendar size={14} className="text-orange-500" />}
                    text="本周"
                    color="text-orange-600"
                  />
                  <Group tasks={weekTasks} onToggle={toggleTask} onOpen={(t) => navigate(`/task-detail/${t.id}`)} onLongPress={setSheetTask} />
                </>
              )}

            {/* 无截止日期 */}
            {activeTab === "all" && noDateTasks.length > 0 && (
              <>
                <SectionHeader text={`其它 · ${noDateTasks.length} 项`} />
                <Group tasks={noDateTasks} onToggle={toggleTask} onOpen={(t) => navigate(`/task-detail/${t.id}`)} onLongPress={setSheetTask} />
              </>
            )}

            {/* 已完成 */}
            {(activeTab === "all" || activeTab === "done") &&
              doneTasks.length > 0 && (
                <>
                  <SectionHeader text={`已完成 · ${doneTasks.length} 项`} />
                  <Group tasks={doneTasks} onToggle={toggleTask} onOpen={(t) => navigate(`/task-detail/${t.id}`)} onLongPress={setSheetTask} faded />
                </>
              )}
          </>
        )}
      </div>

      {/* 长按任务唤起的底部操作面板 */}
      <ActionSheet
        open={sheetTask !== null}
        title={sheetTask?.title}
        items={sheetItems}
        onClose={() => setSheetTask(null)}
      />
    </div>
  );
}

function Chip({
  active,
  onClick,
  label,
  activeColor,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  activeColor?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium ${
        active
          ? activeColor || "bg-[#1677FF] text-white"
          : "bg-slate-100 text-slate-600"
      }`}
    >
      {label}
    </button>
  );
}

function SectionHeader({
  icon,
  text,
  color = "text-slate-400",
}: {
  icon?: React.ReactNode;
  text: string;
  color?: string;
}) {
  return (
    <div
      className={`flex items-center gap-1.5 px-4 pt-3 pb-1 text-xs font-semibold ${color}`}
    >
      {icon}
      <span>{text}</span>
    </div>
  );
}

function Group({
  tasks,
  onToggle,
  onOpen,
  onLongPress,
  faded,
}: {
  tasks: Task[];
  onToggle: (task: Task) => void;
  onOpen: (task: Task) => void;
  onLongPress: (task: Task) => void;
  faded?: boolean;
}) {
  return (
    <div className="mx-4 mb-2 divide-y divide-slate-100 rounded-2xl bg-white">
      {tasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          onToggle={onToggle}
          onOpen={onOpen}
          onLongPress={onLongPress}
          faded={faded}
        />
      ))}
    </div>
  );
}

function TaskRow({
  task,
  onToggle,
  onOpen,
  onLongPress,
  faded,
}: {
  task: Task;
  onToggle: (task: Task) => void;
  onOpen: (task: Task) => void;
  onLongPress: (task: Task) => void;
  faded?: boolean;
}) {
  const due = task.due_date ? new Date(task.due_date) : null;
  const overdue = due && due.getTime() < Date.now() && task.status === 0;

  // 长按任务文本区唤起动作面板；轻点仍进详情。checkbox 独立不受影响
  const longPress = useLongPress(() => onLongPress(task), {
    onClick: () => onOpen(task),
  });

  return (
    <div className={`px-4 py-3 ${faded ? "opacity-50" : ""}`}>
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={task.status === 1}
          onChange={() => onToggle(task)}
          className="mt-0.5 h-5 w-5 shrink-0 rounded"
        />
        <div
          {...longPress}
          role="button"
          className="flex-1 min-w-0 select-none text-left active:opacity-60"
          style={{ WebkitTouchCallout: "none" }}
        >
          <div
            className={`text-sm ${
              task.status === 1
                ? "text-slate-400 line-through"
                : "font-medium text-slate-800"
            }`}
          >
            {task.title}
          </div>
          {(due || task.priority === 0) && (
            <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-400">
              {task.priority === 0 && (
                <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-600">
                  紧急
                </span>
              )}
              {due && (
                <span
                  className={
                    overdue ? "font-medium text-red-500" : "text-slate-400"
                  }
                >
                  {overdue ? "⏰ 已逾期 " : "📅 "}
                  {due.toLocaleDateString("zh-CN", {
                    month: "numeric",
                    day: "numeric",
                  })}{" "}
                  {due.toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
