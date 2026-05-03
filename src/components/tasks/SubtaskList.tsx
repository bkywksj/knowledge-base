import { useEffect, useState, useCallback } from "react";
import { App as AntdApp, Button, Checkbox, Input, Spin, theme as antdTheme } from "antd";
import { Plus, Trash2 } from "lucide-react";
import { taskApi } from "@/lib/api";
import type { Task } from "@/types";
import { MicButton } from "@/components/MicButton";

/**
 * 子任务列表组件——展示在主任务编辑弹窗的底部。
 *
 * 设计参考 Microsoft To Do 的 "steps"：
 * - 一层结构（不嵌套）
 * - 子任务只展示 title + 完成状态
 * - 主任务的 done 与子任务**独立**（不强制同步）
 * - 进度由父组件通过 `onChanged` 回调获知，自行刷新主列表
 */
interface Props {
  /** 主任务 ID（必传，组件只在编辑模式下渲染） */
  parentTaskId: number;
  /**
   * 子任务任何变更（增/删/勾选）后触发，**带最新 done/total**。
   * 父组件用此局部 patch 主任务的进度徽章，避免全量 reload 主列表造成闪烁。
   */
  onChanged?: (done: number, total: number) => void;
  /**
   * 紧凑模式：用在列表行内展开时——隐藏顶部"子任务 N/M"标题（行尾徽章已显示）、
   * 隐藏空状态提示文案、子任务行更紧凑。Modal 内默认 false 保持原样。
   */
  compact?: boolean;
}

export function SubtaskList({ parentTaskId, onChanged, compact = false }: Props) {
  const { message } = AntdApp.useApp();
  const { token } = antdTheme.useToken();
  const [items, setItems] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await taskApi.listSubtasks(parentTaskId);
      setItems(list);
    } catch (e) {
      message.error(`加载子任务失败：${e}`);
    } finally {
      setLoading(false);
    }
  }, [parentTaskId, message]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleAdd() {
    const title = draft.trim();
    if (!title) return;
    setAdding(true);
    try {
      await taskApi.create({
        title,
        priority: 1,
        parent_task_id: parentTaskId,
      });
      setDraft("");
      const list = await taskApi.listSubtasks(parentTaskId);
      setItems(list);
      const done = list.filter((t) => t.status === 1).length;
      onChanged?.(done, list.length);
    } catch (e) {
      message.error(`添加失败：${e}`);
    } finally {
      setAdding(false);
    }
  }

  async function handleToggle(id: number) {
    try {
      await taskApi.toggleStatus(id);
      const list = await taskApi.listSubtasks(parentTaskId);
      setItems(list);
      const done = list.filter((t) => t.status === 1).length;
      onChanged?.(done, list.length);
    } catch (e) {
      message.error(`切换状态失败：${e}`);
    }
  }

  async function handleDelete(id: number) {
    try {
      await taskApi.delete(id);
      const list = await taskApi.listSubtasks(parentTaskId);
      setItems(list);
      const done = list.filter((t) => t.status === 1).length;
      onChanged?.(done, list.length);
    } catch (e) {
      message.error(`删除失败：${e}`);
    }
  }

  const done = items.filter((t) => t.status === 1).length;
  const total = items.length;

  return (
    <div className={compact ? "flex flex-col gap-1" : "flex flex-col gap-2"}>
      {!compact && (
        <div
          className="flex items-center gap-2"
          style={{ fontSize: 11, color: token.colorTextSecondary }}
        >
          <span>子任务</span>
          {total > 0 && (
            <span style={{ color: token.colorTextTertiary }}>
              {done}/{total} 已完成
            </span>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-1">
          <Spin size="small" />
        </div>
      ) : items.length === 0 ? (
        compact ? null : (
          <div
            className="text-[12px] py-1"
            style={{ color: token.colorTextQuaternary }}
          >
            暂无子任务，添加几步把它拆细
          </div>
        )
      ) : (
        <div className="flex flex-col gap-1">
          {items.map((t) => (
            <div
              key={t.id}
              className="flex items-center gap-2 group"
              style={{
                padding: "4px 6px",
                borderRadius: 4,
                background: token.colorFillQuaternary,
              }}
            >
              <Checkbox
                checked={t.status === 1}
                onChange={() => handleToggle(t.id)}
              />
              <span
                className="flex-1 truncate"
                style={{
                  fontSize: 13,
                  color:
                    t.status === 1
                      ? token.colorTextTertiary
                      : token.colorText,
                  textDecoration: t.status === 1 ? "line-through" : "none",
                }}
                title={t.title}
              >
                {t.title}
              </span>
              <Button
                type="text"
                size="small"
                icon={<Trash2 size={12} />}
                onClick={() => handleDelete(t.id)}
                className="opacity-0 group-hover:opacity-100"
                style={{ color: token.colorTextTertiary }}
              />
            </div>
          ))}
        </div>
      )}

      <Input
        size="small"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onPressEnter={handleAdd}
        placeholder="+ 新增子任务（回车确认）"
        prefix={<Plus size={12} style={{ color: token.colorTextTertiary }} />}
        allowClear
        suffix={
          <MicButton
            stripTrailingPunctuation
            onTranscribed={(text) =>
              setDraft((prev) => (prev ? `${prev} ${text}` : text))
            }
          />
        }
        disabled={adding}
      />
    </div>
  );
}
