/**
 * 首页「写作活力」年度热力图（gitee / GitHub 贡献图样式）的纯数据计算。
 *
 * 口径沿用 getWritingTrend：某天的字数 = 最后修改日期落在那天的笔记的字数之和
 * （含日记、排除导入笔记），不是当天新增的字数——与旧 14 天柱状图一致。
 *
 * 布局：每列一周（周一 ~ 周日），最右一列是本周；本周今天之后的格子标记 future，不着色。
 */
import type { DailyWritingStat } from "@/types";

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export interface HeatCell {
  /** YYYY-MM-DD（本地时区） */
  date: string;
  words: number;
  level: HeatLevel;
  /** 今天之后的日子：只占位不着色 */
  future: boolean;
}

export interface YearHeatmap {
  /** columns[周][0..6]，0 = 周一 */
  columns: HeatCell[][];
  /** 月份标签：在该月第一次出现的那一列上方 */
  months: { col: number; label: string }[];
  /** 区间内单日最大字数（0 表示整段都没写） */
  max: number;
  /** 区间内有写作的天数 */
  activeDays: number;
}

/** 本地时区 YYYY-MM-DD（不能用 toISOString，那是 UTC，凌晨会差一天） */
export function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 字数 → 色阶。按 sqrt(字数 / 最大值) 分四档：
 *  线性分档下一篇几万字的长文会把其余日子全压到第 1 档，sqrt 压缩动态范围后日常几百字也分得出深浅 */
export function heatLevel(words: number, max: number): HeatLevel {
  if (words <= 0 || max <= 0) return 0;
  const r = Math.sqrt(words / max);
  if (r < 0.25) return 1;
  if (r < 0.5) return 2;
  if (r < 0.75) return 3;
  return 4;
}

/**
 * 构建以 today 所在周为最后一列、共 weeks 列的热力图。
 * 需要的 trend 天数 = weeks * 7（调用方传 getWritingTrend(371) 足够 53 周）。
 */
export function buildYearHeatmap(
  trend: DailyWritingStat[],
  today: Date = new Date(),
  weeks = 53,
): YearHeatmap {
  const byDate = new Map(trend.map((t) => [t.date, t.word_count]));
  const todayYmd = localYmd(today);

  // 本周周一（getDay：0 = 周日）
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dow = (monday.getDay() + 6) % 7;
  monday.setDate(monday.getDate() - dow);
  const start = new Date(monday);
  start.setDate(start.getDate() - (weeks - 1) * 7);

  // 先算区间内最大值，再分档
  let max = 0;
  let activeDays = 0;
  const raw: { date: string; words: number; future: boolean }[][] = [];
  const cursor = new Date(start);
  for (let w = 0; w < weeks; w++) {
    const col: { date: string; words: number; future: boolean }[] = [];
    for (let d = 0; d < 7; d++) {
      const ymd = localYmd(cursor);
      const future = ymd > todayYmd;
      const words = future ? 0 : byDate.get(ymd) ?? 0;
      if (words > max) max = words;
      if (words > 0) activeDays++;
      col.push({ date: ymd, words, future });
      cursor.setDate(cursor.getDate() + 1);
    }
    raw.push(col);
  }

  const columns: HeatCell[][] = raw.map((col) =>
    col.map((c) => ({ ...c, level: heatLevel(c.words, max) })),
  );

  // 月份标签：某列包含当月 1 号就在这一列标月份；第一列若不含 1 号也标上它所在的月，
  // 但离下一个标签太近（< 3 列）时省掉，免得两个月份字叠在一起
  const months: { col: number; label: string }[] = [];
  columns.forEach((col, i) => {
    const first = col.find((c) => c.date.endsWith("-01"));
    if (first) {
      months.push({ col: i, label: `${Number(first.date.slice(5, 7))}月` });
    }
  });
  if (months.length === 0 || months[0].col >= 3) {
    months.unshift({ col: 0, label: `${Number(columns[0][0].date.slice(5, 7))}月` });
  }

  return { columns, months, max, activeDays };
}
