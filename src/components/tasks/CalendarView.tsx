import { useMemo, useState } from "react";
import {
  theme as antdTheme,
  App as AntdApp,
  Button,
  Segmented,
  Tooltip,
} from "antd";
import { ChevronDown, ChevronLeft, ChevronRight, Inbox } from "lucide-react";
import dayjs, { type Dayjs } from "dayjs";
import type { Task, TaskCategory } from "@/types";
import { isAbandoned } from "@/types";
import { taskApi } from "@/lib/api";
import { useAppStore } from "@/store";
import { MAX_LANES, layoutWeek, shiftRangeTo, taskRange } from "@/lib/calendarLayout";
import { taskTimeLines } from "@/lib/taskTimestamps";

interface Props {
  tasks: Task[];
  onRefresh: () => void;
  onEdit: (t: Task) => void;
  onNewOnDate?: (dateYmd: string) => void;
  /**
   * 任务分类表（id → 分类）。用于「按分类配色」——只按紧急度上色时，
   * 同一天的几条任务看不出分属哪条线；分类色能一眼区分。
   * 不传时「按分类」模式回退成灰色，不会报错。
   */
  categoryMap?: Map<number, TaskCategory>;
}

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/**
 * 「未安排日期」抽屉内容区的最大高度（px）。
 * 约合两行标签（每行 ~26px + gap 8px），超出后抽屉内部自己滚动，
 * 不再往上挤占日历网格的高度。
 */
const INBOX_MAX_HEIGHT = 76;

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

/**
 * 给十六进制色拼上透明度后缀（用作任务条底色）。
 * 分类色是用户自定义的，万一存的不是 #rrggbb（如 rgba(...)），直接拼后缀会得到
 * 非法颜色值，这里退回原色而不是渲染出坏样式。
 */
function withAlpha(color: string, alphaHex: string) {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? `${color}${alphaHex}` : color;
}

/**
 * 按当前配色依据解析任务的展示色。
 * - priority：紧急度三色（老行为）
 * - category：任务分类的自定义色；未分类 / 分类表缺失时退回灰色
 */
function resolveTaskColor(
  t: Task,
  mode: "priority" | "category",
  categoryMap: Map<number, TaskCategory> | undefined,
  token: ReturnType<typeof antdTheme.useToken>["token"],
) {
  if (mode === "category") {
    const c = t.category_id != null ? categoryMap?.get(t.category_id) : undefined;
    return c?.color || token.colorTextQuaternary;
  }
  return priorityColor(t.priority, token);
}

