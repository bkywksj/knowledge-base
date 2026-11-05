import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from "react";
import { useNavigate } from "react-router-dom";
import {
  Card,
  Input,
  Typography,
  Button,
  Modal,
  Popover,
  Segmented,
  App as AntdApp,
  theme as antdTheme,
} from "antd";
import {
  NotebookText,
  CalendarDays,
  Pin,
  Bot,
  CheckSquare,
  PencilLine,
  Send,
  Flame,
  Clock,
  TrendingUp,
  MessageCircle,
  Check,
  Star,
  Type,
  Copy,
  Edit3,
  Trash2,
  ExternalLink,
  ChevronRight,
  CornerDownRight,
  Eye,
  PenTool,
  EyeOff,
  FilePlus2,
  Plus,
} from "lucide-react";
import { Tooltip as AntTooltip } from "antd";
import {
  noteApi,
  dailyApi,
  systemApi,
  taskApi,
  trashApi,
  aiChatApi,
} from "@/lib/api";
import { useContextMenu } from "@/hooks/useContextMenu";
import {
  ContextMenuOverlay,
  type ContextMenuEntry,
} from "@/components/ui/ContextMenuOverlay";
import { relativeTime, localYmd, todayYmd } from "@/lib/utils";
import { EmptyState } from "@/components/ui/EmptyState";
import { NewNoteButton } from "@/components/NewNoteButton";
import { NewTodoButton } from "@/components/NewTodoButton";
import { MicButton } from "@/components/MicButton";
import { HomeSearchInput } from "@/components/HomeSearchInput";
import { useAppStore } from "@/store";
import { useFeatureEnabled } from "@/hooks/useFeatureEnabled";
import type {
  Note,
  DashboardStats,
  DailyWritingStat,
  Task,
  AiConversation,
  NotesOnDay,
} from "@/types";
import { SubtaskList } from "@/components/tasks/SubtaskList";
import { TaskDetailModal } from "@/components/tasks/TaskDetailModal";
import { CreateTaskModal } from "@/components/tasks/CreateTaskModal";
import { HideableCard } from "@/components/home/HideableCard";
import { WritingHeatmap } from "@/components/home/WritingHeatmap";
import { useHomeWidgetsStore } from "@/store/homeWidgets";
import { escapeHtml, quickTextToNote } from "@/lib/quickNote";

const { Text } = Typography;

/**
 * 首页 v2(工作台模式)
 *
 * 结构(从上到下，2026-11-05 按用户反馈精简：入口太多、「今日笔记 / 快速记一笔 / 新建笔记」分不清):
 *   ① 问候 + 搜索 + 新建笔记 + 隐私模式
 *   ② 随手记：一个输入框两个去处 ——「记到今天的日记」/「存为新笔记」
 *   ③ 待办(顶部直接添加，旁边是完整新建 + AI 规划) ｜ 笔记(最近编辑 / 置顶 两个标签)
 *   ④ 写作活力(指标 + 年度热力图，点格子看当天写过的笔记) ｜ 问 AI
 * 原来的快捷按钮行去掉了：添加待办并进待办卡，今日日记在随手记右上角，
 * AI 问答 / 知识图谱侧栏都有入口（AI 问答在问 AI 卡里也有）。
 */
/**
 * 桌面端原版主页（保留所有原有 hook + 1300+ 行实现）。
 * 移动端走文件末尾的 HomePage wrapper → MobileHome（按设计稿小屏布局）。
 */
// 日期口径统一到 @/lib/utils 的 localYmd / todayYmd（本地时区，勿用 UTC toISOString）

