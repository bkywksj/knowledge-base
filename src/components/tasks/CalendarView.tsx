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

  // 按 due_date 聚合（含已完成）；同一天里"未完成在前、已完成在后"，
  // 同状态内按优先级排序，便于一眼看出当日重点
  const tasksByDate = useMemo(() => {
    const map: Record<string, Task[]> = {};
    for (const t of tasks) {
      if (!t.due_date) continue;
      const key = t.due_date.slice(0, 10);
      (map[key] ||= []).push(t);
    }
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => {
        if (a.status !== b.status) return a.status - b.status;
        return a.priority - b.priority;
      });
    }
    return map;
  }, [tasks]);

  // "未安排日期"抽屉只放进行中（已完成且无日期的没意义；放进来还会让抽屉很长）
  const undated = tasks.filter((t) => !t.due_date && t.status === 0);

  const stats = useMemo(() => {
    const active = tasks.filter((t) => t.status === 0);
    return {
      urgent: active.filter((t) => t.priority === 0).length,
      normal: active.filter((t) => t.priority === 1).length,
      low: active.filter((t) => t.priority === 2).length,
      done: tasks.filter((t) => t.status === 1).length,
    };
  }, [tasks]);

  async function handleDropOnDate(e: React.DragEvent, ymd: string) {
    e.preventDefault();
    setHoverCell(null);
    const id = Number(e.dataTransfer.getData("text/plain"));
    if (!id) return;
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    if (task.due_date && task.due_date.slice(0, 10) === ymd) return;
    try {
      // 保留原时分（若有），只改日期部分
      const timePart =
        task.due_date && task.due_date.length > 10 ? task.due_date.slice(10) : "";
      await taskApi.update(id, { due_date: `${ymd}${timePart}` });
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
    <div className="flex flex-col gap-3 h-full">
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
        className="rounded-b-lg border border-t-0 overflow-hidden flex-1 flex flex-col min-h-0"
        style={{
          background: token.colorBgContainer,
          borderColor: token.colorBorderSecondary,
        }}
      >
        <div
          className="grid grid-cols-7 text-xs font-semibold"
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
        <div className="grid grid-cols-7 flex-1 auto-rows-fr">
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
                className="min-h-[100px] p-1.5 transition cursor-pointer"
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
                  className="text-xs font-semibold flex items-center gap-1"
                  style={{ color: sameMonth ? token.colorText : token.colorTextQuaternary }}
                >
                  {d.date()}
                  {isToday && (
                    <span
                      className="text-[10px] leading-none px-1 py-0.5 rounded"
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
                    const isDone = t.status === 1;
                    const bar = priorityColor(t.priority, token);
                    // 已完成：灰底 + 灰字 + 删除线；不再用优先级色（避免视觉抢戏），
                    // 也禁止拖拽到其他日期（避免不小心修改完成任务的截止日）
                    return (
                      <Tooltip key={t.id} title={isDone ? `${t.title}（已完成）` : t.title}>
                        <div
                          draggable={!isDone}
                          onDragStart={
                            isDone
                              ? undefined
                              : (e) => {
                                  e.stopPropagation();
                                  e.dataTransfer.effectAllowed = "move";
                                  e.dataTransfer.setData("text/plain", String(t.id));
                                }
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            onEdit(t);
                          }}
                          className="truncate px-1 py-0.5 rounded text-xs leading-tight cursor-pointer transition hover:opacity-80"
                          style={{
                            background: isDone
                              ? token.colorFillTertiary
                              : `${bar}1a`,
                            color: isDone ? token.colorTextTertiary : bar,
                            borderLeft: `2px solid ${
                              isDone ? token.colorTextQuaternary : bar
                            }`,
                            textDecoration: isDone ? "line-through" : "none",
                            opacity: isDone ? 0.75 : 1,
                          }}
                        >
                          {t.title}
                        </div>
                      </Tooltip>
                    );
                  })}
                  {items.length > 4 && (
                    <div
                      className="text-xs"
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
