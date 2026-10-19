import { describe, expect, it } from "vitest";

import { parseTaskText } from "./taskTextParser";

// 2026-10-19 周一 10:00
const NOW = new Date(2026, 9, 19, 10, 0, 0);
const parse = (s: string) => parseTaskText(s, NOW);

describe("parseTaskText", () => {
  it("群里的原例：通知 + 完整日期 → 标题取日期后的动作", () => {
    const r = parse("某某通知，2026年10月26日上交销售数据。具体要求如下。");
    expect(r.title).toBe("上交销售数据");
    expect(r.due).toEqual({ date: "2026-10-26", time: null });
  });

  it("「X日前将…」去掉「前 / 将」，逗号后的补充不进标题", () => {
    const r = parse("请各部门于10月30日前将季度报表报送至财务处，逾期不候。");
    expect(r.title).toBe("季度报表报送至财务处");
    expect(r.due?.date).toBe("2026-10-30");
  });

  it("会议：时间 + 会议名称", () => {
    const r = parse(
      "定于10月25日下午2点在三楼会议室召开季度总结会，请准时参加。",
    );
    expect(r.title).toBe("季度总结会");
    expect(r.due).toEqual({ date: "2026-10-25", time: "14:00" });
  });

  it("多个日期：跳过已过去的发文日期，取第一个未来日期", () => {
    const r = parse("10月15日发布的通知要求，10月28日下午3点半前提交材料。");
    expect(r.due).toEqual({ date: "2026-10-28", time: "15:30" });
    expect(r.title).toBe("提交材料");
  });

  it("相对日期与星期", () => {
    expect(parse("明天上午9点交周报").due).toEqual({
      date: "2026-10-20",
      time: "09:00",
    });
    expect(parse("下周三之前完成设计稿").due?.date).toBe("2026-10-28");
    expect(parse("周日打扫卫生").due?.date).toBe("2026-10-25");
  });

  it("中文数字日期与 HH:mm 时间", () => {
    expect(parse("十一月三号 14:30 复诊").due).toEqual({
      date: "2026-11-03",
      time: "14:30",
    });
  });

  it("只有时间没有日期：今天，已过则明天", () => {
    expect(parse("下午3点开会讨论").due).toEqual({
      date: "2026-10-19",
      time: "15:00",
    });
    expect(parse("早上8点晨跑").due).toEqual({
      date: "2026-10-20",
      time: "08:00",
    });
  });

  it("跨年：12 月说「1月5日」指明年；近期过去的日期不推到明年", () => {
    const dec = new Date(2026, 11, 20, 10, 0, 0);
    expect(parseTaskText("1月5日前交年终总结", dec).due?.date).toBe(
      "2027-01-05",
    );
  });

  it("没有日期：标题取第一句，去掉「关于…的通知」外壳", () => {
    const r = parse("【重要】关于开展消防安全检查的通知\n各部门：请自查。");
    expect(r.title).toBe("开展消防安全检查");
    expect(r.due).toBeNull();
  });

  it("非法日期不识别", () => {
    expect(parse("2026年13月40日 测试").due).toBeNull();
  });

  it("空文本", () => {
    expect(parse("   ")).toEqual({ title: "", due: null });
  });
});
