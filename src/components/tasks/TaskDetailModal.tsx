import { Modal, Button, Tag, Typography, theme as antdTheme } from "antd";
import { Star, Edit3 } from "lucide-react";
import type { Task } from "@/types";
import { SubtaskList } from "./SubtaskList";

const { Text, Paragraph } = Typography;

const PRIORITY_LABEL: Record<number, string> = { 0: "高", 1: "中", 2: "低" };
const REPEAT_LABEL: Record<string, string> = {
  none: "不循环",
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
  yearly: "每年",
};

interface Props {
  /** 当前查看的任务；为 null 时 Modal 关闭 */
  task: Task | null;
  onClose: () => void;
  /** 点击「标记完成 / 重新开启」时触发，由父级负责切状态 + reload */
  onToggleStatus: (taskId: number) => void;
  /**
   * 子任务勾选/增删后回调（带最新 done/total）。
   * 父级用此局部 patch 列表中的 subtask_done/total，避免重拉造成闪烁。
   */
  onSubtaskChanged?: (taskId: number, done: number, total: number) => void;
  /**
   * 点击「编辑」按钮触发；父级负责打开 CreateTaskModal 编辑态。
   * 未传时不渲染编辑按钮。
   */
  onEdit?: (task: Task) => void;
}

/**
 * 任务详情 Modal（只读视图）
 * - 首页今日待办、/tasks 列表点击行均使用此组件
 * - 不提供编辑入口；编辑走 hover 操作 / 右键菜单 → CreateTaskModal
 * - 主任务才显示子任务区（task.parent_task_id 为 null 时）
 */
export function TaskDetailModal({
  task,
  onClose,
  onToggleStatus,
  onSubtaskChanged,
  onEdit,
}: Props) {
  const { token } = antdTheme.useToken();
  const isMain = task && task.parent_task_id == null;

  return (
    <Modal
      open={task !== null}
      onCancel={onClose}
      title="待办详情"
      footer={
        <div className="flex justify-between items-center gap-2">
          {/* 左侧：编辑入口（父级未传 onEdit 时省略，保持纯只读语义） */}
          <div>
            {onEdit && task && (
              <Button
                icon={<Edit3 size={13} />}
                onClick={() => {
                  const t = task;
                  onClose();
                  onEdit(t);
                }}
              >
                编辑
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button onClick={onClose}>关闭</Button>
            <Button
              type="primary"
              onClick={() => {
                if (task) {
                  onToggleStatus(task.id);
                }
                onClose();
              }}
            >
              {task?.status === 1 ? "重新开启" : "标记完成"}
            </Button>
          </div>
        </div>
      }
      width={520}
    >
      {task && (
        <div className="flex flex-col gap-3">
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              标题
            </Text>
            <div className="flex items-center gap-2 mt-1">
              <Text strong style={{ fontSize: 15 }}>
                {task.title}
              </Text>
              {task.important && (
                <Star
                  size={14}
                  style={{ color: token.colorWarning }}
                  fill={token.colorWarning}
                />
              )}
            </div>
          </div>

          <div className="flex gap-6">
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                优先级
              </Text>
              <div className="mt-1">
                <Tag
                  color={
                    task.priority === 0
                      ? "red"
                      : task.priority === 1
                        ? "blue"
                        : "default"
                  }
                >
                  {PRIORITY_LABEL[task.priority] ?? "—"}
                </Tag>
              </div>
            </div>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                状态
              </Text>
              <div className="mt-1">
                <Tag color={task.status === 0 ? "processing" : "success"}>
                  {task.status === 0 ? "未完成" : "已完成"}
                </Tag>
              </div>
            </div>
            {task.due_date && (
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  截止
                </Text>
                <div className="mt-1" style={{ fontSize: 13 }}>
                  {task.due_date}
                </div>
              </div>
            )}
            {task.repeat_kind && task.repeat_kind !== "none" && (
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  重复
                </Text>
                <div className="mt-1" style={{ fontSize: 13 }}>
                  每 {task.repeat_interval}{" "}
                  {REPEAT_LABEL[task.repeat_kind] ?? task.repeat_kind}
                </div>
              </div>
            )}
          </div>

          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              备注
            </Text>
            <Paragraph
              style={{
                marginTop: 4,
                marginBottom: 0,
                fontSize: 13,
                whiteSpace: "pre-wrap",
                color: task.description?.trim()
                  ? token.colorText
                  : token.colorTextQuaternary,
              }}
            >
              {task.description?.trim() || "暂无备注"}
            </Paragraph>
          </div>

          {/* 子任务（仅主任务显示） */}
          {isMain && (
            <div
              style={{
                marginTop: 4,
                paddingTop: 12,
                borderTop: `1px solid ${token.colorBorderSecondary}`,
              }}
            >
              <Text
                type="secondary"
                style={{ fontSize: 12, display: "block", marginBottom: 6 }}
              >
                子任务
                {task.subtask_total > 0 && (
                  <span style={{ color: token.colorTextTertiary, marginLeft: 6 }}>
                    {task.subtask_done}/{task.subtask_total} 已完成
                  </span>
                )}
              </Text>
              <SubtaskList
                parentTaskId={task.id}
                compact
                onChanged={(done, total) => {
                  onSubtaskChanged?.(task.id, done, total);
                }}
              />
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