export function CalendarView({
  tasks,
  onRefresh,
  onEdit,
  onNewOnDate,
  categoryMap,
}: Props) {
  const { token } = antdTheme.useToken();
  const { message } = AntdApp.useApp();
  const [anchor, setAnchor] = useState<Dayjs>(dayjs());
  const [hoverCell, setHoverCell] = useState<string | null>(null);
  const colorBy = useAppStore((s) => s.tasksCalendarColorBy);
  const setColorBy = useAppStore((s) => s.setTasksCalendarColorBy);

  const grid = useMemo(() => buildGrid(anchor), [anchor]);
  const todayYmd = dayjs().format("YYYY-MM-DD");

  // 6 周 × 7 天：条带按"周"布局，跨天任务在周内连成一条、跨周则在边界截断
  const weeks = useMemo(() => {
    const out: Dayjs[][] = [];
    for (let i = 0; i < grid.length; i += 7) out.push(grid.slice(i, i + 7));
    return out;
  }, [grid]);

  const weekBars = useMemo(
    () => weeks.map((w) => layoutWeek(w[0], tasks)),
    [weeks, tasks],
  );

  /**
   * 拖拽中把条带层整体设为 pointer-events:none，否则横条会挡住下面日期格的
   * dragover/drop，任务永远拖不到"被条压住"的那一天。
   */
  const [dragging, setDragging] = useState(false);

  /** 「未安排日期」抽屉是否收起。收起后日历能多拿一行高度。 */
  const [inboxCollapsed, setInboxCollapsed] = useState(false);

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

  // 分类图例：只列"当前数据里真出现过"的分类，按条数降序取前 6 个，
  // 避免用户建了几十个分类时图例把整行撑爆。
  const categoryLegend = useMemo(() => {
    if (colorBy !== "category") return [];
    const counter = new Map<number | null, number>();
    for (const t of tasks) {
      if (t.status !== 0) continue; // 与紧急度图例口径一致：只数未完成
      const key = t.category_id ?? null;
      counter.set(key, (counter.get(key) ?? 0) + 1);
    }
    return [...counter.entries()]
      .map(([id, count]) => {
        const c = id != null ? categoryMap?.get(id) : undefined;
        return {
          key: id ?? "none",
          count,
          name: c?.name ?? "未分类",
          color: c?.color || token.colorTextQuaternary,
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
  }, [colorBy, tasks, categoryMap, token]);

  async function handleDropOnDate(e: React.DragEvent, ymd: string) {
    e.preventDefault();
    setHoverCell(null);
    setDragging(false);
    const id = Number(e.dataTransfer.getData("text/plain"));
    if (!id) return;
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    // 保留原时分（若有），只改日期部分
    const timePart =
      task.due_date && task.due_date.length > 10 ? task.due_date.slice(10) : "";
    try {
      // 区间任务：拖动 = 整体平移（落点成为新的开始日），跨度保持不变。
      // 只改 due_date 会把区间越拖越短，甚至出现"结束早于开始"的脏数据。
      const shifted = shiftRangeTo(task, ymd);
      if (shifted) {
        await taskApi.update(id, {
          start_date: shifted.start_date,
          due_date: `${shifted.due_date}${timePart}`,
        });
      } else if (task.start_date) {
        // 是区间任务但落点没变 → 什么都不用做
        return;
      } else {
        if (task.due_date && task.due_date.slice(0, 10) === ymd) return;
        await taskApi.update(id, { due_date: `${ymd}${timePart}` });
      }
      onRefresh();
    } catch (err) {
      message.error(`更改日期失败: ${err}`);
    }
  }

  async function handleDropOnInbox(e: React.DragEvent) {
    e.preventDefault();
    // 与 handleDropOnDate 对称：drop 落定即解除条带层的 pointer-events:none。
    // 少了这一句，若 dragend 因故没触发（拖到窗口外松手等），条带层会一直
    // 处于不可点状态，表现为"日历上的任务突然点不动了"。
    setDragging(false);
    const id = Number(e.dataTransfer.getData("text/plain"));
    if (!id) return;
    const task = tasks.find((t) => t.id === id);
    // 已经是无日期的任务再拖回来 = 空操作，直接返回（不是错误）
    if (!task || !task.due_date) return;
    try {
      // 连区间左端一起清掉，否则任务会从日历上消失却仍在甘特图里挂着一条起始日
      await taskApi.update(id, { clear_due_date: true, clear_start_date: true });
      onRefresh();
    } catch (err) {
      message.error(`清空日期失败: ${err}`);
    }
  }

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* 月份导航 + 图例 */}
      <div
        className="flex items-center justify-between px-3 py-2 rounded-t-lg border kb-surface"
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
        <div
          className="flex items-center gap-3 text-[11px] flex-wrap justify-end"
          style={{ color: token.colorTextSecondary }}
        >
          <Segmented
            size="small"
            value={colorBy}
            onChange={(v) => setColorBy(v as "priority" | "category")}
            options={[
              { label: "紧急度", value: "priority" },
              { label: "分类", value: "category" },
            ]}
            title="任务条的配色依据"
          />
          {colorBy === "priority" ? (
            <>
              <span className="flex items-center gap-1">
                <Dot color={token.colorError} /> 紧急 {stats.urgent}
              </span>
              <span className="flex items-center gap-1">
                <Dot color={token.colorPrimary} /> 一般 {stats.normal}
              </span>
              <span className="flex items-center gap-1">
                <Dot color={token.colorTextQuaternary} /> 不急 {stats.low}
              </span>
            </>
          ) : categoryLegend.length === 0 ? (
            <span style={{ color: token.colorTextTertiary }}>暂无进行中的任务</span>
          ) : (
            categoryLegend.map((c) => (
              <span key={c.key} className="flex items-center gap-1">
                <Dot color={c.color} /> {c.name} {c.count}
              </span>
            ))
          )}
          <span style={{ color: token.colorSuccess }}>已完成 {stats.done}</span>
        </div>
      </div>

      {/* 日历网格
          🔴 必须 overflow-y:auto 而不是 hidden。每周行有 min-h-[104px]，6 周 = 624px；
          窗口不够高（或下方"未安排日期"抽屉变高）时 hidden 会**静默裁掉**底部整周 ——
          用户反馈的"日历无法显示当月全部日期"（8 月只显示到 23 号）就是这么来的。
          宁可出现滚动条，也不能让日期凭空消失。 */}
      <div
        className="rounded-b-lg border border-t-0 overflow-x-hidden overflow-y-auto flex-1 flex flex-col min-h-0 kb-surface"
        style={{
          background: token.colorBgContainer,
          borderColor: token.colorBorderSecondary,
        }}
      >
        {/* 星期表头：sticky + flex-shrink-0 —— 网格改成可滚动后，表头必须钉住，
            否则往下滚就看不到"周一…周日"了；不加 shrink-0 还会在 flex column 里被压扁 */}
        <div
          className="grid grid-cols-7 text-xs font-semibold flex-shrink-0 sticky top-0 z-10"
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
        <div className="flex-1 flex flex-col min-h-0">
          {weeks.map((week, wi) => {
            const bars = weekBars[wi];
            const visible = bars.filter((b) => b.lane < MAX_LANES);
            // 超出跑道上限的条：按天累计，落到对应格子底部显示 "+N"
            const overflowByCol = new Array<number>(7).fill(0);
            for (const b of bars) {
              if (b.lane < MAX_LANES) continue;
              for (let c = b.startCol; c <= b.endCol; c += 1) overflowByCol[c] += 1;
            }
            return (
              <div
                key={week[0].format("YYYY-MM-DD")}
                className="relative flex-1 min-h-[104px]"
              >
                {/* 背景层：日期格 + 拖放目标 */}
                <div className="grid grid-cols-7 h-full">
                  {week.map((d, ci) => {
                    const ymd = d.format("YYYY-MM-DD");
                    const sameMonth = d.month() === anchor.month();
                    const isToday = ymd === todayYmd;
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
                        className="p-1.5 transition cursor-pointer flex flex-col"
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
                          style={{
                            color: sameMonth ? token.colorText : token.colorTextQuaternary,
                          }}
                        >
                          {d.date()}
                          {isToday && (
                            <span
                              className="text-[10px] leading-none px-1 py-0.5 rounded"
                              style={{ background: token.colorPrimary, color: "#fff" }}
                            >
                              今
                            </span>
                          )}
                        </div>
                        {overflowByCol[ci] > 0 && (
                          <div
                            className="text-[10px] mt-auto"
                            style={{ color: token.colorTextTertiary }}
                          >
                            +{overflowByCol[ci]}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* 条带层：绝对定位盖在格子上方。
                    整层 pointer-events:none，只有条本身可点；拖拽期间条也让位，
                    否则横条会挡住它压住那几天的 dragover/drop。 */}
                <div
                  className="absolute left-0 right-0"
                  style={{ top: 26, pointerEvents: "none" }}
                >
                  {visible.map((b) => {
                    const t = b.task;
                    // 已完成 / 已放弃都灰显：保留在日历上能看到"这段时间原本安排了什么"，
                    // 但不该继续用优先级/分类色抢视觉
                    const isDone = t.status === 1 || isAbandoned(t);
                    const color = resolveTaskColor(t, colorBy, categoryMap, token);
                    // 按分类配色时紧急度没法用颜色表达了，用左侧竖条加粗把它补回来
                    const barWidth = colorBy === "category" && t.priority === 0 ? 3 : 2;
                    const span = b.endCol - b.startCol + 1;
                    const r = taskRange(t);
                    const rangeText = r
                      ? r.from.isSame(r.to, "day")
                        ? r.from.format("M月D日")
                        : `${r.from.format("M月D日")} – ${r.to.format("M月D日")}`
                      : "";
                    return (
                      <Tooltip
                        key={t.id}
                        // 浮层禁掉指针事件：antd Tooltip 默认让浮层可交互（鼠标移上去
                        // 不消失），而它就弹在任务条正上方，实测会盖住任务条本身
                        // （截图可见浮层矩形与条重叠），挡到点击/拖拽的起手位置。
                        // 这个浮层纯展示，不需要交互，禁掉无副作用。
                        // ⚠️ 注意：这**不是**「拖不回未安排栏」的根因 —— 加了之后真机
                        // 复测仍然拖不回，那个问题另有原因，尚未定位。
                        styles={{ root: { pointerEvents: "none" } }}
                        title={
                          <div>
                            <div>
                              {t.title}
                              {rangeText ? ` · ${rangeText}` : ""}
                              {isDone ? "（已完成）" : ""}
                            </div>
                            {/* 创建 / 完成时间：数据一直都有，只是从没展示过。
                                放 Tooltip 里是零成本增量 —— 不占日历格子的宝贵空间，
                                想看时悬停即得。 */}
                            {taskTimeLines(t).map((line) => (
                              <div
                                key={line.label}
                                style={{ fontSize: 11, opacity: 0.75 }}
                              >
                                {line.label} {line.value}
                              </div>
                            ))}
                          </div>
                        }
                      >
                        <div
                          draggable={!isDone}
                          onDragStart={
                            isDone
                              ? undefined
                              : (e) => {
                                  e.stopPropagation();
                                  e.dataTransfer.effectAllowed = "move";
                                  e.dataTransfer.setData("text/plain", String(t.id));
                                  setDragging(true);
                                }
                          }
                          onDragEnd={() => setDragging(false)}
                          onClick={(e) => {
                            e.stopPropagation();
                            onEdit(t);
                          }}
                          className="absolute truncate px-1.5 rounded text-xs cursor-pointer transition hover:opacity-80"
                          style={{
                            left: `calc(${(b.startCol / 7) * 100}% + 3px)`,
                            width: `calc(${(span / 7) * 100}% - 6px)`,
                            top: b.lane * 21,
                            height: 19,
                            lineHeight: "19px",
                            pointerEvents: dragging ? "none" : "auto",
                            background: isDone
                              ? token.colorFillTertiary
                              : withAlpha(color, "1a"),
                            color: isDone ? token.colorTextTertiary : color,
                            // 跨周截断的一侧不画左竖条 / 不倒圆角，视觉上"还没结束"
                            borderLeft: b.continuesLeft
                              ? "none"
                              : `${barWidth}px solid ${
                                  isDone ? token.colorTextQuaternary : color
                                }`,
                            borderTopLeftRadius: b.continuesLeft ? 0 : 4,
                            borderBottomLeftRadius: b.continuesLeft ? 0 : 4,
                            borderTopRightRadius: b.continuesRight ? 0 : 4,
                            borderBottomRightRadius: b.continuesRight ? 0 : 4,
                            textDecoration: isDone ? "line-through" : "none",
                            opacity: isDone ? 0.75 : 1,
                          }}
                        >
                          {b.continuesLeft ? "◀ " : ""}
                          {t.title}
                          {b.continuesRight ? " ▶" : ""}
                        </div>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 未安排日期 抽屉
          🔴 flex-shrink-0 + 内部限高：抽屉原来既不禁止收缩也没有高度上限，任务一多
          flex-wrap 就换行把自己撑高，反过来挤掉上方日历的可用高度（用户反馈的
          "未安排日期栏超过两栏后日历显示不全"）。现在固定不参与压缩，内容超过约两行
          就自己滚动，日历高度不再受它影响。 */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDrop={handleDropOnInbox}
        className="rounded-lg border p-3 kb-surface flex-shrink-0"
        style={{
          background: token.colorBgContainer,
          borderColor: token.colorBorderSecondary,
        }}
      >
        <div className="flex items-center justify-between mb-2">
          <button
            type="button"
            onClick={() => setInboxCollapsed((v) => !v)}
            className="text-xs font-semibold flex items-center gap-1 border-0 bg-transparent cursor-pointer p-0"
            style={{ color: token.colorTextSecondary }}
            title={inboxCollapsed ? "展开未安排任务" : "收起未安排任务（腾出日历高度）"}
          >
            {inboxCollapsed ? (
              <ChevronRight size={13} />
            ) : (
              <ChevronDown size={13} />
            )}
            <Inbox size={13} />
            未安排日期 · {undated.length}
          </button>
          <span className="text-[10px]" style={{ color: token.colorTextTertiary }}>
            拖日历里的任务到这里清空日期；或把这里的任务拖到某一天
          </span>
        </div>
        {inboxCollapsed ? null : undated.length === 0 ? (
          <div className="text-[11px]" style={{ color: token.colorTextTertiary }}>
            暂无
          </div>
        ) : (
          <div
            className="flex flex-wrap gap-2 overflow-y-auto"
            style={{ maxHeight: INBOX_MAX_HEIGHT }}
          >
            {undated.map((t) => (
              <div
                key={t.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", String(t.id));
                  // 🔴 必须与日历里任务条的 onDragStart 保持一致地置 dragging。
                  // 漏掉它 → 条带层仍是 pointer-events:auto → 挡住下面日期格的
                  // dragover/drop → 从这里拖出的任务**只能落到空白日期**，落到
                  // 已有任务条的那天就没反应（用户反馈的"拖不动/时灵时不灵"）。
                  setDragging(true);
                }}
                onDragEnd={() => setDragging(false)}
                onClick={() => onEdit(t)}
                className="px-2 py-1 rounded border text-[11px] cursor-pointer transition hover:opacity-80"
                style={{
                  background: token.colorFillSecondary,
                  borderColor: token.colorBorderSecondary,
                  borderLeft: `2px solid ${resolveTaskColor(t, colorBy, categoryMap, token)}`,
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
