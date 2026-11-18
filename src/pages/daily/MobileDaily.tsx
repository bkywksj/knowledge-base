import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, TouchEvent as ReactTouchEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUp, Check, ChevronDown, ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import { message } from "antd";
import { dailyApi, trashApi } from "@/lib/api";
import { parseDailyTimeline } from "@/lib/dailyTimeline";
import { appendQuickNoteToDaily } from "@/lib/mobileQuickNote";
import { useAppStore } from "@/store";
import type { DailyEntry, Note, Task } from "@/types";
import { MGroup, MSectionHeader } from "@/components/mobile/primitives";
import { useFeatureEnabled } from "@/hooks/useFeatureEnabled";
import { useDailyTasks } from "@/hooks/useDailyTasks";
import { useLongPress } from "@/hooks/useLongPress";
import { SwipeRow } from "@/components/mobile/SwipeRow";
import { ActionSheet } from "@/components/mobile/ActionSheet";

/**
 * 移动端日记页（v4 原型 09 屏，对应 PC 日记页）
 *
 * 路由 /daily —— isMobile=true 时通过 wrapper 加载本组件；可被设为底部 Tab（设成 Tab 时不显示返回键）。
 *
 * - 顶部「YYYY 年 M 月」+「今天」；点月份（或日期条下的抓手、下拉）展开整月，展开后可切月
 * - 周条：周一开头（同 PC 日期选择器），左右滑换周；有日记的日子带点
 * - 当天卡片：带时间戳的段落排成时间线（parseDailyTimeline 认三种写法），其余文字作预览；点卡片 / 铅笔进编辑器
 * - 选中今天：卡片底部直接「记一笔」追加（与首页同一写法）；选别的日子：按钮「打开 / 开始写 M 月 D 日的日记」
 * - 卡片下方「当天待办」：截止在这天 / 这天完成的待办，可勾选、可直接加一条截止在这天的
 * - 下方「本月 N 篇」列表，点一行切到那一天；左滑 / 长按可打开编辑或删除（与笔记列表同一套手势）
 *
 * 日记日期集合用 listAll 一次拿全（轻量元数据），换周 / 换月不再逐月请求。
 */

type DateStr = string; // "2026-05-04"

function formatDate(d: Date): DateStr {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseDate(s: DateStr): Date {
  return new Date(`${s}T00:00:00`);
}

function addDays(s: DateStr, n: number): DateStr {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return formatDate(d);
}

/** 周一开头的表头 */
const WEEK_HEAD = ["一", "二", "三", "四", "五", "六", "日"];
const weekdayCN = (s: DateStr) => "周" + "日一二三四五六"[parseDate(s).getDay()];

/** 所在周的周一 */
function mondayOf(s: DateStr): DateStr {
  const offset = (parseDate(s).getDay() + 6) % 7;
  return addDays(s, -offset);
}

/** 整月 6×7 格（周一开头，含上下月补位） */
function monthCells(year: number, month: number): { date: DateStr; inMonth: boolean }[] {
  const first = formatDate(new Date(year, month - 1, 1));
  const start = mondayOf(first);
  return Array.from({ length: 42 }, (_, i) => {
    const date = addDays(start, i);
    return { date, inMonth: parseDate(date).getMonth() === month - 1 };
  });
}

/** 文本里的 [[双链]] 用主色字标出（只展示，不跳转） */
function withWikiLinks(text: string): ReactNode {
  const parts = text.split(/(\[\[[^\]]+\]\])/g);
  return parts.map((p, i) =>
    /^\[\[[^\]]+\]\]$/.test(p) ? (
      <span key={i} style={{ color: "var(--m-accent-ink)", fontWeight: 600 }}>
        {p}
      </span>
    ) : (
      <Fragment key={i}>{p}</Fragment>
    ),
  );
}

