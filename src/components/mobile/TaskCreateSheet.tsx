import { useEffect, useRef, useState } from "react";
import { message } from "antd";
import { taskApi } from "@/lib/api";
import type { TaskPriority } from "@/types";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";

/**
 * 移动端「新建待办」底部面板。
 *
 * 背景：移动端待办列表此前完全没有新建入口 —— 全局 FAB 跳 /quick-create，
 * 而 /quick-create 的「新建任务」又跳回 /tasks，兜一圈回到没有加号的页面，
 * 手机上等于无法建待办（新增只能在桌面端的 Modal 里做）。
 *
 * 设计取舍：只放「标题 + 截止 + 优先级」三项——手机上建待办是"随手记一条"，
 * 字段越多越劝退；分类 / 提醒 / 重复 / 子任务留给建完后进详情页（/task-detail/:id）补。
 *
 * 交互与 `@/components/mobile/ActionSheet` 一脉相承：底部滑出、遮罩点击关闭、
 * 适配安全区；额外用 `useKeyboardInset` 让面板顶在软键盘之上（标题 input 会拉起键盘）。
 */

type DuePreset = "none" | "today" | "tomorrow" | "weekend";

const DUE_PRESETS: { key: DuePreset; label: string }[] = [
  { key: "none", label: "不设" },
  { key: "today", label: "今天" },
  { key: "tomorrow", label: "明天" },
  { key: "weekend", label: "本周末" },
];

/** 选中色走主题令牌（v4）：紧急 = 红、普通 = 主色、低 = 中性 */
const PRIORITIES: { value: TaskPriority; label: string; bg: string; fg: string }[] = [
  { value: 0, label: "紧急", bg: "var(--m-bad-soft)", fg: "var(--m-bad)" },
  { value: 1, label: "普通", bg: "var(--m-accent-soft2)", fg: "var(--m-accent-ink)" },
  { value: 2, label: "低", bg: "var(--m-well)", fg: "var(--m-ink)" },
];

/**
 * Date → SQLite 友好的 'YYYY-MM-DD HH:MM:SS'。
 * 刻意不用 toISOString()：那会转成 UTC，东八区下"今天 23:59"会漂成明天，
 * 造成刚建的任务不落在"今日"分组里。
 */
function toSqliteDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** 快捷截止 → due_date 字符串；"不设"返回 null */
function presetToDueDate(preset: DuePreset): string | null {
  if (preset === "none") return null;
  const d = new Date();
  if (preset === "tomorrow") d.setDate(d.getDate() + 1);
  if (preset === "weekend") {
    // 本周日为周末终点（getDay: 0=周日）；今天就是周日则仍取今天
    const day = d.getDay();
    d.setDate(d.getDate() + (day === 0 ? 0 : 7 - day));
  }
  d.setHours(23, 59, 59, 0);
  return toSqliteDateTime(d);
}

interface TaskCreateSheetProps {
  open: boolean;
  onClose: () => void;
  /** 创建成功回调，参数为新任务 id（调用方通常据此刷新列表或跳详情） */
  onCreated: (id: number) => void;
}

export function TaskCreateSheet({
  open,
  onClose,
  onCreated,
}: TaskCreateSheetProps) {
  const keyboardInset = useKeyboardInset();
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState<DuePreset>("none");
  const [priority, setPriority] = useState<TaskPriority>(1);
  const [saving, setSaving] = useState(false);

  // 打开时锁背景滚动 + 重置表单 + 聚焦标题
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDue("none");
    setPriority(1);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // 延迟聚焦：Android WebView 里面板尚未完成入场动画时 focus() 拉不起键盘
    const t = window.setTimeout(() => inputRef.current?.focus(), 120);
    return () => {
      document.body.style.overflow = prev;
      window.clearTimeout(t);
    };
  }, [open]);

  async function submit() {
    const t = title.trim();
    if (!t || saving) return;
    setSaving(true);
    try {
      const id = await taskApi.create({
        title: t,
        priority,
        due_date: presetToDueDate(due),
      });
      message.success("已添加");
      onCreated(id);
      onClose();
    } catch (e) {
      message.error(`创建失败: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  // v4 原型 08 屏：贴着键盘弹出，白底；标题大字直接输，截止 / 优先级做成胶囊
  return (
    <div className="m-sheet-mask" role="dialog" aria-modal="true" aria-label="新建待办">
      <div className="m-sheet-backdrop" onClick={onClose} />

      <div
        className="m-sheet"
        style={{
          background: "var(--m-surface)",
          paddingBottom: keyboardInset ? keyboardInset : "calc(12px + env(safe-area-inset-bottom, 0px))",
        }}
      >
        <div className="m-sheet-grabber" />

        <div className="m-px">
          <input
            ref={inputRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            placeholder="要做什么？"
            aria-label="待办标题"
            className="w-full bg-transparent py-2.5 text-[18px] font-bold leading-snug outline-none placeholder:font-normal placeholder:text-[var(--m-ink3)]"
            style={{ color: "var(--m-ink)" }}
          />
        </div>

        {/* 截止：单选胶囊 */}
        <div className="m-px m-hscroll mt-4 flex items-center gap-2">
          <span className="m-t-cap w-[3.2em] shrink-0">截止</span>
          {DUE_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setDue(p.key)}
              aria-pressed={due === p.key}
              className="m-chip"
              style={
                due === p.key
                  ? { background: "var(--m-accent-soft2)", color: "var(--m-accent-ink)", fontWeight: 700 }
                  : { background: "var(--m-well)" }
              }
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* 优先级：单选胶囊 */}
        <div className="m-px mt-3 flex items-center gap-2">
          <span className="m-t-cap w-[3.2em] shrink-0">优先级</span>
          {PRIORITIES.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => setPriority(p.value)}
              aria-pressed={priority === p.value}
              className="m-chip"
              style={priority === p.value ? { background: p.bg, color: p.fg, fontWeight: 700 } : { background: "var(--m-well)" }}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="m-px m-t-cap mt-4">分类 / 提醒 / 重复 / 子任务可在建完后进详情页设置</div>

        <div className="m-px mt-2 flex items-center justify-end gap-3">
          <button type="button" className="m-tapx shrink-0 text-[15px] font-semibold" style={{ color: "var(--m-ink2)" }} onClick={onClose}>
            取消
          </button>
          <button type="button" className="m-btn shrink-0" onClick={() => void submit()} disabled={!title.trim() || saving}>
            {saving ? "保存中…" : "添加"}
          </button>
        </div>
      </div>
    </div>
  );
}
