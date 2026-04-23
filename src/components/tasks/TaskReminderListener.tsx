import { useEffect, useState } from "react";
import { App as AntdApp, Button, Modal, Space, Tag, Typography } from "antd";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { taskApi } from "@/lib/api";
import type { Task } from "@/types";

const { Text, Paragraph } = Typography;

/**
 * 监听后端 `task:reminder` 事件，对每条到点任务弹应用内 Modal。
 *
 * 放在 AntdApp 内部，整棵树只挂一次（见 App.tsx）。
 */
export function TaskReminderListener() {
  const { message } = AntdApp.useApp();
  // 队列化：同一时刻可能多条任务到点，依次弹出
  const [queue, setQueue] = useState<Task[]>([]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    // 后端 reminded_at 已保证不会重复 emit 同一个提醒周期，前端直接入队即可。
    // snooze 会把 reminded_at 清空，下一轮到点仍会重新入队弹窗。
    listen<Task>("task:reminder", (e) => {
      setQueue((prev) =>
        // 防御性兜底：若当前队列里已排着同一 id，就不重复塞
        prev.some((t) => t.id === e.payload.id) ? prev : [...prev, e.payload],
      );
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const current = queue[0] ?? null;

  function dismiss() {
    setQueue((prev) => prev.slice(1));
  }

  async function handleSnooze(minutes: number) {
    if (!current) return;
    try {
      await taskApi.snooze(current.id, minutes);
      message.success(`已推迟 ${formatMinutes(minutes)} 再提醒`);
    } catch (e) {
      message.error(`推迟失败: ${e}`);
    } finally {
      dismiss();
    }
  }

  async function handleComplete() {
    if (!current) return;
    try {
      await taskApi.toggleStatus(current.id);
      message.success("已标记完成");
    } catch (e) {
      message.error(`操作失败: ${e}`);
    } finally {
      dismiss();
    }
  }

  return (
    <Modal
      open={!!current}
      title="⏰ 待办提醒"
      onCancel={dismiss}
      width={440}
      footer={
        <div className="flex items-center justify-between">
          <Space size="small">
            <Button size="small" onClick={() => handleSnooze(5)}>
              5 分钟后
            </Button>
            <Button size="small" onClick={() => handleSnooze(15)}>
              15 分钟后
            </Button>
            <Button size="small" onClick={() => handleSnooze(60)}>
              1 小时后
            </Button>
          </Space>
          <Space>
            <Button onClick={dismiss}>知道了</Button>
            <Button type="primary" onClick={handleComplete}>
              标记完成
            </Button>
          </Space>
        </div>
      }
    >
      {current && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Text strong style={{ fontSize: 16 }}>
              {current.title}
            </Text>
            {current.priority === 0 && <Tag color="red">紧急</Tag>}
            {current.important && <Tag color="gold">重要</Tag>}
          </div>
          {current.due_date && (
            <Text type="secondary" style={{ fontSize: 13 }}>
              截止 {current.due_date}
            </Text>
          )}
          {current.description && (
            <Paragraph
              type="secondary"
              style={{ fontSize: 13, marginBottom: 0, whiteSpace: "pre-wrap" }}
            >
              {current.description}
            </Paragraph>
          )}
          {queue.length > 1 && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              还有 {queue.length - 1} 条待提醒
            </Text>
          )}
        </div>
      )}
    </Modal>
  );
}

function formatMinutes(m: number): string {
  if (m < 60) return `${m} 分钟`;
  if (m < 1440) return `${Math.round(m / 60)} 小时`;
  return `${Math.round(m / 1440)} 天`;
}