export function MobileDaily() {
  const navigate = useNavigate();
  const todayStr = formatDate(new Date());
  const isTab = useAppStore((s) => s.mobileTabKeys).includes("daily");

  const [selected, setSelected] = useState<DateStr>(todayStr);
  const [expanded, setExpanded] = useState(false);
  /** 展开整月时看的是哪个月（与选中日期解耦：翻月不改选中） */
  const [view, setView] = useState(() => ({ year: new Date().getFullYear(), month: new Date().getMonth() + 1 }));
  const [dailies, setDailies] = useState<DailyEntry[]>([]);
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [loadingNote, setLoadingNote] = useState(false);
  const [quick, setQuick] = useState("");
  const [sending, setSending] = useState(false);
  /** 本月列表长按出菜单的那一篇 */
  const [sheetEntry, setSheetEntry] = useState<DailyEntry | null>(null);

  const loadAll = useCallback(async () => {
    try {
      setDailies(await dailyApi.listAll());
    } catch (e) {
      console.error("[MobileDaily] listAll failed:", e);
    }
  }, []);

  const loadDay = useCallback(async (date: DateStr) => {
    setLoadingNote(true);
    try {
      setSelectedNote(await dailyApi.get(date));
    } catch (e) {
      console.error("[MobileDaily] get failed:", e);
      setSelectedNote(null);
    } finally {
      setLoadingNote(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    void loadDay(selected);
  }, [selected, loadDay]);

  const datesWithNote = useMemo(() => new Set(dailies.map((d) => d.daily_date)), [dailies]);

  const sel = parseDate(selected);
  const headYear = expanded ? view.year : sel.getFullYear();
  const headMonth = expanded ? view.month : sel.getMonth() + 1;
  const monthPrefix = `${headYear}-${String(headMonth).padStart(2, "0")}`;
  const monthList = useMemo(
    () => dailies.filter((d) => d.daily_date.startsWith(monthPrefix)).sort((a, b) => b.daily_date.localeCompare(a.daily_date)),
    [dailies, monthPrefix],
  );

  function toggleExpanded(next = !expanded) {
    if (next) setView({ year: sel.getFullYear(), month: sel.getMonth() + 1 });
    setExpanded(next);
  }

  function shiftMonth(delta: number) {
    setView(({ year, month }) => {
      const d = new Date(year, month - 1 + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() + 1 };
    });
  }

  function goToday() {
    setSelected(todayStr);
    setView({ year: new Date().getFullYear(), month: new Date().getMonth() + 1 });
  }

  // 日历区手势：左右滑 = 换周（展开时换月）；下拉展开、上推收起。
  // 🔴 用 touch 事件不用 pointer 事件：日历区 touchAction 是 pan-y，竖向滑动由浏览器当页面滚动处理，
  // 一开始滚动就发 pointercancel、收不到 pointerup —— 以前「下拉展开」从来没生效过，用户以为抓手拉不动（用户反馈）。
  // touch 事件在页面滚动时照样有 touchend。页面真的滚了（日历位置变了）就不算展开 / 收起手势
  const calRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; top: number } | null>(null);
  function onCalStart(e: ReactTouchEvent) {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    drag.current = { x: t.clientX, y: t.clientY, top: calRef.current?.getBoundingClientRect().top ?? 0 };
  }
  function onCalEnd(e: ReactTouchEvent) {
    const s = drag.current;
    drag.current = null;
    const t = e.changedTouches[0];
    if (!s || !t) return;
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      const dir = dx < 0 ? 1 : -1;
      if (expanded) shiftMonth(dir);
      else setSelected((d) => addDays(d, dir * 7));
    } else if (Math.abs(dy) > 40 && Math.abs(dy) > Math.abs(dx) * 1.2) {
      if (dy > 0) {
        // 下拉：页面不在顶部时这一下是在把页面往回滚，不算展开
        const scrolled = Math.abs((calRef.current?.getBoundingClientRect().top ?? 0) - s.top) > 4;
        if (!scrolled) toggleExpanded(true);
      } else {
        // 上推：整月展开后页面变长，上推必然带着页面滚动，不能拿位置变化来排除（真机实测收不起来）
        toggleExpanded(false);
      }
    }
  }

  function openEntry(d: DailyEntry) {
    navigate(`/notes/${d.id}`);
  }

  async function deleteEntry(d: DailyEntry) {
    try {
      await trashApi.softDelete(d.id);
      message.success("已移到回收站");
      await loadAll();
      if (d.daily_date === selected) await loadDay(selected);
    } catch (e) {
      message.error(`删除失败: ${e}`);
    }
  }

  async function openSelectedDay() {
    try {
      const note = await dailyApi.getOrCreate(selected);
      navigate(`/notes/${note.id}`);
    } catch (e) {
      message.error(`打开失败: ${e}`);
    }
  }

  async function sendQuick() {
    const t = quick.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      await appendQuickNoteToDaily(t);
      message.success("已记到今天的日记");
      setQuick("");
      await Promise.all([loadDay(selected), loadAll()]);
    } catch (e) {
      message.error(`保存失败: ${e}`);
    } finally {
      setSending(false);
    }
  }

  const isToday = selected === todayStr;
  const isCurrentMonth = headYear === new Date().getFullYear() && headMonth === new Date().getMonth() + 1;
  const dayLabel = `${sel.getMonth() + 1} 月 ${sel.getDate()} 日`;
  const timeline = useMemo(() => parseDailyTimeline(selectedNote?.content), [selectedNote]);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(mondayOf(selected), i));
  const cells = expanded ? monthCells(view.year, view.month) : weekDays.map((date) => ({ date, inMonth: true }));

  return (
    <div className="mx-auto w-full max-w-[860px] pb-28">
      {/* 原型 09：紧凑顶栏（返回 + 18px 月份 + 「今天」），不用大标题 */}
      <div className={`flex h-12 items-center pr-3 ${isTab ? "pl-4" : "pl-1"}`}>
        {!isTab && (
          <button type="button" aria-label="返回" className="m-icon-btn" onClick={() => navigate(-1)}>
            <ChevronLeft size={24} />
          </button>
        )}
        <button type="button" className="m-tapx flex items-center gap-1 text-[18px] font-bold" style={{ color: "var(--m-ink)" }} onClick={() => toggleExpanded()} aria-expanded={expanded} aria-label={expanded ? "收起整月" : "展开整月"}>
          {headYear} 年 {headMonth} 月
          <ChevronDown size={16} style={{ color: "var(--m-ink3)", transform: expanded ? "rotate(180deg)" : undefined, transition: "transform .2s" }} />
        </button>
        <div className="flex-1" />
        {expanded && (
          <>
            <button type="button" aria-label="上个月" className="m-icon-btn" onClick={() => shiftMonth(-1)}>
              <ChevronLeft size={20} />
            </button>
            <button type="button" aria-label="下个月" className="m-icon-btn" onClick={() => shiftMonth(1)}>
              <ChevronRight size={20} />
            </button>
          </>
        )}
        <button type="button" className="m-tag m-tapx" style={{ height: 30, padding: "0 12px", fontSize: 13, background: "var(--m-accent-soft2)", color: "var(--m-accent-ink)" }} onClick={goToday}>
          今天
        </button>
      </div>

      {/* 日历：周条 / 整月（原型不套卡片，直接铺在页面上） */}
      <div ref={calRef} className="m-gutter mt-1 select-none" style={{ touchAction: "pan-y" }} onTouchStart={onCalStart} onTouchEnd={onCalEnd} onTouchCancel={() => (drag.current = null)}>
        <div>
          <div className="grid grid-cols-7 pb-1.5 text-center">
            {WEEK_HEAD.map((w) => (
              <div key={w} className="m-t-cap">
                {w}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((c) => (
              <DayCell
                key={c.date}
                date={c.date}
                dim={!c.inMonth}
                selected={c.date === selected}
                today={c.date === todayStr}
                has={datesWithNote.has(c.date)}
                onClick={() => setSelected(c.date)}
              />
            ))}
          </div>
          <button type="button" className="m-tapx flex h-3.5 w-full items-end justify-center" aria-label={expanded ? "收起整月" : "展开整月"} onClick={() => toggleExpanded()}>
            <span className="h-1 w-9 rounded-full" style={{ background: "var(--m-ink4)", opacity: 0.5 }} />
          </button>
        </div>
      </div>

      {/* 当天卡片（原型：浮起卡 p-5） */}
      <div className="m-gutter mt-3">
        <div className="m-float p-5">
          <div className="flex items-center gap-2">
            <span className="m-t-sec">
              {dayLabel} · {weekdayCN(selected)}
            </span>
            <div className="flex-1" />
            {selectedNote && <span className="m-t-cap m-num">{selectedNote.word_count} 字</span>}
            <button type="button" aria-label={`编辑 ${dayLabel} 的日记`} className="m-icon-btn -my-2 -mr-3" onClick={() => void openSelectedDay()}>
              <Pencil size={16} />
            </button>
          </div>

          {loadingNote ? (
            <div className="m-t-meta py-6 text-center">加载中…</div>
          ) : !selectedNote ? (
            <div className="py-6 text-center">
              <div className="m-t-body" style={{ color: "var(--m-ink2)" }}>这一天还没有日记</div>
              <div className="m-t-cap mt-1">{isToday ? "在下面记一笔，会自动建好今天的日记" : "点下方按钮开始写"}</div>
            </div>
          ) : (
            <button type="button" className="mt-1 block w-full text-left" onClick={() => void openSelectedDay()}>
              {timeline.rest.length === 0 && timeline.entries.length === 0 && (
                <div className="m-t-body py-3 italic" style={{ color: "var(--m-ink3)" }}>空白</div>
              )}
              {timeline.rest.length > 0 && (
                <div className="m-t-body line-clamp-6 whitespace-pre-wrap" style={{ color: "var(--m-ink2)" }}>
                  {withWikiLinks(timeline.rest.join("\n"))}
                </div>
              )}
              {timeline.entries.length > 0 && (
                <div className="mt-3 text-[15px] leading-[1.75]" style={{ color: "var(--m-ink)" }}>
                  {timeline.entries.map((e, i) => (
                    <div key={i} className={`flex gap-3 ${i > 0 ? "mt-3" : ""}`}>
                      <span className="m-t-cap m-num w-10 shrink-0 pt-0.5">{e.time}</span>
                      <span className="min-w-0 flex-1 whitespace-pre-wrap">{withWikiLinks(e.text)}</span>
                    </div>
                  ))}
                </div>
              )}
            </button>
          )}

          {isToday ? (
            // 原型：一个凹陷框「＋ 记一笔，自动加时间」；有字时右侧出现发送键
            <div className="mt-4 flex h-11 items-center gap-2 rounded-[var(--m-r-l)] pl-3.5" style={{ background: "var(--m-well)" }}>
              <Plus size={16} className="shrink-0" style={{ color: "var(--m-ink3)" }} />
              <input
                value={quick}
                onChange={(e) => setQuick(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) void sendQuick();
                }}
                placeholder="记一笔，自动加时间"
                aria-label="记一笔"
                className="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-[var(--m-ink3)]"
                style={{ color: "var(--m-ink)" }}
              />
              {quick.trim() && (
                <button type="button" aria-label="记下" className="flex h-11 w-11 shrink-0 items-center justify-center" disabled={sending} onClick={() => void sendQuick()}>
                  <span className="flex h-7 w-7 items-center justify-center rounded-full" style={{ background: "var(--m-grad)", color: "var(--m-on-accent)" }}>
                    <ArrowUp size={16} />
                  </span>
                </button>
              )}
            </div>
          ) : (
            <button type="button" className="m-btn mt-4 w-full" onClick={() => void openSelectedDay()}>
              {selectedNote ? "打开" : "开始写"} {dayLabel}的日记
            </button>
          )}
        </div>
      </div>

      <DayTasks date={selected} isToday={isToday} />

      {/* 本月列表 */}
      <div className="m-gutter mt-6">
        <MSectionHeader className="mb-2" title={isCurrentMonth ? "本月" : `${headMonth} 月`} count={`${monthList.length} 篇`} />
        <MGroup>
          {monthList.length === 0 ? (
            <div className="m-t-meta py-6 text-center">这个月还没有日记</div>
          ) : (
            monthList.map((d, i) => (
              <div key={d.id} className="relative">
                {/* 分隔线画在左滑容器外，滑动时不跟着动（同笔记列表） */}
                {i > 0 && <span className="pointer-events-none absolute top-0 right-0 left-[60px] z-[1] h-[0.5px]" style={{ background: "var(--m-hair)" }} />}
                <SwipeRow
                  actions={[
                    { key: "open", label: "编辑", icon: <Pencil size={18} />, tone: "info", onClick: () => openEntry(d) },
                    { key: "del", label: "删除", icon: <Trash2 size={18} />, tone: "bad", onClick: () => void deleteEntry(d) },
                  ]}
                >
                  <DailyRow entry={d} on={d.daily_date === selected} onPick={() => setSelected(d.daily_date)} onMenu={() => setSheetEntry(d)} />
                </SwipeRow>
              </div>
            ))
          )}
        </MGroup>
      </div>

      <ActionSheet
        open={sheetEntry != null}
        title={sheetEntry?.title || sheetEntry?.daily_date}
        subtitle={sheetEntry ? `${sheetEntry.word_count} 字` : undefined}
        items={
          sheetEntry
            ? [
                { key: "open", label: "打开编辑", icon: <Pencil size={20} />, onClick: () => openEntry(sheetEntry) },
                { key: "del", label: "删除（移到回收站）", icon: <Trash2 size={20} />, danger: true, onClick: () => void deleteEntry(sheetEntry) },
              ]
            : []
        }
        onClose={() => setSheetEntry(null)}
      />
    </div>
  );
}

