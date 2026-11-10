import type { Task, UpdateTaskInput } from "@/types";

const WEEKDAY_LABELS = ["", "一", "二", "三", "四", "五", "六", "日"];

/**
 * 用一句中文描述循环规则（「每天」「每2周」「工作日」「周一三五」），不循环返回空串。
 * 桌面列表的小 tag 和移动端详情页共用，免得一处显示中文、一处显示 `weekly`。
 */
export function describeRepeat(
  task: Pick<Task, "repeat_kind" | "repeat_interval" | "repeat_weekdays">,
): string {
  const { repeat_kind, repeat_interval, repeat_weekdays } = task;
  if (repeat_kind === "none") return "";
  const iv = Math.max(1, repeat_interval);
  if (repeat_kind === "daily") return iv === 1 ? "每天" : `每${iv}天`;
  if (repeat_kind === "monthly") return iv === 1 ? "每月" : `每${iv}月`;
  if (repeat_weekdays) {
    const days = repeat_weekdays
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => n >= 1 && n <= 7)
      .sort((a, b) => a - b);
    if (days.length === 5 && days.join(",") === "1,2,3,4,5") return "工作日";
    return `周${days.map((d) => WEEKDAY_LABELS[d]).join("")}`;
  }
  return iv === 1 ? "每周" : `每${iv}周`;
}

/** 循环规则的界面预设（手机详情页的「重复」面板用；PC 新建 / 编辑弹窗有同口径的一份） */
export type RepeatPreset = "none" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";
export type RepeatUnit = "day" | "week" | "month";

export interface RepeatDraft {
  preset: RepeatPreset;
  unit: RepeatUnit;
  /** 每 N 个单位，≥ 1 */
  interval: number;
  /** 每周的周几（1 = 周一 … 7 = 周日），只在 unit = week 时有意义 */
  weekdays: number[];
}

/** 从任务反推界面预设：默认间隔的常见规则落到对应预设，其余一律算自定义 */
export function repeatDraftFromTask(
  task: Pick<Task, "repeat_kind" | "repeat_interval" | "repeat_weekdays">,
): RepeatDraft {
  const { repeat_kind, repeat_interval, repeat_weekdays } = task;
  const weekdays = repeat_weekdays
    ? repeat_weekdays
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => n >= 1 && n <= 7)
    : [];
  if (repeat_kind === "none") return { preset: "none", unit: "day", interval: 1, weekdays: [] };
  const plain = repeat_interval <= 1;
  if (repeat_kind === "daily" && plain) return { preset: "daily", unit: "day", interval: 1, weekdays: [] };
  if (repeat_kind === "weekly" && plain && repeat_weekdays === "1,2,3,4,5") {
    return { preset: "weekdays", unit: "week", interval: 1, weekdays };
  }
  if (repeat_kind === "weekly" && plain && weekdays.length === 0) {
    return { preset: "weekly", unit: "week", interval: 1, weekdays: [] };
  }
  if (repeat_kind === "monthly" && plain) return { preset: "monthly", unit: "month", interval: 1, weekdays: [] };
  const unit: RepeatUnit = repeat_kind === "daily" ? "day" : repeat_kind === "weekly" ? "week" : "month";
  return { preset: "custom", unit, interval: Math.max(1, repeat_interval), weekdays };
}

/**
 * 界面预设 → taskApi.update 负载。
 *
 * 结束条件（截止日期 / 次数）手机端不提供编辑，所以改规则时原样保留，不发 clear_repeat_until / count，
 * 免得在手机上改个「每周」把 PC 上设好的「共 10 次」冲掉；只有改成「不重复」才一并清掉（同 PC）。
 */
export function repeatDraftToUpdate(d: RepeatDraft): Partial<UpdateTaskInput> {
  if (d.preset === "none") {
    return { repeat_kind: "none", clear_repeat_weekdays: true, clear_repeat_until: true, clear_repeat_count: true };
  }
  let kind: Task["repeat_kind"] = "daily";
  let interval = 1;
  let weekdays: string | null = null;
  if (d.preset === "weekdays") {
    kind = "weekly";
    weekdays = "1,2,3,4,5";
  } else if (d.preset === "weekly") {
    kind = "weekly";
  } else if (d.preset === "monthly") {
    kind = "monthly";
  } else if (d.preset === "custom") {
    kind = d.unit === "day" ? "daily" : d.unit === "week" ? "weekly" : "monthly";
    interval = Math.max(1, Math.floor(d.interval) || 1);
    if (d.unit === "week" && d.weekdays.length > 0) weekdays = [...d.weekdays].sort((a, b) => a - b).join(",");
  }
  return weekdays
    ? { repeat_kind: kind, repeat_interval: interval, repeat_weekdays: weekdays }
    : { repeat_kind: kind, repeat_interval: interval, clear_repeat_weekdays: true };
}
