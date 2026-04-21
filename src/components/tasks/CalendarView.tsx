import { useMemo, useState } from "react";
import { theme as antdTheme, App as AntdApp, Button, Tooltip } from "antd";
import { ChevronLeft, ChevronRight, Inbox } from "lucide-react";
import dayjs, { type Dayjs } from "dayjs";
import type { Task } from "@/types";
import { taskApi } from "@/lib/api";

interface Props {
  tasks: Task[];
  onRefresh: () => void;
  onEdit: (t: Task) => void;
  onNewOnDate?: (dateYmd: string) => void;
}

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/** 构造 42 格（6 周）的月视图 */
function buildGrid(anchor: Dayjs): Dayjs[] {
  // 让周一在第一列；start = 当月第一天 - (isoWeekday - 1)
  const first = anchor.startOf("month");
  const offset = (first.day() + 6) % 7; // day: 0=Sun..6=Sat → 周一起算
  const gridStart = first.subtract(offset, "day");
  return Array.from({ length: 42 }, (_, i) => gridStart.add(i, "day"));
}

function priorityColor(
  p: Task["priority"],
  token: ReturnType<typeof antdTheme.useToken>["token"],
) {
  if (p === 0) return token.colorError;
  if (p === 1) return token.colorPrimary;
  return token.colorTextQuaternary;
}

