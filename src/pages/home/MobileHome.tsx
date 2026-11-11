import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { message } from "antd";
import { Check, ChevronDown, ChevronUp, Cloud, PencilLine, Pin, Search, SendHorizontal } from "lucide-react";
import { cardApi, folderApi, noteApi, syncV1Api, systemApi, taskApi, taskCategoryApi } from "@/lib/api";
import { appendQuickNoteToDaily } from "@/lib/mobileQuickNote";
import { relativeTime } from "@/lib/utils";
import { notePreviewText } from "@/lib/notePreview";
import { useAppStore } from "@/store";
import type { DailyWritingStat, DashboardStats, Folder, Note, SyncBackend, Task, TaskCategory } from "@/types";
import { KingKongIcon } from "@/components/mobile/KingKongIcons";
import { MGroup, MPageHeader, MSectionHeader, MTag } from "@/components/mobile/primitives";

/**
 * 移动端首页（v4 原型 docs/design/mobile-v4 第 01 屏；功能底稿 docs/tasks/mobile-v4-feature-inventory.md）
 *
 * 自上而下：问候 + 同步入口 → 搜索 → 数字条 → 金刚区 → 快速记一笔 → 今天的待办 → 继续编辑（横滑）→ 本周写作
 *
 * 每块的显隐仍由「功能模块 → 主页显示项」（store.mobileDashboardItems）控制，key 不变：
 * - today_words / due_cards / today_tasks_card / total_notes → 数字条里的四格
 * - quick_actions → 金刚区
 * - today_tasks_list → 今天的待办
 * - recent_notes → 继续编辑
 * - heatmap → 本周写作（默认 7 天柱状图，点开看 30 天热力图）
 *
 * 相比旧版修掉的问题：「今日字数」原来显示的是总字数；今日待办只取前 3 条导致计数最多 3；
 * 快速操作「闪念」「新建」都只跳笔记列表；首页待办勾选框只读。
 */

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const GREETING_HOURS = [
  { until: 6, text: "夜深了" },
  { until: 11, text: "早上好" },
  { until: 13, text: "中午好" },
  { until: 18, text: "下午好" },
  { until: 24, text: "晚上好" },
];

