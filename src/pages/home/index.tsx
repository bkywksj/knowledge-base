import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import { useNavigate } from "react-router-dom";
import {
  Card,
  Input,
  Typography,
  Button,
  Tag,
  Modal,
  App as AntdApp,
  theme as antdTheme,
} from "antd";
import {
  NotebookText,
  CalendarDays,
  ArrowRight,
  Pin,
  Bot,
  GitBranch,
  CheckSquare,
  AlertTriangle,
  PencilLine,
  Send,
  Flame,
  Clock,
  TrendingUp,
  Sparkles,
  MessageCircle,
  Check,
  Star,
  Type,
  Copy,
  Edit3,
  Trash2,
  ExternalLink,
  ChevronRight,
  ChevronDown,
  Inbox,
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
import { relativeTime } from "@/lib/utils";
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
} from "@/types";
import { SubtaskList } from "@/components/tasks/SubtaskList";
import { TaskDetailModal } from "@/components/tasks/TaskDetailModal";
import { CreateTaskModal } from "@/components/tasks/CreateTaskModal";

const { Text } = Typography;

/**
 * 首页 v2(工作台模式)
 *
 * 结构(从上到下):
 *   ① 搜索 + 新建笔记拆分按钮(全局入口)
 *   ② 4 个紧凑快速操作按钮(添加待办/今日笔记/AI/知识图谱)
 *   ③ 快速记一笔(textarea, ⌘↩ 追加到今日 daily)
 *   ④ 今日待办速览(左) + 最近笔记(右),都带 inline 创建按钮
 *   ⑤ 写作活力(笔记/连续天数/距上次/本周字数 + 14 天迷你图)
 *   ⑥ 置顶笔记(左) + 问 AI 输入(右,直接输入新建对话)
 */
/**
 * 桌面端原版主页（保留所有原有 hook + 1300+ 行实现）。
 * 移动端走文件末尾的 HomePage wrapper → MobileHome（按设计稿小屏布局）。
 */
/** 本地时区的 YYYY-MM-DD。
 *
 * 不能用 `new Date().toISOString().slice(0,10)` —— 那是 UTC 日期，后端 `DATE(updated_at)`
 * 用的是 localtime，两者在本地凌晨 0~8 点（东八区）会差一天，导致连续写作/柱状图错位。 */
