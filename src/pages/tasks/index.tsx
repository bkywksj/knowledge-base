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
  DatePicker,
  theme as antdTheme,
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import {
  CheckSquare,
  Search,
  AlertTriangle,
  Sun,
  CalendarRange,
  ChevronRight,
  ChevronDown,
  NotebookText,
  Folder as FolderIcon,
  Link as LinkIcon,
  Trash2,
  Edit3,
  ListChecks,
  X as IconX,
  Copy,
  Flame,
  Circle,
  Check as IconCheck,
  Ban,
} from "lucide-react";
import { useContextMenu } from "@/hooks/useContextMenu";
import {
  ContextMenuOverlay,
  type ContextMenuEntry,
} from "@/components/ui/ContextMenuOverlay";
import { NewTodoButton } from "@/components/NewTodoButton";
import { openPath } from "@tauri-apps/plugin-opener";
import { taskApi, taskCategoryApi } from "@/lib/api";
import { filterTasksByDateRange } from "@/lib/taskDateFilter";
import { MicButton } from "@/components/MicButton";
import { useAppStore } from "@/store";
import type { Task, TaskPriority, TaskCategory, TaskStatus } from "@/types";
import { TASK_STATUS_ABANDONED, isAbandoned } from "@/types";

type ViewMode = "list" | "kanban" | "quadrant" | "calendar" | "gantt";
import { CreateTaskModal } from "@/components/tasks/CreateTaskModal";
import { SubtaskList } from "@/components/tasks/SubtaskList";
import { TaskDetailModal } from "@/components/tasks/TaskDetailModal";
import { KanbanView } from "@/components/tasks/KanbanView";
import { QuadrantView } from "@/components/tasks/QuadrantView";
import { CalendarView } from "@/components/tasks/CalendarView";
import { GanttView } from "@/components/tasks/GanttView";
import { ProjectManageModal } from "@/components/tasks/ProjectManageModal";

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

