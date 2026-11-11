import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { message } from "antd";
import { Bell, Calendar, Flag, Repeat, Star, Tag } from "lucide-react";
import { taskApi, taskCategoryApi } from "@/lib/api";
import type { CreateTaskInput, Task, TaskCategory } from "@/types";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";
import { describeRepeat } from "@/lib/taskRepeat";
import { REMIND_OPTIONS, dueChipLabel, flattenCategories, remindLabel, toLocalInput, toSqliteDate } from "@/lib/taskForm";
import { MSheet, PickRow } from "./MSheet";
import { RepeatSheet } from "./RepeatSheet";

/**
 * 移动端「新建待办」底部面板（v4 原型第 08 屏）。
 *
 * 背景：移动端待办列表此前完全没有新建入口 —— 全局 FAB 跳 /quick-create，
 * 而 /quick-create 的「新建任务」又跳回 /tasks，兜一圈回到没有加号的页面。
 *
 * 布局同原型：白底贴键盘；标题大字直接输 →「添加备注」→ 一排横滑胶囊
 * （截止 / 紧急 / 重要 / 分类 / 重复 / 提醒）→ 右下「添加」。
 * 胶囊默认不展开，点了才弹各自的小面板，所以面板本身不变复杂；设过的胶囊高亮并显示取值。
 * 「低」优先级、子任务、附件等不常用项仍在建完后的详情页里改（原来新建时也没有）。
 */

/**
 * Date → SQLite 友好的 'YYYY-MM-DD HH:MM:SS'。
 * 刻意不用 toISOString()：那会转成 UTC，东八区下"今天 23:59"会漂成明天，
 * 造成刚建的任务不落在"今日"分组里。
 */
function toSqliteDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

type DuePreset = "today" | "tomorrow" | "weekend";

/** 快捷截止：当天 23:59:59（「当天内」），本周末 = 本周日；今天就是周日则仍取今天 */
function presetToDueDate(preset: DuePreset): string {
  const d = new Date();
  if (preset === "tomorrow") d.setDate(d.getDate() + 1);
  if (preset === "weekend") {
    const day = d.getDay();
    d.setDate(d.getDate() + (day === 0 ? 0 : 7 - day));
  }
  d.setHours(23, 59, 59, 0);
  return toSqliteDateTime(d);
}

type RepeatFields = Pick<Task, "repeat_kind" | "repeat_interval" | "repeat_weekdays" | "repeat_until" | "repeat_count">;
const NO_REPEAT: RepeatFields = { repeat_kind: "none", repeat_interval: 1, repeat_weekdays: null, repeat_until: null, repeat_count: null };

interface TaskCreateSheetProps {
  open: boolean;
  onClose: () => void;
  /** 创建成功回调，参数为新任务 id（调用方通常据此刷新列表或跳详情） */
  onCreated: (id: number) => void;
}

