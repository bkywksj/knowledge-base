import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUp, ChevronDown, ChevronLeft, ChevronRight, Pencil } from "lucide-react";
import { message } from "antd";
import { dailyApi } from "@/lib/api";
import { parseDailyTimeline } from "@/lib/dailyTimeline";
import { appendQuickNoteToDaily } from "@/lib/mobileQuickNote";
import { useAppStore } from "@/store";
import type { DailyEntry, Note } from "@/types";
import { MGroup, MNavBar, MPageHeader, MSectionHeader, MTag } from "@/components/mobile/primitives";

/**
 * 移动端日记页（v4 原型 09 屏，对应 PC 日记页）
 *
 * 路由 /daily —— isMobile=true 时通过 wrapper 加载本组件；可被设为底部 Tab（设成 Tab 时不显示返回键）。
 *
 * - 顶部「YYYY 年 M 月」+「今天」；点月份（或日期条下的抓手、下拉）展开整月，展开后可切月
 * - 周条：周一开头（同 PC 日期选择器），左右滑换周；有日记的日子带点
 * - 当天卡片：带时间戳的段落排成时间线（parseDailyTimeline 认三种写法），其余文字作预览；点卡片 / 铅笔进编辑器
 * - 选中今天：卡片底部直接「记一笔」追加（与首页同一写法）；选别的日子：按钮「打开 / 开始写 M 月 D 日的日记」
 * - 下方「本月 N 篇」列表，点一行切到那一天
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

  // 日历区手势：左右滑 = 换周（展开时换月）；下拉展开、上推收起
  const drag = useRef<{ x: number; y: number } | null>(null);
  function onCalDown(e: ReactPointerEvent) {
    drag.current = { x: e.clientX, y: e.clientY };
  }
  function onCalUp(e: ReactPointerEvent) {
    const s = drag.current;
    drag.current = null;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      const dir = dx < 0 ? 1 : -1;
      if (expanded) shiftMonth(dir);
      else setSelected((d) => addDays(d, dir * 7));
    } else if (Math.abs(dy) > 40 && Math.abs(dy) > Math.abs(dx) * 1.2) {
      toggleExpanded(dy > 0);
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
  const dayLabel = `${sel.getMonth() + 1} 月 ${sel.getDate()} 日`;
  const timeline = useMemo(() => parseDailyTimeline(selectedNote?.content), [selectedNote]);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(mondayOf(selected), i));
  const cells = expanded ? monthCells(view.year, view.month) : weekDays.map((date) => ({ date, inMonth: true }));

  return (
    <div className="mx-auto w-full max-w-[860px] pb-28">
      {!isTab && <MNavBar onBack={() => navigate(-1)} />}
      <MPageHeader
        title={
          <button type="button" className="m-tapx flex items-center gap-1" onClick={() => toggleExpanded()} aria-expanded={expanded} aria-label={expanded ? "收起整月" : "展开整月"}>
            {headYear} 年 {headMonth} 月
            <ChevronDown size={22} style={{ color: "var(--m-ink3)", transform: expanded ? "rotate(180deg)" : undefined, transition: "transform .2s" }} />
          </button>
        }
        actions={
          <>
            {expanded && (
              <>
                <button type="button" aria-label="上个月" className="m-icon-btn" onClick={() => shiftMonth(-1)}>
                  <ChevronLeft size={22} />
                </button>
                <button type="button" aria-label="下个月" className="m-icon-btn" onClick={() => shiftMonth(1)}>
                  <ChevronRight size={22} />
                </button>
              </>
            )}
            <button
              type="button"
              className="m-chip mr-2"
              style={isToday && (!expanded || (view.year === new Date().getFullYear() && view.month === new Date().getMonth() + 1)) ? { background: "var(--m-well)" } : { background: "var(--m-accent-soft2)", color: "var(--m-accent-ink)", fontWeight: 700 }}
              onClick={goToday}
            >
              今天
            </button>
          </>
        }
      />

      {/* 日历：周条 / 整月 */}
      <div className="m-gutter mt-3 select-none" style={{ touchAction: "pan-y" }} onPointerDown={onCalDown} onPointerUp={onCalUp} onPointerCancel={() => (drag.current = null)}>
        <MGroup className="px-2 pt-2">
          <div className="grid grid-cols-7 text-center">
            {WEEK_HEAD.map((w) => (
              <div key={w} className="m-t-cap py-1">
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
          <button type="button" className="m-tapx flex h-8 w-full items-center justify-center" aria-label={expanded ? "收起整月" : "展开整月"} onClick={() => toggleExpanded()}>
            <span className="h-1 w-9 rounded-full" style={{ background: "var(--m-ink4)", opacity: 0.5 }} />
          </button>
        </MGroup>
      </div>

      {/* 当天卡片 */}
      <div className="m-gutter mt-5">
        <MGroup className="px-4 pt-3 pb-4">
          <div className="flex items-center gap-2">
            <span className="m-t-title">
              {dayLabel} · {weekdayCN(selected)}
            </span>
            {isToday && <MTag tone="accent">今天</MTag>}
            <div className="flex-1" />
            {selectedNote && <span className="m-t-meta m-num">{selectedNote.word_count} 字</span>}
            <button type="button" aria-label={`编辑 ${dayLabel} 的日记`} className="m-icon-btn -mr-2" onClick={() => void openSelectedDay()}>
              <Pencil size={18} />
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
                <div className={timeline.rest.length > 0 ? "mt-3" : "mt-1"}>
                  {timeline.entries.map((e, i) => (
                    <div key={i} className="flex gap-3 py-1.5">
                      <span className="m-num w-11 shrink-0 pt-px text-[13px] font-semibold" style={{ color: "var(--m-accent-ink)" }}>
                        {e.time}
                      </span>
                      <span className="m-t-body min-w-0 flex-1 whitespace-pre-wrap">{withWikiLinks(e.text)}</span>
                    </div>
                  ))}
                </div>
              )}
            </button>
          )}

          {isToday ? (
            <div className="mt-3 flex items-center gap-2">
              <input
                value={quick}
                onChange={(e) => setQuick(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) void sendQuick();
                }}
                placeholder="记一笔，自动加时间"
                aria-label="记一笔"
                className="h-11 min-w-0 flex-1 rounded-[var(--m-r-l)] px-3 text-[16px] outline-none placeholder:text-[var(--m-ink3)]"
                style={{ background: "var(--m-well)", color: "var(--m-ink)" }}
              />
              <button type="button" aria-label="记下" className="m-icon-btn is-primary shrink-0" disabled={!quick.trim() || sending} style={!quick.trim() || sending ? { opacity: 0.45 } : undefined} onClick={() => void sendQuick()}>
                <ArrowUp size={20} />
              </button>
            </div>
          ) : (
            <button type="button" className="m-btn mt-3 w-full" onClick={() => void openSelectedDay()}>
              {selectedNote ? "打开" : "开始写"} {dayLabel}的日记
            </button>
          )}
        </MGroup>
      </div>

      {/* 本月列表 */}
      <div className="m-gutter mt-6">
        <MSectionHeader className="mb-2 px-1" title={`${headMonth} 月`} count={`${monthList.length} 篇`} />
        <MGroup>
          {monthList.length === 0 ? (
            <div className="m-t-meta py-6 text-center">这个月还没有日记</div>
          ) : (
            monthList.map((d, i) => {
              const on = d.daily_date === selected;
              return (
                <button key={d.id} type="button" className="relative flex min-h-[56px] w-full items-center gap-3 px-4 py-2.5 text-left" onClick={() => setSelected(d.daily_date)} aria-current={on ? "date" : undefined}>
                  {i > 0 && <span className="pointer-events-none absolute top-0 right-0 left-[64px] h-[0.5px]" style={{ background: "var(--m-hair)" }} />}
                  <span className="flex w-9 shrink-0 flex-col items-center">
                    <span className="m-num text-[20px] font-bold leading-tight" style={{ color: on ? "var(--m-accent-ink)" : "var(--m-ink)" }}>
                      {parseDate(d.daily_date).getDate()}
                    </span>
                    <span className="m-t-cap leading-tight">{weekdayCN(d.daily_date)}</span>
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[15px]" style={on ? { color: "var(--m-accent-ink)", fontWeight: 700 } : { color: "var(--m-ink)" }}>
                    {d.title || d.daily_date}
                  </span>
                  <span className="m-t-meta m-num shrink-0">{d.word_count} 字</span>
                </button>
              );
            })
          )}
        </MGroup>
      </div>
    </div>
  );
}

function DayCell({ date, dim, selected, today, has, onClick }: { date: DateStr; dim: boolean; selected: boolean; today: boolean; has: boolean; onClick: () => void }) {
  const day = parseDate(date).getDate();
  const style = selected
    ? { background: "var(--m-btn)", color: "var(--m-on-accent)", fontWeight: 700 }
    : today
      ? { color: "var(--m-accent-ink)", fontWeight: 700, boxShadow: "inset 0 0 0 1.5px var(--m-accent-ink)" }
      : { color: dim ? "var(--m-ink3)" : "var(--m-ink)" };
  return (
    <button type="button" className="flex h-12 flex-col items-center justify-center gap-0.5" onClick={onClick} aria-label={`${date}${has ? "，有日记" : ""}`} aria-pressed={selected}>
      <span className="m-num flex h-9 w-9 items-center justify-center rounded-full text-[15px]" style={style}>
        {day}
      </span>
      <span className="h-1 w-1 rounded-full" style={{ background: has ? (selected ? "var(--m-accent-ink)" : "var(--m-accent)") : "transparent" }} />
    </button>
  );
}
