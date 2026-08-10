import { useEffect, useMemo, useState } from "react";
import {
  App as AntdApp,
  Empty,
  Segmented,
  Select,
  theme as antdTheme,
  Tooltip,
} from "antd";
import { projectApi } from "@/lib/api";
import type { Project, Task } from "@/types";
import { isAbandoned } from "@/types";

interface Props {
  /** 当前查询出的全部任务（已按筛选条件过滤） */
  tasks: Task[];
  onRefresh: () => void;
  onEdit: (t: Task) => void;
}

type RangeUnit = "day" | "week";
const DAY_MS = 86_400_000;

/**
 * 甘特图视图（v41 引入）。
 *
 * 设计要点：
 * - **零依赖**：直接画 SVG/div 网格，不引第三方甘特库（gantt-task-react 1MB+ 体积划不来）
 * - **时间范围**：默认显示当前任务集合的 `start_date / due_date` 跨度（前后各加 7 天 buffer）
 * - **没填 start_date 的任务**：在 due_date 当天显示一个"截止点"圆点（不渲染条）
 * - **没填 due_date 也没 start_date**：归到底部"未排期"分组，不画条
 * - **拖拽改时间**：v1 不做，简单点。要改时间用任务详情 Modal 改 start_date/due_date
 * - **按项目分组**：顶部 Select 选项目过滤；选"全部"时按 project_id 分组渲染
 */
