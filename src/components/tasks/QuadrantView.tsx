import { useState } from "react";
import { theme as antdTheme, App as AntdApp } from "antd";
import { Plus } from "lucide-react";
import type { Task, TaskPriority } from "@/types";
import { taskApi } from "@/lib/api";
import { TaskCard } from "./TaskCard";

interface Props {
  tasks: Task[];
  onRefresh: () => void;
  onEdit: (t: Task) => void;
  /** 新建任务：象限隐含 priority + important 预设 */
  onNew: (preset: { priority: TaskPriority; important: boolean }) => void;
}

type Quadrant = 1 | 2 | 3 | 4;

interface QuadMeta {
  key: Quadrant;
  title: string;
  hint: string;
  bg: string;
  border: string;
  color: string;
  /** 落到此象限时强制的 priority + important */
  presetPriority: TaskPriority;
  presetImportant: boolean;
}

/** 由 priority + important 推导四象限 */
function getQuadrant(t: Task): Quadrant {
  const urgent = t.priority === 0;
  if (urgent && t.important) return 1;
  if (!urgent && t.important) return 2;
  if (urgent && !t.important) return 3;
  return 4;
}

export function QuadrantView({ tasks, onRefresh, onEdit, onNew }: Props) {
  const { token } = antdTheme.useToken();
  const { message } = AntdApp.useApp();
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [hoverQ, setHoverQ] = useState<Quadrant | null>(null);

  const quads: QuadMeta[] = [
    {
      key: 1,
      title: "立即做",
      hint: "重要 · 紧急",
      bg: token.colorErrorBg,
      border: token.colorErrorBorder,
      color: token.colorError,
      presetPriority: 0,
      presetImportant: true,
    },
    {
      key: 2,
      title: "计划做",
      hint: "重要 · 不紧急",
      bg: token.colorWarningBg,
      border: token.colorWarningBorder,
      color: token.colorWarning,
      presetPriority: 1,
      presetImportant: true,
    },
    {
      key: 3,
      title: "委派 / 赶做",
      hint: "不重要 · 紧急",
      bg: token.colorPrimaryBg,
      border: token.colorPrimaryBorder,
      color: token.colorPrimary,
      presetPriority: 0,
      presetImportant: false,
    },
    {
      key: 4,
      title: "可删 / 延后",
      hint: "不重要 · 不紧急",
      bg: token.colorFillSecondary,
      border: token.colorBorderSecondary,
      color: token.colorTextSecondary,
      presetPriority: 1,
      presetImportant: false,
    },
  ];

  // 仅未完成
  const activeTasks = tasks.filter((t) => t.status === 0);

  async function handleToggle(task: Task) {
    try {
      if (task.status === 0 && task.repeat_kind !== "none") {
        await taskApi.completeOccurrence(task.id);
      } else {
        await taskApi.toggleStatus(task.id);
      }
      onRefresh();
    } catch (e) {
      message.error(`操作失败: ${e}`);
    }
  }

  async function handleDrop(e: React.DragEvent, q: QuadMeta) {
    e.preventDefault();
    setHoverQ(null);
    const idStr = e.dataTransfer.getData("text/plain");
    const id = Number(idStr);
    if (!id) return;
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    const targetUrgent = q.presetPriority === 0;
    const currentQuadrant = getQuadrant(task);
    if (currentQuadrant === q.key) return;
    // 紧急维度从 priority 推导：拖到紧急列 → priority=0；拖到不紧急列 → 若原本是 0，
    // 提升为 1（一般），否则保留原值（一般/不急）。
    const nextPriority: TaskPriority = targetUrgent
      ? 0
      : task.priority === 0
        ? 1
        : task.priority;
    try {
      await taskApi.update(id, {
        priority: nextPriority,
        important: q.presetImportant,
      });
      onRefresh();
    } catch (err) {
      message.error(`更改象限失败: ${err}`);
    }
  }

  return (
    <div className="grid grid-cols-2 grid-rows-2 gap-3" style={{ minHeight: 540 }}>
      {quads.map((q) => {
        const colTasks = activeTasks.filter((t) => getQuadrant(t) === q.key);
        const isHover = hoverQ === q.key;
        return (
          <div
            key={q.key}
            className="rounded-lg border flex flex-col"
            style={{
              background: q.bg,
              borderColor: isHover ? q.color : q.border,
              borderWidth: isHover ? 1.5 : 1,
              minHeight: 260,
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setHoverQ(q.key);
            }}
            onDragLeave={() => setHoverQ(null)}
            onDrop={(e) => handleDrop(e, q)}
          >
            <div
              className="flex items-center justify-between px-3 py-2"
              style={{ borderBottom: `1px solid ${q.border}` }}
            >
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <span
                  className="inline-flex items-center justify-center rounded-full text-[10px] font-bold"
                  style={{
                    width: 16,
                    height: 16,
                    background: q.color,
                    color: "#fff",
                  }}
                >
                  {q.key}
                </span>
                <span style={{ color: q.color }}>{q.title}</span>
                <span
                  className="text-[10px]"
                  style={{ color: token.colorTextTertiary, fontWeight: 400 }}
                >
                  · {q.hint}
                </span>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{
                    background: token.colorBgContainer,
                    color: token.colorTextSecondary,
                  }}
                >
                  {colTasks.length}
                </span>
              </div>
              <button
                onClick={() =>
                  onNew({
                    priority: q.presetPriority,
                    important: q.presetImportant,
                  })
                }
                className="cursor-pointer transition hover:opacity-80"
                style={{ color: q.color }}
                title={`新建「${q.title}」任务`}
              >
                <Plus size={14} />
              </button>
            </div>
            <div className="p-2 flex flex-col gap-2 overflow-y-auto flex-1">
              {colTasks.length === 0 ? (
                <div
                  className="flex items-center justify-center py-6 text-[11px] rounded border border-dashed"
                  style={{
                    borderColor: token.colorBorderSecondary,
                    color: token.colorTextTertiary,
                  }}
                >
                  {isHover
                    ? `松开把任务移到「${q.title}」`
                    : "拖任务到此，或点 + 新建"}
                </div>
              ) : (
                colTasks.map((t) => (
                  <div
                    key={t.id}
                    style={{
                      opacity: draggingId === t.id ? 0.4 : 1,
                      transition: "opacity .12s",
                    }}
                  >
                    <TaskCard
                      task={t}
                      onToggle={handleToggle}
                      onClick={onEdit}
                      onDragStart={(task) => setDraggingId(task.id)}
                    />
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
