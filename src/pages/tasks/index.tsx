import { useEffect, useMemo, useState, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Input,
  Button,
  Checkbox,
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
  Search,
  AlertTriangle,
  Sun,
  CalendarRange,
  ChevronRight,
  NotebookText,
  Folder as FolderIcon,
  Link as LinkIcon,
  Trash2,
  Edit3,
  ListChecks,
  X as IconX,
} from "lucide-react";
import { NewTodoButton } from "@/components/NewTodoButton";
import { openPath } from "@tauri-apps/plugin-opener";
import { taskApi, taskCategoryApi } from "@/lib/api";
import { useAppStore } from "@/store";
import type { Task, TaskPriority, TaskCategory } from "@/types";

type ViewMode = "list" | "kanban" | "quadrant" | "calendar";
import { CreateTaskModal } from "@/components/tasks/CreateTaskModal";
import { KanbanView } from "@/components/tasks/KanbanView";
import { QuadrantView } from "@/components/tasks/QuadrantView";
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

/** 从 due_date（可能带时分）中提取 YYYY-MM-DD 日期部分 */
function dueDateOnly(due: string): string {
  return due.slice(0, 10);
}

function groupTasks(tasks: Task[]) {
  const today = ymdLocal(new Date());
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

const WEEKDAY_LABELS = ["", "一", "二", "三", "四", "五", "六", "日"];

/** 用一句中文描述循环规则，供列表上的小 tag 显示 */
function describeRepeat(task: Task): string {
  const { repeat_kind, repeat_interval, repeat_weekdays } = task;
  if (repeat_kind === "none") return "";
  const iv = Math.max(1, repeat_interval);
  if (repeat_kind === "daily") return iv === 1 ? "每天" : `每${iv}天`;
  if (repeat_kind === "monthly") return iv === 1 ? "每月" : `每${iv}月`;
  if (repeat_weekdays) {
    const days = repeat_weekdays
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => n >= 1 && n <= 7)
      .sort((a, b) => a - b);
    if (days.length === 5 && days.join(",") === "1,2,3,4,5") return "工作日";
    return `周${days.map((d) => WEEKDAY_LABELS[d]).join("")}`;
  }
  return iv === 1 ? "每周" : `每${iv}周`;
}

