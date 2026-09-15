import { useEffect, useState } from "react";
import { App as AntdApp, Button, Modal, Tag, Tooltip, Typography } from "antd";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { taskApi } from "@/lib/api";
import { useAppStore } from "@/store";
import type { Task } from "@/types";
import { playNormalReminder } from "@/lib/audio/reminderSound";

const { Text, Paragraph } = Typography;

/**
 * 监听后端 `task:reminder` 事件，对每条到点任务弹应用内 Modal。
 * 放在 AntdApp 内部，整棵树只挂一次（见 App.tsx）。
 *
 * 行为说明：
 * - priority==0 紧急任务由后端直接打开「全屏接管窗口」处理，不会 emit 给主窗
 *   所以这里收到的都是 priority>=1 的强烈级，仅"叮"一声 + Modal
 * - 用户操作完成 / snooze / 结束循环后必须 bumpTasksListRefresh，
 *   否则任务列表页 / 看板 / 四象限不会重拉，看到的是陈旧数据
 */
export function TaskReminderListener() {
  const { message } = AntdApp.useApp();
  // 队列化：同一时刻可能多条任务到点，依次弹出
  const [queue, setQueue] = useState<Task[]>([]);
  const [acting, setActing] = useState(false);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<Task>("task:reminder", (e) => {
      setQueue((prev) => {
        if (prev.some((t) => t.id === e.payload.id)) return prev;
        // 强烈级提示：弹 Modal 时按用户设置响提示音（音色/音量/连响遍数见设置页
        // 「待办提醒 → 提醒提示音」；任务栏闪烁已由后端 request_user_attention 触发）。
        // 异步读配置，失败自己兜底成默认音，这里不 await 也不处理错误
        void playNormalReminder();
        return [...prev, e.payload];
      });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const current = queue[0] ?? null;
  const isRepeating = !!current && current.repeat_kind !== "none";

  function dismiss() {
    setQueue((prev) => prev.slice(1));
  }

  /** 通用：先做事 → 提示 → 刷新列表 → 弹下一条 */
  async function runAndDismiss(
    label: string,
    op: () => Promise<unknown>,
    successMsg: string,
  ) {
    if (!current || acting) return;
    setActing(true);
    try {
      await op();
      message.success(successMsg);
      // 关键：bump 任务列表刷新 + 重算紧急角标，避免列表显示陈旧状态
      const s = useAppStore.getState();
      s.bumpTasksListRefresh();
      void s.refreshTaskStats();
    } catch (e) {
      message.error(`${label}失败：${e}`);
    } finally {
      setActing(false);
      dismiss();
    }
  }

  const handleSnooze = (m: number) =>
    runAndDismiss(
      `推迟 ${formatMinutes(m)}`,
      () => taskApi.snooze(current!.id, m),
      `已推迟 ${formatMinutes(m)} 再提醒`,
    );

  const handleCompleteOccurrence = () =>
    runAndDismiss(
      "标记完成",
      () => taskApi.completeOccurrence(current!.id),
      isRepeating ? "已完成本次，已推进到下一次" : "已标记完成",
    );

  const handleEndSeries = () =>
    runAndDismiss(
      "结束循环",
      () => taskApi.toggleStatus(current!.id),
      "已结束整条循环",
    );

  return (
    <Modal
      open={!!current}
      title={
        <span>
          <span style={{ marginRight: 6 }}>⏰</span>待办提醒
        </span>
      }
      onCancel={dismiss}
      width={460}
      footer={
        <div className="flex flex-col gap-3">
          {/* 推迟提醒：左侧标签 + 三个时长按钮 */}
          <div className="flex items-center justify-between">
            <span style={{ fontSize: 12, color: "rgba(0,0,0,0.45)" }}>
              推迟提醒
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="small"
                disabled={acting}
                onClick={() => handleSnooze(5)}
              >
                5 分钟
              </Button>
              <Button
                size="small"
                disabled={acting}
                onClick={() => handleSnooze(15)}
              >
                15 分钟
              </Button>
              <Button
                size="small"
                disabled={acting}
                onClick={() => handleSnooze(60)}
              >
                1 小时
              </Button>
            </div>
          </div>

          {/* 主操作：知道了（关弹窗不动任务） + 结束循环（仅循环任务） + 标记完成 */}
          <div className="flex items-center justify-end gap-2">
            <Tooltip
              title="任务保留待办，本次提醒不再响。循环任务会按规则在下一次到点继续提醒。"
              placement="top"
            >
              <Button disabled={acting} onClick={dismiss}>
                知道了
              </Button>
            </Tooltip>
            {isRepeating && (
              <Button danger disabled={acting} onClick={handleEndSeries}>
                结束循环
              </Button>
            )}
            <Button
              type="primary"
              loading={acting}
              disabled={acting}
              onClick={handleCompleteOccurrence}
            >
              {isRepeating ? "完成本次" : "标记完成"}
            </Button>
          </div>
        </div>
      }
    >
      {current && (
        <div className="flex flex-col" style={{ gap: 10, paddingTop: 4 }}>
          {/* 标签行 */}
          <div className="flex flex-wrap items-center gap-2">
            {current.priority === 0 && (
              <Tag color="red" style={{ margin: 0 }}>
                紧急
              </Tag>
            )}
            {current.important && (
              <Tag color="gold" style={{ margin: 0 }}>
                重要
              </Tag>
            )}
            {isRepeating && (
              <Tag color="blue" style={{ margin: 0 }}>
                {describeRepeat(current)}
              </Tag>
            )}
          </div>

          {/* 标题 */}
          <Text strong style={{ fontSize: 17, lineHeight: 1.4 }}>
            {current.title}
          </Text>

          {/* 截止时间 */}
          {current.due_date && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              截止 {current.due_date}
            </Text>
          )}

          {/* 描述 */}
          {current.description && (
            <Paragraph
              type="secondary"
              style={{
                fontSize: 13,
                marginBottom: 0,
                whiteSpace: "pre-wrap",
                maxHeight: 140,
                overflowY: "auto",
              }}
            >
              {current.description}
            </Paragraph>
          )}

          {/* 队列尾巴提示 */}
          {queue.length > 1 && (
            <Text
              type="secondary"
              style={{ fontSize: 12, marginTop: 4, opacity: 0.7 }}
            >
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

const WEEKDAY_LABELS = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function describeRepeat(task: Task): string {
  const { repeat_kind, repeat_interval, repeat_weekdays } = task;
  if (repeat_kind === "none") return "";
  const iv = Math.max(1, repeat_interval);
  if (repeat_kind === "daily") return iv === 1 ? "每天" : `每 ${iv} 天`;
  if (repeat_kind === "monthly") return iv === 1 ? "每月" : `每 ${iv} 月`;
  if (repeat_weekdays) {
    const days = repeat_weekdays
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => n >= 1 && n <= 7)
      .sort((a, b) => a - b);
    if (days.length === 5 && days.join(",") === "1,2,3,4,5") return "工作日";
    return days.map((d) => WEEKDAY_LABELS[d]).join("/");
  }
  return iv === 1 ? "每周" : `每 ${iv} 周`;
}
