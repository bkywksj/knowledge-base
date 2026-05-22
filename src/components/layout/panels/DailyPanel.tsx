import { useState, useEffect, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, Modal, Segmented, message, theme as antdTheme } from "antd";
import { Calendar, ChevronLeft, ChevronRight, Copy, Trash2 } from "lucide-react";
import { dailyApi, trashApi } from "@/lib/api";
import type { DailyEntry } from "@/types";
import { useAppStore } from "@/store";
import { useContextMenu } from "@/hooks/useContextMenu";
import {
  ContextMenuOverlay,
  type ContextMenuEntry,
} from "@/components/ui/ContextMenuOverlay";
import { DailyMonthCalendar } from "./DailyMonthCalendar";

/**
 * DailyPanel —— Activity Bar 模式下"每日笔记"视图的主面板。
 *
 * 职责：
 *   · 顶部：视图标题 + 快速跳回今天
 *   · 月份切换：← 年-月 →
 *   · 月历网格：紧凑 6×7 月视图，标记今天/选中/有日记/未来日；点击切换日期
 *   · 日期列表：本月所有有日记的日期（倒序），与月历互补——列表显示日期细节（星期/标签）
 *
 * URL 约定：
 *   · /daily           → 默认今天（由主区 pages/daily 处理重定向）
 *   · /daily?date=...  → 指定日期，selectedDate 从 URL 派生
 */

/** 今天的 ISO 日期串 yyyy-mm-dd */
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 解析 yyyy-mm-dd → {year, month, day} */
function parseDate(d: string): { year: number; month: number; day: number } {
  const [y, m, day] = d.split("-").map(Number);
  return { year: y, month: m, day };
}

