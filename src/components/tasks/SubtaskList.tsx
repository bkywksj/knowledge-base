import { useEffect, useRef, useState, useCallback } from "react";
import {
  App as AntdApp,
  Button,
  Checkbox,
  DatePicker,
  Input,
  Spin,
  theme as antdTheme,
} from "antd";
import type { InputRef } from "antd";
import { AlarmClock, Plus, Trash2 } from "lucide-react";
import dayjs, { type Dayjs } from "dayjs";
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
  /** 正在编辑标题的子任务 id（null = 无）。用户反馈"输入后只能删除不能修改"。 */
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingText, setEditingText] = useState("");
  /** 回车追加后保持焦点，用户可连续录入下一条（输入框全程不 disable，焦点不丢） */
  const inputRef = useRef<InputRef>(null);

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
    // 立即乐观清空：输入框马上空出来，焦点不丢，用户可直接连续录入下一条。
    // 同一文本的重复回车由"清空后 title 为空 → 上面的 return"天然挡掉，无需 disable。
    setDraft("");
    try {
      await taskApi.create({
        title,
        priority: 1,
        parent_task_id: parentTaskId,
      });
      const list = await taskApi.listSubtasks(parentTaskId);
      setItems(list);
      const done = list.filter((t) => t.status === 1).length;
      onChanged?.(done, list.length);
    } catch (e) {
      message.error(`添加失败：${e}`);
      // 失败且用户尚未输入新内容时，把刚才的文本还回去，避免丢字
      setDraft((cur) => cur || title);
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

  /**
   * 给子任务设 / 清截止时间。
   *
   * 子任务的时间就是"到点提醒我"（滴答清单同款语义），所以设时间时一并打开准时提醒
   * （remind_before_minutes=0）；清时间时把提醒一起清掉，不留"没有截止时间却挂着提醒"
   * 的孤儿状态。主任务那套「日期 + 提前多久提醒」两段式对子任务过重，这里刻意简化。
   */
  async function handleSetDue(id: number, v: Dayjs | null) {
    try {
      await taskApi.update(
        id,
        v
          ? {
              due_date: v.second(0).format("YYYY-MM-DD HH:mm:ss"),
              remind_before_minutes: 0,
            }
          : { clear_due_date: true, clear_remind_before_minutes: true },
      );
      await refresh();
    } catch (e) {
      message.error(`设置时间失败：${e}`);
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

  /** 进入标题编辑态（双击触发，见下方 span 的 onDoubleClick） */
  function startEdit(t: Task) {
    setEditingId(t.id);
    setEditingText(t.title);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingText("");
  }

  /**
   * 保存标题修改。
   *
   * 空标题视为「取消」而不是把子任务改成空白 —— 用户想删有专门的删除按钮，
   * 清空输入框多半是误操作。标题没变也直接退出，不发无谓的请求。
   */
  async function commitEdit() {
    if (editingId == null) return;
    const id = editingId;
    const next = editingText.trim();
    const original = items.find((t) => t.id === id);
    if (!next || !original || next === original.title) {
      cancelEdit();
      return;
    }
    // 乐观更新：先本地改掉，请求失败再回滚，避免输入框闪回旧值
    setItems((prev) => prev.map((t) => (t.id === id ? { ...t, title: next } : t)));
    cancelEdit();
    try {
      await taskApi.update(id, { title: next });
      await refresh();
    } catch (e) {
      setItems((prev) =>
        prev.map((t) => (t.id === id ? { ...t, title: original.title } : t)),
      );
      message.error(`修改失败：${e}`);
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
        <div className={compact ? "flex flex-col" : "flex flex-col gap-1"}>
          {items.map((t) => (
            <div
              key={t.id}
              className="flex items-center gap-2 group"
              style={
                compact
                  ? { padding: "1px 4px", borderRadius: 4 }
                  : {
                      padding: "4px 6px",
                      borderRadius: 4,
                      background: token.colorFillQuaternary,
                    }
              }
            >
              <Checkbox
                checked={t.status === 1}
                onChange={() => handleToggle(t.id)}
              />
              {editingId === t.id ? (
                <Input
                  className="flex-1"
                  size="small"
                  autoFocus
                  value={editingText}
                  onChange={(e) => setEditingText(e.target.value)}
                  onPressEnter={() => void commitEdit()}
                  // 失焦即保存：用户点到别处通常是"我改完了"，弹确认反而烦
                  onBlur={() => void commitEdit()}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      cancelEdit();
                    }
                  }}
                  style={{ fontSize: 13, minWidth: 0 }}
                />
              ) : (
                <span
                  className="flex-1"
                  // 🔴 用双击而不是单击：这个 span 特意保留了 userSelect:text，
                  // 单击进编辑会毁掉"鼠标划选复制超长内容"的能力（见下方样式注释）。
                  onDoubleClick={() => startEdit(t)}
                  style={{
                    fontSize: 13,
                    color:
                      t.status === 1
                        ? token.colorTextTertiary
                        : token.colorText,
                    textDecoration: t.status === 1 ? "line-through" : "none",
                    // 不再单行截断：自动换行完整显示，超长内容可见且可鼠标划选复制。
                    // minWidth:0 让 flex 子项能正常收缩换行而不是溢出；
                    // overflowWrap/wordBreak 处理无空格长串（URL 等）。
                    minWidth: 0,
                    whiteSpace: "normal",
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                    userSelect: "text",
                    cursor: "text",
                  }}
                  title={`${t.title}\n（双击可修改）`}
                >
                  {t.title}
                </span>
              )}
              {/* 时间：没设时只露一个小闹钟、hover 该行才显形，平时不打扰阅读；
                  设了就常驻显示 月-日 时:分，点开可改可清 */}
              <DatePicker
                value={t.due_date ? dayjs(t.due_date) : null}
                onChange={(v) => handleSetDue(t.id, v)}
                size="small"
                variant="borderless"
                format="MM-DD HH:mm"
                showTime={{ format: "HH:mm", minuteStep: 5 }}
                placeholder=""
                allowClear
                suffixIcon={<AlarmClock size={12} />}
                className={
                  t.due_date ? "" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
                }
                style={{ flex: "none", width: t.due_date ? 132 : 34 }}
                title={
                  t.due_date ? `到点提醒：${t.due_date}` : "设置时间（到点提醒）"
                }
              />
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
        ref={inputRef}
        size="small"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onPressEnter={handleAdd}
        placeholder="新增子任务（回车连续录入）"
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
      />
    </div>
  );
}
