import type { Task } from "@/types";

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
