/**
 * 甘特图时间轴刻度生成。
 *
 * 背景（用户反馈「按周显示模式，标题栏空白」）：原实现无论 day 还是 week 模式
 * **都是每天一格**，week 只是把格子从 22px 拉宽到 70px，然后 label 只在
 * 「每月 1 号」或「第一格」才给文字、其余一律空串 —— 于是按周模式下 100+ 个格子
 * 里只有零星一两个有字，看起来就是"标题栏空白"。
 *
 * 而且那不只是标签问题：120 天的范围在 week 模式下会算出 120×70 = 8400px 的画布，
 * 比 day 模式（120×22 = 2640px）还宽 3 倍 —— 与"按周 = 看得更宏观"的预期完全相反。
 *
 * 正确做法是把两个概念拆开：
 *  - `pxPerDay`  一天占多少像素（所有任务条 / 今天竖线都按天算偏移，沿用这个即可）
 *  - `tickSpanDays` 一个刻度格代表几天（day=1, week=7）
 *  - `tickWidth` = pxPerDay × tickSpanDays
 *
 * 这样任务条的坐标公式一行都不用改（它们本来就是「天偏移 × 每天像素」），
 * 只是刻度变稀、画布变窄。
 */

export type GanttUnit = "day" | "week";

export interface GanttTick {
  /** 该刻度起始日 */
  date: Date;
  /** 显示文字（week 模式下每格都有，不再出现大片空白） */
  label: string;
  /** 是否跨月边界（画粗一点的分隔线） */
  isMonthStart: boolean;
  /** 周末（仅 day 模式有意义；week 模式恒为 false） */
  isWeekend: boolean;
  /** 该格代表几天 —— 末尾格可能不足一整周 */
  spanDays: number;
}

const DAY_MS = 86_400_000;

/** 一天占多少像素。week 模式下一周正好 70px，与改造前的视觉密度一致。 */
export function pxPerDayFor(unit: GanttUnit): number {
  return unit === "day" ? 22 : 10;
}

/** 一个刻度格代表几天 */
export function tickSpanFor(unit: GanttUnit): number {
  return unit === "day" ? 1 : 7;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/**
 * 生成刻度。
 *
 * @param rangeStart 时间轴起点（应为当天 0 点）
 * @param days       总天数
 * @param unit       day / week
 */
export function buildGanttTicks(
  rangeStart: Date,
  days: number,
  unit: GanttUnit,
): GanttTick[] {
  const span = tickSpanFor(unit);
  const out: GanttTick[] = [];

  for (let i = 0; i < days; i += span) {
    const d = addDays(rangeStart, i);
    // 末尾不足一整格时按剩余天数算，避免最后一格超出总宽
    const spanDays = Math.min(span, days - i);
    const wd = d.getDay(); // 0=Sun, 6=Sat

    let label: string;
    let isMonthStart: boolean;

    if (unit === "day") {
      label = `${d.getMonth() + 1}/${d.getDate()}`;
      isMonthStart = d.getDate() === 1;
    } else {
      // 按周：每格都显示该周起始日，绝不留空
      label = `${d.getMonth() + 1}/${d.getDate()}`;
      // 这一格（7 天）里跨过 1 号就算月度边界 —— 按周时 1 号很少正好落在格子起点，
      // 只判断起始日会导致整年都画不出一条月分隔线
      isMonthStart = spansMonthStart(d, spanDays);
    }

    out.push({
      date: d,
      label,
      isMonthStart,
      isWeekend: unit === "day" && (wd === 0 || wd === 6),
      spanDays,
    });
  }

  return out;
}

/** 从 d 起的 spanDays 天内是否跨过某月 1 号（含 d 自己是 1 号） */
function spansMonthStart(d: Date, spanDays: number): boolean {
  for (let k = 0; k < spanDays; k += 1) {
    if (addDays(d, k).getDate() === 1) return true;
  }
  return false;
}

/** 今天相对起点的像素偏移；不在范围内返回 null */
export function todayOffsetPx(
  rangeStart: Date,
  rangeEnd: Date,
  pxPerDay: number,
  now: Date = new Date(),
): number | null {
  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const start = rangeStart.getTime();
  if (today < start || today > rangeEnd.getTime()) return null;
  return ((today - start) / DAY_MS) * pxPerDay;
}
