import { useEffect, useMemo, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  Input,
  Button,
  Typography,
  Tooltip,
  Empty,
  Spin,
  App as AntdApp,
  Popconfirm,
  Segmented,
  theme as antdTheme,
} from "antd";
import {
  CheckSquare,
  Plus,
  Search,
  AlertTriangle,
  Sun,
  CalendarRange,
  ChevronRight,
  FileText,
  Folder as FolderIcon,
  Link as LinkIcon,
  Trash2,
  Edit3,
} from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import { taskApi } from "@/lib/api";
import { useAppStore } from "@/store";
import type { Task, TaskPriority } from "@/types";

type ViewMode = "list" | "kanban" | "calendar";
import { CreateTaskModal } from "@/components/tasks/CreateTaskModal";
import { KanbanView } from "@/components/tasks/KanbanView";
import { CalendarView } from "@/components/tasks/CalendarView";

const { Text, Paragraph } = Typography;

/** 紧急度颜色映射 */
function priorityColor(p: TaskPriority, token: ReturnType<typeof antdTheme.useToken>["token"]): string {
  if (p === 0) return token.colorError;
  if (p === 1) return token.colorPrimary;
  return token.colorTextQuaternary;
}

/** 日期工具 */
function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function groupTasks(tasks: Task[]) {
  const today = ymdLocal(new Date());
  const tomorrow = ymdLocal(new Date(Date.now() + 86400000));
  const weekEnd = ymdLocal(new Date(Date.now() + 7 * 86400000));
  const overdue: Task[] = [];
  const todayGroup: Task[] = [];
  const upcoming: Task[] = [];
  const noDate: Task[] = [];
  const done: Task[] = [];
  for (const t of tasks) {
    if (t.status === 1) {
      done.push(t);
      continue;
    }
    if (!t.due_date) {
      noDate.push(t);
      continue;
    }
    if (t.due_date < today) {
      overdue.push(t);
    } else if (t.due_date === today) {
      todayGroup.push(t);
    } else if (t.due_date <= weekEnd) {
      upcoming.push(t);
    } else {
      upcoming.push(t);
    }
  }
  return { overdue, today: todayGroup, tomorrow, upcoming, noDate, done };
}

function describeDueDate(due: string | null): { text: string; overdue: boolean } {
  if (!due) return { text: "", overdue: false };
  const today = ymdLocal(new Date());
  if (due === today) return { text: "今天", overdue: false };
  if (due < today) {
    const diff = Math.floor(
      (new Date(today).getTime() - new Date(due).getTime()) / 86400000,
    );
    return { text: `逾期 ${diff} 天`, overdue: true };
  }
  const diff = Math.floor(
    (new Date(due).getTime() - new Date(today).getTime()) / 86400000,
  );
  if (diff === 1) return { text: "明天", overdue: false };
  return { text: `${due}（${diff} 天后）`, overdue: false };
}

