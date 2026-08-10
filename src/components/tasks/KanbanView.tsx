import { useEffect, useState } from "react";
import { theme as antdTheme, App as AntdApp, Segmented } from "antd";
import { Plus } from "lucide-react";
import type { KanbanStage, Task, TaskPriority } from "@/types";
import { taskApi } from "@/lib/api";
import { TaskCard } from "./TaskCard";

interface Props {
  tasks: Task[];
  onRefresh: () => void;
  onEdit: (t: Task) => void;
  onNew: (presetPriority?: TaskPriority) => void;
}

/**
 * 看板视图。
 *
 * v1.11 起支持两种分列模式（顶部 Segmented 切换，localStorage 记住偏好）：
 * - `workflow`（默认）：按工作流阶段（待办/进行中/已完成）分列 —— 经典 Trello 风格
 *   拖到 `done` 列会同步标记 status=1，反之拖回 `todo`/`doing` 取消完成状态
 * - `priority`：按紧急度（紧急/一般/不急）分列 —— 用于一次性分流大批待办
 *
 * 两种模式共用一套拖拽事件：拖卡片到列头部即可改变归属，不支持列内排序
 *（保持简单 — 列内按 `updated_at DESC` 自然排）。
 */
type KanbanMode = "workflow" | "priority";

const MODE_STORAGE_KEY = "tasks.kanbanMode";

interface WorkflowCol {
  key: KanbanStage;
  title: string;
  bg: string;
  border: string;
  color: string;
}

interface PriorityCol {
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
  const [hoverCol, setHoverCol] = useState<string | null>(null);
  const [mode, setMode] = useState<KanbanMode>(() => {
    const raw = localStorage.getItem(MODE_STORAGE_KEY);
    return raw === "priority" ? "priority" : "workflow";
  });

  useEffect(() => {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
  }, [mode]);

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

  /** 通用 drop：根据当前 mode 决定调哪个 API */
  async function handleDrop(e: React.DragEvent, target: string) {
    e.preventDefault();
    setHoverCol(null);
    const idStr = e.dataTransfer.getData("text/plain");
    const id = Number(idStr);
    if (!id) return;
    const task = tasks.find((t) => t.id === id);
    if (!task) return;

    try {
      if (mode === "workflow") {
        if (task.kanban_stage === target) return;
        await taskApi.setKanbanStage(id, target as KanbanStage);
      } else {
        const priority = Number(target) as TaskPriority;
        if (task.priority === priority) return;
        await taskApi.update(id, { priority });
      }
      onRefresh();
    } catch (err) {
      message.error(`移动失败: ${err}`);
    }
  }

  const modeSwitcher = (
    <div className="flex justify-end mb-2">
      <Segmented
        size="small"
        value={mode}
        onChange={(v) => setMode(v as KanbanMode)}
        options={[
          { label: "工作流", value: "workflow" },
          { label: "紧急度", value: "priority" },
        ]}
      />
    </div>
  );

  if (mode === "workflow") {
    const cols: WorkflowCol[] = [
      {
        key: "todo",
        title: "待办",
        bg: token.colorFillSecondary,
        border: token.colorBorderSecondary,
        color: token.colorTextSecondary,
      },
      {
        key: "doing",
        title: "进行中",
        bg: token.colorPrimaryBg,
        border: token.colorPrimaryBorder,
        color: token.colorPrimary,
      },
      {
        key: "done",
        title: "已完成",
        bg: token.colorSuccessBg,
        border: token.colorSuccessBorder,
        color: token.colorSuccess,
      },
    ];
    return (
      <div>
        {modeSwitcher}
        <div className="grid grid-cols-3 gap-3">
          {cols.map((col) => {
            const colTasks = tasks.filter((t) => t.kanban_stage === col.key);
            const isHover = hoverCol === col.key;
            return (
              <div
                key={col.key}
                className="rounded-lg border flex flex-col kb-surface-tint"
                style={{
                  background: col.bg,
                  // 自定义背景图下由 .kb-surface-tint 读这个变量，把列的语义色
                  // 按全局面板不透明度稀释（而不是抹成中性灰，见 themes.css）
                  ["--kb-tint" as string]: col.bg,
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
                  {/* 新建按钮：仅在 todo / doing 列显示——把任务直接建进 done 列没意义 */}
                  {col.key !== "done" && (
                    <button
                      onClick={() => onNew()}
                      className="cursor-pointer transition hover:opacity-80"
                      style={{ color: col.color }}
                      title="新建任务"
                    >
                      <Plus size={14} />
                    </button>
                  )}
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
                        ? `松开鼠标移入「${col.title}」`
                        : col.key === "todo"
                          ? "拖任务到此，或点 + 新建"
                          : col.key === "doing"
                            ? "拖任务到此开始处理"
                            : "完成的任务会移入此列"}
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
      </div>
    );
  }

  // priority 模式（v1.10 之前的行为，保留兼容）
  const cols: PriorityCol[] = [
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
  const activeTasks = tasks.filter((t) => t.status === 0);
  return (
    <div>
      {modeSwitcher}
      <div className="grid grid-cols-3 gap-3">
        {cols.map((col) => {
          const colTasks = activeTasks.filter((t) => t.priority === col.key);
          const isHover = hoverCol === String(col.key);
          return (
            <div
              key={col.key}
              className="rounded-lg border flex flex-col kb-surface-tint"
              style={{
                background: col.bg,
                ["--kb-tint" as string]: col.bg,
                borderColor: isHover ? col.color : col.border,
                borderWidth: isHover ? 1.5 : 1,
                minHeight: 300,
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setHoverCol(String(col.key));
              }}
              onDragLeave={() => setHoverCol(null)}
              onDrop={(e) => handleDrop(e, String(col.key))}
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
    </div>
  );
}