/** 对 {year, month} 做偏移（跨年自动进位） */
function shiftMonth(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const total = year * 12 + (month - 1) + delta;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

/** 中文星期 */
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
function weekdayOf(d: string): string {
  return WEEKDAYS[new Date(d + "T00:00:00").getDay()];
}

/** localStorage：记住面板上次的视图模式（月历 / 全部） */
const VIEW_MODE_KEY = "kb.daily.panelViewMode";

/** YYYY-MM → "2026 年 5 月" */
function monthLabel(ym: string): string {
  const [y, m] = ym.split("-");
  return `${y} 年 ${Number(m)} 月`;
}

export function DailyPanel() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { token } = antdTheme.useToken();
  const notesRefreshTick = useAppStore((s) => s.notesRefreshTick);

  const selectedDate = searchParams.get("date") ?? todayStr();
  const today = todayStr();

  // 当前浏览的月份（默认跟随 selectedDate 的月份）
  const [viewMonth, setViewMonth] = useState(() => {
    const { year, month } = parseDate(selectedDate);
    return { year, month };
  });

  // 当切换选中日期到别的月时，自动同步 viewMonth
  useEffect(() => {
    const { year, month } = parseDate(selectedDate);
    setViewMonth((prev) =>
      prev.year === year && prev.month === month ? prev : { year, month },
    );
  }, [selectedDate]);

  const [dates, setDates] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const list = await dailyApi.listDates(viewMonth.year, viewMonth.month);
        if (!cancelled) setDates(list);
      } catch (e) {
        if (!cancelled) message.error(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // notesRefreshTick：主区新建日记后 bump，这里触发重拉
  }, [viewMonth.year, viewMonth.month, notesRefreshTick]);

  // ─── 视图模式：月历 / 全部 ─────────────────────
  const [viewMode, setViewMode] = useState<"calendar" | "all">(
    () =>
      (localStorage.getItem(VIEW_MODE_KEY) as "calendar" | "all" | null) ??
      "calendar",
  );
  useEffect(() => {
    localStorage.setItem(VIEW_MODE_KEY, viewMode);
  }, [viewMode]);

  // 「全部」视图数据：一次拉回所有日记元数据，前端按年月分组
  const [allEntries, setAllEntries] = useState<DailyEntry[]>([]);
  const [allLoading, setAllLoading] = useState(false);

  useEffect(() => {
    if (viewMode !== "all") return;
    let cancelled = false;
    (async () => {
      setAllLoading(true);
      try {
        const list = await dailyApi.listAll();
        if (!cancelled) setAllEntries(list);
      } catch (e) {
        if (!cancelled) message.error(String(e));
      } finally {
        if (!cancelled) setAllLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // notesRefreshTick：新建/删除日记后重拉
  }, [viewMode, notesRefreshTick]);

  // 按年月（YYYY-MM）分组；后端已按 daily_date DESC 排好，分组天然倒序
  const groupedAll = useMemo(() => {
    const map = new Map<string, DailyEntry[]>();
    for (const e of allEntries) {
      const ym = e.daily_date.slice(0, 7);
      const arr = map.get(ym);
      if (arr) arr.push(e);
      else map.set(ym, [e]);
    }
    return [...map.entries()];
  }, [allEntries]);

  // 倒序展示该月已有日记的日期
  const sortedDates = useMemo(() => [...dates].sort((a, b) => b.localeCompare(a)), [dates]);

  // 月历网格用，O(1) 查询某日是否已有日记
  const datesWithEntry = useMemo(() => new Set(dates), [dates]);

  function goToDate(date: string) {
    navigate(`/daily?date=${date}`);
  }

  function goToToday() {
    goToDate(today);
    const { year, month } = parseDate(today);
    setViewMonth({ year, month });
  }

  // ─── 右键菜单 ────────────────────────────────
  // payload 带 hasEntry：决定「删除日记」菜单项是否显示
  const ctx = useContextMenu<{ date: string; hasEntry: boolean }>();

  const menuItems: ContextMenuEntry[] = useMemo(() => {
    const p = ctx.state.payload;
    if (!p) return [];
    const list: ContextMenuEntry[] = [
      { key: "copy", label: "复制日期", icon: <Copy size={13} /> },
    ];
    if (p.hasEntry) {
      list.push({ type: "divider" });
      list.push({
        key: "delete",
        label: "删除日记",
        icon: <Trash2 size={13} />,
        danger: true,
      });
    }
    return list;
  }, [ctx.state.payload]);

  function onMenuClick(key: string, e: React.MouseEvent) {
    e.stopPropagation();
    const p = ctx.state.payload;
    if (!p) return;
    ctx.close();

    if (key === "copy") {
      navigator.clipboard
        .writeText(p.date)
        .then(() => message.success(`已复制日期：${p.date}`))
        .catch((err) => message.error(`复制失败：${err}`));
      return;
    }

    if (key === "delete") {
      Modal.confirm({
        title: `删除 ${p.date} 的日记？`,
        content: "会移到回收站，可以恢复。",
        okText: "删除",
        okButtonProps: { danger: true },
        async onOk() {
          try {
            const note = await dailyApi.get(p.date);
            if (!note) {
              message.warning("该日记已不存在");
              return;
            }
            await trashApi.softDelete(note.id);
            message.success("已移到回收站");
            // 触发 DailyPanel 自身的 useEffect 重拉本月日期 + pages/daily 列表刷新
            useAppStore.getState().bumpNotesRefresh();
            // 如果当前选中的就是被删的日期，跳到今天避免主区显示已删笔记
            if (selectedDate === p.date) {
              goToDate(today);
            }
          } catch (err) {
            message.error(`删除失败：${err}`);
          }
        },
      });
    }
  }

  const isViewingCurrentMonth = (() => {
    const { year, month } = parseDate(today);
    return viewMonth.year === year && viewMonth.month === month;
  })();

  return (
    <>
    <div
      className="flex flex-col h-full"
      style={{ overflow: "hidden" }}
      // 本面板纯导航 + 没有 input 元素 → 顶层兜底吞掉 WebView 默认菜单。
      // DateRow 子级 onContextMenu 会自己 preventDefault + ctx.open 弹自定义菜单
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 视图标题 */}
      <div
        className="flex items-center gap-2 px-3 py-2.5 shrink-0"
        style={{ borderBottom: `1px solid ${token.colorBorderSecondary}` }}
      >
        <Calendar size={15} style={{ color: token.colorPrimary }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: token.colorText }}>
          日记
        </span>
        <div style={{ flex: 1 }} />
        <Button
          type={selectedDate === today ? "primary" : "default"}
          size="small"
          onClick={goToToday}
          title="跳到今天"
        >
          今天
        </Button>
      </div>

      {/* 视图切换：月历 / 全部 */}
      <div
        className="shrink-0"
        style={{
          padding: "8px 12px",
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Segmented
          block
          size="small"
          value={viewMode}
          onChange={(v) => setViewMode(v as "calendar" | "all")}
          options={[
            { label: "月历", value: "calendar" },
            { label: "全部", value: "all" },
          ]}
        />
      </div>

      {viewMode === "calendar" && (
        <>
      {/* 月份切换 */}
      <div
        className="flex items-center justify-between shrink-0"
        style={{
          padding: "8px 12px",
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Button
          type="text"
          size="small"
          icon={<ChevronLeft size={14} />}
          onClick={() =>
            setViewMonth((m) => shiftMonth(m.year, m.month, -1))
          }
          style={{ width: 24, height: 24, padding: 0 }}
        />
        <span
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: token.colorText,
          }}
        >
          {viewMonth.year} 年 {viewMonth.month} 月
        </span>
        <Button
          type="text"
          size="small"
          icon={<ChevronRight size={14} />}
          onClick={() =>
            setViewMonth((m) => shiftMonth(m.year, m.month, 1))
          }
          style={{ width: 24, height: 24, padding: 0 }}
        />
      </div>

      {/* 月历网格：与下方列表互补——这里看月度全貌，下方列表看日期细节（星期/标签） */}
      <div
        style={{
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          paddingTop: 6,
        }}
      >
        <DailyMonthCalendar
          year={viewMonth.year}
          month={viewMonth.month}
          selectedDate={selectedDate}
          today={today}
          datesWithEntry={datesWithEntry}
          onSelectDate={goToDate}
          onContextMenuDate={(e, date, hasEntry) => {
            e.preventDefault();
            ctx.open(e.nativeEvent, { date, hasEntry });
          }}
        />
      </div>
        </>
      )}

      {/* 列表区：月历模式=本月日期列表；全部模式=按年月折叠 */}
      <div
        className="flex-1 overflow-auto"
        style={{ minHeight: 0, padding: "4px 8px 8px" }}
      >
        {viewMode === "calendar" ? (
          <>
        {/* "今天"常驻项（仅在当前浏览月不含今天时显示为独立条目） */}
        {isViewingCurrentMonth &&
          !sortedDates.includes(today) && (
            <DateRow
              date={today}
              selected={selectedDate === today}
              isToday
              hasEntry={false}
              contextActive={ctx.state.payload?.date === today}
              onClick={() => goToDate(today)}
              onContextMenu={(e) => {
                e.preventDefault();
                ctx.open(e.nativeEvent, { date: today, hasEntry: false });
              }}
              token={token}
            />
          )}

        {/* 本月已有日记的日期 */}
        {loading && sortedDates.length === 0 ? (
          <div
            className="text-center py-6"
            style={{ color: token.colorTextQuaternary, fontSize: 12 }}
          >
            加载中…
          </div>
        ) : sortedDates.length === 0 ? (
          <div
            className="text-center py-6"
            style={{ color: token.colorTextQuaternary, fontSize: 12 }}
          >
            本月暂无日记
            {!isViewingCurrentMonth && (
              <>
                <br />
                <span
                  className="cursor-pointer"
                  style={{ color: token.colorPrimary, fontSize: 11 }}
                  onClick={goToToday}
                >
                  回到今天
                </span>
              </>
            )}
          </div>
        ) : (
          sortedDates.map((d) => (
            <DateRow
              key={d}
              date={d}
              selected={selectedDate === d}
              isToday={d === today}
              hasEntry
              contextActive={ctx.state.payload?.date === d}
              onClick={() => goToDate(d)}
              onContextMenu={(e) => {
                e.preventDefault();
                ctx.open(e.nativeEvent, { date: d, hasEntry: true });
              }}
              token={token}
            />
          ))
        )}
          </>
        ) : (
          <>
            {allLoading && allEntries.length === 0 ? (
              <div
                className="text-center py-6"
                style={{ color: token.colorTextQuaternary, fontSize: 12 }}
              >
                加载中…
              </div>
            ) : allEntries.length === 0 ? (
              <div
                className="text-center py-6"
                style={{ color: token.colorTextQuaternary, fontSize: 12 }}
              >
                还没有任何日记
              </div>
            ) : (
              groupedAll.map(([ym, entries], gi) => (
                <MonthGroup
                  key={ym}
                  ym={ym}
                  count={entries.length}
                  defaultOpen={gi < 2}
                  token={token}
                >
                  {entries.map((e) => (
                    <DateRow
                      key={e.daily_date}
                      date={e.daily_date}
                      selected={selectedDate === e.daily_date}
                      isToday={e.daily_date === today}
                      hasEntry
                      contextActive={ctx.state.payload?.date === e.daily_date}
                      onClick={() => goToDate(e.daily_date)}
                      onContextMenu={(ev) => {
                        ev.preventDefault();
                        ctx.open(ev.nativeEvent, {
                          date: e.daily_date,
                          hasEntry: true,
                        });
                      }}
                      token={token}
                    />
                  ))}
                </MonthGroup>
              ))
            )}
          </>
        )}
      </div>
    </div>
    <ContextMenuOverlay
      open={!!ctx.state.payload}
      x={ctx.state.x}
      y={ctx.state.y}
      items={menuItems}
      onClick={onMenuClick}
      onClose={ctx.close}
    />
    </>
  );
}

/** 单行日期渲染 */
function DateRow({
  date,
  selected,
  isToday,
  hasEntry,
  contextActive,
  onClick,
  onContextMenu,
  token,
}: {
  date: string;
  selected: boolean;
  isToday: boolean;
  hasEntry: boolean;
  /** 右键菜单当前指向本行 → 加边框提示用户操作目标 */
  contextActive?: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  token: {
    colorPrimary: string;
    colorText: string;
    colorTextSecondary: string;
    colorTextTertiary: string;
    colorBorderSecondary: string;
  };
}) {
  const { day } = parseDate(date);
  return (
    <div
      onClick={onClick}
      onContextMenu={onContextMenu}
      className="cursor-pointer"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 10px",
        borderRadius: 6,
        background: selected ? `${token.colorPrimary}14` : "transparent",
        color: selected ? token.colorPrimary : token.colorText,
        fontWeight: selected ? 500 : undefined,
        // 右键菜单指向本行 → 1px 实色描边提示
        outline: contextActive ? `1px solid ${token.colorPrimary}` : "none",
        outlineOffset: -1,
        transition: "background .15s, outline .1s",
      }}
    >
      {/* 日期数字方块 */}
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
          fontWeight: 600,
          background: isToday
            ? token.colorPrimary
            : selected
              ? `${token.colorPrimary}22`
              : token.colorBorderSecondary,
          color: isToday
            ? "#fff"
            : selected
              ? token.colorPrimary
              : token.colorTextSecondary,
          flexShrink: 0,
        }}
      >
        {day}
      </div>
      {/* 星期 + 标签 */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13 }}>{weekdayOf(date)}</div>
        <div
          style={{
            fontSize: 11,
            color: selected ? token.colorPrimary : token.colorTextTertiary,
          }}
        >
          {isToday ? "今天" : date}
        </div>
      </div>
      {/* 有日记的小圆点 */}
      {hasEntry && (
        <span
          aria-label="有日记"
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: selected ? token.colorPrimary : token.colorTextTertiary,
            flexShrink: 0,
          }}
        />
      )}
    </div>
  );
}

/** 「全部」视图里的「年-月」可折叠分组 */
function MonthGroup({
  ym,
  count,
  defaultOpen,
  token,
  children,
}: {
  ym: string;
  count: number;
  defaultOpen: boolean;
  token: {
    colorTextSecondary: string;
    colorTextTertiary: string;
  };
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 2 }}>
      <div
        onClick={() => setOpen((o) => !o)}
        className="cursor-pointer select-none"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 6px",
          fontSize: 12,
          fontWeight: 600,
          color: token.colorTextSecondary,
        }}
      >
        <ChevronRight
          size={13}
          style={{
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform .15s",
            flexShrink: 0,
          }}
        />
        <span>{monthLabel(ym)}</span>
        <span style={{ fontWeight: 400, color: token.colorTextTertiary }}>
          {count} 篇
        </span>
      </div>
      {open && <div>{children}</div>}
    </div>
  );
}
