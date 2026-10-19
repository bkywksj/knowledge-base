/**
 * 从一段通知 / 消息里识别待办（本地规则，不联网、不耗 token）。
 *
 * 核心思路：**按日期的「身份」打分，而不是按出现位置。**
 * 一段通知里常有好几个日期 —— 发文日期、报名截止、开会时间、起止区间 —— 取第一个或第一个
 * 未来日期都只是在猜。这里看每个日期周围的词判断它是什么，再按身份 + 是否已过去打分选最佳，
 * 其余候选也返回给 UI，用户点一下就能换。
 *
 * 另外：编号清单拆成子任务；顺带识别提醒、地点、紧急 / 重要。
 * 只给「建议」：调用方回填表单让用户确认，不直接落库；不确定时可以交给 AI 识别。
 */

export interface DueTime {
  /** YYYY-MM-DD */
  date: string;
  /** HH:mm；原文没写时间时为 null（由调用方补默认时间） */
  time: string | null;
}

/** 日期身份：截止 / 活动开始 / 时间段 / 发文落款 / 普通提及 */
export type DateRole = "deadline" | "event" | "range" | "publish" | "plain";

export interface DateCandidate extends DueTime {
  /** 时间段的起始日（date 是结束日）；非时间段为 undefined */
  start?: string;
  role: DateRole;
  /** 早于今天 */
  past: boolean;
  /** 给 UI 切换用的短说明，如「截止 · 上交销售数据」 */
  label: string;
  score: number;
}

export interface RecognizedSubtask {
  title: string;
  due: DueTime | null;
}

export interface RecognizedTask {
  /** 建议标题；识别不出时为空串（调用方保留用户原标题） */
  title: string;
  due: DueTime | null;
  /** 时间段起始日（YYYY-MM-DD），只有识别为时间段时才有 */
  start: string | null;
  /** 建议提醒：提前 N 分钟；null = 不建议提醒 */
  remindBefore: number | null;
  important: boolean;
  urgent: boolean;
  location: string | null;
  /** 编号清单拆出的子任务（至少 2 项才算清单） */
  subtasks: RecognizedSubtask[];
  /** 全部日期候选，按得分从高到低；第一个就是 due 的来源 */
  candidates: DateCandidate[];
  /** 本地规则是否有把握（没把握时调用方可以再走 AI） */
  confident: boolean;
}

// ─── 数字 / 日期基础 ─────────────────────────────────

const CN_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 「26」「二十六」「十」「两」→ 数字；不认识返回 NaN */
function toNum(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === "十") return 10;
  const m = /^([一二三四五六七八九两])?十([一二三四五六七八九])?$/.exec(s);
  if (m)
    return (m[1] ? CN_DIGITS[m[1]] : 1) * 10 + (m[2] ? CN_DIGITS[m[2]] : 0);
  if (s.length === 1 && s in CN_DIGITS) return CN_DIGITS[s];
  return NaN;
}

const NUM = "(\\d{1,4}|[零〇一二三四五六七八九十两]{1,3})";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  r.setDate(r.getDate() + n);
  return r;
}

function validDate(y: number, m: number, d: number): Date | null {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(y, m - 1, d);
  return dt.getMonth() === m - 1 ? dt : null;
}

interface DateHit {
  start: number;
  end: number;
  date: Date;
}

const WEEKDAY: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
};

/** 月-日 补年份：早于今天半年以上算明年（12 月说「1月5日」），近期过去的日期保持今年 */
function inferYear(today: Date, mo: number, d: number): Date | null {
  const date = validDate(today.getFullYear(), mo, d);
  if (date && today.getTime() - date.getTime() > 180 * 86400_000) {
    return validDate(today.getFullYear() + 1, mo, d);
  }
  return date;
}