export default function TasksPage() {
  const navigate = useNavigate();
  const { token } = antdTheme.useToken();
  const { message } = AntdApp.useApp();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [statusFilter, setStatusFilter] = useState<"todo" | "done" | "all">("todo");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [presetPriority, setPresetPriority] = useState<TaskPriority | undefined>(undefined);
  const [presetDueDate, setPresetDueDate] = useState<string | undefined>(undefined);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      // 看板 / 日历视图只展示未完成；列表视图按用户选的 status 过滤
      const statusArg =
        viewMode === "kanban" || viewMode === "calendar"
          ? 0
          : statusFilter === "all"
            ? undefined
            : statusFilter === "todo"
              ? 0
              : 1;
      const list = await taskApi.list({
        status: statusArg,
        keyword: keyword.trim() || undefined,
      });
      setTasks(list);
      // 每次重拉任务列表时，顺带刷新侧边栏紧急任务数
      useAppStore.getState().refreshTaskStats();
    } catch (e) {
      message.error(`加载任务失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [viewMode, statusFilter, keyword, message]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  const grouped = useMemo(() => groupTasks(tasks), [tasks]);

  async function handleToggle(task: Task) {
    try {
      await taskApi.toggleStatus(task.id);
      await loadTasks();
    } catch (e) {
      message.error(`操作失败: ${e}`);
    }
  }

  async function handleDelete(task: Task) {
    try {
      await taskApi.delete(task.id);
      message.success("已删除");
      await loadTasks();
    } catch (e) {
      message.error(`删除失败: ${e}`);
    }
  }

  async function handleOpenLink(link: Task["links"][number]) {
    try {
      if (link.kind === "note") {
        navigate(`/notes/${link.target}`);
      } else {
        await openPath(link.target);
      }
    } catch (e) {
      message.error(`打开失败: ${e}`);
    }
  }

  return (
    <div className="max-w-4xl mx-auto">
      {/* 标题栏 */}
      <div className="flex items-end justify-between mb-4">
        <div>
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <CheckSquare size={20} style={{ color: token.colorPrimary }} />
            待办
          </h1>
          <Text type="secondary" className="text-xs">
            {tasks.filter((t) => t.status === 0).length} 条未完成 ·{" "}
            <span style={{ color: token.colorError }}>
              {tasks.filter((t) => t.status === 0 && t.priority === 0).length} 条紧急
            </span>
          </Text>
        </div>
        <div className="flex items-center gap-2">
          <Segmented
            size="small"
            value={viewMode}
            onChange={(v) => setViewMode(v as ViewMode)}
            options={[
              { label: "列表", value: "list" },
              { label: "看板", value: "kanban" },
              { label: "日历", value: "calendar" },
            ]}
          />
          {viewMode === "list" && (
            <Segmented
              size="small"
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as "todo" | "done" | "all")}
              options={[
                { label: "进行中", value: "todo" },
                { label: "已完成", value: "done" },
                { label: "全部", value: "all" },
              ]}
            />
          )}
          <Button
            type="primary"
            icon={<Plus size={14} />}
            onClick={() => {
              setPresetPriority(undefined);
              setPresetDueDate(undefined);
              setCreateOpen(true);
            }}
          >
            新建任务
          </Button>
        </div>
      </div>

      {/* 搜索 */}
      <Input
        placeholder="搜索任务标题 / 描述"
        prefix={<Search size={14} style={{ color: token.colorTextQuaternary }} />}
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        allowClear
        className="mb-4"
      />

      {loading ? (
        <div className="flex justify-center py-12">
          <Spin />
        </div>
      ) : viewMode === "kanban" ? (
        <KanbanView
          tasks={tasks}
          onRefresh={loadTasks}
          onEdit={setEditing}
          onNew={(p) => {
            setPresetPriority(p);
            setCreateOpen(true);
          }}
        />
      ) : viewMode === "calendar" ? (
        <CalendarView
          tasks={tasks}
          onRefresh={loadTasks}
          onEdit={setEditing}
          onNewOnDate={(ymd) => {
            setPresetPriority(undefined);
            setPresetDueDate(ymd);
            setCreateOpen(true);
          }}
        />
      ) : tasks.length === 0 ? (
        <Empty
          description={
            statusFilter === "done"
              ? "暂无已完成任务"
              : "还没有任务，点右上「新建任务」开始吧"
          }
        />
      ) : (
        <div className="flex flex-col gap-5">
          {grouped.overdue.length > 0 && (
            <TaskSection
              title="逾期"
              icon={<AlertTriangle size={14} style={{ color: token.colorError }} />}
              count={grouped.overdue.length}
              color={token.colorError}
              tasks={grouped.overdue}
              onToggle={handleToggle}
              onDelete={handleDelete}
              onEdit={setEditing}
              onOpenLink={handleOpenLink}
              token={token}
            />
          )}
          {grouped.today.length > 0 && (
            <TaskSection
              title="今天"
              icon={<Sun size={14} style={{ color: token.colorWarning }} />}
              count={grouped.today.length}
              tasks={grouped.today}
              onToggle={handleToggle}
              onDelete={handleDelete}
              onEdit={setEditing}
              onOpenLink={handleOpenLink}
              token={token}
            />
          )}
          {grouped.upcoming.length > 0 && (
            <TaskSection
              title="即将到期"
              icon={<CalendarRange size={14} style={{ color: token.colorPrimary }} />}
              count={grouped.upcoming.length}
              tasks={grouped.upcoming}
              onToggle={handleToggle}
              onDelete={handleDelete}
              onEdit={setEditing}
              onOpenLink={handleOpenLink}
              token={token}
            />
          )}
          {grouped.noDate.length > 0 && (
            <TaskSection
              title="无截止"
              count={grouped.noDate.length}
              tasks={grouped.noDate}
              onToggle={handleToggle}
              onDelete={handleDelete}
              onEdit={setEditing}
              onOpenLink={handleOpenLink}
              token={token}
            />
          )}
          {grouped.done.length > 0 && (
            <TaskSection
              title="已完成"
              count={grouped.done.length}
              tasks={grouped.done}
              onToggle={handleToggle}
              onDelete={handleDelete}
              onEdit={setEditing}
              onOpenLink={handleOpenLink}
              token={token}
            />
          )}
        </div>
      )}

      <CreateTaskModal
        open={createOpen}
        presetPriority={presetPriority}
        presetDueDate={presetDueDate}
        onClose={() => {
          setCreateOpen(false);
          setPresetDueDate(undefined);
        }}
        onSaved={() => {
          setCreateOpen(false);
          setPresetDueDate(undefined);
          loadTasks();
        }}
      />
      <CreateTaskModal
        open={!!editing}
        editing={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          loadTasks();
        }}
      />
    </div>
  );
}

interface SectionProps {
  title: string;
  count: number;
  icon?: React.ReactNode;
  color?: string;
  tasks: Task[];
  token: ReturnType<typeof antdTheme.useToken>["token"];
  onToggle: (t: Task) => void;
  onDelete: (t: Task) => void;
  onEdit: (t: Task) => void;
  onOpenLink: (l: Task["links"][number]) => void;
}

function TaskSection({
  title,
  count,
  icon,
  color,
  tasks,
  token,
  onToggle,
  onDelete,
  onEdit,
  onOpenLink,
}: SectionProps) {
  return (
    <section>
      <div
        className="text-xs font-semibold flex items-center gap-1 mb-2"
        style={{ color: color ?? token.colorTextSecondary }}
      >
        {icon}
        {title} · {count}
      </div>
      <div
        className="rounded-lg border"
        style={{
          background: token.colorBgContainer,
          borderColor: token.colorBorderSecondary,
        }}
      >
        {tasks.map((t, idx) => (
          <TaskRow
            key={t.id}
            task={t}
            isLast={idx === tasks.length - 1}
            token={token}
            onToggle={onToggle}
            onDelete={onDelete}
            onEdit={onEdit}
            onOpenLink={onOpenLink}
          />
        ))}
      </div>
    </section>
  );
}

interface RowProps {
  task: Task;
  isLast: boolean;
  token: ReturnType<typeof antdTheme.useToken>["token"];
  onToggle: (t: Task) => void;
  onDelete: (t: Task) => void;
  onEdit: (t: Task) => void;
  onOpenLink: (l: Task["links"][number]) => void;
}

function TaskRow({ task, isLast, token, onToggle, onDelete, onEdit, onOpenLink }: RowProps) {
  const done = task.status === 1;
  const due = describeDueDate(task.due_date);
  return (
    <div
      className="group flex items-start gap-3 px-4 py-3 transition"
      style={{
        borderBottom: isLast ? "none" : `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      {/* 完成勾选 */}
      <Tooltip title={done ? "标记为未完成" : "标记为已完成"}>
        <button
          onClick={() => onToggle(task)}
          className="mt-0.5 rounded-full flex items-center justify-center transition cursor-pointer shrink-0"
          style={{
            width: 18,
            height: 18,
            border: done
              ? `1.5px solid ${token.colorSuccess}`
              : `1.5px solid ${token.colorBorder}`,
            background: done ? token.colorSuccess : "transparent",
            color: "#fff",
          }}
        >
          {done && <ChevronRight size={12} style={{ transform: "rotate(90deg) scale(0.9)" }} />}
        </button>
      </Tooltip>

      {/* 紧急度圆点 */}
      <span
        className="shrink-0 rounded-full"
        style={{
          width: 8,
          height: 8,
          background: priorityColor(task.priority, token),
          marginTop: 7,
          opacity: done ? 0.35 : 1,
        }}
      />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className="font-medium"
            style={{
              fontSize: 13,
              textDecoration: done ? "line-through" : "none",
              color: done ? token.colorTextTertiary : token.colorText,
            }}
          >
            {task.title}
          </span>
          {due.text && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded"
              style={{
                background: due.overdue
                  ? `${token.colorErrorBg}`
                  : token.colorFillSecondary,
                color: due.overdue ? token.colorError : token.colorTextSecondary,
              }}
            >
              {due.text}
            </span>
          )}
          {task.important && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded"
              style={{
                background: token.colorWarningBg,
                color: token.colorWarning,
              }}
            >
              重要
            </span>
          )}
        </div>
        {task.description && (
          <Paragraph
            type="secondary"
            ellipsis={{ rows: 1 }}
            style={{ marginBottom: 0, fontSize: 11, marginTop: 2 }}
          >
            {task.description}
          </Paragraph>
        )}
        {/* 关联 chips */}
        {task.links.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 mt-1.5">
            {task.links.map((l) => (
              <button
                key={l.id}
                onClick={() => onOpenLink(l)}
                className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[11px] hover:opacity-80 transition cursor-pointer"
                style={{
                  background: token.colorFillTertiary,
                  color: token.colorTextSecondary,
                }}
                title={l.target}
              >
                {l.kind === "note" && <FileText size={10} />}
                {l.kind === "path" && <FolderIcon size={10} />}
                {l.kind === "url" && <LinkIcon size={10} />}
                <span className="truncate max-w-[180px]">
                  {l.label || l.target}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* hover 操作 */}
      <div className="opacity-0 group-hover:opacity-100 transition flex items-center gap-1 shrink-0">
        <Tooltip title="编辑">
          <Button
            type="text"
            size="small"
            icon={<Edit3 size={12} />}
            onClick={() => onEdit(task)}
          />
        </Tooltip>
        <Popconfirm
          title="确定删除？"
          okText="删除"
          okButtonProps={{ danger: true }}
          cancelText="取消"
          onConfirm={() => onDelete(task)}
        >
          <Button type="text" size="small" icon={<Trash2 size={12} />} danger />
        </Popconfirm>
      </div>
    </div>
  );
}