export function TaskCreateSheet({ open, onClose, onCreated }: TaskCreateSheetProps) {
  const keyboardInset = useKeyboardInset();
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [due, setDue] = useState<string | null>(null);
  const [urgent, setUrgent] = useState(false);
  const [important, setImportant] = useState(false);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [repeat, setRepeat] = useState<RepeatFields>(NO_REPEAT);
  const [remind, setRemind] = useState<number | null>(null);
  const [categories, setCategories] = useState<TaskCategory[]>([]);
  const [saving, setSaving] = useState(false);
  const [picker, setPicker] = useState<null | "due" | "category" | "repeat" | "remind">(null);
  const [dueInput, setDueInput] = useState("");

  // 打开时锁背景滚动 + 重置表单 + 聚焦标题
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setNote("");
    setDue(null);
    setUrgent(false);
    setImportant(false);
    setCategoryId(null);
    setRepeat(NO_REPEAT);
    setRemind(null);
    setPicker(null);
    taskCategoryApi.list().then(setCategories).catch(() => {});
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // 延迟聚焦：Android WebView 里面板尚未完成入场动画时 focus() 拉不起键盘
    const t = window.setTimeout(() => inputRef.current?.focus(), 120);
    return () => {
      document.body.style.overflow = prev;
      window.clearTimeout(t);
    };
  }, [open]);

  const flatCategories = useMemo(() => flattenCategories(categories), [categories]);
  const categoryName = categoryId != null ? categories.find((c) => c.id === categoryId)?.name : undefined;
  const repeatText = repeat.repeat_kind !== "none" ? describeRepeat(repeat) : "";

  async function submit() {
    const t = title.trim();
    if (!t || saving) return;
    setSaving(true);
    try {
      const input: CreateTaskInput = {
        title: t,
        description: note.trim() || null,
        priority: urgent ? 0 : 1,
        important,
        due_date: due,
        remind_before_minutes: remind,
        category_id: categoryId,
      };
      if (repeat.repeat_kind !== "none") {
        input.repeat_kind = repeat.repeat_kind;
        input.repeat_interval = repeat.repeat_interval;
        input.repeat_weekdays = repeat.repeat_weekdays;
      }
      const id = await taskApi.create(input);
      message.success("已添加");
      onCreated(id);
      onClose();
    } catch (e) {
      message.error(`创建失败: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  function openPicker(p: "due" | "category" | "repeat" | "remind") {
    inputRef.current?.blur();
    if (p === "due") setDueInput(toLocalInput(due));
    setPicker(p);
  }

  if (!open) return null;

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

        <div className="m-gutter">
          <input
            ref={inputRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            placeholder="要做什么？"
            aria-label="待办标题"
            className="h-11 w-full bg-transparent text-[18px] font-bold leading-snug outline-none placeholder:font-normal placeholder:text-[var(--m-ink3)]"
            style={{ color: "var(--m-ink)" }}
          />
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="添加备注"
            aria-label="备注"
            rows={1}
            className="block min-h-[44px] max-h-24 w-full resize-none bg-transparent py-2.5 text-[15px] leading-normal outline-none placeholder:text-[var(--m-ink3)]"
            style={{ color: "var(--m-ink)", fieldSizing: "content" } as React.CSSProperties}
          />
        </div>

        {/* 一排横滑胶囊：设过的高亮并显示取值 */}
        <div className="m-gutter m-hscroll mt-4 flex items-center gap-2 pb-1">
          <Chip icon={<Calendar size={14} />} on={due != null} onClick={() => openPicker("due")}>
            {due ? dueChipLabel(due) : "截止"}
          </Chip>
          <Chip icon={<Flag size={14} />} on={urgent} tone="bad" onClick={() => setUrgent((v) => !v)}>
            紧急
          </Chip>
          <Chip icon={<Star size={14} />} on={important} tone="warn" onClick={() => setImportant((v) => !v)}>
            重要
          </Chip>
          <Chip icon={<Tag size={14} />} on={categoryId != null} onClick={() => openPicker("category")}>
            {categoryName ?? "分类"}
          </Chip>
          <Chip icon={<Repeat size={14} />} on={repeat.repeat_kind !== "none"} onClick={() => openPicker("repeat")}>
            {repeatText || "重复"}
          </Chip>
          <Chip icon={<Bell size={14} />} on={remind != null} onClick={() => openPicker("remind")}>
            {remind != null ? remindLabel(remind) : "提醒"}
          </Chip>
        </div>

        <div className="m-gutter mt-3 flex items-center justify-end gap-3">
          <button type="button" className="m-tapx shrink-0 text-[15px] font-semibold" style={{ color: "var(--m-ink2)" }} onClick={onClose}>
            取消
          </button>
          <button type="button" className="m-btn shrink-0" onClick={() => void submit()} disabled={!title.trim() || saving}>
            {saving ? "保存中…" : "添加"}
          </button>
        </div>
      </div>

      {/* 截止：快捷 + 自选日期时间 */}
      <MSheet
        open={picker === "due"}
        title="截止时间"
        onClose={() => setPicker(null)}
        footer={
          <div className="mt-3 flex items-center gap-3">
            {due && (
              <button type="button" className="m-tapx text-[15px] font-semibold" style={{ color: "var(--m-bad)" }} onClick={() => { setDue(null); setPicker(null); }}>
                清除
              </button>
            )}
            <div className="flex-1" />
            <button type="button" className="m-tapx text-[15px] font-semibold" style={{ color: "var(--m-ink2)" }} onClick={() => setPicker(null)}>
              取消
            </button>
            <button type="button" className="m-btn" disabled={!dueInput} onClick={() => { setDue(toSqliteDate(dueInput)); setPicker(null); }}>
              确定
            </button>
          </div>
        }
      >
        <div className="m-group">
          {(["today", "tomorrow", "weekend"] as DuePreset[]).map((p) => (
            <PickRow
              key={p}
              label={p === "today" ? "今天" : p === "tomorrow" ? "明天" : "本周末"}
              active={due != null && due === presetToDueDate(p)}
              onClick={() => { setDue(presetToDueDate(p)); setPicker(null); }}
            />
          ))}
        </div>
        <div className="m-t-cap mt-3 mb-1.5 px-1">或指定日期时间</div>
        <input
          type="datetime-local"
          value={dueInput}
          onChange={(e) => setDueInput(e.target.value)}
          aria-label="截止时间"
          className="h-12 w-full rounded-[var(--m-r-l)] px-3 text-[16px] outline-none"
          style={{ background: "var(--m-well)", color: "var(--m-ink)" }}
        />
      </MSheet>

      {/* 分类（多级缩进，同详情页） */}
      <MSheet open={picker === "category"} title="分类" caption={categories.length === 0 ? "还没有分类，可在桌面端待办侧栏新建" : undefined} onClose={() => setPicker(null)}>
        <div className="m-group max-h-[50vh] overflow-y-auto">
          <PickRow label="未分类" dot="var(--m-ink4)" active={categoryId == null} onClick={() => { setCategoryId(null); setPicker(null); }} />
          {flatCategories.map(({ c, depth }) => (
            <PickRow key={c.id} label={c.name} dot={c.color} indent={depth} active={categoryId === c.id} onClick={() => { setCategoryId(c.id); setPicker(null); }} />
          ))}
        </div>
      </MSheet>

      {/* 提醒（同详情页选项） */}
      <MSheet open={picker === "remind"} title="提前多久提醒" caption={due ? undefined : "还没设截止时间，提醒要等设了截止时间才会触发"} onClose={() => setPicker(null)}>
        <div className="m-group">
          {REMIND_OPTIONS.map((v) => (
            <PickRow key={String(v)} label={remindLabel(v)} active={remind === v} onClick={() => { setRemind(v); setPicker(null); }} />
          ))}
        </div>
      </MSheet>

      {/* 重复：复用详情页的重复面板；面板给的是 update 补丁，这里只取规则字段 */}
      <RepeatSheet
        open={picker === "repeat"}
        task={{ ...repeat, due_date: due }}
        onClose={() => setPicker(null)}
        onSave={async (patch) => {
          setRepeat({
            ...repeat,
            repeat_kind: patch.repeat_kind ?? repeat.repeat_kind,
            repeat_interval: patch.repeat_interval ?? 1,
            repeat_weekdays: patch.clear_repeat_weekdays ? null : patch.repeat_weekdays ?? repeat.repeat_weekdays,
          });
          return true;
        }}
      />
    </div>
  );
}

/** 原型 08 的胶囊：14px 图标 + 文字；设过 / 打开的用对应色高亮 */
function Chip({ icon, on, tone = "accent", onClick, children }: { icon: ReactNode; on: boolean; tone?: "accent" | "bad" | "warn"; onClick: () => void; children: ReactNode }) {
  const onStyle =
    tone === "bad"
      ? { background: "var(--m-bad-soft)", color: "var(--m-bad)" }
      : tone === "warn"
        ? { background: "var(--m-warn-soft)", color: "var(--m-warn)" }
        : { background: "var(--m-accent-soft2)", color: "var(--m-accent-ink)" };
  return (
    <button type="button" aria-pressed={on} className="m-chip gap-1" style={on ? { ...onStyle, fontWeight: 700 } : { background: "var(--m-well)" }} onClick={onClick}>
      {icon}
      {children}
    </button>
  );
}