/** 找出全文所有日期，按出现位置排序 */
function findDates(text: string, today: Date): DateHit[] {
  const hits: DateHit[] = [];
  const taken: [number, number][] = [];
  const overlaps = (s: number, e: number) =>
    taken.some(([a, b]) => s < b && e > a);
  const push = (s: number, e: number, date: Date | null) => {
    if (!date || overlaps(s, e)) return;
    taken.push([s, e]);
    hits.push({ start: s, end: e, date });
  };

  // 2026年10月26日 / 2026-10-26 / 2026/10/26 / 2026.10.26
  for (const m of text.matchAll(
    /(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*[日号]?/g,
  )) {
    push(m.index!, m.index! + m[0].length, validDate(+m[1], +m[2], +m[3]));
  }
  // 10月26日 / 十月二十六号
  for (const m of text.matchAll(
    new RegExp(`${NUM}\\s*月\\s*${NUM}\\s*[日号]`, "g"),
  )) {
    push(
      m.index!,
      m.index! + m[0].length,
      inferYear(today, toNum(m[1]), toNum(m[2])),
    );
  }
  // 今天 / 明天 / 后天 / 大后天
  for (const m of text.matchAll(/大后天|后天|明天|明日|今天|今日/g)) {
    const off =
      { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3 }[m[0]] ?? 0;
    push(m.index!, m.index! + m[0].length, addDays(today, off));
  }
  // 周三 / 下周五 / 本周日 / 星期二 / 礼拜天
  for (const m of text.matchAll(
    /(下下|下|本|这)?(?:周|星期|礼拜)([一二三四五六日天1-7])/g,
  )) {
    const target = WEEKDAY[m[2]];
    const cur = today.getDay() === 0 ? 7 : today.getDay();
    let off = target - cur;
    if (m[1] === "下") off += 7;
    else if (m[1] === "下下") off += 14;
    else if (!m[1] && off < 0) off += 7; // 光说「周三」且本周已过 → 下周三
    push(m.index!, m.index! + m[0].length, addDays(today, off));
  }
  return hits.sort((a, b) => a.start - b.start);
}

const TIME_RE = new RegExp(
  `^\\s*(?:的)?\\s*(上午|早上|早晨|中午|下午|傍晚|晚上|凌晨)?\\s*${NUM}\\s*(?:[:：]\\s*(\\d{2})|[点时](?:\\s*(半|\\d{1,2}|[一二三四五]?十[一二三四五六七八九]?|[一二三四五六七八九])\\s*分?)?)`,
);

/** 从 pos 开始（紧跟日期后）读一个时间；返回 HH:mm 与时间文本的结束位置 */
function readTime(
  text: string,
  pos: number,
): { time: string; end: number } | null {
  const m = TIME_RE.exec(text.slice(pos));
  if (!m) return null;
  let h = toNum(m[2]);
  const min = m[3] ? Number(m[3]) : m[4] === "半" ? 30 : m[4] ? toNum(m[4]) : 0;
  if (!(h >= 0 && h <= 24 && min >= 0 && min < 60)) return null;
  const mer = m[1];
  if ((mer === "下午" || mer === "晚上" || mer === "傍晚") && h < 12) h += 12;
  if (mer === "中午" && h < 11) h += 12;
  if (h === 24) h = 23;
  return { time: `${pad(h)}:${pad(min)}`, end: pos + m[0].length };
}

// ─── 文本清洗 / 标题 ─────────────────────────────────

const MEETING_WORDS =
  "会议|例会|座谈会|研讨会|培训会|评审会|周会|月会|晨会|总结会|推进会|动员会|发布会|讨论会|启动会|交流会|复盘会|年会";
const EVENT_WORDS =
  "召开|举行|举办|开会|会议|培训|活动|报到|集合|出发|见面|面试|考试|讲座|演出|聚餐|拜访|开课|上课|答辩|体检|复诊|就诊|面谈|直播|宣讲";

function cleanTitle(s: string): string {
  return s
    .replace(/^[\s，,：:、。．.；;]+/, "")
    .replace(/[\s，,：:、。．.；;！!？?]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(s: string, n = 40): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 会议：取「召开 / 参加…」后面的会议名称 */
function meetingTitle(text: string): string {
  const withVerb = new RegExp(
    `(?:召开|举行|举办|参加|组织|出席|开展)\\s*([^\\s，。,；;：:、]{0,20}?(?:${MEETING_WORDS}))(?![室厅])`,
  ).exec(text);
  if (withVerb) return cleanTitle(withVerb[1]);
  // 没有动词时，名称里不允许出现日期 / 时间字符，免得把「10月25日下午2点在…」整段吞进来
  const bare = new RegExp(
    `([^\\s，。,；;：:、\\d年月日号点时午]{1,16}?(?:${MEETING_WORDS}))(?![室厅])`,
  ).exec(text);
  return bare ? cleanTitle(bare[1]) : "";
}

/** 取 pos 之后那半句当事项（「…10月26日前上交销售数据，逾期不候」→「上交销售数据」） */
function actionAfter(text: string, pos: number): string {
  // 只取到第一个逗号：后面多是「逾期不候」「并附说明」这类补充，不适合进标题
  const sentence = text.slice(pos).split(/[。！？!?\n；;，,]/)[0] ?? "";
  const s = cleanTitle(
    sentence
      .replace(/^\s*(?:之前|以前|前|截止|为止|止)/, "")
      .replace(/^[\s，,：:、]+/, "")
      .replace(/^(?:请|务必|需要|须|需|要|应)/, "")
      .replace(/^(?:将|把)/, "")
      // 「在三楼会议室召开季度总结会」：地点交给 location，标题从动词后开始
      .replace(/^在[^，,。]{1,16}?(?=召开|举行|举办|开展|进行)/, ""),
  );
  return s.length >= 2 && s.length <= 40 ? s : "";
}

/** 兜底标题：第一句话，去掉【】前缀和「关于…的通知」外壳 */
function headline(text: string): string {
  let s = text.split(/[。！？!?\n]/).find((x) => x.trim()) ?? "";
  s = s.replace(/^【[^】]*】/, "").replace(/^(?:通知|公告|提醒)[：:]/, "");
  const about = /关于(.{2,40}?)的(?:通知|公告|提醒|函)/.exec(s);
  if (about) s = about[1];
  return clip(cleanTitle(s));
}

function findLocation(text: string): string | null {
  const labeled = /地点[：:]\s*([^\n，。,；;]{2,24})/.exec(text);
  if (labeled) return cleanTitle(labeled[1]);
  const inPlace =
    /在([^\s，。,；;]{1,16}?(?:会议室|报告厅|礼堂|教室|办公室|大厅|中心|广场|酒店|餐厅|公司|学校|医院|[0-9一二三四五六七八九十]+楼|[0-9]+层|室|厅|馆))/.exec(
      text,
    );
  return inPlace ? inPlace[1] : null;
}

// ─── 日期身份判断与打分 ─────────────────────────────────

const ROLE_SCORE: Record<DateRole, number> = {
  deadline: 5,
  event: 4,
  range: 4,
  plain: 2,
  publish: -10,
};
const ROLE_NAME: Record<DateRole, string> = {
  deadline: "截止",
  event: "活动",
  range: "时间段",
  publish: "发文",
  plain: "日期",
};

const RANGE_SEP = /^\s*(?:至|到|~|～|—|－|-)\s*/;

function lineOf(text: string, pos: number): string {
  const s = text.lastIndexOf("\n", pos - 1) + 1;
  const e = text.indexOf("\n", pos);
  return text.slice(s, e < 0 ? text.length : e);
}

function judgeDates(text: string, today: Date): DateCandidate[] {
  const hits = findDates(text, today);
  const out: DateCandidate[] = [];
  const consumed = new Set<number>();

  hits.forEach((h, i) => {
    if (consumed.has(i)) return;
    const t = readTime(text, h.end);
    let endPos = t?.end ?? h.end;
    let date = h.date;
    let time = t?.time ?? null;
    let start: string | undefined;
    let role: DateRole | null = null;

    // 时间段：「10月20日至26日」「10月20日-10月26日」
    const sep = RANGE_SEP.exec(text.slice(endPos));
    if (sep) {
      const after = endPos + sep[0].length;
      const nextIdx = hits.findIndex((x, j) => j > i && x.start === after);
      const dayOnly = /^(\d{1,2})\s*[日号]/.exec(text.slice(after));
      let endDate: Date | null = null;
      let endAt = after;
      if (nextIdx >= 0) {
        endDate = hits[nextIdx].date;
        endAt = hits[nextIdx].end;
        consumed.add(nextIdx);
      } else if (dayOnly) {
        endDate = validDate(
          h.date.getFullYear(),
          h.date.getMonth() + 1,
          Number(dayOnly[1]),
        );
        endAt = after + dayOnly[0].length;
      }
      if (endDate && endDate.getTime() >= h.date.getTime()) {
        start = ymd(h.date);
        date = endDate;
        const t2 = readTime(text, endAt);
        time = t2?.time ?? null;
        endPos = t2?.end ?? endAt;
        role = "range";
      }
    }

    const before = text.slice(Math.max(0, h.start - 10), h.start);
    const after = text.slice(endPos, endPos + 16);
    const clause = text
      .slice(endPos)
      .split(/[。！？!?\n；;]/)[0]
      .slice(0, 30);
    const line = lineOf(text, h.start).trim();
    const dateText = text.slice(h.start, h.end).trim();

    if (!role) {
      if (
        /(印发|发布|发文|签发|成文)\s*$/.test(before) ||
        /^\s*(印发|发布|发文|签发|起施行|起执行)/.test(after) ||
        line === dateText // 单独占一行的日期 = 落款
      ) {
        role = "publish";
      } else if (
        /^\s*(之前|以前|前|为止|止)/.test(after) ||
        /(截止|截至|不晚于|最迟|最晚|期限)[^，。\n]{0,3}$/.test(before) ||
        /截止|截至/.test(clause)
      ) {
        role = "deadline";
      } else if (
        /(定于|将于|拟于|时间[：:])\s*$/.test(before) ||
        new RegExp(EVENT_WORDS).test(clause)
      ) {
        role = "event";
      } else {
        role = "plain";
      }
    }

    const past = date.getTime() < today.getTime();
    const snippet =
      role === "publish"
        ? ""
        : actionAfter(text, endPos) || cleanTitle(clause).slice(0, 12);
    out.push({
      date: ymd(date),
      time,
      start,
      role,
      past,
      label: `${ROLE_NAME[role]}${snippet ? ` · ${clip(snippet, 12)}` : ""}`,
      // 身份分 + 已过去扣分 + 写了具体时间略加分；位置只做同分时的极小 tie-break
      score:
        ROLE_SCORE[role] - (past ? 6 : 0) + (time ? 0.5 : 0) - h.start * 1e-6,
    });
    // 记录事项起点，供标题使用
    (out[out.length - 1] as DateCandidate & { _end?: number })._end = endPos;
  });

  return out.sort((a, b) => b.score - a.score);
}

/** 「只有时间没有日期」（「下午3点开会」）→ 今天，已过则明天 */
function timeOnly(
  text: string,
  now: Date,
  today: Date,
): { due: DueTime; end: number } | null {
  for (const m of text.matchAll(
    /上午|早上|早晨|中午|下午|傍晚|晚上|凌晨|\d{1,2}\s*[:：]\s*\d{2}/g,
  )) {
    const t = readTime(text, m.index!);
    if (!t) continue;
    const [h, mi] = t.time.split(":").map(Number);
    const passed = h * 60 + mi <= now.getHours() * 60 + now.getMinutes();
    return {
      due: { date: ymd(passed ? addDays(today, 1) : today), time: t.time },
      end: t.end,
    };
  }
  return null;
}

// ─── 编号清单 → 子任务 ─────────────────────────────────

const ITEM_RE =
  /^\s*(?:\d{1,2}\s*[.、．)）]|[（(]\s*\d{1,2}\s*[)）]|[①②③④⑤⑥⑦⑧⑨⑩]|[一二三四五六七八九十][、.．])\s*(.+)$/;

function splitItems(text: string): { items: string[]; listStart: number } {
  // 同一行里的「：1. xxx；2. xxx」也拆开（冒号后紧跟第一项是很常见的写法）
  const norm = text.replace(
    /[；;。：:]\s*(?=(?:\d{1,2}\s*[.、．)）]|[（(]\s*\d{1,2}\s*[)）]|[①②③④⑤⑥⑦⑧⑨⑩]))/g,
    "\n",
  );
  const items: string[] = [];
  let listStart = -1;
  let offset = 0;
  for (const line of norm.split("\n")) {
    const m = ITEM_RE.exec(line);
    if (m) {
      if (listStart < 0)
        listStart = text.indexOf(m[1]) >= 0 ? text.indexOf(m[1]) : offset;
      items.push(m[1].trim());
    }
    offset += line.length + 1;
  }
  return items.length >= 2
    ? { items, listStart }
    : { items: [], listStart: -1 };
}

function recognizeItem(item: string, today: Date): RecognizedSubtask {
  const best = judgeDates(item, today)[0] as
    (DateCandidate & { _end?: number }) | undefined;
  const title =
    (best && best.role !== "publish"
      ? actionAfter(item, best._end ?? 0)
      : "") || clip(cleanTitle(item));
  return {
    title,
    due:
      best && best.role !== "publish"
        ? { date: best.date, time: best.time }
        : null,
  };
}

// ─── 入口 ─────────────────────────────────

export function recognizeTask(
  raw: string,
  now: Date = new Date(),
): RecognizedTask {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  const empty: RecognizedTask = {
    title: "",
    due: null,
    start: null,
    remindBefore: null,
    important: false,
    urgent: false,
    location: null,
    subtasks: [],
    candidates: [],
    confident: false,
  };
  if (!text) return empty;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const candidates = judgeDates(text, today);
  const best = candidates.find((c) => c.role !== "publish") as
    (DateCandidate & { _end?: number }) | undefined;

  let due: DueTime | null = best ? { date: best.date, time: best.time } : null;
  let actionPos = best?._end ?? -1;
  if (!best) {
    const t = timeOnly(text, now, today);
    if (t) {
      due = t.due;
      actionPos = t.end;
    }
  }

  const { items, listStart } = splitItems(text);
  const subtasks = items.map((it) => recognizeItem(it, today));
  const location = findLocation(text);
  const role = best?.role ?? (due ? "event" : null);
  const isMeeting = new RegExp(`(?:${MEETING_WORDS})(?![室厅])`).test(text);

  // 标题：日期落在清单里时，事项属于子任务，主标题取通知抬头
  const dateInList = listStart >= 0 && actionPos > listStart;
  let title =
    (isMeeting && role === "event" ? meetingTitle(text) : "") ||
    (actionPos >= 0 && !dateInList ? actionAfter(text, actionPos) : "") ||
    headline(text);
  if (location && role === "event" && !title.includes(location)) {
    title = clip(`${title} @${location}`, 50);
  }

  const urgent = /紧急|加急|特急|立即|马上|尽快|火速/.test(text);
  const important =
    urgent || /务必|重要|逾期不候|不得延误|严禁|必须/.test(text);

  // 提醒：有具体时刻的活动提前 30 分钟；截止 / 时间段提前一天；普通提及不主动建议
  const remindBefore =
    role === "event" && due?.time
      ? 30
      : role === "deadline" || role === "range"
        ? 1440
        : null;

  const top = candidates.filter((c) => c.role !== "publish");
  const confident =
    !!best &&
    !best.past &&
    (best.role === "deadline" ||
      best.role === "event" ||
      best.role === "range") &&
    !(top[1] && Math.abs(top[1].score - best.score) < 0.01) &&
    !!title;

  return {
    title,
    due,
    start: best?.role === "range" ? (best.start ?? null) : null,
    remindBefore,
    important,
    urgent,
    location,
    subtasks,
    candidates: candidates.map(({ ...c }) => {
      delete (c as { _end?: number })._end;
      return c;
    }),
    confident,
  };
}
