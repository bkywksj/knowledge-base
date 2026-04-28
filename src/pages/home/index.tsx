import { useState, useEffect, useCallback, useMemo } from "react";
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
  Search,
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
} from "lucide-react";
import { Tooltip as AntTooltip } from "antd";
import {
  noteApi,
  dailyApi,
  systemApi,
  taskApi,
  aiChatApi,
} from "@/lib/api";
import { relativeTime } from "@/lib/utils";
import { EmptyState } from "@/components/ui/EmptyState";
import { NewNoteButton } from "@/components/NewNoteButton";
import { NewTodoButton } from "@/components/NewTodoButton";
import { useAppStore } from "@/store";
import type {
  Note,
  DashboardStats,
  DailyWritingStat,
  Task,
  AiConversation,
} from "@/types";

const { Text, Paragraph } = Typography;

const PRIORITY_LABEL: Record<number, string> = { 0: "高", 1: "中", 2: "低" };
const REPEAT_LABEL: Record<string, string> = {
  none: "不循环",
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
  yearly: "每年",
};

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
export default function HomePage() {
  const navigate = useNavigate();
  const { token } = antdTheme.useToken();
  const { message } = AntdApp.useApp();
  const refreshTaskStats = useAppStore((s) => s.refreshTaskStats);

  // ─── 数据状态 ─────────────────────────────────────
  const [recentNotes, setRecentNotes] = useState<Note[]>([]);
  const [pinnedNotes, setPinnedNotes] = useState<Note[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [trend, setTrend] = useState<DailyWritingStat[]>([]);
  /** 今日待办速览(今天 + 逾期,前端筛 / 切片) */
  const [todayTasks, setTodayTasks] = useState<Task[]>([]);
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
      // 筛今日 + 逾期(due_date <= 今天结束)未完成,按时间排序
      const today = new Date();
      const todayEnd = new Date(today);
      todayEnd.setHours(23, 59, 59, 999);
      const filtered = allTodos
        .filter((t) => t.status === 0 && t.due_date)
        .filter((t) => new Date(t.due_date!).getTime() <= todayEnd.getTime())
        .sort((a, b) => {
          // 逾期优先
          const ad = new Date(a.due_date!).getTime();
          const bd = new Date(b.due_date!).getTime();
          return ad - bd;
        });
      setTodayTasks(filtered);
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
    // trend 是按日期升序,只含有笔记的日期
    const todayStr = new Date().toISOString().slice(0, 10);
    const trendByDate = new Map(trend.map((d) => [d.date, d]));

    // 连续写作天数:从今天往前数,直到某天没写作
    let streak = 0;
    const cursor = new Date();
    for (let i = 0; i < 365; i++) {
      const ymd = cursor.toISOString().slice(0, 10);
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

    // 距上次写作:用最近笔记 updated_at
    const lastWritingAt = recentNotes[0]?.updated_at ?? pinnedNotes[0]?.updated_at;
    const lastSinceLabel = lastWritingAt ? relativeTime(lastWritingAt) : "—";

    // 本周字数(最近 7 天) + 上周字数(8-14 天)对比
    let thisWeek = 0;
    let lastWeek = 0;
    const now = new Date();
    for (let i = 0; i < 14; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const ymd = d.toISOString().slice(0, 10);
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
  }, [trend, stats, recentNotes, pinnedNotes]);

  // 14 天柱状图的 normalize
  const trendBars = useMemo(() => {
    const now = new Date();
    const items: { date: string; words: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const ymd = d.toISOString().slice(0, 10);
      const stat = vitalityMetrics.trendByDate.get(ymd);
      items.push({ date: ymd, words: stat?.word_count ?? 0 });
    }
    const maxW = Math.max(...items.map((i) => i.words), 1);
    return items.map((it) => ({ ...it, ratio: it.words / maxW }));
  }, [vitalityMetrics]);

  // 待办速览展示前 5 条
  const displayedTodos = useMemo(() => todayTasks.slice(0, 5), [todayTasks]);
  const overdueTodayCount = useMemo(() => {
    const now = Date.now();
    return todayTasks.filter((t) => new Date(t.due_date!).getTime() < now).length;
  }, [todayTasks]);
  const displayedRecent = useMemo(() => recentNotes.slice(0, 5), [recentNotes]);

  // ─── 渲染 ─────────────────────────────────────────
  return (
    <div className="max-w-5xl mx-auto" style={{ display: "flex", flexDirection: "column", gap: 12 }}>

      {/* ① 顶部搜索 + 新建笔记 */}
      <div className="flex gap-3">
        <Input
          size="large"
          placeholder="搜索笔记 / 待办 / 标签…  (Ctrl+K)"
          prefix={<Search size={16} style={{ color: token.colorTextQuaternary }} />}
          value={searchKeyword}
          onChange={(e) => setSearchKeyword(e.target.value)}
          onPressEnter={handleSearch}
          allowClear
          style={{ borderRadius: 8 }}
          className="flex-1"
        />
        <NewNoteButton size="large" style={{ borderRadius: 8 }} />
      </div>

      {/* ② 快速操作工具条 — 4 按钮(default size,32px 自然一致)
          添加待办用 NewTodoButton 分段按钮(主按钮弹 Modal + ▼ 下拉 AI 规划) */}
      <div className="grid grid-cols-4 gap-3">
        <NewTodoButton
          block
          onSaved={() => {
            loadDashboard();
            refreshTaskStats();
          }}
        />
        <Button
          icon={<CalendarDays size={14} style={{ color: token.colorPrimary }} />}
          onClick={handleTodayNote}
          block
          style={{ borderRadius: 8 }}
        >
          今日笔记
        </Button>
        <Button
          icon={<Bot size={14} style={{ color: "#9333ea" }} />}
          onClick={() => navigate("/ai")}
          block
          style={{ borderRadius: 8 }}
        >
          AI 问答
        </Button>
        <Button
          icon={<GitBranch size={14} style={{ color: "#2563eb" }} />}
          onClick={() => navigate("/graph")}
          block
          style={{ borderRadius: 8 }}
        >
          知识图谱
        </Button>
      </div>

      {/* ③ 快速记一笔 — 追加到今日 daily */}
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

      {/* ④ 双列:今日待办速览(左) + 最近笔记(右) */}
      <div className="grid grid-cols-12 gap-3">

        {/* 今日待办 */}
        <Card
          size="small"
          className="col-span-7"
          styles={{ body: { padding: "8px 14px" } }}
          title={
            <span className="flex items-center gap-2 text-sm">
              <CheckSquare size={14} style={{ color: token.colorSuccess }} />
              今日待办
              <Text type="secondary" style={{ fontSize: 12, fontWeight: "normal" }}>
                · {todayTasks.length} 条
              </Text>
              {overdueTodayCount > 0 && (
                <span
                  className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded"
                  style={{ background: `${token.colorError}1a`, color: token.colorError }}
                >
                  <AlertTriangle size={10} /> {overdueTodayCount} 逾期
                </span>
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
          {displayedTodos.length === 0 ? (
            <div className="text-center py-4">
              <Text type="secondary" style={{ fontSize: 12 }}>
                {loading ? "加载中…" : "今天没有待办，太棒了 ✨"}
              </Text>
            </div>
          ) : (
            <ul className="flex flex-col gap-2 m-0 p-0 list-none">
              {displayedTodos.map((task) => {
                const dueAt = new Date(task.due_date!).getTime();
                const isOverdue = dueAt < Date.now();
                const dotColor =
                  task.priority === 0
                    ? token.colorError
                    : task.priority === 1
                      ? token.colorPrimary
                      : token.colorTextTertiary;
                const desc = task.description?.trim();
                return (
                  <li
                    key={task.id}
                    className="flex items-start gap-2.5"
                    style={{ padding: "4px 0" }}
                  >
                    <input
                      type="checkbox"
                      onChange={() => handleToggleTask(task.id)}
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
                        {isOverdue ? (
                          <span
                            className="text-[11px] px-1.5 py-0.5 rounded shrink-0"
                            style={{
                              background: `${token.colorError}1a`,
                              color: token.colorError,
                            }}
                          >
                            逾期
                          </span>
                        ) : (
                          <Text
                            type="secondary"
                            style={{ fontSize: 11, flexShrink: 0 }}
                          >
                            今天
                          </Text>
                        )}
                      </div>
                      {/* 第二行始终渲染：无 desc 时用不间断空格占位，
                          保证每条待办高度 = 标题 + 描述行，与右侧笔记节奏一致 */}
                      <Text
                        type="secondary"
                        ellipsis
                        style={{ fontSize: 11, display: "block", minHeight: 16 }}
                      >
                        {desc || "\u00A0"}
                      </Text>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* 最近笔记 */}
        <Card
          size="small"
          className="col-span-5"
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
              {displayedRecent.map((note) => (
                <li
                  key={note.id}
                  className="cursor-pointer"
                  style={{ padding: "4px 0" }}
                  onClick={() => navigate(`/notes/${note.id}`)}
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
              ))}
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

      {/* ⑥ 双列:置顶笔记 + 问 AI */}
      <div className="grid grid-cols-12 gap-3">
        <Card
          size="small"
          className="col-span-5"
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
      </div>

      {/* 待办详情弹窗 — 点击列表项触发；展示 + 标记完成（状态切换由 handleToggleTask） */}
      <Modal
        open={taskDetail !== null}
        onCancel={() => setTaskDetail(null)}
        title="待办详情"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setTaskDetail(null)}>关闭</Button>
            <Button
              type="primary"
              onClick={() => {
                if (taskDetail) {
                  void handleToggleTask(taskDetail.id);
                }
                setTaskDetail(null);
              }}
            >
              {taskDetail?.status === 1 ? "重新开启" : "标记完成"}
            </Button>
          </div>
        }
        width={480}
      >
        {taskDetail && (
          <div className="flex flex-col gap-3">
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                标题
              </Text>
              <div className="flex items-center gap-2 mt-1">
                <Text strong style={{ fontSize: 15 }}>
                  {taskDetail.title}
                </Text>
                {taskDetail.important && (
                  <Star
                    size={14}
                    style={{ color: token.colorWarning }}
                    fill={token.colorWarning}
                  />
                )}
              </div>
            </div>

            <div className="flex gap-6">
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  优先级
                </Text>
                <div className="mt-1">
                  <Tag
                    color={
                      taskDetail.priority === 0
                        ? "red"
                        : taskDetail.priority === 1
                          ? "blue"
                          : "default"
                    }
                  >
                    {PRIORITY_LABEL[taskDetail.priority] ?? "—"}
                  </Tag>
                </div>
              </div>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  状态
                </Text>
                <div className="mt-1">
                  <Tag color={taskDetail.status === 0 ? "processing" : "success"}>
                    {taskDetail.status === 0 ? "未完成" : "已完成"}
                  </Tag>
                </div>
              </div>
              {taskDetail.due_date && (
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    截止
                  </Text>
                  <div className="mt-1" style={{ fontSize: 13 }}>
                    {taskDetail.due_date}
                  </div>
                </div>
              )}
              {taskDetail.repeat_kind && taskDetail.repeat_kind !== "none" && (
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    重复
                  </Text>
                  <div className="mt-1" style={{ fontSize: 13 }}>
                    每 {taskDetail.repeat_interval}{" "}
                    {REPEAT_LABEL[taskDetail.repeat_kind] ?? taskDetail.repeat_kind}
                  </div>
                </div>
              )}
            </div>

            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                备注
              </Text>
              <Paragraph
                style={{
                  marginTop: 4,
                  marginBottom: 0,
                  fontSize: 13,
                  whiteSpace: "pre-wrap",
                  color: taskDetail.description?.trim()
                    ? token.colorText
                    : token.colorTextQuaternary,
                }}
              >
                {taskDetail.description?.trim() || "暂无备注"}
              </Paragraph>
            </div>
          </div>
        )}
      </Modal>
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