/** 本月列表一行：轻点切到那一天，长按出菜单（外层 SwipeRow 负责左滑） */
function DailyRow({ entry, on, onPick, onMenu }: { entry: DailyEntry; on: boolean; onPick: () => void; onMenu: () => void }) {
  const lp = useLongPress(onMenu, { onClick: onPick });
  return (
    <div
      {...lp}
      role="button"
      tabIndex={0}
      className="m-row cursor-pointer select-none"
      style={{ WebkitTouchCallout: "none" }}
      aria-current={on ? "date" : undefined}
      aria-label={`${entry.daily_date} ${weekdayCN(entry.daily_date)}`}
    >
      <span className="m-num w-8 shrink-0 text-[18px] font-bold" style={{ color: "var(--m-accent-ink)" }}>
        {parseDate(entry.daily_date).getDate()}
      </span>
      <span className="min-w-0 flex-1 truncate text-[15px]" style={on ? { color: "var(--m-accent-ink)", fontWeight: 700 } : { color: "var(--m-ink)" }}>
        {entry.title || entry.daily_date}
      </span>
      <span className="m-t-cap m-num shrink-0">{entry.word_count} 字</span>
    </div>
  );
}

/**
 * 「当天待办」：截止在这天 / 这天完成的待办（数据口径同 PC 日记右栏，见 useDailyTasks）。
 * 勾选框直接完成 / 撤回；底部输入框回车新建一条截止在这天的；今天的逾期收成一行跳待办页。
 * 待办模块被关掉时整块不渲染。
 */
