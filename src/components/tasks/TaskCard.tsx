import { Tooltip, theme as antdTheme } from "antd";
import { FileText, Folder as FolderIcon, Link as LinkIcon, Clock } from "lucide-react";
import type { Task } from "@/types";

interface Props {
  task: Task;
  onToggle: (t: Task) => void;
  onClick: (t: Task) => void;
  onDragStart?: (t: Task) => void;
  compact?: boolean;
}

/** 看板 / 日历 共用的任务卡片 */
export function TaskCard({ task, onToggle, onClick, onDragStart, compact }: Props) {
  const { token } = antdTheme.useToken();
  const done = task.status === 1;
  const priorityColor =
    task.priority === 0
      ? token.colorError
      : task.priority === 1
        ? token.colorPrimary
        : token.colorTextQuaternary;

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(task.id));
        onDragStart?.(task);
      }}
      onClick={() => onClick(task)}
      className="group rounded-md border p-2 cursor-pointer transition"
      style={{
        background: token.colorBgContainer,
        borderColor: token.colorBorderSecondary,
        borderLeft: `3px solid ${priorityColor}`,
        opacity: done ? 0.5 : 1,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = token.boxShadowTertiary;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = "none";
      }}
    >
      <div className="flex items-start gap-1.5">
        <Tooltip title={done ? "标记为未完成" : "标记为已完成"}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle(task);
            }}
            className="rounded-full shrink-0 cursor-pointer transition"
            style={{
              width: 14,
              height: 14,
              marginTop: 2,
              border: done
                ? `1.5px solid ${token.colorSuccess}`
                : `1.5px solid ${token.colorBorder}`,
              background: done ? token.colorSuccess : "transparent",
            }}
          />
        </Tooltip>
        <div className="flex-1 min-w-0">
          <div
            className="text-[12px] leading-snug"
            style={{
              textDecoration: done ? "line-through" : "none",
              color: done ? token.colorTextTertiary : token.colorText,
            }}
          >
            {task.title}
          </div>
          {!compact && task.due_date && (
            <div
              className="flex items-center gap-0.5 mt-1 text-[10px]"
              style={{ color: token.colorTextTertiary }}
            >
              <Clock size={10} />
              <span>
                {task.due_date.length > 10
                  ? `${task.due_date.slice(0, 10)} ${task.due_date.slice(11, 16)}`
                  : task.due_date}
              </span>
            </div>
          )}
          {task.links.length > 0 && !compact && (
            <div className="flex flex-wrap items-center gap-1 mt-1">
              {task.links.slice(0, 2).map((l) => {
                const Icon = l.kind === "note" ? FileText : l.kind === "path" ? FolderIcon : LinkIcon;
                return (
                  <span
                    key={l.id}
                    className="flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px]"
                    style={{
                      background: token.colorFillTertiary,
                      color: token.colorTextSecondary,
                    }}
                  >
                    <Icon size={9} />
                    <span className="truncate max-w-[120px]">{l.label || l.target}</span>
                  </span>
                );
              })}
              {task.links.length > 2 && (
                <span className="text-[10px]" style={{ color: token.colorTextTertiary }}>
                  +{task.links.length - 2}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
