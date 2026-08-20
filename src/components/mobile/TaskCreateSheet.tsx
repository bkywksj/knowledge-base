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

const PRIORITIES: { value: TaskPriority; label: string; active: string }[] = [
  { value: 0, label: "紧急", active: "bg-red-100 text-red-700" },
  { value: 1, label: "普通", active: "bg-blue-100 text-blue-700" },
  { value: 2, label: "低", active: "bg-slate-200 text-slate-700" },
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

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col justify-end"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-black/40 animate-[kbFadeIn_0.15s_ease]"
        onClick={onClose}
      />

      <div
        className="relative z-10 rounded-t-2xl bg-white animate-[kbSheetUp_0.2s_ease]"
        style={{
          paddingBottom: keyboardInset
            ? keyboardInset
            : "env(safe-area-inset-bottom, 0px)",
        }}
      >
        <div className="px-5 pt-4 pb-2 text-center text-xs text-slate-400">
          新建待办
        </div>

        {/* 标题 */}
        <div className="px-4">
          <input
            ref={inputRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            placeholder="要做什么？"
            className="w-full rounded-xl bg-slate-100 px-4 py-3 text-base text-slate-800 outline-none placeholder:text-slate-400"
          />
        </div>

        {/* 截止 */}
        <div className="px-4 pt-3">
          <div className="pb-1.5 text-xs text-slate-400">截止</div>
          <div className="flex gap-2">
            {DUE_PRESETS.map((p) => (
              <button
                key={p.key}
                onClick={() => setDue(p.key)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium ${
                  due === p.key
                    ? "bg-[#1677FF] text-white"
                    : "bg-slate-100 text-slate-600"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* 优先级 */}
        <div className="px-4 pt-3">
          <div className="pb-1.5 text-xs text-slate-400">优先级</div>
          <div className="flex gap-2">
            {PRIORITIES.map((p) => (
              <button
                key={p.value}
                onClick={() => setPriority(p.value)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium ${
                  priority === p.value
                    ? p.active
                    : "bg-slate-100 text-slate-600"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* 操作 */}
        <div className="flex gap-3 px-4 pt-4 pb-3">
          <button
            onClick={onClose}
            className="flex-1 rounded-xl bg-slate-100 text-base font-medium text-slate-600 active:bg-slate-200"
            style={{ minHeight: 48 }}
          >
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={!title.trim() || saving}
            className="flex-[2] rounded-xl bg-[#1677FF] text-base font-medium text-white active:opacity-80 disabled:opacity-40"
            style={{ minHeight: 48 }}
          >
            {saving ? "保存中…" : "添加"}
          </button>
        </div>

        <div className="pb-2 text-center text-[11px] text-slate-400">
          分类 / 提醒 / 重复 / 子任务可在建完后进详情页设置
        </div>
      </div>
    </div>
  );
}
