import { useMemo } from "react";
import { theme as antdTheme } from "antd";
import dayjs, { type Dayjs } from "dayjs";

interface Props {
  /** 视图年份 */
  year: number;
  /** 视图月份 (1-12) */
  month: number;
  /** 当前选中日期 yyyy-mm-dd */
  selectedDate: string;
  /** 今天 yyyy-mm-dd */
  today: string;
  /** 当月已有日记的日期集合 yyyy-mm-dd */
  datesWithEntry: Set<string>;
  /** 点击格子；未来日已被组件内部拦截，回调不会被触发 */
  onSelectDate: (date: string) => void;
  /** 右键格子；hasEntry 用于决定外部菜单要不要显示「删除日记」 */
  onContextMenuDate?: (
    e: React.MouseEvent,
    date: string,
    hasEntry: boolean,
  ) => void;
}

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

/**
 * 构造 42 格（6 周）月视图。周一为列起点，与任务侧 CalendarView 保持一致。
 *
 * 算法：取目标月 1 号，往前补到本周的周一，作为网格起点。
 */
function buildGrid(year: number, month: number): Dayjs[] {
  const first = dayjs(`${year}-${String(month).padStart(2, "0")}-01`);
  // dayjs day(): 0=Sun..6=Sat → 周一为 0 的偏移
  const offset = (first.day() + 6) % 7;
  const start = first.subtract(offset, "day");
  return Array.from({ length: 42 }, (_, i) => start.add(i, "day"));
}

/**
 * DailyMonthCalendar —— 侧栏内嵌紧凑月视图。
 *
 * 视觉状态优先级（从高到低）：
 *   1. 未来日 → 禁用、灰色不可点（与主区 DatePicker 的 disabledDate 保持一致）
 *   2. 今天 → 主色实底 + 白字
 *   3. 选中（且非今天） → 主色描边 + 主色字
 *   4. 有日记（且非今天/选中） → 主色弱底 + 主色字
 *   5. 当月普通日 → 默认色
 *   6. 非当月（用于补齐 6 周网格的上月末/下月初） → 弱化色
 */
export function DailyMonthCalendar({
  year,
  month,
  selectedDate,
  today,
  datesWithEntry,
  onSelectDate,
  onContextMenuDate,
}: Props) {
  const { token } = antdTheme.useToken();
  const grid = useMemo(() => buildGrid(year, month), [year, month]);
  const todayDayjs = useMemo(() => dayjs(today), [today]);

  return (
    <div className="px-2 pb-2 shrink-0">
      {/* 周标题 */}
      <div
        className="grid grid-cols-7"
        style={{
          fontSize: 10,
          color: token.colorTextTertiary,
          fontWeight: 500,
          marginBottom: 2,
        }}
      >
        {WEEKDAYS.map((w, i) => (
          <div
            key={w}
            className="text-center py-1"
            style={{
              color: i >= 5 ? token.colorTextQuaternary : undefined,
            }}
          >
            {w}
          </div>
        ))}
      </div>

      {/* 日期网格 */}
      <div
        className="grid grid-cols-7"
        style={{ gap: 2 }}
      >
        {grid.map((d) => {
          const ymd = d.format("YYYY-MM-DD");
          const sameMonth = d.month() === month - 1 && d.year() === year;
          const isToday = ymd === today;
          const isSelected = ymd === selectedDate;
          const isFuture = d.isAfter(todayDayjs, "day");
          const hasEntry = datesWithEntry.has(ymd);

          let bg = "transparent";
          let color = sameMonth ? token.colorText : token.colorTextQuaternary;
          let outline: string | undefined;
          let cursor = "pointer";
          let weight = 400;

          if (isFuture) {
            color = token.colorTextQuaternary;
            cursor = "not-allowed";
          } else if (isToday) {
            bg = token.colorPrimary;
            color = "#fff";
            weight = 600;
          } else if (isSelected) {
            outline = `1.5px solid ${token.colorPrimary}`;
            color = token.colorPrimary;
            weight = 600;
          } else if (hasEntry) {
            bg = `${token.colorPrimary}1a`;
            color = token.colorPrimary;
            weight = 500;
          }

          return (
            <button
              key={ymd}
              type="button"
              disabled={isFuture}
              onClick={() => {
                if (isFuture) return;
                onSelectDate(ymd);
              }}
              onContextMenu={(e) => {
                if (isFuture) {
                  e.preventDefault();
                  return;
                }
                onContextMenuDate?.(e, ymd, hasEntry);
              }}
              title={isFuture ? "未来日期不可选" : ymd}
              className="flex items-center justify-center transition"
              style={{
                aspectRatio: "1 / 1",
                minHeight: 26,
                fontSize: 12,
                fontWeight: weight,
                background: bg,
                color,
                outline,
                outlineOffset: -1,
                borderRadius: 6,
                border: "none",
                padding: 0,
                cursor,
                opacity: isFuture ? 0.45 : 1,
              }}
            >
              {d.date()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
