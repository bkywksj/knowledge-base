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
  onNew: (presetPriority?: TaskPriority) => void;
}

interface ColMeta {
  key: TaskPriority;
  title: string;
  bg: string;
  border: string;
  color: string;
}

export function KanbanView({ tasks, onRefresh, onEdit, onNew }: Props) {
  const { token } = antdTheme.useToken();
  const { message } = AntdApp.useApp();
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [hoverCol, setHoverCol] = useState<TaskPriority | null>(null);

  const cols: ColMeta[] = [
    {
      key: 0,
      title: "紧急",
      bg: token.colorErrorBg,
      border: token.colorErrorBorder,
      color: token.colorError,
    },
    {
      key: 1,
      title: "一般",
      bg: token.colorPrimaryBg,
      border: token.colorPrimaryBorder,
      color: token.colorPrimary,
    },
    {
      key: 2,
      title: "不急",
      bg: token.colorFillSecondary,
      border: token.colorBorderSecondary,
      color: token.colorTextSecondary,
    },
  ];

  // 只看未完成（已完成在列表视图查看）
  const activeTasks = tasks.filter((t) => t.status === 0);

  async function handleToggle(task: Task) {
    try {
      await taskApi.toggleStatus(task.id);
      onRefresh();
    } catch (e) {
      message.error(`操作失败: ${e}`);
    }
  }

  async function handleDrop(e: React.DragEvent, priority: TaskPriority) {
    e.preventDefault();
    setHoverCol(null);
    const idStr = e.dataTransfer.getData("text/plain");
    const id = Number(idStr);
    if (!id) return;
    const task = tasks.find((t) => t.id === id);
    if (!task || task.priority === priority) return;
    try {
      await taskApi.update(id, { priority });
      onRefresh();
    } catch (err) {
      message.error(`更改紧急度失败: ${err}`);
    }
  }

  return (
    <div className="grid grid-cols-3 gap-3">
      {cols.map((col) => {
        const colTasks = activeTasks.filter((t) => t.priority === col.key);
        const isHover = hoverCol === col.key;
        return (
          <div
            key={col.key}
            className="rounded-lg border flex flex-col"
            style={{
              background: col.bg,
              borderColor: isHover ? col.color : col.border,
              borderWidth: isHover ? 1.5 : 1,
              minHeight: 300,
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setHoverCol(col.key);
            }}
            onDragLeave={() => setHoverCol(null)}
            onDrop={(e) => handleDrop(e, col.key)}
          >
            <div
              className="flex items-center justify-between px-3 py-2"
              style={{ borderBottom: `1px solid ${col.border}` }}
            >
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <span
                  className="inline-block rounded-full"
                  style={{ width: 6, height: 6, background: col.color }}
                />
                <span style={{ color: col.color }}>{col.title}</span>
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
                onClick={() => onNew(col.key)}
                className="cursor-pointer transition hover:opacity-80"
                style={{ color: col.color }}
                title={`新建${col.title}任务`}
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
                  {isHover ? "松开鼠标把任务改为此紧急度" : "拖任务到此，或点 + 新建"}
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
