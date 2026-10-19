/**
 * 从一段通知 / 消息里识别待办（本地规则，不联网、不耗 token）。
 *
 * 群里的需求原话：「仿照快递地址识别。如：某某通知，2026年10月26日上交销售数据。
 * 识别的话标题某销售数据，时间根据提供的时间直接先提取，有多个时间先提取第一个。
 * 会议的话更简单，时间 + 会议名称。全段内容直接放在描述里。」
 *
 * 只给出「建议」：调用方回填表单让用户确认，不直接落库；识别不准时可以再走 AI 识别。
 */

export interface ParsedTaskText {
  /** 建议标题；识别不出时为空串（调用方保留用户原标题） */
  title: string;
  /** 建议截止：date = YYYY-MM-DD；time = HH:mm，原文没写时间时为 null（由调用方补默认时间） */
  due: { date: string; time: string | null } | null;
}

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
    const mo = toNum(m[1]);
    const d = toNum(m[2]);
    let date = validDate(today.getFullYear(), mo, d);
    // 跨年：12 月说「1月5日」指明年。早于今天半年以上才认为是明年，
    // 免得把「10月15日发布的通知」这种近期过去的日期推到明年
    if (date && today.getTime() - date.getTime() > 180 * 86400_000) {
      date = validDate(today.getFullYear() + 1, mo, d);
    }
    push(m.index!, m.index! + m[0].length, date);
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

const MEETING_WORDS =
  "会议|例会|座谈会|研讨会|培训会|评审会|周会|月会|晨会|总结会|推进会|动员会|发布会|讨论会|启动会|交流会|复盘会";

function cleanTitle(s: string): string {
  return s
    .replace(/^[\s，,：:、。．.；;]+/, "")
    .replace(/[\s，,：:、。．.；;！!？?]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
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

/** 通知：取截止日期后面那半句（「…10月26日前上交销售数据。」→「上交销售数据」） */
function actionAfter(text: string, pos: number): string {
  const rest = text.slice(pos);
  // 只取到第一个逗号：后面多是「逾期不候」「并附说明」这类补充，不适合进标题
  const sentence = rest.split(/[。！？!?\n；;，,]/)[0] ?? "";
  const s = cleanTitle(
    sentence
      .replace(/^\s*(?:之前|以前|前|截止|为止|止)/, "")
      .replace(/^[\s，,：:、]+/, "")
      .replace(/^(?:请|务必|需要|须|需|要|应)/, "")
      .replace(/^(?:将|把)/, ""),
  );
  return s.length >= 2 && s.length <= 40 ? s : "";
}

/** 兜底：第一句话，去掉【】前缀和「关于…的通知」外壳 */
function firstSentence(text: string): string {
  let s = text.split(/[。！？!?\n]/).find((x) => x.trim()) ?? "";
  s = s.replace(/^【[^】]*】/, "").replace(/^(?:通知|公告|提醒)[：:]/, "");
  const about = /关于(.{2,40}?)的(?:通知|公告|提醒)/.exec(s);
  if (about) s = about[1];
  s = cleanTitle(s);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

export function parseTaskText(
  raw: string,
  now: Date = new Date(),
): ParsedTaskText {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (!text) return { title: "", due: null };
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const dates = findDates(text, today);
  // 「有多个时间先取第一个」——但跳过已经过去的（通知开头常写发文日期），全都过去了才用第一个
  const pick =
    dates.find((d) => d.date.getTime() >= today.getTime()) ?? dates[0] ?? null;

  let due: ParsedTaskText["due"] = null;
  let afterPos = -1;
  if (pick) {
    const t = readTime(text, pick.end);
    due = { date: ymd(pick.date), time: t?.time ?? null };
    afterPos = t?.end ?? pick.end;
  } else {
    // 只有时间没有日期（「下午3点开会」）→ 今天；时间已过则算明天
    for (const m of text.matchAll(
      /上午|早上|早晨|中午|下午|傍晚|晚上|凌晨|\d{1,2}\s*[:：]\s*\d{2}/g,
    )) {
      const t = readTime(text, m.index!);
      if (!t) continue;
      const [h, mi] = t.time.split(":").map(Number);
      const passed = h * 60 + mi <= now.getHours() * 60 + now.getMinutes();
      due = { date: ymd(passed ? addDays(today, 1) : today), time: t.time };
      afterPos = t.end;
      break;
    }
  }

  const isMeeting = new RegExp(`(?:${MEETING_WORDS})(?![室厅])`).test(text);
  const title =
    (isMeeting ? meetingTitle(text) : "") ||
    (afterPos >= 0 ? actionAfter(text, afterPos) : "") ||
    firstSentence(text);

  return { title, due };
}