export function CalendarView({ tasks, onRefresh, onEdit, onNewOnDate }: Props) {
  const { token } = antdTheme.useToken();
  const { message } = AntdApp.useApp();
  const [anchor, setAnchor] = useState<Dayjs>(dayjs());
  const [hoverCell, setHoverCell] = useState<string | null>(null);

  const grid = useMemo(() => buildGrid(anchor), [anchor]);
  const todayYmd = dayjs().format("YYYY-MM-DD");
  const activeTasks = tasks.filter((t) => t.status === 0);

  // 按 due_date 聚合
  const tasksByDate = useMemo(() => {
    const map: Record<string, Task[]> = {};
    for (const t of activeTasks) {
      if (!t.due_date) continue;
      (map[t.due_date] ||= []).push(t);
    }
    return map;
  }, [activeTasks]);

  const undated = activeTasks.filter((t) => !t.due_date);

  const stats = useMemo(() => {
    return {
      urgent: activeTasks.filter((t) => t.priority === 0).length,
      normal: activeTasks.filter((t) => t.priority === 1).length,
      low: activeTasks.filter((t) => t.priority === 2).length,
      done: tasks.filter((t) => t.status === 1).length,
    };
  }, [activeTasks, tasks]);

  async function handleDropOnDate(e: React.DragEvent, ymd: string) {
    e.preventDefault();
    setHoverCell(null);
    const id = Number(e.dataTransfer.getData("text/plain"));
    if (!id) return;
    const task = tasks.find((t) => t.id === id);
    if (!task || task.due_date === ymd) return;
    try {
      await taskApi.update(id, { due_date: ymd });
      onRefresh();
    } catch (err) {
      message.error(`更改日期失败: ${err}`);
    }
  }

  async function handleDropOnInbox(e: React.DragEvent) {
    e.preventDefault();
    const id = Number(e.dataTransfer.getData("text/plain"));
    if (!id) return;
    const task = tasks.find((t) => t.id === id);
    if (!task || !task.due_date) return;
    try {
      await taskApi.update(id, { clear_due_date: true });
      onRefresh();
    } catch (err) {
      message.error(`清空日期失败: ${err}`);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 月份导航 + 图例 */}
      <div
        className="flex items-center justify-between px-3 py-2 rounded-t-lg border"
        style={{
          background: token.colorBgContainer,
          borderColor: token.colorBorderSecondary,
        }}
      >
        <div className="flex items-center gap-2">
          <Button size="small" onClick={() => setAnchor(dayjs())}>
            今天
          </Button>
          <Button
            size="small"
            icon={<ChevronLeft size={14} />}
            onClick={() => setAnchor(anchor.subtract(1, "month"))}
          />
          <Button
            size="small"
            icon={<ChevronRight size={14} />}
            onClick={() => setAnchor(anchor.add(1, "month"))}
          />
          <span className="ml-2 font-semibold text-sm">{anchor.format("YYYY 年 M 月")}</span>
        </div>
        <div className="flex items-center gap-3 text-[11px]" style={{ color: token.colorTextSecondary }}>
          <span className="flex items-center gap-1">
            <Dot color={token.colorError} /> 紧急 {stats.urgent}
          </span>
          <span className="flex items-center gap-1">
            <Dot color={token.colorPrimary} /> 一般 {stats.normal}
          </span>
          <span className="flex items-center gap-1">
            <Dot color={token.colorTextQuaternary} /> 不急 {stats.low}
          </span>
          <span style={{ color: token.colorSuccess }}>已完成 {stats.done}</span>
        </div>
      </div>

      {/* 日历网格 */}
      <div
        className="rounded-b-lg border border-t-0 overflow-hidden"
        style={{
          background: token.colorBgContainer,
          borderColor: token.colorBorderSecondary,
        }}
      >
        <div
          className="grid grid-cols-7 text-[10px] font-semibold"
          style={{
            background: token.colorFillSecondary,
            color: token.colorTextSecondary,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          {WEEKDAY_LABELS.map((w, i) => (
            <div
              key={w}
              className="px-2 py-1"
              style={{
                color: i >= 5 ? token.colorTextTertiary : undefined,
              }}
            >
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {grid.map((d) => {
            const ymd = d.format("YYYY-MM-DD");
            const sameMonth = d.month() === anchor.month();
            const isToday = ymd === todayYmd;
            const items = tasksByDate[ymd] || [];
            const isHover = hoverCell === ymd;
            return (
              <div
                key={ymd}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setHoverCell(ymd);
                }}
                onDragLeave={() => setHoverCell(null)}
                onDrop={(e) => handleDropOnDate(e, ymd)}
                onDoubleClick={() => onNewOnDate?.(ymd)}
                className="min-h-[96px] p-1.5 transition cursor-pointer"
                style={{
                  background: isToday
                    ? token.colorPrimaryBg
                    : sameMonth
                      ? "transparent"
                      : token.colorFillQuaternary,
                  borderRight: `1px solid ${token.colorBorderSecondary}`,
                  borderBottom: `1px solid ${token.colorBorderSecondary}`,
                  outline: isHover ? `1.5px solid ${token.colorPrimary}` : "none",
                  outlineOffset: -1,
                }}
                title="双击空白可在这一天新建任务"
              >
                <div
                  className="text-[10px] font-semibold flex items-center gap-1"
                  style={{ color: sameMonth ? token.colorText : token.colorTextQuaternary }}
                >
                  {d.date()}
                  {isToday && (
                    <span
                      className="text-[9px] leading-none px-1 py-0.5 rounded"
                      style={{
                        background: token.colorPrimary,
                        color: "#fff",
                      }}
                    >
                      今
                    </span>
                  )}
                </div>
                <div className="space-y-1 mt-1">
                  {items.slice(0, 4).map((t) => {
                    const bar = priorityColor(t.priority, token);
                    return (
                      <Tooltip key={t.id} title={t.title}>
                        <div
                          draggable
                          onDragStart={(e) => {
                            e.stopPropagation();
                            e.dataTransfer.effectAllowed = "move";
                            e.dataTransfer.setData("text/plain", String(t.id));
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            onEdit(t);
                          }}
                          className="truncate px-1 py-0.5 rounded text-[10px] leading-tight cursor-pointer transition hover:opacity-80"
                          style={{
                            background: `${bar}1a`,
                            color: bar,
                            borderLeft: `2px solid ${bar}`,
                          }}
                        >
                          {t.title}
                        </div>
                      </Tooltip>
                    );
                  })}
                  {items.length > 4 && (
                    <div
                      className="text-[10px]"
                      style={{ color: token.colorTextTertiary }}
                    >
                      +{items.length - 4} 更多
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 未安排日期 抽屉 */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDrop={handleDropOnInbox}
        className="rounded-lg border p-3"
        style={{
          background: token.colorBgContainer,
          borderColor: token.colorBorderSecondary,
        }}
      >
        <div className="flex items-center justify-between mb-2">
          <div
            className="text-xs font-semibold flex items-center gap-1"
            style={{ color: token.colorTextSecondary }}
          >
            <Inbox size={13} />
            未安排日期 · {undated.length}
          </div>
          <span className="text-[10px]" style={{ color: token.colorTextTertiary }}>
            拖日历里的任务到这里清空日期；或把这里的任务拖到某一天
          </span>
        </div>
        {undated.length === 0 ? (
          <div className="text-[11px]" style={{ color: token.colorTextTertiary }}>
            暂无
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {undated.map((t) => (
              <div
                key={t.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", String(t.id));
                }}
                onClick={() => onEdit(t)}
                className="px-2 py-1 rounded border text-[11px] cursor-pointer transition hover:opacity-80"
                style={{
                  background: token.colorFillSecondary,
                  borderColor: token.colorBorderSecondary,
                  borderLeft: `2px solid ${priorityColor(t.priority, token)}`,
                }}
              >
                {t.title}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Dot({ color }: { color: string }) {
  return (
    <span
      className="inline-block rounded-full"
      style={{ width: 6, height: 6, background: color }}
    />
  );
}