function DayTasks({ date, isToday }: { date: DateStr; isToday: boolean }) {
  const navigate = useNavigate();
  const enabled = useFeatureEnabled("tasks");
  const { tasks, overdue, toggle, add } = useDailyTasks(date, isToday, enabled);
  const [draft, setDraft] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  if (!enabled) return null;

  async function onToggle(t: Task) {
    if (busyId != null) return;
    setBusyId(t.id);
    try {
      await toggle(t);
    } catch (e) {
      message.error(`操作失败: ${e}`);
    } finally {
      setBusyId(null);
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
    <div className="m-gutter mt-6">
      <MSectionHeader className="mb-2" title={isToday ? "今日待办" : "当天待办"} count={tasks.length ? `${openCount} 未完成` : undefined} />
      <MGroup>
        {tasks.map((t) => {
          const done = t.status === 1;
          const doneAt = done ? (t.completed_at?.slice(11, 16) ?? "") : "";
          return (
            <div key={t.id} className="m-row m-row-icon cursor-pointer" style={{ minHeight: 52 }} onClick={() => navigate(`/task-detail/${t.id}`)} role="button" tabIndex={0}>
              <button
                type="button"
                aria-label={done ? "撤回为未完成" : "完成"}
                disabled={busyId === t.id}
                onClick={(e) => {
                  e.stopPropagation();
                  void onToggle(t);
                }}
                className="relative flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[var(--m-r-s)] after:absolute after:-inset-[11px] after:content-['']"
                style={done ? { background: "var(--m-ok)", color: "#fff" } : { boxShadow: "inset 0 0 0 1.6px var(--m-ink4)" }}
              >
                {done && <Check size={14} strokeWidth={3} />}
              </button>
              <div className="min-w-0 flex-1">
                <div className={`truncate text-[15px] ${done ? "line-through" : ""}`} style={{ color: done ? "var(--m-ink3)" : "var(--m-ink)" }}>
                  {t.title}
                </div>
                {doneAt && <div className="m-t-cap mt-0.5">{doneAt} 完成</div>}
              </div>
            </div>
          );
        })}
        <div className="m-row m-row-icon" style={{ minHeight: 52 }}>
          <Plus size={18} className="shrink-0" style={{ color: "var(--m-ink3)" }} />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) void onAdd();
            }}
            disabled={adding}
            enterKeyHint="done"
            placeholder={isToday ? "添加今天的待办" : "添加这天的待办"}
            aria-label="添加待办"
            className="h-11 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-[var(--m-ink3)]"
            style={{ color: "var(--m-ink)" }}
          />
          {draft.trim() && (
            <button type="button" className="m-tapx shrink-0 text-[15px] font-semibold" style={{ color: "var(--m-accent-ink)" }} disabled={adding} onClick={() => void onAdd()}>
              添加
            </button>
          )}
        </div>
      </MGroup>
      {overdue.length > 0 && (
        <button type="button" className="m-tapx mt-2 text-[13px]" style={{ color: "var(--m-bad)" }} onClick={() => navigate("/tasks?filter=overdue")}>
          另有 {overdue.length} 条逾期 →
        </button>
      )}
    </div>
  );
}