function getGreeting(): string {
  const h = new Date().getHours();
  return GREETING_HOURS.find((g) => h < g.until)?.text ?? "你好";
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 今天结束时刻：截止时间不晚于它的未完成任务 = 今天 + 逾期（与 PC 首页「今日待办」同口径） */
function endOfToday(): number {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

interface HomeData {
  stats: DashboardStats | null;
  notes: Note[];
  todoTasks: Task[];
  dueCards: number;
  trend: DailyWritingStat[];
  folderNames: Map<number, string>;
  /** 今天完成的待办（原型：排在未完成后面，打勾 + 删除线 +「09:30 完成」） */
  doneToday: Task[];
  categoryNames: Map<number, string>;
}

const EMPTY: HomeData = {
  stats: null,
  notes: [],
  todoTasks: [],
  dueCards: 0,
  trend: [],
  folderNames: new Map(),
  doneToday: [],
  categoryNames: new Map(),
};

function flattenFolderNames(list: Folder[], out = new Map<number, string>()): Map<number, string> {
  for (const f of list) {
    out.set(f.id, f.name);
    if (f.children?.length) flattenFolderNames(f.children, out);
  }
  return out;
}

export function MobileHome() {
  const navigate = useNavigate();
  const dashItems = useAppStore((s) => s.mobileDashboardItems);
  const show = (k: string) => dashItems.has(k as never);
  const [data, setData] = useState<HomeData>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  /** 同步状态（原型右上角「● 已同步」）：null = 加载中或没配同步，只显示入口 */
  const [syncBackend, setSyncBackend] = useState<SyncBackend | null>(null);
  useEffect(() => {
    let alive = true;
    syncV1Api
      .listBackends()
      .then((list) => alive && setSyncBackend(list.find((b) => b.enabled) ?? list[0] ?? null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const load = useCallback(async () => {
    // 各项独立兜底：一项失败不拖垮整页（旧版统计失败整页都空）
    const [stats, notesPage, tasks, dueCards, trend, folders, doneTasks, categories] = await Promise.all([
      systemApi.getDashboardStats().catch(() => null),
      noteApi.list({ page: 1, page_size: 8 }).catch(() => ({ items: [] as Note[] })),
      taskApi.list({ status: 0 }).catch(() => [] as Task[]),
      cardApi.listDue().catch(() => [] as unknown[]),
      systemApi.getWritingTrend(30).catch(() => [] as DailyWritingStat[]),
      folderApi.list().catch(() => [] as Folder[]),
      taskApi.list({ status: 1 }).catch(() => [] as Task[]),
      taskCategoryApi.list().catch(() => [] as TaskCategory[]),
    ]);
    const today = ymd(new Date());
    setData({
      stats,
      notes: notesPage.items ?? [],
      todoTasks: tasks,
      dueCards: dueCards.length,
      trend,
      folderNames: flattenFolderNames(folders),
      // completed_at 是本地时间 YYYY-MM-DD HH:MM:SS；子任务不上首页
      doneToday: doneTasks
        .filter((t) => t.status === 1 && t.parent_task_id == null && t.completed_at?.startsWith(today))
        .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""))
        .slice(0, 3),
      categoryNames: new Map(categories.map((c) => [c.id, c.name])),
    });
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ─── 派生数据 ───
  const todayKey = ymd(new Date());
  const todayWords = data.trend.find((t) => t.date === todayKey)?.word_count ?? 0;
  const { todayTasks, overdueCount } = useMemo(() => {
    const end = endOfToday();
    const startOfToday = new Date().setHours(0, 0, 0, 0);
    const due = data.todoTasks
      .filter((t) => t.due_date && new Date(t.due_date).getTime() <= end)
      .sort((a, b) => new Date(a.due_date!).getTime() - new Date(b.due_date!).getTime());
    return {
      todayTasks: due,
      overdueCount: due.filter((t) => new Date(t.due_date!).getTime() < startOfToday).length,
    };
  }, [data.todoTasks]);

  const now = new Date();
  const dateLine = `${now.getMonth() + 1} 月 ${now.getDate()} 日 · ${WEEKDAYS[now.getDay()]}`;

  const statCells = [
    show("today_words") && { key: "w", value: loaded ? todayWords : "—", label: "今日字数", to: "/daily" },
    show("due_cards") && { key: "c", value: loaded ? data.dueCards : "—", label: "待复习", to: "/cards" },
    show("today_tasks_card") && { key: "t", value: loaded ? todayTasks.length : "—", label: "今日待办", to: "/tasks" },
    show("total_notes") && {
      key: "n",
      value: data.stats?.total_notes ?? "—",
      label: "笔记总数",
      // 「今日更新 N」放成数字右上角的 +N，四格宽度放不下一整句
      delta: data.stats && data.stats.today_updated > 0 ? data.stats.today_updated : undefined,
      to: "/notes",
    },
  ].filter(Boolean) as { key: string; value: number | string; label: string; delta?: number; to: string }[];

  async function createBlankNote() {
    try {
      const note = await noteApi.create({ title: "无标题笔记", content: "", folder_id: null });
      useAppStore.getState().bumpNotesRefresh();
      navigate(`/notes/${note.id}`);
    } catch (e) {
      message.error(`创建失败: ${e}`);
    }
  }

  return (
    // 大屏（平板 / 折叠屏展开）限宽居中，免得横向拉成长条
    <div className="mx-auto w-full max-w-[860px] pb-8">
      <MPageHeader
        subtitle={dateLine}
        title={getGreeting()}
        actions={
          <button
            type="button"
            className="m-tapx mb-1 mr-2 flex h-8 items-center gap-1.5 rounded-[var(--m-r-m)] px-3 text-[13px]"
            style={{ background: "var(--m-surface)", color: "var(--m-ink2)" }}
            onClick={() => navigate("/sync")}
          >
            <SyncBadge backend={syncBackend} />
          </button>
        }
      />

      <div className="m-gutter mt-4">
        <button
          type="button"
          className="flex h-11 w-full items-center gap-2.5 rounded-[var(--m-r-l)] px-4 text-[15px]"
          style={{ background: "var(--m-surface)", color: "var(--m-ink3)" }}
          onClick={() => navigate("/search")}
        >
          <Search size={18} />
          <span className="flex-1 text-left">搜索笔记、待办</span>
        </button>
      </div>

      {/* 数字条：原 4 张数据卡收成一行，开关逻辑照旧 */}
      {statCells.length > 0 && (
        <div className="m-gutter mt-3">
          <MGroup>
            <div className="grid" style={{ gridTemplateColumns: `repeat(${statCells.length}, minmax(0, 1fr))` }}>
              {statCells.map((c, i) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => navigate(c.to)}
                  className="flex flex-col items-center gap-0.5 py-3 active:bg-[var(--m-accent-soft)]"
                  style={i > 0 ? { borderLeft: "0.5px solid var(--m-hair)" } : undefined}
                >
                  <span className="m-num text-[20px] font-bold leading-tight" style={{ color: "var(--m-ink)" }}>
                    {typeof c.value === "number" ? c.value.toLocaleString() : c.value}
                    {c.delta != null && (
                      <sup className="ml-0.5 text-[12px] font-semibold" style={{ color: "var(--m-ok)" }} aria-label={`今日更新 ${c.delta} 篇`}>
                        +{c.delta}
                      </sup>
                    )}
                  </span>
                  <span className="m-t-cap max-w-full truncate px-1">{c.label}</span>
                </button>
              ))}
            </div>
          </MGroup>
        </div>
      )}

      {/* 金刚区：彩色实心图标直接放在页面上，不垫底色、不包卡片 */}
      {show("quick_actions") && (
        <div className="m-gutter mt-5 grid grid-cols-4">
          <button type="button" className="m-kk" onClick={createBlankNote}>
            <KingKongIcon kind="note" />
            新建笔记
          </button>
          <button type="button" className="m-kk" onClick={() => navigate("/tasks?new=1")}>
            <KingKongIcon kind="todo" />
            添加待办
          </button>
          <button type="button" className="m-kk" onClick={() => navigate("/daily")}>
            <KingKongIcon kind="daily" day={now.getDate()} />
            今日日记
          </button>
          <button type="button" className="m-kk" onClick={() => navigate("/ai")}>
            <KingKongIcon kind="ai" />
            问 AI
          </button>
        </div>
      )}

      <QuickNoteBar onSaved={load} />

      {/* 今天：今天到期 + 逾期的未完成待办，可直接勾完成 */}
      {show("today_tasks_list") && (
        <div className="m-gutter mt-7">
          <MSectionHeader
            title="今天"
            count={loaded ? `${todayTasks.length} 项待办` : undefined}
            action={
              overdueCount > 0 ? (
                <button type="button" className="m-tapx" onClick={() => navigate("/tasks")}>
                  <MTag tone="bad">逾期 {overdueCount}</MTag>
                </button>
              ) : (
                <button type="button" className="m-tapx text-[13px] font-semibold" style={{ color: "var(--m-accent-ink)" }} onClick={() => navigate("/tasks")}>
                  全部待办
                </button>
              )
            }
          />
          <div className="mt-2.5">
            {todayTasks.length === 0 && data.doneToday.length === 0 ? (
              <MGroup className="py-7 text-center">
                <span className="m-t-meta">{loaded ? "今天没有到期的待办" : "加载中…"}</span>
              </MGroup>
            ) : (
              <MGroup>
                {todayTasks.slice(0, 5).map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    category={t.category_id != null ? data.categoryNames.get(t.category_id) : undefined}
                    onChanged={load}
                    onOpen={() => navigate(`/task-detail/${t.id}`)}
                  />
                ))}
                {todayTasks.length > 5 && (
                  <button type="button" className="m-row justify-center text-[14px] font-semibold" style={{ color: "var(--m-accent-ink)" }} onClick={() => navigate("/tasks")}>
                    还有 {todayTasks.length - 5} 项
                  </button>
                )}
                {data.doneToday.map((t) => (
                  <DoneTaskRow key={t.id} task={t} onChanged={load} onOpen={() => navigate(`/task-detail/${t.id}`)} />
                ))}
              </MGroup>
            )}
          </div>
        </div>
      )}

      {/* 继续编辑：横滑内容卡，和上下的列表拉开版式 */}
      {show("recent_notes") && (
        <div className="mt-7">
          <MSectionHeader
            className="m-gutter"
            title="继续编辑"
            action={
              <button type="button" className="m-tapx text-[13px] font-semibold" style={{ color: "var(--m-accent-ink)" }} onClick={() => navigate("/notes")}>
                全部笔记
              </button>
            }
          />
          {data.notes.length === 0 ? (
            <div className="m-gutter mt-2.5">
              <MGroup className="py-7 text-center">
                <span className="m-t-meta">{loaded ? "还没有笔记，点上面「新建笔记」开始" : "加载中…"}</span>
              </MGroup>
            </div>
          ) : (
            <div className="m-hscroll mt-2.5">
              <div className="m-gutter flex w-max gap-3 pb-3">
                {data.notes.map((n) => (
                  <NoteCard key={n.id} note={n} folderName={n.folder_id != null ? data.folderNames.get(n.folder_id) : undefined} onOpen={() => navigate(`/notes/${n.id}`)} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {show("heatmap") && <WritingCard trend={data.trend} />}
    </div>
  );
}

// ─── 快速记一笔：一行输入条，有内容才出现「记下」按钮；追加到今天的日记 ───
function QuickNoteBar({ onSaved }: { onSaved: () => void }) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [focused, setFocused] = useState(false);
  const expanded = focused || text.length > 0;

  async function save() {
    if (!text.trim() || saving) return;
    setSaving(true);
    try {
      await appendQuickNoteToDaily(text);
      message.success("已记到今天的日记");
      setText("");
      useAppStore.getState().bumpNotesRefresh();
      onSaved();
    } catch (e) {
      message.error(`保存失败: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="m-gutter mt-6">
      <div
        className="flex items-start gap-2 rounded-[var(--m-r-xl)] py-3 pl-4 pr-2"
        style={{ background: "var(--m-surface)" }}
      >
        <PencilLine size={18} className="mt-0.5 shrink-0" style={{ color: "var(--m-ink3)" }} />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          rows={expanded ? 3 : 1}
          placeholder="记一笔，追加到今天的日记"
          // 16px：iOS 输入框字号小于 16 会在聚焦时自动放大页面
          className="min-w-0 flex-1 resize-none bg-transparent text-[16px] leading-[1.5] outline-none placeholder:text-[var(--m-ink3)]"
          style={{ color: "var(--m-ink)" }}
        />
        {text.trim() && (
          <button
            type="button"
            aria-label="记下"
            disabled={saving}
            onMouseDown={(e) => e.preventDefault()}
            onClick={save}
            className="m-icon-btn is-primary -my-1.5 h-10 w-10"
          >
            <SendHorizontal size={18} />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── 待办行：勾选框直接完成；循环任务勾选 = 完成本次（与待办页一致） ───
function TaskRow({ task, category, onChanged, onOpen }: { task: Task; category?: string; onChanged: () => void; onOpen: () => void }) {
  const [busy, setBusy] = useState(false);
  const due = new Date(task.due_date!);
  const overdue = due.getTime() < new Date().setHours(0, 0, 0, 0);
  const dueText = overdue
    ? `${due.getMonth() + 1} 月 ${due.getDate()} 日`
    : due.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

  async function complete(e: React.MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      if (task.repeat_kind !== "none") {
        await taskApi.completeOccurrence(task.id);
        message.success("已完成本次，已推进到下一次");
      } else {
        await taskApi.toggleStatus(task.id);
      }
      useAppStore.getState().refreshTaskStats();
      onChanged();
    } catch (err) {
      message.error(`操作失败: ${err}`);
      setBusy(false);
    }
  }

  return (
    <div className="m-row m-row-icon cursor-pointer" style={{ minHeight: 56 }} onClick={onOpen} role="button" tabIndex={0}>
      <button
        type="button"
        aria-label="完成"
        onClick={complete}
        className="relative flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[var(--m-r-s)] after:absolute after:-inset-[11px] after:content-['']"
        style={{ boxShadow: "inset 0 0 0 1.6px var(--m-ink4)" }}
      >
        {busy && <Check size={14} style={{ color: "var(--m-ok)" }} />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px]">{task.title}</div>
        {/* 原型：「工作 · 14:00」—— 分类在前；逾期整行红字 */}
        <div className="m-t-cap mt-0.5 truncate" style={overdue ? { color: "var(--m-bad)" } : undefined}>
          {category ? `${category} · ` : ""}
          {overdue ? `逾期 · ${dueText}` : dueText}
        </div>
      </div>
      <span
        className="m-dot"
        style={{ background: task.priority === 0 ? "var(--m-bad)" : task.priority === 2 ? "var(--m-ink4)" : "var(--m-accent)" }}
        aria-label={task.priority === 0 ? "紧急" : task.priority === 2 ? "低" : "普通"}
      />
    </div>
  );
}

// ─── 今天已完成的待办：绿勾 + 删除线 +「09:30 完成」（原型）；点勾撤回为未完成 ───
function DoneTaskRow({ task, onChanged, onOpen }: { task: Task; onChanged: () => void; onOpen: () => void }) {
  const [busy, setBusy] = useState(false);
  const doneAt = task.completed_at?.slice(11, 16) ?? "";

  async function undo(e: React.MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await taskApi.toggleStatus(task.id);
      useAppStore.getState().refreshTaskStats();
      onChanged();
    } catch (err) {
      message.error(`操作失败: ${err}`);
      setBusy(false);
    }
  }

  return (
    <div className="m-row m-row-icon cursor-pointer" style={{ minHeight: 56 }} onClick={onOpen} role="button" tabIndex={0}>
      <button
        type="button"
        aria-label="撤回为未完成"
        onClick={undo}
        className="relative flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[var(--m-r-s)] after:absolute after:-inset-[11px] after:content-['']"
        style={{ background: "var(--m-ok)", color: "#fff" }}
      >
        <Check size={14} strokeWidth={3} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] line-through" style={{ color: "var(--m-ink3)" }}>
          {task.title}
        </div>
        <div className="m-t-cap mt-0.5">{doneAt ? `${doneAt} 完成` : "已完成"}</div>
      </div>
    </div>
  );
}

// ─── 右上角同步状态（原型：● 已同步）───
// 没配同步 / 加载中只显示入口，不报一个不真实的状态；失败优先于「已同步」
function SyncBadge({ backend }: { backend: SyncBackend | null }) {
  if (!backend) {
    return (
      <>
        <Cloud size={15} />
        同步
      </>
    );
  }
  const last = [backend.lastPullTs, backend.lastPushTs].filter(Boolean).sort().pop();
  const [dot, label] = backend.lastError ? ["var(--m-bad)", "同步失败"] : last ? ["var(--m-ok)", "已同步"] : ["var(--m-warn)", "未同步"];
  return (
    <>
      <span className="m-dot" style={{ width: 7, height: 7, background: dot }} />
      {label}
    </>
  );
}

// ─── 继续编辑卡片 ───
function NoteCard({ note, folderName, onOpen }: { note: Note; folderName?: string; onOpen: () => void }) {
  const preview = note.is_encrypted ? "已加密，解锁后查看" : notePreviewText(note.content, { title: note.title, max: 90, noteType: note.note_type });
  const where = note.is_daily ? "日记" : folderName ?? "未分类";
  return (
    <button type="button" onClick={onOpen} className="m-float flex w-[200px] flex-col p-4 text-left active:opacity-80">
      <div className="m-t-cap truncate">
        {where} · {relativeTime(note.updated_at)}
      </div>
      <div className="mt-1.5 flex items-center gap-1">
        {note.is_pinned && <Pin size={13} className="shrink-0" style={{ color: "var(--m-accent-ink)" }} aria-label="已置顶" />}
        <span className="m-t-title line-clamp-1">{note.title || "未命名笔记"}</span>
      </div>
      <div className="mt-1 line-clamp-3 min-h-[3lh] text-[13px] leading-[1.6]" style={{ color: "var(--m-ink2)" }}>
        {preview || "（空白）"}
      </div>
      <div className="m-t-cap m-num mt-3">{note.word_count.toLocaleString()} 字</div>
    </button>
  );
}

// ─── 本周写作：默认近 7 天柱状图，点开看 30 天热力图 ───
function WritingCard({ trend }: { trend: DailyWritingStat[] }) {
  const [expanded, setExpanded] = useState(false);
  const byDate = useMemo(() => new Map(trend.map((t) => [t.date, t.word_count])), [trend]);

  const days = useMemo(() => {
    const out: { key: string; words: number; label: string }[] = [];
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    for (let i = 29; i >= 0; i--) {
      const d = new Date(base);
      d.setDate(base.getDate() - i);
      const key = ymd(d);
      out.push({ key, words: byDate.get(key) ?? 0, label: i === 0 ? "今天" : WEEKDAYS[d.getDay()].slice(1) });
    }
    return out;
  }, [byDate]);

  const week = days.slice(-7);
  const prevWeek = days.slice(-14, -7);
  const weekTotal = week.reduce((s, d) => s + d.words, 0);
  const prevTotal = prevWeek.reduce((s, d) => s + d.words, 0);
  const change = prevTotal > 0 ? Math.round(((weekTotal - prevTotal) / prevTotal) * 100) : null;
  // 连续写作天数：从今天往前数（今天还没写就从昨天起算，免得一早打开就显示 0）
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].words > 0) streak++;
    else if (i === days.length - 1) continue;
    else break;
  }
  const max = Math.max(1, ...week.map((d) => d.words));

  return (
    <div className="m-gutter mt-4">
      <button type="button" className="m-group block w-full p-4 text-left" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
        <div className="flex items-baseline">
          <span className="m-t-sec">本周写作</span>
          {change !== null && (
            <span className="m-num ml-auto text-[13px] font-semibold" style={{ color: change >= 0 ? "var(--m-ok)" : "var(--m-bad)" }}>
              {change >= 0 ? "↑" : "↓"} {Math.abs(change)}%
            </span>
          )}
          <span className={change !== null ? "ml-2" : "ml-auto"} style={{ color: "var(--m-ink3)" }}>
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </span>
        </div>
        <div className="mt-1 flex items-end gap-1.5">
          <span className="m-num text-[26px] font-bold leading-none" style={{ color: "var(--m-ink)" }}>
            {weekTotal.toLocaleString()}
          </span>
          <span className="m-t-meta mb-0.5">字{streak > 0 ? ` · 连续 ${streak} 天` : ""}</span>
        </div>

        {expanded ? (
          <>
            <div className="m-t-cap m-num mt-3">近 30 天共 {days.reduce((s, d) => s + d.words, 0).toLocaleString()} 字</div>
            <Heatmap days={days} />
          </>
        ) : (
          <>
            <div className="mt-4 flex h-14 items-end gap-2">
              {week.map((d, i) => (
                <span
                  key={d.key}
                  className="flex-1 rounded-[var(--m-r-s)]"
                  title={`${d.key} · ${d.words} 字`}
                  style={{
                    height: `${Math.max(6, (d.words / max) * 100)}%`,
                    background: i === week.length - 1 ? "var(--m-accent)" : "var(--m-accent-soft2)",
                  }}
                />
              ))}
            </div>
            <div className="mt-1.5 grid grid-cols-7 gap-2 text-center">
              {week.map((d, i) => (
                <span key={d.key} className="m-t-cap" style={i === week.length - 1 ? { color: "var(--m-ink)", fontWeight: 700 } : undefined}>
                  {d.label}
                </span>
              ))}
            </div>
          </>
        )}
      </button>
    </div>
  );
}

/** 30 天热力图：周日开头补空对齐；5 档用主题主色的不同深浅（跟随主题） */
function Heatmap({ days }: { days: { key: string; words: number }[] }) {
  const lead = new Date(days[0].key).getDay();
  const level = (w: number) => (w >= 800 ? 4 : w >= 300 ? 3 : w >= 100 ? 2 : w > 0 ? 1 : 0);
  const shade = ["var(--m-well)", "var(--m-accent-soft2)", "color-mix(in srgb, var(--m-accent) 40%, transparent)", "color-mix(in srgb, var(--m-accent) 70%, transparent)", "var(--m-accent)"];
  const todayKey = days[days.length - 1].key;
  return (
    <div className="mt-4 max-w-[360px]">
      <div className="mb-1.5 grid grid-cols-7 gap-1 text-center">
        {["日", "一", "二", "三", "四", "五", "六"].map((w) => (
          <span key={w} className="m-t-cap">{w}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: lead }).map((_, i) => (
          <span key={`pad-${i}`} className="aspect-square" />
        ))}
        {days.map((d) => (
          <span
            key={d.key}
            className="aspect-square rounded-[var(--m-r-xs)]"
            title={`${d.key} · ${d.words} 字`}
            style={{
              background: shade[level(d.words)],
              boxShadow: d.key === todayKey ? "inset 0 0 0 2px var(--m-accent-ink)" : undefined,
            }}
          />
        ))}
      </div>
      <div className="m-t-cap mt-2.5 flex items-center justify-end gap-1.5">
        少
        {shade.map((c, i) => (
          <span key={i} className="h-2.5 w-2.5 rounded-[3px]" style={{ background: c }} />
        ))}
        多
      </div>
    </div>
  );
}
