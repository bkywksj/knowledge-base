import { useEffect, useState } from "react";
import { Minus, Plus } from "lucide-react";
import type { Task, UpdateTaskInput } from "@/types";
import { repeatDraftFromTask, repeatDraftToUpdate, type RepeatDraft, type RepeatPreset, type RepeatUnit } from "@/lib/taskRepeat";
import { MSheet, PickRow } from "./MSheet";

/**
 * 手机端「重复」面板：预设一点即存；「自定义」展开间隔 / 单位 / 周几，点「保存」才存。
 * 规则口径与 PC 新建 / 编辑弹窗一致；结束条件（截止日期 / 次数）手机端不编辑、原样保留，见 repeatDraftToUpdate。
 */

const PRESETS: { key: RepeatPreset; label: string }[] = [
  { key: "none", label: "不重复" },
  { key: "daily", label: "每天" },
  { key: "weekdays", label: "工作日（周一至周五）" },
  { key: "weekly", label: "每周" },
  { key: "monthly", label: "每月" },
  { key: "custom", label: "自定义" },
];

const UNITS: { key: RepeatUnit; label: string }[] = [
  { key: "day", label: "天" },
  { key: "week", label: "周" },
  { key: "month", label: "月" },
];

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

type RepeatTask = Pick<Task, "repeat_kind" | "repeat_interval" | "repeat_weekdays" | "repeat_until" | "repeat_count" | "due_date">;

export function RepeatSheet({
  open,
  task,
  onSave,
  onClose,
}: {
  open: boolean;
  task: RepeatTask | null;
  /** 返回是否保存成功；失败时面板不关（调用方负责提示） */
  onSave: (patch: Partial<UpdateTaskInput>) => Promise<boolean>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<RepeatDraft>({ preset: "none", unit: "day", interval: 1, weekdays: [] });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && task) setDraft(repeatDraftFromTask(task));
  }, [open, task]);

  async function save(d: RepeatDraft) {
    if (saving) return;
    setSaving(true);
    try {
      if (await onSave(repeatDraftToUpdate(d))) onClose();
    } finally {
      setSaving(false);
    }
  }

  function pickPreset(p: RepeatPreset) {
    if (p === "custom") {
      // 从当前预设平滑过渡到自定义：沿用它的单位
      setDraft((d) => ({ ...d, preset: "custom", unit: d.preset === "weekly" || d.preset === "weekdays" ? "week" : d.preset === "monthly" ? "month" : d.unit }));
      return;
    }
    void save({ preset: p, unit: "day", interval: 1, weekdays: [] });
  }

  const end = task?.repeat_until ? `截至 ${task.repeat_until.slice(0, 10)}` : task?.repeat_count ? `共 ${task.repeat_count} 次` : null;
  const caption = [
    !task?.due_date ? "循环按截止时间往后推，建议先设截止时间" : null,
    end ? `结束条件「${end}」沿用桌面端设置` : null,
  ]
    .filter(Boolean)
    .join("；");

  const isCustom = draft.preset === "custom";

  return (
    <MSheet
      open={open}
      title="重复"
      caption={caption || undefined}
      onClose={onClose}
      footer={
        isCustom ? (
          <div className="mt-3 flex items-center justify-end gap-3">
            <button type="button" className="m-tapx text-[15px] font-semibold" style={{ color: "var(--m-ink2)" }} onClick={onClose}>
              取消
            </button>
            <button type="button" className="m-btn" disabled={saving} onClick={() => void save(draft)}>
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        ) : undefined
      }
    >
      <div className="m-group">
        {PRESETS.map((p) => (
          <PickRow key={p.key} label={p.label} active={draft.preset === p.key} onClick={() => pickPreset(p.key)} />
        ))}
      </div>

      {isCustom && (
        <div className="m-group mt-3 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-[15px]" style={{ color: "var(--m-ink)" }}>每</span>
            <button
              type="button"
              aria-label="减少"
              className="m-icon-btn"
              style={{ background: "var(--m-well)" }}
              disabled={draft.interval <= 1}
              onClick={() => setDraft((d) => ({ ...d, interval: Math.max(1, d.interval - 1) }))}
            >
              <Minus size={18} />
            </button>
            <span className="m-num w-8 text-center text-[17px] font-bold" style={{ color: "var(--m-ink)" }} aria-live="polite">
              {draft.interval}
            </span>
            <button
              type="button"
              aria-label="增加"
              className="m-icon-btn"
              style={{ background: "var(--m-well)" }}
              disabled={draft.interval >= 99}
              onClick={() => setDraft((d) => ({ ...d, interval: Math.min(99, d.interval + 1) }))}
            >
              <Plus size={18} />
            </button>
            <div className="flex-1" />
            {UNITS.map((u) => (
              <button
                key={u.key}
                type="button"
                className="m-chip"
                aria-pressed={draft.unit === u.key}
                style={draft.unit === u.key ? { background: "var(--m-accent-soft2)", color: "var(--m-accent-ink)", fontWeight: 700 } : { background: "var(--m-well)" }}
                onClick={() => setDraft((d) => ({ ...d, unit: u.key }))}
              >
                {u.label}
              </button>
            ))}
          </div>

          {draft.unit === "week" && (
            <>
              <div className="m-t-cap mt-3 mb-2">在这几天（不选 = 按截止日当天）</div>
              <div className="grid grid-cols-7 gap-1.5">
                {WEEKDAYS.map((w, i) => {
                  const n = i + 1;
                  const on = draft.weekdays.includes(n);
                  return (
                    <button
                      key={n}
                      type="button"
                      aria-pressed={on}
                      aria-label={`周${w}`}
                      className="flex h-11 items-center justify-center rounded-[var(--m-r-m)] text-[15px]"
                      style={on ? { background: "var(--m-accent-soft2)", color: "var(--m-accent-ink)", fontWeight: 700 } : { background: "var(--m-well)", color: "var(--m-ink)" }}
                      onClick={() =>
                        setDraft((d) => ({ ...d, weekdays: on ? d.weekdays.filter((x) => x !== n) : [...d.weekdays, n] }))
                      }
                    >
                      {w}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </MSheet>
  );
}