export function GanttView({ tasks, onEdit }: Props) {
  const { token } = antdTheme.useToken();
  const { message } = AntdApp.useApp();
  const [projects, setProjects] = useState<Project[]>([]);
  const [filterProjectId, setFilterProjectId] = useState<number | "all" | "none">("all");
  const [unit, setUnit] = useState<RangeUnit>("day");

  useEffect(() => {
    projectApi.list(false).then(setProjects).catch((e) => {
      message.error(`加载项目失败：${e}`);
    });
  }, [message]);

  // 按 project 筛选
  const filteredTasks = useMemo(() => {
    if (filterProjectId === "all") return tasks;
    if (filterProjectId === "none") return tasks.filter((t) => t.project_id == null);
    return tasks.filter((t) => t.project_id === filterProjectId);
  }, [tasks, filterProjectId]);

  // 拆"已排期"和"未排期"
  const { scheduled, unscheduled } = useMemo(() => {
    const scheduled: Task[] = [];
    const unscheduled: Task[] = [];
    for (const t of filteredTasks) {
      if (t.start_date || t.due_date) scheduled.push(t);
      else unscheduled.push(t);
    }
    return { scheduled, unscheduled };
  }, [filteredTasks]);

  // 计算时间范围：取 min(start_date) / max(due_date)，前后各 buffer 7 天
  const { rangeStart, rangeEnd, days } = useMemo(() => {
    if (scheduled.length === 0) {
      const today = startOfDay(new Date());
      return {
        rangeStart: today,
        rangeEnd: addDays(today, 14),
        days: 14,
      };
    }
    let min = Infinity;
    let max = -Infinity;
    for (const t of scheduled) {
      const left = parseDateMs(t.start_date) ?? parseDateMs(t.due_date);
      const right = parseDateMs(t.due_date) ?? parseDateMs(t.start_date);
      if (left != null) min = Math.min(min, left);
      if (right != null) max = Math.max(max, right);
    }
    const start = addDays(new Date(min), -3);
    const end = addDays(new Date(max), 7);
    return {
      rangeStart: startOfDay(start),
      rangeEnd: startOfDay(end),
      days: Math.max(1, Math.round((startOfDay(end).getTime() - startOfDay(start).getTime()) / DAY_MS)),
    };
  }, [scheduled]);

  // 每格像素宽度（day=22px，week=70px）
  const cellWidth = unit === "day" ? 22 : 70;
  const totalWidth = days * cellWidth;
  const rowHeight = 32;
  const labelWidth = 240;

  // 按项目分组（如果选了"全部"，每个项目一个 group；否则单组）
  const groups = useMemo(() => {
    if (filterProjectId !== "all") {
      return [{ project: null as Project | null, tasks: scheduled }];
    }
    const map = new Map<number | null, Task[]>();
    for (const t of scheduled) {
      const key = t.project_id ?? null;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    }
    return Array.from(map.entries())
      .sort((a, b) => {
        // null（无项目）排最后
        if (a[0] == null) return 1;
        if (b[0] == null) return -1;
        return a[0] - b[0];
      })
      .map(([pid, ts]) => ({
        project: pid != null ? projects.find((p) => p.id === pid) ?? null : null,
        tasks: ts,
      }));
  }, [scheduled, projects, filterProjectId]);

  // 生成时间轴 ticks（每天一格）
  const ticks = useMemo(() => {
    const out: { date: Date; label: string; isMonthStart: boolean; isWeekend: boolean }[] = [];
    for (let i = 0; i < days; i++) {
      const d = addDays(rangeStart, i);
      const isMonthStart = d.getDate() === 1;
      const wd = d.getDay(); // 0=Sun, 6=Sat
      out.push({
        date: d,
        label: unit === "day"
          ? `${d.getMonth() + 1}/${d.getDate()}`
          : isMonthStart || i === 0
            ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
            : "",
        isMonthStart,
        isWeekend: wd === 0 || wd === 6,
      });
    }
    return out;
  }, [rangeStart, days, unit]);

  // 今天位置（如果在范围内）
  const todayOffset = useMemo(() => {
    const today = startOfDay(new Date()).getTime();
    const start = rangeStart.getTime();
    if (today < start || today > rangeEnd.getTime()) return null;
    return ((today - start) / DAY_MS) * cellWidth;
  }, [rangeStart, rangeEnd, cellWidth]);

  return (
    <div className="flex flex-col gap-2 h-full">
      {/* 工具栏 */}
      <div className="flex items-center gap-3">
        <Select
          size="small"
          style={{ minWidth: 160 }}
          value={filterProjectId}
          onChange={(v) => setFilterProjectId(v as typeof filterProjectId)}
          options={[
            { label: "全部项目", value: "all" },
            { label: "无项目（散任务）", value: "none" },
            ...projects.map((p) => ({
              label: p.name,
              value: p.id,
            })),
          ]}
        />
        <Segmented
          size="small"
          value={unit}
          onChange={(v) => setUnit(v as RangeUnit)}
          options={[
            { label: "按天", value: "day" },
            { label: "按周", value: "week" },
          ]}
        />
        <span style={{ fontSize: 12, color: token.colorTextTertiary }}>
          {fmtDate(rangeStart)} — {fmtDate(addDays(rangeEnd, -1))}
        </span>
      </div>

      {scheduled.length === 0 ? (
        <div className="flex flex-col items-center justify-center" style={{ flex: 1 }}>
          <Empty
            description={
              <span style={{ fontSize: 12 }}>
                选中的范围下没有已排期的任务。
                <br />在任务详情里设置开始日期/截止日期即可显示甘特条。
              </span>
            }
          />
        </div>
      ) : (
        <div
          className="overflow-auto border rounded kb-surface"
          style={{
            borderColor: token.colorBorderSecondary,
            flex: 1,
            minHeight: 0,
          }}
        >
          <div style={{ minWidth: labelWidth + totalWidth, position: "relative" }}>
            {/* 顶部时间轴 */}
            <div
              className="sticky top-0 z-10 flex"
              style={{
                background: token.colorBgContainer,
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
              }}
            >
              <div
                style={{
                  width: labelWidth,
                  flexShrink: 0,
                  padding: "6px 10px",
                  fontSize: 12,
                  fontWeight: 600,
                  color: token.colorTextSecondary,
                  borderRight: `1px solid ${token.colorBorderSecondary}`,
                }}
              >
                任务 / {filteredTasks.length} 条
              </div>
              <div className="flex" style={{ minWidth: totalWidth }}>
                {ticks.map((t, i) => (
                  <div
                    key={i}
                    style={{
                      width: cellWidth,
                      flexShrink: 0,
                      padding: "4px 0",
                      textAlign: "center",
                      fontSize: 10,
                      color: t.isWeekend ? token.colorTextTertiary : token.colorTextSecondary,
                      background: t.isWeekend ? token.colorFillQuaternary : "transparent",
                      borderRight: t.isMonthStart
                        ? `1px solid ${token.colorBorder}`
                        : `1px solid ${token.colorBorderSecondary}`,
                    }}
                  >
                    {t.label}
                  </div>
                ))}
              </div>
            </div>

            {/* 今天竖线 */}
            {todayOffset != null && (
              <div
                aria-label="今天"
                style={{
                  position: "absolute",
                  left: labelWidth + todayOffset,
                  top: 28,
                  bottom: 0,
                  width: 2,
                  background: token.colorError,
                  opacity: 0.7,
                  pointerEvents: "none",
                  zIndex: 5,
                }}
              />
            )}

            {/* 分组 + 行 */}
            {groups.map((g, gi) => (
              <div key={gi}>
                {/* 组标题 */}
                {filterProjectId === "all" && (
                  <div
                    className="flex items-center gap-2"
                    style={{
                      padding: "6px 10px",
                      background: token.colorFillQuaternary,
                      borderBottom: `1px solid ${token.colorBorderSecondary}`,
                      fontSize: 12,
                      fontWeight: 600,
                      color: token.colorTextSecondary,
                      position: "sticky",
                      left: 0,
                      width: labelWidth + totalWidth,
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 2,
                        background: g.project?.color ?? token.colorTextQuaternary,
                      }}
                    />
                    <span>{g.project?.name ?? "无项目"}</span>
                    <span style={{ fontSize: 10, color: token.colorTextTertiary }}>
                      · {g.tasks.length}
                    </span>
                  </div>
                )}
                {g.tasks.map((t) => (
                  <GanttRow
                    key={t.id}
                    task={t}
                    rangeStart={rangeStart}
                    cellWidth={cellWidth}
                    rowHeight={rowHeight}
                    labelWidth={labelWidth}
                    totalWidth={totalWidth}
                    color={g.project?.color}
                    onClick={() => onEdit(t)}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 未排期分组（标题 + 行，列表样式） */}
      {unscheduled.length > 0 && (
        <div
          style={{
            border: `1px dashed ${token.colorBorderSecondary}`,
            borderRadius: 6,
            padding: "8px 10px",
            background: token.colorFillQuaternary,
          }}
        >
          <div
            style={{
              fontSize: 12,
              color: token.colorTextSecondary,
              marginBottom: 6,
            }}
          >
            未排期（{unscheduled.length}） · 设置开始/截止日期后会出现在甘特图上
          </div>
          <div className="flex flex-wrap gap-1">
            {unscheduled.slice(0, 20).map((t) => (
              <Tooltip key={t.id} title={t.title}>
                <span
                  onClick={() => onEdit(t)}
                  className="cursor-pointer truncate"
                  style={{
                    fontSize: 11,
                    padding: "2px 8px",
                    borderRadius: 10,
                    background: token.colorBgContainer,
                    border: `1px solid ${token.colorBorderSecondary}`,
                    maxWidth: 180,
                  }}
                >
                  {t.title}
                </span>
              </Tooltip>
            ))}
            {unscheduled.length > 20 && (
              <span style={{ fontSize: 11, color: token.colorTextTertiary, alignSelf: "center" }}>
                ... 还有 {unscheduled.length - 20} 条
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface RowProps {
  task: Task;
  rangeStart: Date;
  cellWidth: number;
  rowHeight: number;
  labelWidth: number;
  totalWidth: number;
  color?: string;
  onClick: () => void;
}

function GanttRow({
  task,
  rangeStart,
  cellWidth,
  rowHeight,
  labelWidth,
  totalWidth,
  color,
  onClick,
}: RowProps) {
  const { token } = antdTheme.useToken();
  const start = parseDateMs(task.start_date);
  const due = parseDateMs(task.due_date);

  // 计算条/点位置
  let bar: { left: number; width: number } | null = null;
  let dot: number | null = null;
  if (start != null && due != null) {
    const sOff = (start - rangeStart.getTime()) / DAY_MS;
    const eOff = (due - rangeStart.getTime()) / DAY_MS + 1; // +1 让条覆盖到 due 当天
    bar = { left: sOff * cellWidth, width: Math.max(cellWidth * 0.5, (eOff - sOff) * cellWidth) };
  } else if (start != null) {
    bar = { left: ((start - rangeStart.getTime()) / DAY_MS) * cellWidth, width: cellWidth };
  } else if (due != null) {
    dot = ((due - rangeStart.getTime()) / DAY_MS) * cellWidth + cellWidth / 2;
  }

  // 已完成 / 已放弃都灰显（甘特图保留时间线完整性，但不再抢视觉）
  const isDone = task.status === 1 || isAbandoned(task);
  const barColor = color ?? (task.priority === 0 ? token.colorError : token.colorPrimary);

  return (
    <div
      className="flex cursor-pointer hover:bg-[var(--ant-color-fill-quaternary)]"
      style={{
        height: rowHeight,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
      }}
      onClick={onClick}
    >
      <div
        className="truncate"
        style={{
          width: labelWidth,
          flexShrink: 0,
          padding: "0 10px",
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
          borderRight: `1px solid ${token.colorBorderSecondary}`,
          textDecoration: isDone ? "line-through" : undefined,
          color: isDone ? token.colorTextTertiary : token.colorText,
        }}
        title={task.title}
      >
        {task.title}
      </div>
      <div
        style={{
          position: "relative",
          minWidth: totalWidth,
          height: rowHeight,
        }}
      >
        {bar && (
          <Tooltip
            title={
              <>
                {task.title}
                <br />
                {task.start_date ?? "—"} → {task.due_date ?? "—"}
              </>
            }
          >
            <div
              style={{
                position: "absolute",
                top: 6,
                height: rowHeight - 12,
                left: bar.left,
                width: bar.width,
                borderRadius: 4,
                background: barColor,
                opacity: isDone ? 0.4 : 0.85,
                border: `1px solid ${barColor}`,
              }}
            />
          </Tooltip>
        )}
        {dot != null && (
          <Tooltip title={`截止：${task.due_date}`}>
            <div
              style={{
                position: "absolute",
                top: rowHeight / 2 - 5,
                left: dot - 5,
                width: 10,
                height: 10,
                borderRadius: 5,
                background: barColor,
                opacity: isDone ? 0.4 : 0.9,
              }}
            />
          </Tooltip>
        )}
      </div>
    </div>
  );
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function parseDateMs(s: string | null | undefined): number | null {
  if (!s) return null;
  // 接受 'YYYY-MM-DD' 或 'YYYY-MM-DD HH:MM:SS'，取日期部分
  const ymd = s.slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getTime();
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