function DayCell({ date, dim, selected, today, has, onClick }: { date: DateStr; dim: boolean; selected: boolean; today: boolean; has: boolean; onClick: () => void }) {
  const day = parseDate(date).getDate();
  // 原型 09：整格圆角 10；选中 = 深渐变白字；有日记 = 深色半粗；没日记 = 灰字；外月再淡一档
  const style = selected
    ? { background: "var(--m-grad)", color: "var(--m-on-accent)", fontWeight: 700 }
    : today
      ? { color: "var(--m-accent-ink)", fontWeight: 700, boxShadow: "inset 0 0 0 1.5px var(--m-accent-ink)" }
      : has
        ? { color: dim ? "var(--m-ink3)" : "var(--m-ink)", fontWeight: 600 }
        : { color: dim ? "var(--m-ink4)" : "var(--m-ink3)" };
  return (
    <button type="button" className="m-num flex h-12 flex-col items-center justify-center rounded-[10px] text-[16px]" style={style} onClick={onClick} aria-label={`${date}${has ? "，有日记" : ""}`} aria-pressed={selected}>
      {day}
      <span className="mt-1 h-1 w-1 rounded-full" style={{ background: has ? (selected ? "var(--m-on-accent)" : "var(--m-accent)") : "transparent" }} />
    </button>
  );
}