function DesktopHomePage() {
  const navigate = useNavigate();
  const { token } = antdTheme.useToken();
  const { message } = AntdApp.useApp();
  const refreshTaskStats = useAppStore((s) => s.refreshTaskStats);
  const privacyMode = useHomeWidgetsStore((s) => s.privacyMode);

  // 功能模块开关：用户在设置里关闭某模块时，首页相关的卡片/按钮也要联动隐藏
  const tasksEnabled = useFeatureEnabled("tasks");
  const dailyEnabled = useFeatureEnabled("daily");
  const aiEnabled = useFeatureEnabled("ai");

  // ─── 数据状态 ─────────────────────────────────────
  const [recentNotes, setRecentNotes] = useState<Note[]>([]);
  const [pinnedNotes, setPinnedNotes] = useState<Note[]>([]);
  /** 笔记总数（笔记列表口径：不含日记 / 隐藏），笔记卡显示「共 N 篇」和「还有 N 篇」 */
  const [notesTotal, setNotesTotal] = useState(0);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [trend, setTrend] = useState<DailyWritingStat[]>([]);
  /** 今日待办速览(今天 + 逾期,前端筛 / 切片) */
  const [todayTasks, setTodayTasks] = useState<Task[]>([]);
  /** 即将到期速览(今天之后,按 due 升序取最近的,不再卡 7 天上限) */
  const [upcomingTasks, setUpcomingTasks] = useState<Task[]>([]);
  /** 无截止日期速览(due_date 为空的待办,重要优先 + 最近创建) */
  const [noDueTasks, setNoDueTasks] = useState<Task[]>([]);
  /** 最近 AI 会话(用于"问 AI"卡 fallback 列表) */
  const [recentChats, setRecentChats] = useState<AiConversation[]>([]);
  /** 今日日记字数（随手记右上角「今天的日记」后面的数字）；null = 今天还没有日记。
   *  用只读的 dailyApi.get，不能用 getOrCreate——打开首页不该凭空建一篇日记 */
  const [todayDailyWords, setTodayDailyWords] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  // ─── 输入态 ───────────────────────────────────────
  const [searchKeyword, setSearchKeyword] = useState("");
  const [quickNote, setQuickNote] = useState("");
  const [quickNoteSaving, setQuickNoteSaving] = useState(false);
  const [aiQuestion, setAiQuestion] = useState("");
  /** 待办卡顶部的快速添加 */
  const [quickTodo, setQuickTodo] = useState("");
  const [quickTodoSaving, setQuickTodoSaving] = useState(false);
  /** 笔记卡当前看哪个标签 */
  const [noteTab, setNoteTab] = useState<"recent" | "pinned">("recent");
  /** 热力图点开的那天：格子位置用来摆弹层 */
  const [dayPick, setDayPick] = useState<{ date: string; rect: DOMRect } | null>(null);
  const [dayNotes, setDayNotes] = useState<NotesOnDay | null>(null);
  /** 待办详情弹窗 */
  const [taskDetail, setTaskDetail] = useState<Task | null>(null);
  /** 编辑弹窗（详情 Modal 点「编辑」时打开）*/
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  /** 行内展开子任务的任务 id 集合（仅 widget 内存态，不持久化） */
  const [expandedTodoIds, setExpandedTodoIds] = useState<Set<number>>(
    () => new Set(),
  );

  // ─── 加载 ─────────────────────────────────────────
  const loadDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const [notesResult, dashStats, trendData, allTodos, chats, todayDaily] =
        await Promise.all([
          // 拉 12 条而不是 8：这一批还要被 is_pinned 拆成「最近笔记」和「置顶笔记」
          // 两卡，置顶多的用户按 8 条拉会让「最近笔记」凑不够要显示的 8 条。
          // 拉 24 条：要拆成「最近」和「置顶」两组，窗口高时每组最多能放十几条
          noteApi.list({ page: 1, page_size: 24 }),
          systemApi.getDashboardStats(),
          // 371 天 = 53 周：写作活力的年度热力图要一整年；连续写作 / 本周字数也从这批里算
          systemApi.getWritingTrend(371),
          taskApi.list({ status: 0 }).catch(() => [] as Task[]),
          aiChatApi.listConversations().catch(() => [] as AiConversation[]),
          dailyApi.get(todayYmd()).catch(() => null),
        ]);
      setRecentNotes(notesResult.items.filter((n) => !n.is_pinned));
      setNotesTotal(notesResult.total);
      setPinnedNotes(notesResult.items.filter((n) => n.is_pinned));
      setStats(dashStats);
      setTrend(trendData);
      // 四段筛：逾期+今日 给 todayTasks；今天之后 给 upcomingTasks（不再卡 7 天）；
      // 无截止日期 给 noDueTasks（之前被整段丢弃，导致没设时间的待办永不显示）
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);
      const open = allTodos.filter((t) => t.status === 0);
      const allWithDue = open.filter((t) => t.due_date);
      const noDue = open.filter((t) => !t.due_date);
      const sortByDue = (a: Task, b: Task) =>
        new Date(a.due_date!).getTime() - new Date(b.due_date!).getTime();
      // 逾期 + 今日（≤ 今天结束）
      const todayOrOverdue = allWithDue
        .filter((t) => new Date(t.due_date!).getTime() <= todayEnd.getTime())
        .sort(sortByDue);
      // 即将到期（今天结束之后的全部，按 due 升序——展示时取最靠近今天的几条）
      const upcoming = allWithDue
        .filter((t) => new Date(t.due_date!).getTime() > todayEnd.getTime())
        .sort(sortByDue);
      // 无截止日期：重要优先，其次按创建时间倒序（新建的靠前）
      const noDueSorted = [...noDue].sort((a, b) => {
        if (a.important !== b.important) return a.important ? -1 : 1;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
      setTodayTasks(todayOrOverdue);
      setUpcomingTasks(upcoming);
      setNoDueTasks(noDueSorted);
      setRecentChats(chats.slice(0, 3));
      setTodayDailyWords(todayDaily ? todayDaily.word_count : null);
    } catch (e) {
      console.error("加载首页数据失败:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  // ─── 搜索 ─────────────────────────────────────────
  const handleSearch = useCallback(() => {
    if (searchKeyword.trim()) {
      navigate(`/search?q=${encodeURIComponent(searchKeyword.trim())}`);
    }
  }, [searchKeyword, navigate]);

  // ─── 今日笔记跳转 ──────────────────────────────────
  const handleTodayNote = useCallback(async () => {
    try {
      const today = todayYmd();
      await dailyApi.getOrCreate(today);
      navigate(`/daily?date=${today}`);
    } catch (e) {
      message.error(`打开今天的日记失败: ${e}`);
    }
  }, [navigate, message]);

  // ─── 快速记一笔:追加到今日 daily ───────────────────
  const handleQuickSaveNote = useCallback(async () => {
    const text = quickNote.trim();
    if (!text) return;
    setQuickNoteSaving(true);
    try {
      const today = todayYmd();
      const daily = await dailyApi.getOrCreate(today);
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      // 用时间戳前缀分隔多条快速记录,内容追加到 content 末尾(content 是 HTML)
      const appendBlock = `<p><strong>[${hhmm}]</strong> ${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
      const newContent = (daily.content || "") + appendBlock;
      await noteApi.update(daily.id, {
        title: daily.title,
        content: newContent,
        folder_id: daily.folder_id,
      });
      message.success("已记到今天的日记");
      setQuickNote("");
      // 也刷新最近笔记列表(daily 会出现在最近)
      loadDashboard();
      // getOrCreate 可能新建今日日记 → 让左侧 NotesPanel / 笔记列表重拉，新日记立即出现
      useAppStore.getState().bumpNotesRefresh();
    } catch (e) {
      message.error(`保存失败: ${e}`);
    } finally {
      setQuickNoteSaving(false);
    }
  }, [quickNote, message, loadDashboard]);

  // ─── 随手记：存为新笔记（第一行当标题） ─────────────
  const handleQuickSaveAsNote = useCallback(async () => {
    const text = quickNote.trim();
    if (!text) return;
    setQuickNoteSaving(true);
    try {
      const { title, content } = quickTextToNote(text);
      await noteApi.create({ title, content, folder_id: null });
      message.success(`已存为新笔记「${title}」`);
      setQuickNote("");
      loadDashboard();
      useAppStore.getState().bumpNotesRefresh();
    } catch (e) {
      message.error(`保存失败: ${e}`);
    } finally {
      setQuickNoteSaving(false);
    }
  }, [quickNote, message, loadDashboard]);

  // ─── 待办卡顶部快速添加：默认今天到期，完整选项走旁边的「详细新建」 ───
  const handleQuickAddTodo = useCallback(async () => {
    const title = quickTodo.trim();
    if (!title) return;
    setQuickTodoSaving(true);
    try {
      await taskApi.create({ title, due_date: `${todayYmd()} 00:00:00` });
      setQuickTodo("");
      setTodoTab("today");
      refreshTaskStats();
      loadDashboard();
    } catch (e) {
      message.error(`添加待办失败: ${e}`);
    } finally {
      setQuickTodoSaving(false);
    }
    // setTodoTab 在下方声明，是稳定的 setter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickTodo, message, refreshTaskStats, loadDashboard]);

  // ─── 热力图：点某天列出当天写过的笔记 ─────────────────
  const handleSelectDay = useCallback(
    (date: string, el: HTMLElement) => {
      setDayPick({ date, rect: el.getBoundingClientRect() });
      setDayNotes(null);
      systemApi
        .listNotesWrittenOn(date)
        .then(setDayNotes)
        .catch((e) => {
          setDayPick(null);
          message.error(`读取 ${date} 的笔记失败: ${e}`);
        });
    },
    [message],
  );

  // ─── 完成 / 切换待办状态 ──────────────────────────
  const handleToggleTask = useCallback(
    async (id: number) => {
      try {
        await taskApi.toggleStatus(id);
        refreshTaskStats();
        loadDashboard();
      } catch (e) {
        message.error(`操作失败: ${e}`);
      }
    },
    [message, refreshTaskStats, loadDashboard],
  );

  /** 同时 patch todayTasks 和 upcomingTasks（一个任务可能在任一段里） */
  const patchTask = useCallback((id: number, patch: Partial<Task>) => {
    setTodayTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );
    setUpcomingTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );
    setNoDueTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );
  }, []);

  // ─── 右键菜单（最近笔记 + 今日待办两个 widget） ─────
  const noteCtx = useContextMenu<Note>();
  const taskCtx = useContextMenu<Task>();

  const noteMenuItems: ContextMenuEntry[] = useMemo(() => {
    const p = noteCtx.state.payload;
    if (!p) return [];
    return [
      {
        key: "open",
        label: "打开笔记",
        icon: <ExternalLink size={13} />,
        onClick: () => {
          noteCtx.close();
          navigate(`/notes/${p.id}`);
        },
      },
      {
        key: "copy-wiki",
        label: "复制为 wiki 链接",
        icon: <Copy size={13} />,
        onClick: () => {
          noteCtx.close();
          const link = `[[${p.title || "无标题"}]]`;
          navigator.clipboard
            .writeText(link)
            .then(() => message.success(`已复制：${link}`))
            .catch((e) => message.error(`复制失败：${e}`));
        },
      },
      { type: "divider" },
      {
        key: "trash",
        label: "移到回收站",
        icon: <Trash2 size={13} />,
        danger: true,
        onClick: () => {
          noteCtx.close();
          Modal.confirm({
            title: `把「${p.title || "(无标题)"}」移到回收站？`,
            content: "可以在回收站恢复。",
            okText: "移入回收站",
            okButtonProps: { danger: true },
            async onOk() {
              try {
                await trashApi.softDelete(p.id);
                message.success("已移到回收站");
                loadDashboard();
              } catch (e) {
                message.error(`删除失败：${e}`);
              }
            },
          });
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteCtx.state.payload]);

  const taskMenuItems: ContextMenuEntry[] = useMemo(() => {
    const p = taskCtx.state.payload;
    if (!p) return [];
    const done = p.status === 1;
    return [
      {
        key: "toggle",
        label: done ? "标记为未完成" : "标记已完成",
        icon: <Check size={13} />,
        onClick: () => {
          taskCtx.close();
          void handleToggleTask(p.id);
        },
      },
      {
        key: "edit",
        label: "在待办页打开",
        icon: <Edit3 size={13} />,
        onClick: () => {
          taskCtx.close();
          navigate(`/tasks?taskId=${p.id}`);
        },
      },
      { type: "divider" },
      {
        key: "delete",
        label: "删除任务",
        icon: <Trash2 size={13} />,
        danger: true,
        onClick: () => {
          taskCtx.close();
          Modal.confirm({
            title: `删除任务「${p.title || "(无标题)"}」？`,
            content: "此操作不可恢复。",
            okText: "删除",
            okButtonProps: { danger: true },
            async onOk() {
              try {
                await taskApi.delete(p.id);
                message.success("已删除");
                refreshTaskStats();
                loadDashboard();
              } catch (e) {
                message.error(`删除失败：${e}`);
              }
            },
          });
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskCtx.state.payload]);

  // ─── 问 AI 直接发送 ───────────────────────────────
  // 新建会话后通过 location.state 把 pendingPrompt 传给 AI 页,
  // AI 页的 effect 会自动 setActiveConvId + 发送
  const handleAskAi = useCallback(async () => {
    const q = aiQuestion.trim();
    if (!q) return;
    try {
      const conv = await aiChatApi.createConversation(q.slice(0, 30));
      navigate("/ai", {
        state: { activeConvId: conv.id, pendingPrompt: q },
      });
      setAiQuestion("");
    } catch (e) {
      message.error(`新建会话失败: ${e}`);
    }
  }, [aiQuestion, navigate, message]);

  // ─── 第二行（待办 / 笔记）实际高度：撑满首页剩余高度，按它决定每张卡放几条 ───
  const r4Ref = useRef<HTMLDivElement>(null);
  const [r4Height, setR4Height] = useState(300);
  useEffect(() => {
    const el = r4Ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setR4Height(Math.round(entry.contentRect.height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // 卡头 42 + 快速添加 38 + 胶囊 30 +「还有 N 条」20 + 底边 10（实测，300 高正好放 4 条）；每条 40
  const todoRows = Math.max(3, Math.floor((r4Height - 140) / 40));
  // 卡头 42 +「还有 N 篇」20 + 底边 12；每条 40
  const noteRows = Math.max(4, Math.floor((r4Height - 74) / 40));

  // ─── 派生指标(纯前端从 trend 计算) ────────────────
  const vitalityMetrics = useMemo(() => {
    // trend 是按日期升序,只含有笔记的日期（后端已含日记、排除导入）
    const todayStr = localYmd(new Date());
    const trendByDate = new Map(trend.map((d) => [d.date, d]));

    // 连续写作天数:从今天往前数,直到某天没写作
    let streak = 0;
    const cursor = new Date();
    for (let i = 0; i < 365; i++) {
      const ymd = localYmd(cursor);
      const d = trendByDate.get(ymd);
      if (d && d.word_count > 0) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
      } else {
        // 如果今天还没写,允许从昨天起算(避免一进首页就 = 0)
        if (i === 0) {
          cursor.setDate(cursor.getDate() - 1);
          continue;
        }
        break;
      }
    }

    // 距上次写作:用后端 last_written_at（含日记、排除导入），口径与图表/连续写作一致。
    // 不再用 recentNotes[0]——那来自普通笔记列表，强制排除日记，写日记不会刷新此项。
    const lastWritingAt = stats?.last_written_at ?? undefined;
    const lastSinceLabel = lastWritingAt ? relativeTime(lastWritingAt) : "—";

    // 本周字数(最近 7 天) + 上周字数(8-14 天)对比
    let thisWeek = 0;
    let lastWeek = 0;
    const now = new Date();
    for (let i = 0; i < 14; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const ymd = localYmd(d);
      const stat = trendByDate.get(ymd);
      if (!stat) continue;
      if (i < 7) thisWeek += stat.word_count;
      else lastWeek += stat.word_count;
    }
    const weekDelta = lastWeek > 0
      ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100)
      : null;

    return {
      totalNotes: stats?.total_notes ?? 0,
      totalWords: stats?.total_words ?? 0,
      streak,
      lastSinceLabel,
      thisWeekWords: thisWeek,
      weekDelta,
      todayStr,
      trendByDate,
    };
  }, [trend, stats]);


  // 待办速览三段：逾期（昨天及更早）/ 今日 / 即将到期。每段最多 5 条
  /** 待办速览当前看哪个分组；null = 还没手动选过（默认今日，今日空则第一个有内容的） */
  const [todoTab, setTodoTab] = useState<TodoTab | null>(null);
  const todoGroups = useMemo(() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayStartMs = todayStart.getTime();
    const overdue: Task[] = [];
    const today: Task[] = [];
    for (const t of todayTasks) {
      // todayTasks 已经是 due ≤ 今天结束 的，按 todayStart 切：早于今天 0:00 = 逾期
      if (new Date(t.due_date!).getTime() < todayStartMs) overdue.push(t);
      else today.push(t);
    }
    // 每段条数上限：按原型取 4 条 —— 这一行三卡固定 256 高（原型实测），
    // 首页才能一屏放下底部热力图（2026-11-04 用户要求不滚动）。
    // 超出部分仍由段尾「+ 还有 N 条…」引导去待办页，不改"速览"的定位。
    // 条数随卡片高度变（todoRows），放不下的仍由「+ 还有 N 条…」引导去待办页
    return {
      overdue: overdue.slice(0, todoRows),
      overdueTotal: overdue.length,
      today: today.slice(0, todoRows),
      todayTotal: today.length,
      // 即将到期去掉 7 天上限后，只展示最靠近今天的几条
      upcoming: upcomingTasks.slice(0, todoRows),
      upcomingTotal: upcomingTasks.length,
      noDue: noDueTasks.slice(0, todoRows),
      noDueTotal: noDueTasks.length,
    };
  }, [todayTasks, upcomingTasks, noDueTasks, todoRows]);
  const totalTodoCount =
    todoGroups.overdueTotal +
    todoGroups.todayTotal +
    todoGroups.upcomingTotal +
    todoGroups.noDueTotal;
  // 与左侧待办速览卡同处一行（固定 256 高）：原型最近笔记 5 条正好放满
  const displayedRecent = useMemo(() => recentNotes.slice(0, noteRows), [recentNotes, noteRows]);

  // 全局隐私模式快捷键（Ctrl/⌘+Shift+H）：一键遮住首页所有卡片，
  // 用于「有人走过来了 / 要投屏」这类临时场景。
  // 只在首页挂载：别的页面没有可遮的卡片，全局注册纯属占用组合键。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "h"
      ) {
        e.preventDefault();
        useHomeWidgetsStore.getState().togglePrivacyMode();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ─── 渲染 ─────────────────────────────────────────
  return (
    <div
      // 外层 wrapper 撑满 Content 区域 —— max-w-5xl 居中后两侧空白属于 Content
      // 不属于内层 div，事件不会冒泡。把 onContextMenu 放在撑满的 wrapper 上
      // 才能拦到这部分空白的右键
      className="kb-home"
      style={{ width: "100%", minHeight: "100%", display: "flex", flexDirection: "column" }}
      onContextMenu={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest("input, textarea, [contenteditable='true']")) return;
        e.preventDefault();
      }}
    >
    <div
      // 不再限内容最大宽度：横向留白统一交给 AppLayout Content 的 padding，
      // 跟知识图谱 / 笔记 / 待办 / 提示词 等页一个口径（历史上这里是 max-w-5xl →
      // max-w-7xl，都是在单独跟"两侧留白太多"较劲，现在全站统一由一处控制）
      // 行距 10（原 12）：首页要在 1080p 默认窗口里一屏放下底部热力图
      // flex 1：撑满首页高度，第二行（kb-home-r4）再用 flex 吃掉剩下的
      style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1 }}
    >

      {/* ① 页头：日期 + 问候（今天写了多少字）｜ 搜索 + 新建笔记 + 隐私模式（原型 .hm-head） */}
      <div className="kb-home-head">
        <div className="kb-home-greet">
          <div className="kb-home-date">{homeDateLabel(new Date())}</div>
          <h1>
            {greetingFor(new Date().getHours())}，今天写了{" "}
            <span className="kb-home-num">
              {(vitalityMetrics.trendByDate.get(vitalityMetrics.todayStr)?.word_count ?? 0).toLocaleString()}
            </span>{" "}
            字
          </h1>
        </div>
        <div className="kb-home-tools">
          {/* 搜索：输入即下拉建议（笔记 + 待办，点击跳详情），回车去 /search 全量结果 */}
          <div className="kb-home-search">
            <HomeSearchInput
              value={searchKeyword}
              onChange={setSearchKeyword}
              onPressEnter={handleSearch}
            />
          </div>
          <NewNoteButton size="large" />
          {/* 隐私模式：原来只有 Ctrl/⌘+Shift+H，补一个看得见的开关 */}
          <AntTooltip title={privacyMode ? "退出隐私模式 (Ctrl+Shift+H)" : "隐私模式：遮住首页卡片 (Ctrl+Shift+H)"}>
            <Button
              size="large"
              type="text"
              className={privacyMode ? "kb-home-privacy is-on" : "kb-home-privacy"}
              icon={privacyMode ? <EyeOff size={17} /> : <Eye size={17} />}
              onClick={() => useHomeWidgetsStore.getState().togglePrivacyMode()}
            />
          </AntTooltip>
        </div>
      </div>

      {/* ② 随手记 — 一个输入框两个去处；日记模块关掉时只剩「存为新笔记」 */}
      <Card
        size="small"
        className="kb-quick-card"
        styles={{ body: { padding: "12px 14px" } }}
      >
        <div className="kb-card-h">
          <span className="kb-cico" style={{ color: token.colorPrimary }}>
            <PencilLine size={15} />
          </span>
          <b>随手记</b>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {dailyEnabled ? "先记下来，再决定放哪儿" : "第一行作标题，存成一篇新笔记"}
          </Text>
          {dailyEnabled && (
            <button type="button" className="kb-lnk kb-quick-daily" onClick={handleTodayNote}>
              <CalendarDays size={12} />
              今天的日记 · {todayDailyWords == null ? "未开始" : `${todayDailyWords.toLocaleString()} 字`}
              <ChevronRight size={12} />
            </button>
          )}
        </div>
        <Input.TextArea
          variant="borderless"
          className="kb-quick-input"
          rows={1}
          placeholder="想到什么先记下来…"
          value={quickNote}
          onChange={(e) => setQuickNote(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              if (dailyEnabled) handleQuickSaveNote();
              else handleQuickSaveAsNote();
            }
          }}
          // 默认一行：空着的时候不占地方，打字时自动长高（首页要一屏放下底部热力图）
          autoSize={{ minRows: 1, maxRows: 5 }}
        />
        <div className="kb-quick-foot">
          <Text type="secondary" style={{ fontSize: 12 }}>
            Ctrl / ⌘ + Enter {dailyEnabled ? "记到今天的日记" : "保存"}
          </Text>
          <span className="flex-1" />
          {quickNote.trim() && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {quickNote.trim().length} 字
            </Text>
          )}
          <MicButton
            onTranscribed={(text) =>
              setQuickNote((prev) => (prev ? `${prev}\n${text}` : text))
            }
          />
          <Button
            type={dailyEnabled ? "default" : "primary"}
            icon={<FilePlus2 size={14} />}
            loading={quickNoteSaving}
            disabled={!quickNote.trim()}
            onClick={handleQuickSaveAsNote}
            title="单独建一篇笔记，第一行作标题"
          >
            存为新笔记
          </Button>
          {dailyEnabled && (
            <Button
              type="primary"
              icon={<CalendarDays size={14} />}
              loading={quickNoteSaving}
              disabled={!quickNote.trim()}
              onClick={handleQuickSaveNote}
              title="带上时间追加到今天的日记末尾"
            >
              记到今天的日记
            </Button>
          )}
        </div>
      </Card>

      {/* ③ 一行两卡：待办 5 ｜ 笔记 7（12 栏）；待办关闭时笔记占满 */}
      <div ref={r4Ref} className="grid grid-cols-12 gap-3 kb-home-r4">

        {tasksEnabled && (
        <HideableCard
          widgetKey="todo"
          size="small"
          className="col-span-5"
          // 底部留 8：4 条 + 「还有 N 条」放进 266 高的卡片后，与底边还有约 12
          styles={{ body: { padding: "0 8px 8px" } }}
          title={
            <span className="flex items-center gap-2 text-sm">
              <CheckSquare size={14} style={{ color: token.colorSuccess }} />
              待办
              {totalTodoCount > 0 && (
                <span className="kb-card-n">共 {totalTodoCount} 条</span>
              )}
            </span>
          }
          extra={
            <button type="button" className="kb-lnk" onClick={() => navigate("/tasks")}>
              全部待办
              <ChevronRight size={12} />
            </button>
          }
        >
          {(() => {
            const sections: Array<{
              key: TodoTab;
              items: Task[];
              total: number;
              label: string;
            }> = [
              { key: "overdue", items: todoGroups.overdue, total: todoGroups.overdueTotal, label: "逾期" },
              { key: "today", items: todoGroups.today, total: todoGroups.todayTotal, label: "今日" },
              { key: "upcoming", items: todoGroups.upcoming, total: todoGroups.upcomingTotal, label: "即将到期" },
              { key: "noDue", items: todoGroups.noDue, total: todoGroups.noDueTotal, label: "无截止日期" },
            ];
            // 没手动选过：今日有就看今日，否则第一个有内容的分组（原型默认停在「今日」）
            const activeKey: TodoTab =
              todoTab ??
              (todoGroups.todayTotal > 0
                ? "today"
                : (sections.find((s) => s.total > 0)?.key ?? "today"));
            const active = sections.find((s) => s.key === activeKey)!;

            /** 单条任务（原型 .td）：方形勾选 · 标题 · 星标 / 子任务 / 优先级徽标 · 右侧时间 */
            const renderTaskRow = (task: Task, sectionKey: TodoTab) => {
              const due = new Date(task.due_date ?? Date.now());
              const dueMs = due.getTime();
              const desc = task.description?.trim();
              const ctxActive = taskCtx.state.payload?.id === task.id;
              const hasSubtasks = task.subtask_total > 0;
              const expanded = expandedTodoIds.has(task.id);

              // 右侧时间：逾期 = 红字「N 天前」；今日 = 时:分（已过点也标红）；即将 = +N 天；无期限
              let dueText: string;
              let dueBad = false;
              if (sectionKey === "overdue") {
                const todayStart = new Date();
                todayStart.setHours(0, 0, 0, 0);
                const days = Math.max(1, Math.round((todayStart.getTime() - dueMs) / 86400000));
                dueText = days === 1 ? "昨天" : `${days} 天前`;
                dueBad = true;
              } else if (sectionKey === "today") {
                const hh = String(due.getHours()).padStart(2, "0");
                const mm = String(due.getMinutes()).padStart(2, "0");
                const allDay = hh === "00" && mm === "00";
                dueText = allDay ? "今天" : `${hh}:${mm}`;
                dueBad = !allDay && dueMs < Date.now();
              } else if (sectionKey === "upcoming") {
                const todayStart = new Date();
                todayStart.setHours(0, 0, 0, 0);
                dueText = `+${Math.max(1, Math.ceil((dueMs - todayStart.getTime()) / 86400000))} 天`;
              } else {
                dueText = "无期限";
              }

              return (
                <Fragment key={task.id}>
                  <li
                    className={"kb-hm-td" + (ctxActive ? " is-ctx" : "")}
                    // 描述原来单独占一行，原型行高固定 40、不展示描述 → 收进悬停提示，信息不丢
                    title={desc || undefined}
                    onClick={() => setTaskDetail(task)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      taskCtx.open(e.nativeEvent, task);
                    }}
                  >
                    <button
                      type="button"
                      className="kb-task-ck"
                      aria-label="标记完成"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleToggleTask(task.id);
                      }}
                    />
                    <span className="kb-hm-td-tx">{task.title}</span>
                    {task.important && (
                      // 主题主色（淡紫 / 暖炭自动切）：原黄色在淡紫主题里很跳
                      <Star size={12} style={{ color: token.colorPrimary, flexShrink: 0 }} fill={token.colorPrimary} />
                    )}
                    {hasSubtasks && (
                      <button
                        type="button"
                        className="kb-hm-badge is-btn"
                        title={expanded ? "折叠子任务" : "展开子任务"}
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedTodoIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(task.id)) next.delete(task.id);
                            else next.add(task.id);
                            return next;
                          });
                        }}
                      >
                        <CornerDownRight size={11} />
                        {task.subtask_done}/{task.subtask_total}
                      </button>
                    )}
                    {/* 优先级：紧急红徽标、低优先级灰徽标；普通不标（原来的彩色小圆点改成这两枚徽标） */}
                    {task.priority === 0 && <span className="kb-hm-badge is-r">紧急</span>}
                    {task.priority === 2 && <span className="kb-hm-badge">低</span>}
                    <span className={"kb-hm-due" + (dueBad ? " is-bad" : "")}>{dueText}</span>
                  </li>
                  {expanded && hasSubtasks && (
                    <li className="kb-hm-sub" onClick={(e) => e.stopPropagation()}>
                      <SubtaskList
                        parentTaskId={task.id}
                        compact
                        onChanged={(done, total) =>
                          patchTask(task.id, { subtask_done: done, subtask_total: total })
                        }
                      />
                    </li>
                  )}
                </Fragment>
              );
            };

            return (
              <>
                {/* 快速添加（原来首页顶上的「添加待办」按钮并进来）：回车 = 今天到期的一条；
                    右侧是完整新建弹窗和 AI 规划，原按钮的入口一个不少 */}
                <div className="kb-hm-add">
                  <Input
                    variant="borderless"
                    size="small"
                    prefix={<Plus size={14} />}
                    placeholder="添加今天的待办，回车保存"
                    value={quickTodo}
                    disabled={quickTodoSaving}
                    onChange={(e) => setQuickTodo(e.target.value)}
                    onPressEnter={handleQuickAddTodo}
                  />
                  <NewTodoButton
                    variant="inline"
                    onSaved={() => {
                      loadDashboard();
                      refreshTaskStats();
                    }}
                  />
                </div>
                {/* 分组胶囊（原型 .pills）：原来四段竖排，现在一次看一段 */}
                <div className="kb-hm-pills">
                  {sections.map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      className={s.key === activeKey ? "is-on" : undefined}
                      onClick={() => setTodoTab(s.key)}
                    >
                      {s.label}
                      <b className={s.key === "overdue" && s.total > 0 ? "is-bad" : undefined}>{s.total}</b>
                    </button>
                  ))}
                </div>
                {active.items.length === 0 ? (
                  <div className="kb-hm-empty">
                    {loading ? "加载中…" : totalTodoCount === 0 ? "暂无待办，享受当下 ✨" : `「${active.label}」里没有待办`}
                  </div>
                ) : (
                  // 卡片固定高（.kb-home-r4），展开子任务超出时在卡片内滚动
                  <ul className="kb-hm-list">
                    {active.items.map((t) => renderTaskRow(t, active.key))}
                    {/* 紧凑 20 高；条数由 todoRows 按卡片高度算，保证这一行不被挤出卡片 */}
                    {active.total > active.items.length && (
                      <li className="kb-hm-more">
                        <button type="button" onClick={() => navigate("/tasks")}>
                          + 还有 {active.total - active.items.length} 条…
                        </button>
                      </li>
                    )}
                  </ul>
                )}
              </>
            );
          })()}
        </HideableCard>
        )}

        {/* 笔记：最近编辑 / 置顶 两个标签（原来两张卡）；待办开 7 列 / 关 12 列 */}
        <HideableCard
          widgetKey="recentNotes"
          size="small"
          className={tasksEnabled ? "col-span-7" : "col-span-12"}
          styles={{ body: { padding: "0 8px 10px" } }}
          title={
            <span className="flex items-center gap-2 text-sm">
              <NotebookText size={14} style={{ color: token.colorPrimary }} />
              <Segmented
                size="small"
                value={noteTab}
                onChange={(v) => setNoteTab(v as "recent" | "pinned")}
                options={[
                  { label: "最近编辑", value: "recent" },
                  {
                    label: (
                      <span className="inline-flex items-center gap-1">
                        <Pin size={12} />
                        置顶{pinnedNotes.length > 0 ? ` ${pinnedNotes.length}` : ""}
                      </span>
                    ),
                    value: "pinned",
                  },
                ]}
              />
              {notesTotal > 0 && <span className="kb-card-n">共 {notesTotal} 篇</span>}
            </span>
          }
          extra={
            <button type="button" className="kb-lnk" onClick={() => navigate("/notes")}>
              全部笔记
              <ChevronRight size={12} />
            </button>
          }
        >
          {(() => {
            const list = noteTab === "recent" ? displayedRecent : pinnedNotes.slice(0, noteRows);
            // 置顶排在列表最前，拉回来的 24 条里已含全部置顶（置顶超过 24 篇时这里会少算，可接受）
            const tabTotal =
              noteTab === "recent" ? Math.max(0, notesTotal - pinnedNotes.length) : pinnedNotes.length;
            const remaining = tabTotal - list.length;
            if (list.length === 0) {
              return noteTab === "recent" ? (
                <EmptyState description={loading ? "加载中…" : "还没有笔记"} />
              ) : (
                <div className="kb-hm-empty">在笔记编辑器右上角可置顶</div>
              );
            }
            return (
              <ul className="kb-hm-list">
                {list.map((note) => {
                  const ctxActive = noteCtx.state.payload?.id === note.id;
                  return (
                    <li
                      key={note.id}
                      className={"kb-hm-nr" + (ctxActive ? " is-ctx" : "")}
                      title={`${note.title} · ${note.word_count} 字`}
                      onClick={() => navigate(`/notes/${note.id}`)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        noteCtx.open(e.nativeEvent, note);
                      }}
                    >
                      <div className="kb-nr">
                        {noteTab === "pinned" ? (
                          <Pin size={14} style={{ color: token.colorPrimary, flexShrink: 0 }} />
                        ) : (
                          <NoteTypeIcon isDaily={note.is_daily} noteType={note.note_type} />
                        )}
                        <Text ellipsis style={{ fontSize: 13.5, flex: 1, minWidth: 0 }}>
                          {note.title}
                        </Text>
                        <time className="kb-hm-time">{relativeTime(note.updated_at)}</time>
                      </div>
                    </li>
                  );
                })}
                {/* 与待办卡同款：放不下的引导去笔记列表 */}
                {remaining > 0 && (
                  <li className="kb-hm-more">
                    <button type="button" onClick={() => navigate("/notes")}>
                      + 还有 {remaining} 篇…
                    </button>
                  </li>
                )}
              </ul>
            );
          })()}
        </HideableCard>
      </div>

      {/* ④ 写作活力（5 指标 + 年度热力图）9 ｜ 问 AI 3；AI 关闭时写作活力占满 */}
      <div className="grid grid-cols-12 gap-3">
      <Card
        size="small"
        className={aiEnabled ? "col-span-9" : "col-span-12"}
        styles={{ body: { padding: "12px 14px" } }}
      >
        <div className="flex items-center justify-between mb-2">
          {/* 原型 .card-h：橙色图标块 + 火焰，与其它卡片头同字号 */}
          <span className="kb-card-h" style={{ marginBottom: 0 }}>
            <span className="kb-cico sm is-warn">
              <Flame size={14} />
            </span>
            <b>写作活力</b>
          </span>
          <Text type="secondary" style={{ fontSize: 11 }}>
            近一年
          </Text>
        </div>
        <div className="grid grid-cols-5 gap-3">
          <MetricItem
            icon={<NotebookText size={16} style={{ color: token.colorPrimary }} />}
            iconBg={tint(token.colorPrimary)}
            value={vitalityMetrics.totalNotes}
            label="笔记总数"
          />
          <MetricItem
            icon={<Type size={16} style={{ color: token.colorPrimary }} />}
            iconBg={tint(token.colorPrimary)}
            value={
              vitalityMetrics.totalWords >= 10000
                ? (vitalityMetrics.totalWords / 10000).toFixed(1)
                : vitalityMetrics.totalWords.toLocaleString()
            }
            valueSuffix={vitalityMetrics.totalWords >= 10000 ? "万字" : "字"}
            title={`${vitalityMetrics.totalWords.toLocaleString()} 字`}
            label="总字数"
          />
          <MetricItem
            icon={<Flame size={16} style={{ color: token.colorWarning }} />}
            iconBg={tint(token.colorWarning)}
            value={vitalityMetrics.streak}
            valueSuffix="天"
            label="连续写作"
          />
          <MetricItem
            icon={<Clock size={16} style={{ color: token.colorInfo }} />}
            iconBg={tint(token.colorInfo)}
            value={vitalityMetrics.lastSinceLabel}
            label="距上次写作"
          />
          <MetricItem
            icon={<TrendingUp size={16} style={{ color: token.colorSuccess }} />}
            iconBg={tint(token.colorSuccess)}
            value={vitalityMetrics.thisWeekWords.toLocaleString()}
            valueSuffix="字"
            label="本周字数"
            extra={
              vitalityMetrics.weekDelta != null && (
                <span
                  className="text-[11px]"
                  style={{
                    color:
                      vitalityMetrics.weekDelta >= 0
                        ? token.colorSuccess
                        : token.colorError,
                  }}
                >
                  {vitalityMetrics.weekDelta >= 0 ? "▲" : "▼"} {Math.abs(vitalityMetrics.weekDelta)}%
                </span>
              )
            }
          />
        </div>
        {/* 年度热力图（每日方块，悬停看「日期 · 字数」）——替代原来的 14 天柱状图 */}
        <div
          className="mt-2 pt-2"
          style={{ borderTop: `1px solid ${token.colorBorderSecondary}` }}
        >
          <WritingHeatmap trend={trend} onSelectDay={handleSelectDay} />
        </div>
        {/* 当天笔记弹层：挂在被点格子的位置上（fixed 占位元素当锚点） */}
        <Popover
          open={!!dayPick}
          onOpenChange={(o) => {
            if (!o) setDayPick(null);
          }}
          trigger="click"
          placement="top"
          title={dayPick ? `${dayPick.date} 写过的笔记` : ""}
          content={
            <div className="kb-day-notes">
              {!dayNotes ? (
                <div className="kb-hm-empty">加载中…</div>
              ) : dayNotes.notes.length === 0 ? (
                <div className="kb-hm-empty">
                  {dayNotes.hidden_count > 0 ? "这天只编辑过隐藏笔记" : "这天的笔记后来又改过，已算到更晚的日期"}
                </div>
              ) : (
                <ul className="kb-hm-list">
                  {dayNotes.notes.map((n) => (
                    <li
                      key={n.id}
                      className="kb-hm-nr"
                      onClick={() => {
                        setDayPick(null);
                        navigate(`/notes/${n.id}`);
                      }}
                    >
                      <NoteTypeIcon isDaily={n.is_daily} noteType={n.note_type} />
                      <Text ellipsis style={{ fontSize: 13, flex: 1, minWidth: 0 }}>
                        {n.title || "无标题"}
                      </Text>
                      <time className="kb-hm-time">{n.word_count.toLocaleString()} 字</time>
                    </li>
                  ))}
                </ul>
              )}
              {dayNotes && dayNotes.hidden_count > 0 && dayNotes.notes.length > 0 && (
                <div className="kb-day-notes-foot">另有 {dayNotes.hidden_count} 篇隐藏笔记</div>
              )}
            </div>
          }
        >
          <span
            aria-hidden
            style={{
              position: "fixed",
              left: dayPick?.rect.left ?? 0,
              top: dayPick?.rect.top ?? 0,
              width: dayPick?.rect.width ?? 0,
              height: dayPick?.rect.height ?? 0,
              pointerEvents: "none",
            }}
          />
        </Popover>
      </Card>

        {aiEnabled && (
        <HideableCard
          widgetKey="askAi"
          size="small"
          className="col-span-3"
          styles={{ body: { padding: "12px 14px" } }}
          title={
            <span className="flex items-center gap-2 text-sm">
              <Bot size={14} style={{ color: token.colorPrimary }} />
              问 AI
            </span>
          }
          extra={
            <button type="button" className="kb-lnk" onClick={() => navigate("/ai")}>
              所有会话
              <ChevronRight size={12} />
            </button>
          }
        >
          <Input
            className="kb-ask-in"
            placeholder="基于你的笔记回答，回答附出处…"
            value={aiQuestion}
            onChange={(e) => setAiQuestion(e.target.value)}
            onPressEnter={handleAskAi}
            suffix={
              <Button
                type="primary"
                size="small"
                className="kb-ask-send"
                icon={<Send size={13} />}
                disabled={!aiQuestion.trim()}
                onClick={handleAskAi}
              />
            }

          />
          {/* 推荐问题（v4 新增）：点一下填进输入框，用户确认 / 改一改再回车，不直接替用户发出去 */}
          <div className="kb-ask-sugs">
            {ASK_AI_SUGGESTIONS.map((q) => (
              <button key={q} type="button" onClick={() => setAiQuestion(q)}>
                {q}
              </button>
            ))}
          </div>
          {recentChats.length > 0 ? (
            <>
              <ul className="kb-hm-list kb-ask-chats">
                {recentChats.map((chat) => (
                  <li key={chat.id} className="kb-hm-nr is-sm" onClick={() => navigate(`/ai?cid=${chat.id}`)}>
                    <MessageCircle size={13} style={{ flexShrink: 0, color: "var(--kb-text-tertiary)" }} />
                    <span className="kb-hm-td-tx">{chat.title || "未命名会话"}</span>
                    <time className="kb-hm-time">{relativeTime(chat.updated_at)}</time>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <Text type="secondary" style={{ fontSize: 11 }}>
              输入问题回车直接发送,自动新建对话
            </Text>
          )}
        </HideableCard>
        )}
      </div>

      {/* 待办详情弹窗 — 点击今日待办列表项触发；只读视图 + 标记完成 + 子任务 + 编辑入口 */}
      <TaskDetailModal
        task={taskDetail}
        onClose={() => setTaskDetail(null)}
        onToggleStatus={(id) => void handleToggleTask(id)}
        onSubtaskChanged={(id, done, total) => {
          // 局部 patch（同时覆盖 today / upcoming），避免重拉造成闪烁
          patchTask(id, { subtask_done: done, subtask_total: total });
        }}
        onEdit={(t) => setEditingTask(t)}
      />
      {/* 详情 Modal 点「编辑」→ CreateTaskModal 编辑态；保存后重拉首页数据 */}
      <CreateTaskModal
        open={!!editingTask}
        editing={editingTask}
        onClose={() => setEditingTask(null)}
        onSaved={() => {
          setEditingTask(null);
          void loadDashboard();
        }}
        onSubtaskChanged={(done, total) => {
          if (!editingTask) return;
          patchTask(editingTask.id, {
            subtask_done: done,
            subtask_total: total,
          });
        }}
      />

      {/* 最近笔记右键菜单 */}
      <ContextMenuOverlay
        open={!!noteCtx.state.payload}
        x={noteCtx.state.x}
        y={noteCtx.state.y}
        items={noteMenuItems}
        onClose={noteCtx.close}
      />

      {/* 今日待办右键菜单 */}
      <ContextMenuOverlay
        open={!!taskCtx.state.payload}
        x={taskCtx.state.x}
        y={taskCtx.state.y}
        items={taskMenuItems}
        onClose={taskCtx.close}
      />
    </div>
    </div>
  );
}

/** 写作活力卡内的单指标小项 */
/** 首页「问 AI」推荐问题：通用、不依赖具体笔记内容 */
const ASK_AI_SUGGESTIONS = ["总结我这周写的内容", "最近有哪些没写完的笔记", "找出没有链接的孤立笔记"];

/** 图标底色：主题色的 14% 透明叠加（亮暗主题都合适，替代原来写死的浅色块） */
function tint(color: string): string {
  return `color-mix(in srgb, ${color} 14%, transparent)`;
}

/** 按小时给问候语 */
/** 待办速览的四个分组 */
type TodoTab = "overdue" | "today" | "upcoming" | "noDue";

function greetingFor(hour: number): string {
  if (hour < 5) return "夜深了";
  if (hour < 9) return "早上好";
  if (hour < 12) return "上午好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

/** 「11 月 3 日 · 星期二」 */
function homeDateLabel(d: Date): string {
  const wk = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 星期${wk}`;
}

/** 笔记类型图标块：日记橙、白板蓝、普通笔记主色 */
function NoteTypeIcon({ isDaily, noteType }: { isDaily: boolean; noteType: string }) {
  const { token } = antdTheme.useToken();
  const whiteboard = noteType === "whiteboard";
  return (
    <span
      className="kb-cico sm"
      title={isDaily ? "日记" : whiteboard ? "白板" : "笔记"}
      style={{ color: isDaily ? token.colorWarning : whiteboard ? token.colorInfo : token.colorPrimary }}
    >
      {isDaily ? <CalendarDays size={14} /> : whiteboard ? <PenTool size={14} /> : <NotebookText size={14} />}
    </span>
  );
}

function MetricItem({
  icon,
  iconBg,
  value,
  valueSuffix,
  label,
  extra,
  title,
}: {
  icon: React.ReactNode;
  iconBg: string;
  value: number | string;
  valueSuffix?: string;
  label: string;
  extra?: React.ReactNode;
  /** 悬停提示：数字被换算（如「万字」）时放原值 */
  title?: string;
}) {
  // v4：原型的指标是「大号数字 + 小字说明」，不再画图标块；icon / iconBg 保留在签名里，
  // 只用作数字前的读屏说明，免得调用方大改
  void icon;
  void iconBg;
  return (
    <div className="kb-metric">
      <div className="min-w-0">
        <div className="kb-metric-v" title={title}>
          {value}
          {valueSuffix && <small>{valueSuffix}</small>}
          {extra && <span className="ml-1.5">{extra}</span>}
        </div>
        <div className="kb-metric-l">{label}</div>
      </div>
    </div>
  );
}

// ─── 移动端 Wrapper（T-M008）─────────────────────────
import { useIsMobile } from "@/hooks/useIsMobile";
import { MobileHome } from "./MobileHome";

/**
 * Wrapper：根据视口/平台决定渲染桌面版 or 移动版。
 * 注意：必须用 wrapper 模式而不是函数体内 early-return，
 * 否则 React Hooks 顺序会因平台不同而变化（违反 Hooks 规则）。
 */
export default function HomePage() {
  const isMobile = useIsMobile();
  return isMobile ? <MobileHome /> : <DesktopHomePage />;
}