function describeDueDate(
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

/** SidePanel 的 TasksPanel 和主区共享的筛选键 */
type SmartFilter =
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
function filterToStatusArg(filter: SmartFilter): TaskStatus | undefined {
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
function applySmartFilter(
  tasks: Task[],
  filter: SmartFilter,
  viewMode: ViewMode = "list",
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
function filterTitle(filter: SmartFilter): string {
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

function DesktopTasksPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { token } = antdTheme.useToken();
  const { message } = AntdApp.useApp();

  // URL 是筛选真相源
  const filter = ((searchParams.get("filter") ?? "todo") as SmartFilter);
  /** URL `?category=` 参数：纯数字 = 分类 ID，"none" = 未分类，null = 不按分类筛选 */
  const categoryParam = searchParams.get("category");

  const [tasks, setTasks] = useState<Task[]>([]);
  /** 局部更新单条任务字段（避免 reload 整列表造成闪烁），子任务勾选/增删后用 */
  const patchTask = useCallback((id: number, patch: Partial<Task>) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  /** 日期区间筛选（前端过滤，不重拉后端）：[开始, 结束]，任一端可为 null 表示不限 */
  const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  /** 行点击 → 只读详情 Modal（与首页一致）；编辑走 hover Edit / 右键菜单 → setEditing */
  const [detailViewing, setDetailViewing] = useState<Task | null>(null);
  // 初值取持久化的「待办默认视图」（设置页可改），不再写死 list
  const [viewMode, setViewMode] = useState<ViewMode>(
    () => useAppStore.getState().tasksDefaultView,
  );
  const [projectManageOpen, setProjectManageOpen] = useState(false);
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
      let statusArg: TaskStatus | undefined;
      // 甘特图 / 日历都要看全量（含已完成）才能展示完整时间线；
      // 看板 / 四象限默认只看未完成（已完成的去 list 视图查）
      if (viewMode === "calendar" || viewMode === "gantt") {
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
      setTasks(applySmartFilter(list, filter, viewMode));
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

  /** 日期筛选是否生效（两端全空 = 未启用） */
  const dateActive = !!(dateRange?.[0] || dateRange?.[1]);
  /** 快捷区间预设（周起始由 dayjs zh-cn locale 决定 = 周一，见 main.tsx） */
  const datePresets = useMemo<Array<{ label: string; value: [Dayjs, Dayjs] }>>(() => {
    const today = dayjs();
    const yesterday = today.subtract(1, "day");
    const lastMonth = today.subtract(1, "month");
    return [
      { label: "今天", value: [today, today] },
      { label: "昨天", value: [yesterday, yesterday] },
      { label: "最近 7 天", value: [today.subtract(6, "day"), today] },
      { label: "最近 30 天", value: [today.subtract(29, "day"), today] },
      { label: "本周", value: [today.startOf("week"), today.endOf("week")] },
      { label: "本月", value: [today.startOf("month"), today.endOf("month")] },
      { label: "上月", value: [lastMonth.startOf("month"), lastMonth.endOf("month")] },
    ];
  }, []);
  /** 日历 / 甘特自带时间轴，日期区间对它们没意义，也不参与过滤 */
  const dateFilterApplicable = viewMode !== "calendar" && viewMode !== "gantt";

  /** 经日期区间过滤后的任务：列表 / 看板 / 四象限都用它，日历 / 甘特仍看全量 */
  const visibleTasks = useMemo(() => {
    if (!dateActive || !dateFilterApplicable) return tasks;
    const start = dateRange?.[0] ? dateRange[0].format("YYYY-MM-DD") : null;
    const end = dateRange?.[1] ? dateRange[1].format("YYYY-MM-DD") : null;
    return filterTasksByDateRange(tasks, start, end);
  }, [tasks, dateRange, dateActive, dateFilterApplicable]);

  const grouped = useMemo(() => groupTasks(visibleTasks), [visibleTasks]);

  // "全部任务"视图底部折叠区只展示最近 7 天完成的（避免历史归档塞满主区）；
  // 其他 filter（如 done）下不裁剪，由其自有渲染分支处理。
  // 日期筛选生效时也不裁剪：用户已经指定了要看的区间，再叠加"最近 7 天"
  // 会让选了旧区间却什么都看不到。
  const recentDoneTasks = useMemo(() => {
    if (filter !== "todo" || dateActive) return grouped.done;
    const cutoff = ymdLocal(new Date(Date.now() - 7 * 86400000));
    return grouped.done.filter((t) => {
      const day = t.completed_at?.slice(0, 10);
      // 旧数据可能缺 completed_at，宽容保留以免"消失"
      return !day || day >= cutoff;
    });
  }, [grouped.done, filter, dateActive]);

  async function handleToggle(task: Task) {
    try {
      if (isAbandoned(task)) {
        // 放弃态的勾选框语义是「恢复」——后端 toggle 对 status=2 是无操作，
        // 这里必须显式走 restore，否则点了没反应
        await taskApi.restoreAbandoned(task.id);
        message.success("已恢复为未完成");
      } else if (task.status === 0 && task.repeat_kind !== "none") {
        // 循环任务：完成本次并推进到下一次；若想结束整条循环，在提醒 Modal 或编辑页里操作
        await taskApi.completeOccurrence(task.id);
      } else {
        await taskApi.toggleStatus(task.id);
      }
      await loadTasks();
      useAppStore.getState().refreshTaskStats();
    } catch (e) {
      message.error(`操作失败: ${e}`);
    }
  }

  /** 放弃任务：留档但不再进待办 / 不提醒 / 不计入完成率 */
  async function handleAbandon(task: Task) {
    try {
      await taskApi.abandon(task.id);
      message.success("已放弃（可在「已放弃」里找回）");
      await loadTasks();
      useAppStore.getState().refreshTaskStats();
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
  /** 全选当前可见的未完成任务（已完成的不参与，避免误操作）。
   *  以日期筛选后的列表为准——屏幕上看不见的任务不该被"全选"选中。 */
  function selectAllVisible() {
    const ids = visibleTasks.filter((t) => t.status === 0).map((t) => t.id);
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

  // 全部视图统一：全宽 + 两侧 16px(px-4) 内边距，边界一致；不再按视图切窄/宽栏，
  // 避免切视图时容器宽度变化导致右上角按钮群位置跳动。
  return (
    <div className="w-full h-full flex flex-col min-h-0 px-4">
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
            {/* 「已放弃」/「已完成」列表里全是非待办任务，"0 条未完成 · 0 条紧急"
                纯属噪音，改报条数 */}
            {filter === "abandoned" || filter === "done" ? (
              `共 ${visibleTasks.length} 条`
            ) : (
              <>
                {visibleTasks.filter((t) => t.status === 0).length} 条未完成 ·{" "}
                <span style={{ color: token.colorError }}>
                  {visibleTasks.filter((t) => t.status === 0 && t.priority === 0).length} 条紧急
                </span>
              </>
            )}
            {dateActive && dateFilterApplicable && (
              <span style={{ color: token.colorTextTertiary }}>
                {" "}
                · 已按日期筛选
              </span>
            )}
          </Text>
        </div>
        <div className="flex items-center gap-2">
          {/* 视图相关的次要按钮放在 Segmented 左侧：这样 Segmented(视图切换) 与
              添加待办 锚定在最右侧，切换视图时它们的位置不动，只有左侧的次要按钮进出。 */}
          {viewMode === "gantt" && (
            <Button
              size="small"
              icon={<FolderIcon size={14} />}
              onClick={() => setProjectManageOpen(true)}
              title="项目管理"
            >
              项目管理
            </Button>
          )}
          {viewMode === "list" && (
            <Button
              size="small"
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
          <Segmented
            size="small"
            value={viewMode}
            onChange={(v) => setViewMode(v as ViewMode)}
            options={[
              { label: "列表", value: "list" },
              { label: "看板", value: "kanban" },
              { label: "四象限", value: "quadrant" },
              { label: "日历", value: "calendar" },
              { label: "甘特图", value: "gantt" },
            ]}
          />
          <NewTodoButton
            onSaved={() => {
              loadTasks();
              useAppStore.getState().refreshTaskStats();
            }}
          />
        </div>
      </div>

      {/* 搜索 + 日期筛选（日历 / 甘特自带时间轴，不显示日期筛选） */}
      <div className="flex items-center gap-2 mb-3 flex-shrink-0">
        <Input
          placeholder="搜索任务标题 / 描述"
          prefix={<Search size={14} style={{ color: token.colorTextQuaternary }} />}
          suffix={
            <MicButton
              size="small"
              stripTrailingPunctuation
              onTranscribed={(text) =>
                setKeyword((prev) => (prev ? `${prev} ${text}` : text))
              }
            />
          }
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          allowClear
          className="flex-1 min-w-0"
        />
        {dateFilterApplicable && (
          <DatePicker.RangePicker
            value={dateRange}
            onChange={(v) => setDateRange(v as [Dayjs | null, Dayjs | null] | null)}
            // 允许只填一端 → 「某天之前 / 之后」的开区间筛选
            allowEmpty={[true, true]}
            presets={datePresets}
            placeholder={["开始日期", "结束日期"]}
            title="按日期筛选：未完成看截止日期，已完成 / 已放弃看完成日期"
            style={{ width: 250, flexShrink: 0 }}
          />
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-auto pr-1">
      {loading ? (
        <div className="flex justify-center py-12">
          <Spin />
        </div>
      ) : viewMode === "kanban" ? (
        <KanbanView
          tasks={visibleTasks}
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
          tasks={visibleTasks}
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
          categoryMap={categoryMap}
          onNewOnDate={(ymd) => {
            setPresetPriority(undefined);
            setPresetImportant(undefined);
            setPresetDueDate(ymd);
            setCreateOpen(true);
          }}
        />
      ) : viewMode === "gantt" ? (
        <GanttView
          tasks={tasks}
          onRefresh={loadTasks}
          onEdit={setEditing}
        />
      ) : visibleTasks.length === 0 ? (
        <Empty
          description={
            // 日期筛选把结果清空时，先说"是日期筛掉的"——否则用户会误以为真没任务
            dateActive
              ? "所选日期范围内没有任务"
              : filter === "done"
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
              onAbandon={handleAbandon}
              onEdit={setEditing}
              onRowClick={setDetailViewing}
              onOpenLink={handleOpenLink}
              token={token}
              multiSelect={multiSelect}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              categoryMap={categoryMap}
              onUpdated={loadTasks}
              onPatchTask={patchTask}
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
              onAbandon={handleAbandon}
              onEdit={setEditing}
              onRowClick={setDetailViewing}
              onOpenLink={handleOpenLink}
              token={token}
              multiSelect={multiSelect}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              categoryMap={categoryMap}
              onUpdated={loadTasks}
              onPatchTask={patchTask}
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
              onAbandon={handleAbandon}
              onEdit={setEditing}
              onRowClick={setDetailViewing}
              onOpenLink={handleOpenLink}
              token={token}
              multiSelect={multiSelect}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              categoryMap={categoryMap}
              onUpdated={loadTasks}
              onPatchTask={patchTask}
            />
          )}
          {grouped.noDate.length > 0 && (
            <TaskSection
              title="无截止"
              count={grouped.noDate.length}
              tasks={grouped.noDate}
              onToggle={handleToggle}
              onDelete={handleDelete}
              onAbandon={handleAbandon}
              onEdit={setEditing}
              onRowClick={setDetailViewing}
              onOpenLink={handleOpenLink}
              token={token}
              multiSelect={multiSelect}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              categoryMap={categoryMap}
              onUpdated={loadTasks}
              onPatchTask={patchTask}
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
                  onAbandon={handleAbandon}
                  onEdit={setEditing}
                  onRowClick={setDetailViewing}
                  onOpenLink={handleOpenLink}
                  token={token}
                  multiSelect={multiSelect}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelect}
                  categoryMap={categoryMap}
                  onUpdated={loadTasks}
                  onPatchTask={patchTask}
                />
              )
            : grouped.done.length > 0 && (
                <TaskSection
                  // groupTasks 把「已完成」和「已放弃」都收进 done 分组（两者都不再待办），
                  // 所以标题要看当前筛选：在「已放弃」列表里写"已完成"会前后矛盾
                  title={filter === "abandoned" ? "已放弃" : "已完成"}
                  count={grouped.done.length}
                  tasks={grouped.done}
                  onToggle={handleToggle}
                  onDelete={handleDelete}
                  onAbandon={handleAbandon}
                  onEdit={setEditing}
                  onRowClick={setDetailViewing}
                  onOpenLink={handleOpenLink}
                  token={token}
                  multiSelect={multiSelect}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelect}
                  categoryMap={categoryMap}
                  onUpdated={loadTasks}
                  onPatchTask={patchTask}
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
        // 子任务变更：复用 patchTask 局部更新（避免全量 reload 闪烁）
        onSubtaskChanged={(done, total) => {
          if (!editing) return;
          patchTask(editing.id, { subtask_done: done, subtask_total: total });
        }}
      />
      {/* 行点击 → 只读详情 Modal（与首页一致）；编辑入口：详情 Modal 内编辑按钮 / hover Edit / 右键菜单 */}
      <TaskDetailModal
        task={detailViewing}
        onClose={() => setDetailViewing(null)}
        onToggleStatus={(id) => {
          const t = tasks.find((x) => x.id === id);
          if (t) void handleToggle(t);
        }}
        onSubtaskChanged={(id, done, total) => {
          patchTask(id, { subtask_done: done, subtask_total: total });
        }}
        onEdit={(t) => setEditing(t)}
      />
      {/* AI 规划 / 添加待办的三个 Modal 已封装进 NewTodoButton；本页面不再单独挂 */}
      <ProjectManageModal
        open={projectManageOpen}
        onClose={() => setProjectManageOpen(false)}
        onChanged={() => loadTasks()}
      />
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
  /** 放弃任务（status=2）：留档但不再进待办；右键菜单用 */
  onAbandon?: (t: Task) => void;
  onEdit: (t: Task) => void;
  /** 行 onClick → 弹只读详情 Modal（与首页保持一致）；编辑走 hover Edit / 右键菜单 */
  onRowClick: (t: Task) => void;
  onOpenLink: (l: Task["links"][number]) => void;
  /** 右键菜单中"改优先级"等需要重拉列表的操作完成后回调，由父级触发 loadTasks */
  onUpdated?: () => void;
  /** 局部更新单条 task 字段（不 reload 整列表） —— 子任务勾选/增删后由父级
   * 用此 patch subtask_done/total，避免重拉造成列表闪烁 */
  onPatchTask?: (id: number, patch: Partial<Task>) => void;
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
  onAbandon,
  onEdit,
  onRowClick,
  onOpenLink,
  onUpdated,
  onPatchTask,
  multiSelect,
  selectedIds,
  onToggleSelect,
  hideHeader,
  categoryMap,
}: SectionProps) {
  const { message } = AntdApp.useApp();
  // 右键菜单：每个 section 独立 ctx state；同一时刻只有一个 section 弹菜单不冲突
  const ctx = useContextMenu<Task>();
  // 行内展开的 task id 集合（内存态，组件重挂载 / 切视图重置）
  const [expandedIds, setExpandedIds] = useState<Set<number>>(() => new Set());

  /** 把任务序列化成 markdown 列表项 */
  function toMarkdown(t: Task): string {
    // 放弃的任务用 [-]（Obsidian / Logseq 的"取消"约定），别用 [x] 冒充完成
    const checkbox = isAbandoned(t) ? "[-]" : t.status === 1 ? "[x]" : "[ ]";
    const due = t.due_date ? ` (截止: ${t.due_date.slice(0, 16)})` : "";
    return `- ${checkbox} ${t.title}${due}`;
  }

  async function changePriority(t: Task, p: 0 | 1 | 2) {
    try {
      await taskApi.update(t.id, { priority: p });
      message.success(p === 0 ? "已设为紧急" : p === 1 ? "已设为普通" : "已设为低");
      onUpdated?.();
    } catch (e) {
      message.error(`修改优先级失败：${e}`);
    }
  }

  const menuItems: ContextMenuEntry[] = useMemo(() => {
    const t = ctx.state.payload;
    if (!t) return [];
    const done = t.status === 1;
    const abandoned = isAbandoned(t);
    return [
      {
        key: "toggle",
        label: abandoned
          ? "恢复为未完成"
          : done
            ? "标记为未完成"
            : "标记已完成",
        icon: <IconCheck size={13} />,
        onClick: () => {
          ctx.close();
          onToggle(t);
        },
      },
      // 放弃：事情黄了但想留个记录。已放弃的任务这里不再重复给入口（上面的
      // 「恢复为未完成」就是它的反向操作）
      ...(abandoned
        ? []
        : [
            {
              key: "abandon",
              label: "放弃这个任务",
              icon: <Ban size={13} />,
              onClick: () => {
                ctx.close();
                onAbandon?.(t);
              },
            } as ContextMenuEntry,
          ]),
      {
        key: "edit",
        label: "编辑任务",
        icon: <Edit3 size={13} />,
        onClick: () => {
          ctx.close();
          onEdit(t);
        },
      },
      {
        key: "copy",
        label: "复制为 Markdown",
        icon: <Copy size={13} />,
        onClick: () => {
          ctx.close();
          navigator.clipboard
            .writeText(toMarkdown(t))
            .then(() => message.success("已复制"))
            .catch((err) => message.error(`复制失败：${err}`));
        },
      },
      { type: "divider" },
      {
        key: "p-urgent",
        label: "设为紧急",
        icon: <Flame size={13} />,
        disabled: t.priority === 0,
        hint: t.priority === 0 ? "✓" : undefined,
        onClick: () => {
          ctx.close();
          void changePriority(t, 0);
        },
      },
      {
        key: "p-normal",
        label: "设为普通",
        icon: <Circle size={13} />,
        disabled: t.priority === 1,
        hint: t.priority === 1 ? "✓" : undefined,
        onClick: () => {
          ctx.close();
          void changePriority(t, 1);
        },
      },
      {
        key: "p-low",
        label: "设为低",
        icon: <Circle size={13} />,
        disabled: t.priority === 2,
        hint: t.priority === 2 ? "✓" : undefined,
        onClick: () => {
          ctx.close();
          void changePriority(t, 2);
        },
      },
      { type: "divider" },
      {
        key: "delete",
        label: "删除任务",
        icon: <Trash2 size={13} />,
        danger: true,
        onClick: () => {
          ctx.close();
          onDelete(t);
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.state.payload]);

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
            onRowClick={onRowClick}
            onOpenLink={onOpenLink}
            multiSelect={multiSelect}
            selected={selectedIds?.has(t.id)}
            onToggleSelect={onToggleSelect}
            category={t.category_id != null ? categoryMap?.get(t.category_id) : undefined}
            contextActive={ctx.state.payload?.id === t.id}
            onContextMenu={(e) => {
              e.preventDefault();
              ctx.open(e.nativeEvent, t);
            }}
            expanded={expandedIds.has(t.id)}
            onToggleExpand={() =>
              setExpandedIds((prev) => {
                const next = new Set(prev);
                if (next.has(t.id)) next.delete(t.id);
                else next.add(t.id);
                return next;
              })
            }
            onSubtaskChanged={(done, total) => {
              onPatchTask?.(t.id, {
                subtask_done: done,
                subtask_total: total,
              });
            }}
          />
        ))}
      </div>

      <ContextMenuOverlay
        open={!!ctx.state.payload}
        x={ctx.state.x}
        y={ctx.state.y}
        items={menuItems}
        onClose={ctx.close}
      />
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
  onRowClick: (t: Task) => void;
  onOpenLink: (l: Task["links"][number]) => void;
  multiSelect?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: number) => void;
  /** 任务对应的分类（已 join 好），用于行内渲染圆点 + 名字；缺省/未分类则不渲染 */
  category?: TaskCategory;
  /** 右键菜单当前指向本行 → 加蓝色描边提示操作目标 */
  contextActive?: boolean;
  /** 右键事件，由父级 TaskSection 注入 ctx.open */
  onContextMenu?: (e: React.MouseEvent) => void;
  /** 是否展开行内子任务区（仅 subtask_total > 0 时有意义） */
  expanded?: boolean;
  /** 切换展开/折叠 */
  onToggleExpand?: () => void;
  /** 子任务变更回调：父级用来局部 patch 该 task 的 subtask_done/total */
  onSubtaskChanged?: (done: number, total: number) => void;
}

function TaskRow({
  task,
  isLast,
  token,
  onToggle,
  onDelete,
  onEdit,
  onRowClick,
  onOpenLink,
  multiSelect,
  selected,
  onToggleSelect,
  category,
  contextActive,
  onContextMenu,
  expanded,
  onToggleExpand,
  onSubtaskChanged,
}: RowProps) {
  const done = task.status === 1;
  const abandoned = isAbandoned(task);
  // 放弃与完成的共同点：都不再"待办"，所以同样灰显 + 删除线；
  // 区别在勾选框（放弃态显示 ✕ 且点击是「恢复」而不是「切换完成」）
  const inactive = done || abandoned;
  const due = describeDueDate(task.due_date, inactive);
  const isSelected = !!selected;
  const hasSubtasks = task.subtask_total > 0;
  return (
    <>
    <div
      className="group flex items-start gap-3 px-4 py-3 transition"
      style={{
        // 展开时不画下边框，让展开区与本行视觉相连
        borderBottom:
          isLast || expanded
            ? "none"
            : `1px solid ${token.colorBorderSecondary}`,
        background:
          multiSelect && isSelected ? token.colorPrimaryBg : "transparent",
        cursor: "pointer",
        outline: contextActive ? `1px solid ${token.colorPrimary}` : "none",
        outlineOffset: -1,
        transition: "background .15s, outline .1s",
      }}
      onClick={
        multiSelect
          ? () => onToggleSelect?.(task.id)
          : () => onRowClick(task)
      }
      onContextMenu={onContextMenu}
    >
      {/* 展开/折叠 ▶ ▼：仅有子任务时显示。多选态下也保留（按钮已 stopPropagation 不会误触发选中），避免布局跳动 */}
      {hasSubtasks ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand?.();
          }}
          className="mt-0.5 shrink-0 flex items-center justify-center cursor-pointer hover:bg-black/5 rounded transition"
          style={{
            width: 18,
            height: 18,
            color: token.colorTextTertiary,
          }}
          title={expanded ? "折叠子任务" : "展开子任务"}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
      ) : (
        // 占位保持对齐（无子任务的行不显示 ▶，但留 18px 空位让标题列对齐）
        <span className="shrink-0" style={{ width: 18 }} />
      )}

      {/* 多选态：复选框；普通态：完成勾选 */}
      {multiSelect ? (
        <Checkbox
          checked={isSelected}
          onChange={() => onToggleSelect?.(task.id)}
          onClick={(e) => e.stopPropagation()}
          style={{ marginTop: 2 }}
        />
      ) : (
        <Tooltip
          title={
            abandoned
              ? "已放弃 —— 点击恢复为未完成"
              : done
                ? "标记为未完成"
                : "标记为已完成"
          }
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle(task);
            }}
            className="mt-0.5 rounded-full flex items-center justify-center transition cursor-pointer shrink-0"
            style={{
              width: 18,
              height: 18,
              border: abandoned
                ? `1.5px dashed ${token.colorTextQuaternary}`
                : done
                  ? `1.5px solid ${token.colorSuccess}`
                  : `1.5px solid ${token.colorBorder}`,
              background: done ? token.colorSuccess : "transparent",
              color: abandoned ? token.colorTextQuaternary : "#fff",
            }}
          >
            {abandoned ? (
              <IconX size={11} />
            ) : done ? (
              <ChevronRight
                size={12}
                style={{ transform: "rotate(90deg) scale(0.9)" }}
              />
            ) : null}
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
          opacity: inactive ? 0.35 : 1,
        }}
      />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className="font-medium"
            style={{
              fontSize: 13,
              textDecoration: inactive ? "line-through" : "none",
              color: inactive ? token.colorTextTertiary : token.colorText,
            }}
          >
            {task.title}
          </span>
          {abandoned && (
            <span
              className="shrink-0 text-[10px] leading-none px-1.5 py-0.5 rounded"
              style={{
                background: token.colorFillTertiary,
                color: token.colorTextTertiary,
              }}
            >
              已放弃
            </span>
          )}
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
          {task.subtask_total > 0 && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded inline-flex items-center gap-1"
              style={{
                background:
                  task.subtask_done === task.subtask_total
                    ? token.colorSuccessBg
                    : token.colorFillSecondary,
                color:
                  task.subtask_done === task.subtask_total
                    ? token.colorSuccess
                    : token.colorTextSecondary,
              }}
              title={`子任务进度：${task.subtask_done}/${task.subtask_total}`}
            >
              {task.subtask_done}/{task.subtask_total}
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
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenLink(l);
                }}
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
        <div
          className="opacity-0 group-hover:opacity-100 transition flex items-center gap-1 shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
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
    {/* 行内展开子任务区：紧贴行下方，缩进与 ▶ 对齐 */}
    {expanded && hasSubtasks && (
      <div
        style={{
          padding: "6px 16px 10px 56px",
          borderBottom: isLast ? "none" : `1px solid ${token.colorBorderSecondary}`,
          background: token.colorFillQuaternary,
        }}
        // 阻止冒泡到行级 onClick（多选态切勿误触）
        onClick={(e) => e.stopPropagation()}
      >
        <SubtaskList
          parentTaskId={task.id}
          compact
          onChanged={onSubtaskChanged}
        />
      </div>
    )}
    </>
  );
}

import { useIsMobile } from "@/hooks/useIsMobile";
import { MobileTasks } from "./MobileTasks";

export default function TasksPage() {
  const isMobile = useIsMobile();
  return isMobile ? <MobileTasks /> : <DesktopTasksPage />;
}
