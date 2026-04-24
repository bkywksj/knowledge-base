import { useState, useEffect, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, message, theme as antdTheme } from "antd";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import { dailyApi } from "@/lib/api";
import { useAppStore } from "@/store";

/**
 * DailyPanel —— Activity Bar 模式下"每日笔记"视图的主面板。
 *
 * 职责：
 *   · 顶部：视图标题 + 快速跳回今天
 *   · 月份切换：← 年-月 →
 *   · 日期列表：本月所有有日记的日期（倒序），选中态高亮
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

  // 倒序展示该月已有日记的日期
  const sortedDates = useMemo(() => [...dates].sort((a, b) => b.localeCompare(a)), [dates]);

  function goToDate(date: string) {
    navigate(`/daily?date=${date}`);
  }

  function goToToday() {
    goToDate(today);
    const { year, month } = parseDate(today);
    setViewMonth({ year, month });
  }

  const isViewingCurrentMonth = (() => {
    const { year, month } = parseDate(today);
    return viewMonth.year === year && viewMonth.month === month;
  })();

  return (
    <div
      className="flex flex-col h-full"
      style={{ overflow: "hidden" }}
    >
      {/* 视图标题 */}
      <div
        className="flex items-center gap-2 px-3 py-2.5 shrink-0"
        style={{ borderBottom: `1px solid ${token.colorBorderSecondary}` }}
      >
        <Calendar size={15} style={{ color: token.colorPrimary }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: token.colorText }}>
          每日笔记
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

      {/* 日期列表 */}
      <div
        className="flex-1 overflow-auto"
        style={{ minHeight: 0, padding: "4px 8px 8px" }}
      >
        {/* "今天"常驻项（仅在当前浏览月不含今天时显示为独立条目） */}
        {isViewingCurrentMonth &&
          !sortedDates.includes(today) && (
            <DateRow
              date={today}
              selected={selectedDate === today}
              isToday
              hasEntry={false}
              onClick={() => goToDate(today)}
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
              onClick={() => goToDate(d)}
              token={token}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** 单行日期渲染 */
function DateRow({
  date,
  selected,
  isToday,
  hasEntry,
  onClick,
  token,
}: {
  date: string;
  selected: boolean;
  isToday: boolean;
  hasEntry: boolean;
  onClick: () => void;
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
        transition: "background .15s",
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