function describeDueDate(due: string | null): { text: string; overdue: boolean } {
  if (!due) return { text: "", overdue: false };
  const today = ymdLocal(new Date());
  const dueDay = dueDateOnly(due);
  // 带时分时把时分单独展示在末尾
  const timeSuffix = due.length > 10 ? ` ${due.slice(11, 16)}` : "";
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

/** SidePanel 的 TasksPanel 和主区共享的筛选键 */
type SmartFilter =
  | "todo"
  | "done"
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
function filterToStatusArg(filter: SmartFilter): 0 | 1 | undefined {
  if (filter === "done") return 1;
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
function applySmartFilter(tasks: Task[], filter: SmartFilter): Task[] {
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
    default:
      // todo / done / all：保持后端 status 过滤的结果（todo 拉全部用于日历回顾）
      return tasks;
  }
}

/** 动态标题：和 SidePanel 选中项呼应，给用户"看的是什么"的反馈 */
function filterTitle(filter: SmartFilter): string {
  switch (filter) {
    case "done": return "已完成";
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

export default function TasksPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { token } = antdTheme.useToken();
  const { message } = AntdApp.useApp();

  // URL 是筛选真相源
  const filter = ((searchParams.get("filter") ?? "todo") as SmartFilter);
  /** URL `?category=` 参数：纯数字 = 分类 ID，"none" = 未分类，null = 不按分类筛选 */
  const categoryParam = searchParams.get("category");

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [presetPriority, setPresetPriority] = useState<TaskPriority | undefined>(undefined);
  const [presetImportant, setPresetImportant] = useState<boolean | undefined>(undefined);
  const [presetDueDate, setPresetDueDate] = useState<string | undefined>(undefined);
  /** 分类列表（用于在任务行内按 category_id 渲染圆点 + 名字） */
  const [categories, setCategories] = useState<TaskCategory[]>([]);
  const categoryMap = useMemo(() => {
    const m = new Map<number, TaskCategory>();
    for (const c of categories) m.set(c.id, c);
    return m;
  }, [categories]);

  useEffect(() => {
    taskCategoryApi
      .list()
      .then(setCategories)
      .catch(() => setCategories([]));
  }, []);

  // 多选模式（仅 list 视图，切到 kanban/quadrant/calendar 自动退出）
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  function toggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function clearSelection() {
    setSelectedIds(new Set());
  }
  function exitMultiSelect() {
    setMultiSelect(false);
    setSelectedIds(new Set());
  }
  // 切视图时自动退出多选
  useEffect(() => {
    if (viewMode !== "list" && multiSelect) {
      exitMultiSelect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode]);

  // SidePanel 传 ?new=1 唤起新建 Modal（一次性，消费后清掉参数）
  useEffect(() => {
    if (searchParams.get("new") === "1") {
      setPresetPriority(undefined);
      setPresetImportant(undefined);
      setPresetDueDate(undefined);
      setCreateOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete("new");
      navigate(`/tasks${next.toString() ? `?${next.toString()}` : ""}`, {
        replace: true,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // 顶栏 Ctrl+K 搜索点中某条待办：?taskId=N → 自动打开编辑 Modal
  // 一次性消费：拉到任务后 setEditing 并清掉 URL 参数，避免后续刷新还触发
  useEffect(() => {
    const tid = searchParams.get("taskId");
    if (!tid) return;
    const id = Number(tid);
    if (!Number.isFinite(id) || id <= 0) return;
    let cancelled = false;
    taskApi
      .get(id)
      .then((task) => {
        if (cancelled) return;
        setEditing(task);
      })
      .catch((e) => {
        message.error(`任务不存在或已删除: ${e}`);
      })
      .finally(() => {
        if (cancelled) return;
        const next = new URLSearchParams(searchParams);
        next.delete("taskId");
        navigate(`/tasks${next.toString() ? `?${next.toString()}` : ""}`, {
          replace: true,
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      // 数据范围策略：
      //   · 日历视图：拉全部（含已完成），让用户回顾历史完成情况；CalendarView 内部把
      //     已完成置灰、未完成正常显示。
      //   · 看板视图：仅未完成（看板 Done 列改造另议）。
      //   · 列表视图：filter=todo（"全部任务"默认入口）拉全部，已完成进底部折叠区；
      //     其他 filter（如 done / urgent / today...）维持原 status 行为。
      let statusArg: 0 | 1 | undefined;
      if (viewMode === "calendar") {
        statusArg = undefined;
      } else if (viewMode === "kanban" || viewMode === "quadrant") {
        statusArg = 0;
      } else {
        statusArg = filter === "todo" ? undefined : filterToStatusArg(filter);
      }
      // 分类筛选下放给后端：URL 上的 category 参数转成 category_id / uncategorized
      const categoryQuery = categoryParam
        ? categoryParam === "none"
          ? { uncategorized: true }
          : { category_id: Number(categoryParam) }
        : {};
      const list = await taskApi.list({
        status: statusArg,
        keyword: keyword.trim() || undefined,
        ...categoryQuery,
      });
      // overdue / today / urgent 这些维度后端暂未支持参数，前端二次过滤
      setTasks(applySmartFilter(list, filter));
      // 每次重拉任务列表时，顺带刷新侧边栏紧急任务数
      useAppStore.getState().refreshTaskStats();
    } catch (e) {
      message.error(`加载任务失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [viewMode, filter, keyword, categoryParam, message]);

  // 订阅全局 tasksListRefreshTick：提醒弹窗 / 紧急窗 / 后台 reminder 推进循环
  // 任务等场景修改任务后会 bump tick，让本页自动重拉，无需关页再开
  const tasksListRefreshTick = useAppStore((s) => s.tasksListRefreshTick);

  useEffect(() => {
    loadTasks();
  }, [loadTasks, tasksListRefreshTick]);

  const grouped = useMemo(() => groupTasks(tasks), [tasks]);

  // "全部任务"视图底部折叠区只展示最近 7 天完成的（避免历史归档塞满主区）；
  // 其他 filter（如 done）下不裁剪，由其自有渲染分支处理
  const recentDoneTasks = useMemo(() => {
    if (filter !== "todo") return grouped.done;
    const cutoff = ymdLocal(new Date(Date.now() - 7 * 86400000));
    return grouped.done.filter((t) => {
      const day = t.completed_at?.slice(0, 10);
      // 旧数据可能缺 completed_at，宽容保留以免"消失"
      return !day || day >= cutoff;
    });
  }, [grouped.done, filter]);

  async function handleToggle(task: Task) {
    try {
      if (task.status === 0 && task.repeat_kind !== "none") {
        // 循环任务：完成本次并推进到下一次；若想结束整条循环，在提醒 Modal 或编辑页里操作
        await taskApi.completeOccurrence(task.id);
      } else {
        await taskApi.toggleStatus(task.id);
      }
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

  // ─── 批量操作（多选模式）────────────────────
  async function handleBatchDelete() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    try {
      const removed = await taskApi.deleteBatch(ids);
      message.success(`已删除 ${removed} 条任务`);
      exitMultiSelect();
      await loadTasks();
    } catch (e) {
      message.error(`批量删除失败: ${e}`);
    }
  }
  async function handleBatchComplete() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    try {
      const updated = await taskApi.completeBatch(ids);
      message.success(`已标记完成 ${updated} 条任务`);
      exitMultiSelect();
      await loadTasks();
    } catch (e) {
      message.error(`批量完成失败: ${e}`);
    }
  }
  /** 全选当前可见的未完成任务（已完成的不参与，避免误操作） */
  function selectAllVisible() {
    const ids = tasks.filter((t) => t.status === 0).map((t) => t.id);
    setSelectedIds(new Set(ids));
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
    <div className="max-w-4xl mx-auto h-full flex flex-col min-h-0">
      {/* 标题栏：标题随 SidePanel 选择动态变化，操作栏只留视图模式 + AI + 新建
          顶部头(标题 + 搜索) flex-shrink-0 永不滚动；下面列表区单独可滚 */}
      <div className="flex items-end justify-between mb-2 flex-shrink-0">
        <div>
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <CheckSquare size={20} style={{ color: token.colorPrimary }} />
            {(() => {
              if (categoryParam === "none") return "未分类";
              if (categoryParam) {
                const c = categoryMap.get(Number(categoryParam));
                if (c) {
                  return (
                    <span className="inline-flex items-center gap-2">
                      <span
                        style={{
                          display: "inline-block",
                          width: 12,
                          height: 12,
                          borderRadius: 999,
                          background: c.color,
                        }}
                      />
                      {c.name}
                    </span>
                  );
                }
              }
              return filterTitle(filter);
            })()}
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
              { label: "四象限", value: "quadrant" },
              { label: "日历", value: "calendar" },
            ]}
          />
          {viewMode === "list" && (
            <Button
              icon={multiSelect ? <IconX size={14} /> : <ListChecks size={14} />}
              onClick={() => {
                if (multiSelect) {
                  exitMultiSelect();
                } else {
                  setMultiSelect(true);
                  setSelectedIds(new Set());
                }
              }}
              title={multiSelect ? "退出多选" : "进入多选模式（批量删除/完成）"}
              type={multiSelect ? "primary" : "default"}
            >
              {multiSelect ? "退出多选" : "多选"}
            </Button>
          )}
          <NewTodoButton
            onSaved={() => {
              loadTasks();
              useAppStore.getState().refreshTaskStats();
            }}
          />
        </div>
      </div>

      {/* 搜索 */}
      <Input
        placeholder="搜索任务标题 / 描述"
        prefix={<Search size={14} style={{ color: token.colorTextQuaternary }} />}
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        allowClear
        className="mb-3 flex-shrink-0"
      />

      <div className="flex-1 min-h-0 overflow-auto pr-1">
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
            setPresetImportant(undefined);
            setCreateOpen(true);
          }}
        />
      ) : viewMode === "quadrant" ? (
        <QuadrantView
          tasks={tasks}
          onRefresh={loadTasks}
          onEdit={setEditing}
          onNew={(preset) => {
            setPresetPriority(preset.priority);
            setPresetImportant(preset.important);
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
            setPresetImportant(undefined);
            setPresetDueDate(ymd);
            setCreateOpen(true);
          }}
        />
      ) : tasks.length === 0 ? (
        <Empty
          description={
            filter === "done"
              ? "暂无已完成任务"
              : filter === "overdue"
                ? "太棒了，没有逾期任务 ✨"
                : filter === "today"
                  ? "今天没有到期的任务"
                  : filter === "week"
                    ? "本周没有到期任务"
                    : filter === "no-date"
                      ? "所有任务都有日期"
                      : filter === "urgent"
                        ? "没有紧急任务"
                        : filter === "normal"
                          ? "没有普通优先级任务"
                          : filter === "low"
                            ? "没有低优先级任务"
                            : filter === "recurring"
                              ? "没有循环任务"
                              : filter === "linked"
                                ? "没有关联笔记/文件的任务"
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
              multiSelect={multiSelect}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              categoryMap={categoryMap}
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
              multiSelect={multiSelect}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              categoryMap={categoryMap}
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
              multiSelect={multiSelect}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              categoryMap={categoryMap}
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
              multiSelect={multiSelect}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              categoryMap={categoryMap}
            />
          )}
          {filter === "todo"
            ? recentDoneTasks.length > 0 && (
                <TaskSection
                  title={
                    <span>
                      已完成
                      {grouped.done.length > recentDoneTasks.length && (
                        <span
                          style={{
                            fontWeight: 400,
                            color: token.colorTextTertiary,
                            marginLeft: 6,
                          }}
                        >
                          （最近 7 天 ·{" "}
                          <a
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate("/tasks?filter=done");
                            }}
                            style={{ color: token.colorPrimary }}
                          >
                            查看全部 {grouped.done.length} 条
                          </a>
                          ）
                        </span>
                      )}
                    </span>
                  }
                  count={recentDoneTasks.length}
                  color={token.colorTextTertiary}
                  tasks={recentDoneTasks}
                  onToggle={handleToggle}
                  onDelete={handleDelete}
                  onEdit={setEditing}
                  onOpenLink={handleOpenLink}
                  token={token}
                  multiSelect={multiSelect}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelect}
                  categoryMap={categoryMap}
                />
              )
            : grouped.done.length > 0 && (
                <TaskSection
                  title="已完成"
                  count={grouped.done.length}
                  tasks={grouped.done}
                  onToggle={handleToggle}
                  onDelete={handleDelete}
                  onEdit={setEditing}
                  onOpenLink={handleOpenLink}
                  token={token}
                  multiSelect={multiSelect}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelect}
                  categoryMap={categoryMap}
                />
              )}
        </div>
      )}

      </div>

      {/* 多选模式底部 ActionBar：浮在屏幕底部，仅 list 视图 + 选中至少 1 条时显示 */}
      {multiSelect && viewMode === "list" && selectedIds.size > 0 && (
        <div
          className="fixed left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2 rounded-full shadow-lg"
          style={{
            bottom: 24,
            background: token.colorBgElevated,
            border: `1px solid ${token.colorBorder}`,
            boxShadow: token.boxShadow,
          }}
        >
          <span className="text-xs" style={{ color: token.colorTextSecondary }}>
            已选 <strong style={{ color: token.colorPrimary }}>{selectedIds.size}</strong> 条
          </span>
          <Button
            size="small"
            type="link"
            onClick={selectAllVisible}
            style={{ padding: 0 }}
          >
            全选未完成
          </Button>
          <Button
            size="small"
            type="link"
            onClick={clearSelection}
            style={{ padding: 0 }}
          >
            清空
          </Button>
          <span style={{ color: token.colorBorderSecondary }}>|</span>
          <Button
            size="small"
            icon={<CheckSquare size={12} />}
            onClick={handleBatchComplete}
          >
            标记完成
          </Button>
          <Popconfirm
            title={`确认删除选中的 ${selectedIds.size} 条任务？`}
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={handleBatchDelete}
          >
            <Button size="small" danger icon={<Trash2 size={12} />}>
              删除
            </Button>
          </Popconfirm>
          <Button
            size="small"
            type="text"
            icon={<IconX size={12} />}
            onClick={exitMultiSelect}
            title="退出多选"
          />
        </div>
      )}

      <CreateTaskModal
        open={createOpen}
        presetPriority={presetPriority}
        presetImportant={presetImportant}
        presetDueDate={presetDueDate}
        onClose={() => {
          setCreateOpen(false);
          setPresetImportant(undefined);
          setPresetDueDate(undefined);
        }}
        onSaved={() => {
          setCreateOpen(false);
          setPresetImportant(undefined);
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
      {/* AI 规划 / 添加待办的三个 Modal 已封装进 NewTodoButton；本页面不再单独挂 */}
    </div>
  );
}

interface SectionProps {
  /** 支持 ReactNode 以便在标题里嵌"查看全部"等链接 */
  title: React.ReactNode;
  count: number;
  icon?: React.ReactNode;
  color?: string;
  tasks: Task[];
  token: ReturnType<typeof antdTheme.useToken>["token"];
  onToggle: (t: Task) => void;
  onDelete: (t: Task) => void;
  onEdit: (t: Task) => void;
  onOpenLink: (l: Task["links"][number]) => void;
  /** 多选态相关；undefined 表示非多选态 */
  multiSelect?: boolean;
  selectedIds?: Set<number>;
  onToggleSelect?: (id: number) => void;
  /** 显式隐藏标题的留口（备用） */
  hideHeader?: boolean;
  /** 分类映射（id → category），用于行内渲染分类圆点 */
  categoryMap?: Map<number, TaskCategory>;
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
  multiSelect,
  selectedIds,
  onToggleSelect,
  hideHeader,
  categoryMap,
}: SectionProps) {
  return (
    <section>
      {!hideHeader && (
        <div
          className="text-xs font-semibold flex items-center gap-1 mb-2"
          style={{ color: color ?? token.colorTextSecondary }}
        >
          {icon}
          {title} · {count}
        </div>
      )}
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
            multiSelect={multiSelect}
            selected={selectedIds?.has(t.id)}
            onToggleSelect={onToggleSelect}
            category={t.category_id != null ? categoryMap?.get(t.category_id) : undefined}
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
  multiSelect?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: number) => void;
  /** 任务对应的分类（已 join 好），用于行内渲染圆点 + 名字；缺省/未分类则不渲染 */
  category?: TaskCategory;
}

function TaskRow({
  task,
  isLast,
  token,
  onToggle,
  onDelete,
  onEdit,
  onOpenLink,
  multiSelect,
  selected,
  onToggleSelect,
  category,
}: RowProps) {
  const done = task.status === 1;
  const due = describeDueDate(task.due_date);
  const isSelected = !!selected;
  return (
    <div
      className="group flex items-start gap-3 px-4 py-3 transition"
      style={{
        borderBottom: isLast ? "none" : `1px solid ${token.colorBorderSecondary}`,
        background:
          multiSelect && isSelected ? token.colorPrimaryBg : "transparent",
        cursor: multiSelect ? "pointer" : "default",
      }}
      onClick={
        multiSelect ? () => onToggleSelect?.(task.id) : undefined
      }
    >
      {/* 多选态：复选框；普通态：完成勾选 */}
      {multiSelect ? (
        <Checkbox
          checked={isSelected}
          onChange={() => onToggleSelect?.(task.id)}
          onClick={(e) => e.stopPropagation()}
          style={{ marginTop: 2 }}
        />
      ) : (
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
            {done && (
              <ChevronRight
                size={12}
                style={{ transform: "rotate(90deg) scale(0.9)" }}
              />
            )}
          </button>
        </Tooltip>
      )}

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
          {task.repeat_kind !== "none" && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded"
              style={{
                background: token.colorInfoBg,
                color: token.colorInfoText ?? token.colorPrimary,
              }}
              title="循环任务"
            >
              {describeRepeat(task)}
            </span>
          )}
          {category && (
            <span
              className="inline-flex items-center gap-1 text-[10px]"
              style={{ color: token.colorTextTertiary }}
              title={`分类：${category.name}`}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: category.color,
                  opacity: done ? 0.4 : 1,
                }}
              />
              {category.name}
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
                {l.kind === "note" && <NotebookText size={10} />}
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

      {/* hover 操作（多选态下隐藏，避免误触） */}
      {!multiSelect && (
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
      )}
    </div>
  );
}
