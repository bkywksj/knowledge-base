import { describe, expect, it } from "vitest";
import { buildYearHeatmap, heatLevel, localYmd } from "./writingHeatmap";

const stat = (date: string, word_count: number) => ({ date, note_count: 1, word_count });

describe("heatLevel", () => {
  it("没写 / 整段没数据都是 0 档", () => {
    expect(heatLevel(0, 100)).toBe(0);
    expect(heatLevel(5, 0)).toBe(0);
  });

  it("按 sqrt(字数/最大值) 分四档，最大值那天一定是 4 档", () => {
    expect(heatLevel(100, 100)).toBe(4);
    expect(heatLevel(1, 10000)).toBe(1); // sqrt = 0.01
    expect(heatLevel(1000, 10000)).toBe(2); // sqrt ≈ 0.316
    expect(heatLevel(4000, 10000)).toBe(3); // sqrt ≈ 0.632
  });

  it("一篇超长文不会把几百字的日子压成看不见（sqrt 压缩）", () => {
    // 线性下 500/50000 = 1%，几乎看不出；sqrt 后 0.1 → 仍是第 1 档、有颜色
    expect(heatLevel(500, 50000)).toBeGreaterThan(0);
  });
});

describe("buildYearHeatmap", () => {
  // 2026-11-03 是周二
  const today = new Date(2026, 10, 3, 21, 30);

  it("53 列 × 7 行，最后一列是本周、从周一开始", () => {
    const hm = buildYearHeatmap([], today);
    expect(hm.columns).toHaveLength(53);
    hm.columns.forEach((c) => expect(c).toHaveLength(7));
    const last = hm.columns[52];
    expect(last[0].date).toBe("2026-11-02"); // 周一
    expect(last[1].date).toBe("2026-11-03"); // 今天
  });

  it("今天之后的格子标 future，不计入字数", () => {
    const hm = buildYearHeatmap([stat("2026-11-05", 999)], today);
    const last = hm.columns[52];
    expect(last[1].future).toBe(false);
    expect(last[2].future).toBe(true);
    expect(last[3].words).toBe(0);
    expect(hm.max).toBe(0);
  });

  it("字数落到对应日期格，并统计最大值与有写作的天数", () => {
    const hm = buildYearHeatmap(
      [stat("2026-11-03", 300), stat("2026-11-02", 1200), stat("2026-01-15", 50)],
      today,
    );
    const last = hm.columns[52];
    expect(last[0].words).toBe(1200);
    expect(last[0].level).toBe(4);
    expect(last[1].words).toBe(300);
    expect(hm.max).toBe(1200);
    expect(hm.activeDays).toBe(3);
  });

  it("区间之外的数据忽略", () => {
    const hm = buildYearHeatmap([stat("2024-01-01", 99999)], today);
    expect(hm.max).toBe(0);
  });

  it("跨年：一月初的今天，本周这一列横跨两年，最早一列在 53 周前", () => {
    // 2026-01-02 是周五 → 本周周一是 2025-12-29；往前 52 周 = 2024-12-30
    const hm = buildYearHeatmap([stat("2025-12-31", 80)], new Date(2026, 0, 2));
    const last = hm.columns[52];
    expect(last[0].date).toBe("2025-12-29");
    expect(last[4].date).toBe("2026-01-02");
    expect(last[2].words).toBe(80);
    expect(hm.columns[0][0].date).toBe("2024-12-30");
  });

  it("月份标签按列递增、不重叠（相邻至少隔 3 列）", () => {
    const hm = buildYearHeatmap([], today);
    expect(hm.months.length).toBeGreaterThanOrEqual(12);
    for (let i = 1; i < hm.months.length; i++) {
      expect(hm.months[i].col - hm.months[i - 1].col).toBeGreaterThanOrEqual(3);
    }
    // 本月（11 月）的标签在最后几列
    const nov = hm.months.filter((m) => m.label === "11月");
    expect(nov[nov.length - 1].col).toBeGreaterThanOrEqual(48);
  });

  it("localYmd 用本地时区，不受 UTC 偏移影响", () => {
    expect(localYmd(new Date(2026, 10, 3, 0, 5))).toBe("2026-11-03");
  });
});
