/**
 * 手机端待办表单的共用小工具：任务详情页（MobileTaskDetail）与新建面板（TaskCreateSheet）两处共用，
 * 原来只在详情页里，新建面板按原型 08 也要选截止 / 提醒 / 分类，抽出来免得两份口径漂移。
 */
import type { TaskCategory } from "@/types";

/** 原手机端 7 档 + PC 端独有的准时 / 3 小时 / 1 周，两端设的值在这里都能选中 */
export const REMIND_OPTIONS: (number | null)[] = [null, 0, 5, 15, 30, 60, 120, 180, 1440, 10080];

/** 提醒值 → 文案；0 = 到点准时提醒，不是「不提醒」，只有 null 才是不提醒 */
export function remindLabel(min: number | null | undefined): string {
  if (min == null) return "不提醒";
  if (min === 0) return "准时提醒";
  if (min % 10080 === 0) return `提前 ${min / 10080} 周`;
  if (min % 1440 === 0) return `提前 ${min / 1440} 天`;
  if (min % 60 === 0) return `提前 ${min / 60} 小时`;
  return `提前 ${min} 分钟`;
}

/** 多级分类拍平成「父在前、子紧随」的顺序，带层级（选择面板缩进用） */
export function flattenCategories(list: TaskCategory[]): { c: TaskCategory; depth: number }[] {
  const byParent = new Map<number | null, TaskCategory[]>();
  for (const c of list) {
    const p = c.parent_id ?? null;
    byParent.set(p, [...(byParent.get(p) ?? []), c]);
  }
  const out: { c: TaskCategory; depth: number }[] = [];
  const seen = new Set<number>();
  const walk = (parent: number | null, depth: number) => {
    for (const c of (byParent.get(parent) ?? []).sort((a, b) => a.sort_order - b.sort_order)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  // 父分类已不存在的孤儿也列出来，别让任务的分类在面板里「消失」
  for (const c of list) if (!seen.has(c.id)) out.push({ c, depth: 0 });
  return out;
}

/** "YYYY-MM-DDTHH:MM" → "YYYY-MM-DD HH:MM:SS"（SQLite 友好），空字符串保留为 null */
export function toSqliteDate(local: string): string | null {
  if (!local) return null;
  const [date, time] = local.split("T");
  return time ? `${date} ${time}:00` : `${date} 23:59:59`;
}

/** 反向：SQLite 字符串 → datetime-local input 接受的 "YYYY-MM-DDTHH:MM" */
export function toLocalInput(sql: string | null): string {
  if (!sql) return "";
  const [date, time] = sql.split(" ");
  if (!time) return `${date}T23:59`;
  return `${date}T${time.slice(0, 5)}`;
}

/**
 * 截止时间 → 胶囊短文案（原型 08「今天 14:00」）：今天 / 明天 / 本年「M 月 D 日」/ 跨年带年份，
 * 23:59（「当天内」的默认值）不写时间。
 */
export function dueChipLabel(sql: string, now: Date = new Date()): string {
  const [date, time = ""] = sql.split(" ");
  const [y, m, d] = date.split("-").map(Number);
  const hm = time.slice(0, 5);
  const t = hm && hm !== "23:59" ? ` ${hm}` : "";
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diff = Math.round((new Date(y, m - 1, d).getTime() - day0) / 86400000);
  if (diff === 0) return `今天${t}`;
  if (diff === 1) return `明天${t}`;
  return `${y !== now.getFullYear() ? `${y} 年 ` : ""}${m} 月 ${d} 日${t}`;
}
