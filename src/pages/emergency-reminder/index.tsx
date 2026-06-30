import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Button, Spin, Tag } from "antd";
import { AlertOctagon, Bell, BellOff, Check, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { taskApi } from "@/lib/api";
import type { Task } from "@/types";
import { startBeepLoop } from "@/lib/audio/beep";

/** 紧急提醒响铃封顶时长：5 分钟。到点自动停声，但弹窗仍保留显示。 */
const MAX_BEEP_MS = 5 * 60 * 1000;

/**
 * 紧急待办「置顶弹窗」承载页面（参考 Outlook 会议提醒交互）。
 *
 * 关键设计点：
 * - 布局：560×380 中型窗，顶部窄拖动条 + 中间内容 + 底部操作栏
 * - 主题：用主窗共用的 CSS 变量（`var(--kb-bg-...)`），保持视觉一致；
 *   紧急感靠左侧红色边条 + 红 Tag + 红色"逾期"提示，而不是整窗压暗
 * - drag region：仅顶部窄条；操作按钮全部显式 `data-tauri-drag-region={false}`，
 *   否则点 SVG 图标会被父级 drag-region 拦截当作"拖动起手"
 * - acting state：try/catch/finally 总是复位，避免关窗失败时按钮永久卡 disabled
 * - lib.rs `on_window_event` 已对 emergency-* 跳过 prevent_close，所以这里
 *   `getCurrentWindow().close()` 直接关，不会触发主窗的"关闭/最小化"弹窗
 */
export default function EmergencyReminderPage() {
  const { id } = useParams<{ id: string }>();
  const taskId = id ? Number(id) : NaN;
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  // 响铃超过封顶时长后自动停声（窗口仍保留）。与 muted（用户手动静音）区分。
  const [soundStopped, setSoundStopped] = useState(false);
  const [acting, setActing] = useState(false);
  const stopBeepRef = useRef<(() => void) | null>(null);

  // 拉任务详情
  useEffect(() => {
    if (!Number.isFinite(taskId)) {
      setErrorText("无效的任务 ID");
      setLoading(false);
      return;
    }
    let cancelled = false;
    taskApi
      .get(taskId)
      .then((t) => {
        if (cancelled) return;
        setTask(t);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setErrorText(String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  // 启动循环铃（任务加载后再响）。响铃最长 MAX_BEEP_MS（5 分钟），到点自动停声，
  // 但窗口仍保留显示——避免声音无限循环吵人。
  useEffect(() => {
    if (!task || muted || soundStopped) return;
    const stop = startBeepLoop(1500, MAX_BEEP_MS, () => setSoundStopped(true));
    stopBeepRef.current = stop;
    return () => {
      stop();
      stopBeepRef.current = null;
    };
  }, [task, muted, soundStopped]);

  useEffect(() => {
    return () => {
      stopBeepRef.current?.();
    };
  }, []);

  async function closeSelf() {
    stopBeepRef.current?.();
    try {
      await getCurrentWindow().close();
    } catch (e) {
      console.error("[emergency-reminder] window close failed:", e);
      setErrorText(`关闭窗口失败：${e}`);
    }
  }

  // ESC 关窗
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        void closeSelf();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 通用「先做事 → 关窗」包装：finally 总是复位 acting，关窗失败也不卡死
  async function runAndClose(label: string, op: () => Promise<unknown>) {
    if (!task || acting) return;
    setActing(true);
    setErrorText(null);
    try {
      await op();
      // 紧急窗与主窗是不同 webview，Zustand store 各自一份，但 main 窗的 store
      // 监听不到这里的 set —— 改走全局 Tauri 事件让主窗自己 bump tick
      const { emit } = await import("@tauri-apps/api/event");
      await emit("tasks:list-refresh", null);
      await closeSelf();
    } catch (e) {
      console.error(`[emergency-reminder] ${label} failed:`, e);
      setErrorText(`${label}失败：${e}`);
    } finally {
      setActing(false);
    }
  }

  const handleSnooze = (m: number) =>
    runAndClose(`推迟 ${formatMinutes(m)}`, () => taskApi.snooze(task!.id, m));
  const handleComplete = () =>
    runAndClose("标记完成", () => taskApi.completeOccurrence(task!.id));
  const handleEndSeries = () =>
    runAndClose("结束循环", () => taskApi.toggleStatus(task!.id));

  const isRepeating = !!task && task.repeat_kind !== "none";

  const overdueText = useMemo(() => {
    if (!task?.due_date) return null;
    const dueMs = parseDueMs(task.due_date);
    if (Number.isNaN(dueMs)) return null;
    const diffMin = Math.round((Date.now() - dueMs) / 60000);
    if (diffMin > 0) return `已逾期 ${formatMinutes(diffMin)}`;
    if (diffMin > -60) return `${Math.abs(diffMin)} 分钟内到期`;
    return null;
  }, [task]);

  return (
    <div
      className="flex h-screen w-screen flex-col"
      style={{
        // 用主窗共用的主题变量，保持视觉一致
        background: "var(--kb-bg-app, #f5f3fa)",
        color: "var(--kb-text-primary, #1e1b4b)",
        userSelect: "none",
        overflow: "hidden",
        // 左侧红色细条 + 整窗红色边框，标识"紧急"
        borderLeft: "4px solid #ef4444",
        boxSizing: "border-box",
      }}
    >
      {/* 标题栏：唯一的拖动区 */}
      <div
        data-tauri-drag-region
        className="flex items-center justify-between"
        style={{
          height: 36,
          padding: "0 8px 0 12px",
          background: "var(--kb-bg-header, rgba(255,255,255,0.6))",
          borderBottom: "1px solid var(--kb-border, rgba(0,0,0,0.06))",
          flexShrink: 0,
        }}
      >
        <div
          data-tauri-drag-region
          className="flex items-center gap-2"
          style={{ color: "#dc2626", fontSize: 12, fontWeight: 600 }}
        >
          <AlertOctagon size={14} />
          <span data-tauri-drag-region>紧急待办提醒</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            data-tauri-drag-region={false}
            onClick={() => {
              // 静音中 / 已自动停声 → 点击恢复响铃；正在响 → 点击静音
              if (muted || soundStopped) {
                setMuted(false);
                setSoundStopped(false);
              } else {
                setMuted(true);
              }
            }}
            title={
              soundStopped
                ? "响铃已超过 5 分钟自动停止，点击重新响铃"
                : muted
                  ? "恢复响铃"
                  : "静音"
            }
            style={titleBtnStyle}
          >
            {muted || soundStopped ? <BellOff size={14} /> : <Bell size={14} />}
          </button>
          <button
            data-tauri-drag-region={false}
            onClick={closeSelf}
            title="关闭 (ESC)"
            style={titleBtnStyle}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* 内容区 */}
      <div
        className="flex flex-1 flex-col gap-3"
        style={{ padding: "16px 20px", overflow: "auto" }}
      >
        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <Spin />
          </div>
        ) : !task ? (
          <div style={{ color: "#dc2626", fontSize: 14 }}>
            {errorText || "加载失败"}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Tag color="red" style={{ margin: 0 }}>
                紧急
              </Tag>
              {task.important && (
                <Tag color="gold" style={{ margin: 0 }}>
                  重要
                </Tag>
              )}
              {isRepeating && (
                <Tag color="blue" style={{ margin: 0 }}>
                  {describeRepeat(task)}
                </Tag>
              )}
              {overdueText && (
                <span style={{ fontSize: 12, color: "#dc2626", fontWeight: 600 }}>
                  {overdueText}
                </span>
              )}
            </div>

            <div
              style={{
                fontSize: 22,
                lineHeight: 1.3,
                fontWeight: 700,
              }}
            >
              {task.title}
            </div>

            {task.due_date && (
              <div
                style={{
                  fontSize: 12,
                  color: "var(--kb-text-secondary, #6b7280)",
                }}
              >
                截止 {task.due_date}
              </div>
            )}

            {task.description && (
              <div
                style={{
                  fontSize: 13,
                  color: "var(--kb-text-secondary, #4b5563)",
                  whiteSpace: "pre-wrap",
                  maxHeight: 110,
                  overflowY: "auto",
                  paddingRight: 4,
                }}
              >
                {task.description}
              </div>
            )}

            {errorText && (
              <div style={{ fontSize: 12, color: "#dc2626" }}>{errorText}</div>
            )}
          </>
        )}
      </div>

      {/* 操作区 */}
      <div
        className="flex flex-col gap-2"
        style={{
          padding: "10px 16px 12px",
          background: "var(--kb-bg-header, rgba(255,255,255,0.6))",
          borderTop: "1px solid var(--kb-border, rgba(0,0,0,0.06))",
          flexShrink: 0,
        }}
      >
        {/* 推迟提醒 */}
        <div className="flex items-center justify-between gap-2">
          <span
            style={{
              fontSize: 12,
              color: "var(--kb-text-tertiary, #6b7280)",
              flexShrink: 0,
            }}
          >
            推迟提醒
          </span>
          <div className="flex items-center gap-1">
            <Button
              data-tauri-drag-region={false}
              size="small"
              disabled={!task || acting}
              onClick={() => handleSnooze(5)}
            >
              5 分钟
            </Button>
            <Button
              data-tauri-drag-region={false}
              size="small"
              disabled={!task || acting}
              onClick={() => handleSnooze(15)}
            >
              15 分钟
            </Button>
            <Button
              data-tauri-drag-region={false}
              size="small"
              disabled={!task || acting}
              onClick={() => handleSnooze(60)}
            >
              1 小时
            </Button>
          </div>
        </div>

        {/* 主操作 */}
        <div className="flex items-center justify-end gap-2">
          {/* 知道了：仅关窗 + 停铃，任务保留待办、本次不再响（与主窗 Modal 语义一致） */}
          <Button
            data-tauri-drag-region={false}
            disabled={acting}
            onClick={closeSelf}
            title="任务保留待办，本次提醒不再响（=ESC / 关闭按钮）"
          >
            知道了
          </Button>
          {isRepeating && (
            <Button
              data-tauri-drag-region={false}
              size="small"
              danger
              disabled={!task || acting}
              onClick={handleEndSeries}
            >
              结束循环
            </Button>
          )}
          <Button
            data-tauri-drag-region={false}
            type="primary"
            disabled={!task || acting}
            loading={acting}
            icon={<Check size={14} />}
            onClick={handleComplete}
          >
            {isRepeating ? "完成本次" : "标记完成"}
          </Button>
        </div>
      </div>
    </div>
  );
}

const titleBtnStyle: React.CSSProperties = {
  width: 26,
  height: 26,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 4,
  background: "transparent",
  color: "var(--kb-text-secondary, #6b7280)",
  border: "none",
  cursor: "pointer",
};

function parseDueMs(due: string): number {
  const compact = due.length === 10 ? `${due} 23:59:59` : due;
  return new Date(compact.replace(" ", "T")).getTime();
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