function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function DesktopHomePage() {
  const navigate = useNavigate();
  const { token } = antdTheme.useToken();
  const { message } = AntdApp.useApp();
  const refreshTaskStats = useAppStore((s) => s.refreshTaskStats);

  // 功能模块开关：用户在设置里关闭某模块时，首页相关的卡片/按钮也要联动隐藏
  const tasksEnabled = useFeatureEnabled("tasks");
  const dailyEnabled = useFeatureEnabled("daily");
  const aiEnabled = useFeatureEnabled("ai");
  const graphEnabled = useFeatureEnabled("graph");

  // ─── 数据状态 ─────────────────────────────────────
  const [recentNotes, setRecentNotes] = useState<Note[]>([]);
  const [pinnedNotes, setPinnedNotes] = useState<Note[]>([]);
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
  const [loading, setLoading] = useState(true);

  // ─── 输入态 ───────────────────────────────────────
  const [searchKeyword, setSearchKeyword] = useState("");
  const [quickNote, setQuickNote] = useState("");
  const [quickNoteSaving, setQuickNoteSaving] = useState(false);
  const [aiQuestion, setAiQuestion] = useState("");
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
      const [notesResult, dashStats, trendData, allTodos, chats] =
        await Promise.all([
          noteApi.list({ page: 1, page_size: 8 }),
          systemApi.getDashboardStats(),
          systemApi.getWritingTrend(14),
          taskApi.list({ status: 0 }).catch(() => [] as Task[]),
          aiChatApi.listConversations().catch(() => [] as AiConversation[]),
        ]);
      setRecentNotes(notesResult.items.filter((n) => !n.is_pinned));
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
      const today = new Date().toISOString().slice(0, 10);
      await dailyApi.getOrCreate(today);
      navigate(`/daily?date=${today}`);
    } catch (e) {
      message.error(`打开今日笔记失败: ${e}`);
    }
  }, [navigate, message]);

  // ─── 快速记一笔:追加到今日 daily ───────────────────
  const handleQuickSaveNote = useCallback(async () => {
    const text = quickNote.trim();
    if (!text) return;
    setQuickNoteSaving(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const daily = await dailyApi.getOrCreate(today);
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      // 用时间戳前缀分隔多条快速记录,内容追加到 content 末尾(content 是 HTML)
      const appendBlock = `<p><strong>[${hhmm}]</strong> ${text.replace(/\n/g, "<br>")}</p>`;
      const newContent = (daily.content || "") + appendBlock;
      await noteApi.update(daily.id, {
        title: daily.title,
        content: newContent,
        folder_id: daily.folder_id,
      });
      message.success("已写入今日笔记");
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

  // 14 天柱状图的 normalize
  const trendBars = useMemo(() => {
    const now = new Date();
    const items: { date: string; words: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const ymd = localYmd(d);
      const stat = vitalityMetrics.trendByDate.get(ymd);
      items.push({ date: ymd, words: stat?.word_count ?? 0 });
    }
    const maxW = Math.max(...items.map((i) => i.words), 1);
    // sqrt 归一化:线性归一化下,一条 25 万字的导入/长笔记会把其它天压成肉眼为 0 的细条。
    // sqrt 压缩动态范围,让几十~几百字的日常写作(含日记)也清晰可见。
    return items.map((it) => ({
      ...it,
      ratio: it.words > 0 ? Math.sqrt(it.words / maxW) : 0,
    }));
  }, [vitalityMetrics]);

  // 待办速览三段：逾期（昨天及更早）/ 今日 / 即将到期。每段最多 5 条
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
    return {
      overdue: overdue.slice(0, 5),
      overdueTotal: overdue.length,
      today: today.slice(0, 5),
      todayTotal: today.length,
      // 即将到期去掉 7 天上限后，只展示最靠近今天的 3 条
      upcoming: upcomingTasks.slice(0, 3),
      upcomingTotal: upcomingTasks.length,
      noDue: noDueTasks.slice(0, 5),
      noDueTotal: noDueTasks.length,
    };
  }, [todayTasks, upcomingTasks, noDueTasks]);
  const totalTodoCount =
    todoGroups.overdueTotal +
    todoGroups.todayTotal +
    todoGroups.upcomingTotal +
    todoGroups.noDueTotal;
  const displayedRecent = useMemo(() => recentNotes.slice(0, 5), [recentNotes]);

  // ─── 渲染 ─────────────────────────────────────────
  return (
    <div
      // 外层 wrapper 撑满 Content 区域 —— max-w-5xl 居中后两侧空白属于 Content
      // 不属于内层 div，事件不会冒泡。把 onContextMenu 放在撑满的 wrapper 上
      // 才能拦到这部分空白的右键
      style={{ width: "100%", minHeight: "100%" }}
      onContextMenu={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest("input, textarea, [contenteditable='true']")) return;
        e.preventDefault();
      }}
    >
    <div
      className="max-w-5xl mx-auto"
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
    >

      {/* ① 顶部搜索 + 新建笔记
          搜索：输入即下拉建议（笔记 + 待办，点击跳详情），回车去 /search 全量结果 */}
      <div className="flex gap-3">
        <HomeSearchInput
          value={searchKeyword}
          onChange={setSearchKeyword}
          onPressEnter={handleSearch}
        />
        <NewNoteButton size="large" style={{ borderRadius: 8 }} />
      </div>

      {/* ② 快速操作工具条 — 按启用模块动态分列
          添加待办用 NewTodoButton 分段按钮(主按钮弹 Modal + ▼ 下拉 AI 规划)
          某模块在设置里关闭时，对应按钮自动消失，剩余按钮等宽分布 */}
      {(() => {
        const quickActions: { key: string; show: boolean; node: React.ReactNode }[] = [
          {
            key: "todo",
            show: tasksEnabled,
            node: (
              <NewTodoButton
                block
                onSaved={() => {
                  loadDashboard();
                  refreshTaskStats();
                }}
              />
            ),
          },
          {
            key: "today",
            show: dailyEnabled,
            node: (
              <Button
                icon={<CalendarDays size={14} style={{ color: token.colorPrimary }} />}
                onClick={handleTodayNote}
                block
                style={{ borderRadius: 8 }}
              >
                今日笔记
              </Button>
            ),
          },
          {
            key: "ai",
            show: aiEnabled,
            node: (
              <Button
                icon={<Bot size={14} style={{ color: "#9333ea" }} />}
                onClick={() => navigate("/ai")}
                block
                style={{ borderRadius: 8 }}
              >
                AI 问答
              </Button>
            ),
          },
          {
            key: "graph",
            show: graphEnabled,
            node: (
              <Button
                icon={<GitBranch size={14} style={{ color: "#2563eb" }} />}
                onClick={() => navigate("/graph")}
                block
                style={{ borderRadius: 8 }}
              >
                知识图谱
              </Button>
            ),
          },
        ];
        const visible = quickActions.filter((a) => a.show);
        if (visible.length === 0) return null;
        return (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${visible.length}, 1fr)`,
              gap: 12,
            }}
          >
            {visible.map((a) => (
              <div key={a.key}>{a.node}</div>
            ))}
          </div>
        );
      })()}

      {/* ③ 快速记一笔 — 追加到今日 daily（每日笔记关闭时整块隐藏） */}
      {dailyEnabled && (
      <Card
        size="small"
        styles={{ body: { padding: "12px 14px" } }}
      >
        <div className="flex items-center justify-between mb-2 gap-3">
          <span className="flex items-center gap-2 text-sm font-medium">
            <PencilLine size={14} style={{ color: token.colorPrimary }} />
            快速记一笔
            <Text type="secondary" style={{ fontSize: 11, fontWeight: "normal" }}>
              追加到「今日笔记」
            </Text>
          </span>
          <div className="flex items-center gap-2 shrink-0">
            {quickNote.trim() && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                {quickNote.trim().length} 字
              </Text>
            )}
            <Text type="secondary" style={{ fontSize: 11 }}>
              Ctrl/⌘ + ↩
            </Text>
            <MicButton
              onTranscribed={(text) =>
                setQuickNote((prev) => (prev ? `${prev}\n${text}` : text))
              }
            />
            <Button
              size="small"
              type="primary"
              ghost
              icon={<Check size={13} />}
              loading={quickNoteSaving}
              disabled={!quickNote.trim()}
              onClick={handleQuickSaveNote}
            >
              保存
            </Button>
          </div>
        </div>
        <Input.TextArea
          rows={2}
          placeholder="想到什么先记下来…"
          value={quickNote}
          onChange={(e) => setQuickNote(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              handleQuickSaveNote();
            }
          }}
          style={{ borderRadius: 6, fontSize: 13 }}
          autoSize={{ minRows: 2, maxRows: 5 }}
        />
      </Card>
      )}

      {/* ④ 双列:今日待办速览(左) + 最近笔记(右)；待办关闭时只剩最近笔记一列 */}
      <div className="grid grid-cols-12 gap-3">

        {/* 待办速览(三段:逾期/今日/即将到期):tasks 关闭整卡不渲染，最近笔记自动占满 */}
        {tasksEnabled && (
        <Card
          size="small"
          className="col-span-7"
          styles={{ body: { padding: "8px 14px" } }}
          title={
            <span className="flex items-center gap-2 text-sm">
              <CheckSquare size={14} style={{ color: token.colorSuccess }} />
              待办速览
              {totalTodoCount > 0 && (
                <Text type="secondary" style={{ fontSize: 12, fontWeight: "normal" }}>
                  · 共 {totalTodoCount} 条
                </Text>
              )}
            </span>
          }
          extra={
            <Button
              type="link"
              size="small"
              onClick={() => navigate("/tasks")}
              style={{ padding: 0, fontSize: 12 }}
            >
              全部 <ArrowRight size={11} />
            </Button>
          }
        >
          {totalTodoCount === 0 ? (
            <div className="text-center py-4">
              <Text type="secondary" style={{ fontSize: 12 }}>
                {loading ? "加载中…" : "暂无待办，享受当下 ✨"}
              </Text>
            </div>
          ) : (
            (() => {
              /** 单条任务渲染（三段共用），按段类型决定日期标签的色/文 */
              const renderTaskRow = (
                task: Task,
                sectionKey: "overdue" | "today" | "upcoming" | "noDue",
              ) => {
                const due = new Date(task.due_date!);
                const dueMs = due.getTime();
                const dotColor =
                  task.priority === 0
                    ? token.colorError
                    : task.priority === 1
                      ? token.colorPrimary
                      : token.colorTextTertiary;
                const desc = task.description?.trim();
                const ctxActive = taskCtx.state.payload?.id === task.id;
                const hasSubtasks = task.subtask_total > 0;
                const expanded = expandedTodoIds.has(task.id);

                // 日期标签：每段不同
                let dateLabel: React.ReactNode;
                if (sectionKey === "overdue") {
                  const todayStart = new Date();
                  todayStart.setHours(0, 0, 0, 0);
                  const days = Math.max(
                    1,
                    Math.round((todayStart.getTime() - dueMs) / 86400000),
                  );
                  dateLabel = (
                    <span
                      className="text-[11px] px-1.5 py-0.5 rounded shrink-0"
                      style={{
                        background: `${token.colorError}1a`,
                        color: token.colorError,
                      }}
                    >
                      {days === 1 ? "昨天" : `${days} 天前`}
                    </span>
                  );
                } else if (sectionKey === "today") {
                  const hh = String(due.getHours()).padStart(2, "0");
                  const mm = String(due.getMinutes()).padStart(2, "0");
                  const noTime = hh === "00" && mm === "00";
                  const overdueNow = dueMs < Date.now();
                  dateLabel = (
                    <Text
                      type={overdueNow ? "danger" : "secondary"}
                      style={{ fontSize: 11, flexShrink: 0 }}
                    >
                      {noTime ? "今天" : `${hh}:${mm}`}
                    </Text>
                  );
                } else if (sectionKey === "upcoming") {
                  const todayStart = new Date();
                  todayStart.setHours(0, 0, 0, 0);
                  const days = Math.max(
                    1,
                    Math.ceil((dueMs - todayStart.getTime()) / 86400000),
                  );
                  dateLabel = (
                    <Text
                      type="secondary"
                      style={{ fontSize: 11, flexShrink: 0 }}
                    >
                      +{days} 天
                    </Text>
                  );
                } else {
                  // noDue：无截止日期，显示中性「无期限」标签
                  dateLabel = (
                    <Text
                      type="secondary"
                      style={{ fontSize: 11, flexShrink: 0 }}
                    >
                      无期限
                    </Text>
                  );
                }

                return (
                  <Fragment key={task.id}>
                    <li
                      className="flex items-start gap-2.5"
                      style={{
                        padding: "4px 6px",
                        borderRadius: 4,
                        background: ctxActive ? token.colorPrimaryBg : "transparent",
                        transition: "background .12s",
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        taskCtx.open(e.nativeEvent, task);
                      }}
                    >
                      {hasSubtasks ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedTodoIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(task.id)) next.delete(task.id);
                              else next.add(task.id);
                              return next;
                            });
                          }}
                          className="flex items-center justify-center hover:bg-black/5 rounded transition cursor-pointer"
                          style={{
                            width: 16,
                            height: 16,
                            marginTop: 3,
                            flexShrink: 0,
                            color: token.colorTextTertiary,
                          }}
                          title={expanded ? "折叠子任务" : "展开子任务"}
                        >
                          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        </button>
                      ) : (
                        <span style={{ width: 16, flexShrink: 0 }} />
                      )}
                      <input
                        type="checkbox"
                        onChange={() => handleToggleTask(task.id)}
                        onClick={(e) => e.stopPropagation()}
                        style={{ cursor: "pointer", flexShrink: 0, marginTop: 4 }}
                      />
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          background: dotColor,
                          flexShrink: 0,
                          marginTop: 7,
                        }}
                      />
                      <div
                        className="flex-1 min-w-0 cursor-pointer"
                        onClick={() => setTaskDetail(task)}
                      >
                        <div className="flex items-center gap-1.5">
                          <Text
                            ellipsis
                            style={{ fontSize: 13, flex: 1, minWidth: 0 }}
                          >
                            {task.title}
                          </Text>
                          {task.important && (
                            <Star
                              size={11}
                              style={{ color: token.colorWarning, flexShrink: 0 }}
                              fill={token.colorWarning}
                            />
                          )}
                          {dateLabel}
                        </div>
                        <Text
                          type="secondary"
                          ellipsis
                          style={{ fontSize: 11, display: "block", minHeight: 16 }}
                        >
                          {desc || "\u00A0"}
                        </Text>
                      </div>
                    </li>
                    {expanded && hasSubtasks && (
                      <li
                        className="list-none"
                        style={{
                          padding: "0 8px 4px 38px",
                          marginTop: -2,
                        }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <SubtaskList
                          parentTaskId={task.id}
                          compact
                          onChanged={(done, total) =>
                            patchTask(task.id, {
                              subtask_done: done,
                              subtask_total: total,
                            })
                          }
                        />
                      </li>
                    )}
                  </Fragment>
                );
              };

              const sections: Array<{
                key: "overdue" | "today" | "upcoming" | "noDue";
                items: Task[];
                total: number;
                label: string;
                icon: React.ReactNode;
                color: string;
              }> = [
                {
                  key: "overdue",
                  items: todoGroups.overdue,
                  total: todoGroups.overdueTotal,
                  label: "逾期",
                  icon: <AlertTriangle size={11} />,
                  color: token.colorError,
                },
                {
                  key: "today",
                  items: todoGroups.today,
                  total: todoGroups.todayTotal,
                  label: "今日",
                  icon: <CalendarDays size={11} />,
                  color: token.colorPrimary,
                },
                {
                  key: "upcoming",
                  items: todoGroups.upcoming,
                  total: todoGroups.upcomingTotal,
                  label: "即将到期",
                  icon: <Clock size={11} />,
                  color: token.colorTextSecondary,
                },
                {
                  key: "noDue",
                  items: todoGroups.noDue,
                  total: todoGroups.noDueTotal,
                  label: "无截止日期",
                  icon: <Inbox size={11} />,
                  color: token.colorTextTertiary,
                },
              ];

              return (
                <div
                  className="flex flex-col gap-3"
                  style={{ maxHeight: 420, overflowY: "auto" }}
                >
                  {sections
                    .filter((s) => s.items.length > 0)
                    .map((s) => (
                      <div key={s.key} className="flex flex-col gap-1">
                        <div
                          className="flex items-center gap-1.5"
                          style={{
                            fontSize: 11,
                            color: s.color,
                            fontWeight: 600,
                          }}
                        >
                          {s.icon}
                          <span>{s.label}</span>
                          <Text
                            type="secondary"
                            style={{ fontSize: 11, fontWeight: 400 }}
                          >
                            · {s.total}
                          </Text>
                        </div>
                        <ul className="flex flex-col gap-1.5 m-0 p-0 list-none">
                          {s.items.map((t) => renderTaskRow(t, s.key))}
                        </ul>
                        {s.total > s.items.length && (
                          <Button
                            type="link"
                            size="small"
                            onClick={() => navigate("/tasks")}
                            style={{
                              padding: 0,
                              fontSize: 11,
                              alignSelf: "flex-start",
                              marginLeft: 24,
                            }}
                          >
                            + 还有 {s.total - s.items.length} 条…
                          </Button>
                        )}
                      </div>
                    ))}
                </div>
              );
            })()
          )}
        </Card>
        )}

        {/* 最近笔记：tasks 关时占满 12 列，反之 5 列 */}
        <Card
          size="small"
          className={tasksEnabled ? "col-span-5" : "col-span-12"}
          styles={{ body: { padding: "8px 14px" } }}
          title={
            <span className="flex items-center gap-2 text-sm">
              <NotebookText size={14} style={{ color: token.colorPrimary }} />
              最近笔记
            </span>
          }
          extra={
            <Button
              type="link"
              size="small"
              onClick={() => navigate("/notes")}
              style={{ padding: 0, fontSize: 12 }}
            >
              更多 <ArrowRight size={11} />
            </Button>
          }
        >
          {displayedRecent.length === 0 ? (
            <EmptyState
              description={loading ? "加载中…" : "还没有笔记"}
            />
          ) : (
            <ul className="flex flex-col gap-2 m-0 p-0 list-none">
              {displayedRecent.map((note) => {
                const ctxActive = noteCtx.state.payload?.id === note.id;
                return (
                <li
                  key={note.id}
                  className="cursor-pointer"
                  style={{
                    padding: "4px 6px",
                    borderRadius: 4,
                    background: ctxActive ? token.colorPrimaryBg : "transparent",
                    transition: "background .12s",
                  }}
                  onClick={() => navigate(`/notes/${note.id}`)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    noteCtx.open(e.nativeEvent, note);
                  }}
                >
                  <div className="flex items-center gap-1.5">
                    {note.is_daily && (
                      <Tag
                        color="blue"
                        style={{ fontSize: 10, lineHeight: "14px", padding: "0 4px", margin: 0 }}
                      >
                        日记
                      </Tag>
                    )}
                    <Text ellipsis style={{ fontSize: 13, flex: 1, minWidth: 0 }}>
                      {note.title}
                    </Text>
                  </div>
                  <Text
                    type="secondary"
                    style={{ fontSize: 11, display: "block", minHeight: 16 }}
                  >
                    {relativeTime(note.updated_at)} · {note.word_count} 字
                  </Text>
                </li>
              );
              })}
            </ul>
          )}
        </Card>
      </div>

      {/* ⑤ 写作活力 — 4 指标 + 14 天迷你图 */}
      <Card
        size="small"
        styles={{ body: { padding: "12px 14px" } }}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Sparkles size={14} style={{ color: "#f97316" }} />
            写作活力
          </span>
          <Text type="secondary" style={{ fontSize: 11 }}>
            近 14 天
          </Text>
        </div>
        <div className="grid grid-cols-5 gap-3">
          <MetricItem
            icon={<NotebookText size={16} style={{ color: token.colorPrimary }} />}
            iconBg={`${token.colorPrimary}15`}
            value={vitalityMetrics.totalNotes}
            label="笔记总数"
          />
          <MetricItem
            icon={<Type size={16} style={{ color: "#7c3aed" }} />}
            iconBg="#ede9fe"
            value={vitalityMetrics.totalWords.toLocaleString()}
            label="总字数"
            isText
          />
          <MetricItem
            icon={<Flame size={16} style={{ color: "#ea580c" }} />}
            iconBg="#fff7ed"
            value={vitalityMetrics.streak}
            valueSuffix="天"
            label="连续写作"
          />
          <MetricItem
            icon={<Clock size={16} style={{ color: "#2563eb" }} />}
            iconBg="#dbeafe"
            value={vitalityMetrics.lastSinceLabel}
            label="距上次写作"
            isText
          />
          <MetricItem
            icon={<TrendingUp size={16} style={{ color: token.colorSuccess }} />}
            iconBg={`${token.colorSuccess}1a`}
            value={vitalityMetrics.thisWeekWords.toLocaleString()}
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
        {/* 迷你 14 天柱状图 + 底部 X 轴标签(3 个关键日期) */}
        <div
          className="mt-3 pt-3"
          style={{ borderTop: `1px solid ${token.colorBorderSecondary}` }}
        >
          <div className="flex items-end gap-0.5" style={{ height: 36 }}>
            {trendBars.map((bar) => (
              <AntTooltip key={bar.date} title={`${bar.date} · ${bar.words} 字`}>
                <div
                  className="flex-1 rounded-sm transition-colors"
                  style={{
                    height: `${Math.max(bar.ratio * 100, 4)}%`,
                    background: bar.words > 0 ? token.colorPrimary : token.colorBorderSecondary,
                    opacity: bar.words > 0 ? 0.5 + bar.ratio * 0.5 : 0.4,
                    cursor: "pointer",
                  }}
                />
              </AntTooltip>
            ))}
          </div>
          {/* X 轴标签:14 天前 / 7 天前 / 今天 */}
          <div
            className="flex justify-between mt-1"
            style={{ fontSize: 10, color: token.colorTextQuaternary }}
          >
            <span>{trendBars[0]?.date.slice(5) ?? ""}</span>
            <span>{trendBars[7]?.date.slice(5) ?? "7 天前"}</span>
            <span>今天</span>
          </div>
        </div>
      </Card>

      {/* ⑥ 双列:置顶笔记 + 问 AI；ai 关闭时只剩置顶笔记一列 */}
      <div className="grid grid-cols-12 gap-3">
        <Card
          size="small"
          className={aiEnabled ? "col-span-5" : "col-span-12"}
          styles={{ body: { padding: "12px 14px" } }}
          title={
            <span className="flex items-center gap-2 text-sm">
              <Pin size={14} style={{ color: token.colorWarning }} />
              置顶笔记
              {pinnedNotes.length > 0 && (
                <Text type="secondary" style={{ fontSize: 12, fontWeight: "normal" }}>
                  · {pinnedNotes.length}
                </Text>
              )}
            </span>
          }
        >
          {pinnedNotes.length === 0 ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              在笔记编辑器右上角可置顶
            </Text>
          ) : (
            <ul className="flex flex-col gap-1.5 m-0 p-0 list-none">
              {pinnedNotes.slice(0, 5).map((note) => (
                <li
                  key={note.id}
                  className="flex items-center gap-2 cursor-pointer"
                  onClick={() => navigate(`/notes/${note.id}`)}
                  style={{ padding: "2px 0" }}
                >
                  <Pin size={11} style={{ color: token.colorWarning, flexShrink: 0 }} />
                  <Text ellipsis style={{ fontSize: 13, flex: 1, minWidth: 0 }}>
                    {note.title}
                  </Text>
                  <Text type="secondary" style={{ fontSize: 10, flexShrink: 0 }}>
                    {relativeTime(note.updated_at)}
                  </Text>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {aiEnabled && (
        <Card
          size="small"
          className="col-span-7"
          styles={{ body: { padding: "12px 14px" } }}
          title={
            <span className="flex items-center gap-2 text-sm">
              <Bot size={14} style={{ color: "#9333ea" }} />
              问 AI
            </span>
          }
          extra={
            <Button
              type="link"
              size="small"
              onClick={() => navigate("/ai")}
              style={{ padding: 0, fontSize: 12 }}
            >
              所有会话 <ArrowRight size={11} />
            </Button>
          }
        >
          <Input
            placeholder="例如:总结我本周写的内容…"
            value={aiQuestion}
            onChange={(e) => setAiQuestion(e.target.value)}
            onPressEnter={handleAskAi}
            suffix={
              <Button
                type="text"
                size="small"
                icon={<Send size={12} />}
                disabled={!aiQuestion.trim()}
                onClick={handleAskAi}
                style={{ color: aiQuestion.trim() ? "#9333ea" : undefined }}
              />
            }
            style={{ borderRadius: 6, marginBottom: 8 }}
          />
          {recentChats.length > 0 ? (
            <>
              <Text type="secondary" style={{ fontSize: 11 }}>
                最近会话
              </Text>
              <ul className="flex flex-col gap-1 mt-1 m-0 p-0 list-none">
                {recentChats.map((chat) => (
                  <li
                    key={chat.id}
                    className="flex items-center gap-2 cursor-pointer hover:opacity-70 transition"
                    onClick={() => navigate(`/ai?cid=${chat.id}`)}
                    style={{ fontSize: 12 }}
                  >
                    <MessageCircle size={11} style={{ flexShrink: 0, opacity: 0.6 }} />
                    <Text ellipsis style={{ fontSize: 12, flex: 1, minWidth: 0 }}>
                      {chat.title || "未命名会话"}
                    </Text>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <Text type="secondary" style={{ fontSize: 11 }}>
              输入问题回车直接发送,自动新建对话
            </Text>
          )}
        </Card>
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
function MetricItem({
  icon,
  iconBg,
  value,
  valueSuffix,
  label,
  extra,
  isText,
}: {
  icon: React.ReactNode;
  iconBg: string;
  value: number | string;
  valueSuffix?: string;
  label: string;
  extra?: React.ReactNode;
  isText?: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <div
        className="flex items-center justify-center rounded-lg shrink-0"
        style={{ width: 36, height: 36, background: iconBg }}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-base font-semibold leading-tight" style={{ fontSize: isText ? 14 : 18 }}>
          {value}
          {valueSuffix && (
            <span className="text-xs text-slate-400 font-normal ml-0.5">{valueSuffix}</span>
          )}
          {extra && <span className="ml-1.5">{extra}</span>}
        </div>
        <div className="text-[11px] text-slate-500">{label}</div>
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
