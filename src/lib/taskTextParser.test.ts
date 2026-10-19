import { describe, expect, it } from "vitest";

import { recognizeTask } from "./taskTextParser";

// 2026-10-19 周一 10:00
const NOW = new Date(2026, 9, 19, 10, 0, 0);
const rec = (s: string) => recognizeTask(s, NOW);

describe("recognizeTask：日期身份", () => {
  it("群里的原例：通知 + 完整日期", () => {
    const r = rec("某某通知，2026年10月26日上交销售数据。具体要求如下。");
    expect(r.title).toBe("上交销售数据");
    expect(r.due).toEqual({ date: "2026-10-26", time: null });
  });

  it("截止优先于更早出现的普通日期 / 发文日期", () => {
    const r = rec(
      "各单位：根据10月15日印发的方案，请于10月30日前将季度报表报送至财务处，逾期不候。",
    );
    expect(r.due?.date).toBe("2026-10-30");
    expect(r.candidates[0].role).toBe("deadline");
    expect(r.title).toBe("季度报表报送至财务处");
    expect(r.important).toBe(true); // 逾期不候
    expect(r.remindBefore).toBe(1440);
    expect(r.confident).toBe(true);
  });

  it("落款日期（单独一行）不当截止", () => {
    const r = rec(
      "关于开展消防安全检查的通知\n请各部门10月28日前完成自查。\n2026年10月18日",
    );
    expect(r.due?.date).toBe("2026-10-28");
    expect(r.candidates.find((c) => c.date === "2026-10-18")?.role).toBe(
      "publish",
    );
  });

  it("会议：活动时间 + 会议名 + 地点，提醒提前 30 分钟", () => {
    const r = rec(
      "定于10月25日下午2点在三楼会议室召开季度总结会，请准时参加。",
    );
    expect(r.title).toBe("季度总结会 @三楼会议室");
    expect(r.due).toEqual({ date: "2026-10-25", time: "14:00" });
    expect(r.location).toBe("三楼会议室");
    expect(r.remindBefore).toBe(30);
  });

  it("时间段：起止都填", () => {
    const r = rec("10月20日至26日开展安全生产月检查活动");
    expect(r.start).toBe("2026-10-20");
    expect(r.due?.date).toBe("2026-10-26");
    expect(r.candidates[0].role).toBe("range");
  });

  it("截止与活动同在：截止分更高", () => {
    const r = rec("培训定于11月3日举行，请于10月28日前报名。");
    expect(r.due?.date).toBe("2026-10-28");
    expect(r.title).toBe("报名");
    // 另一个候选保留给 UI 切换
    expect(r.candidates.map((c) => c.date)).toContain("2026-11-03");
  });

  it("已过去的日期降权", () => {
    const r = rec("10月15日发布的通知要求，10月28日下午3点半前提交材料。");
    expect(r.due).toEqual({ date: "2026-10-28", time: "15:30" });
    expect(r.title).toBe("提交材料");
  });
});

describe("recognizeTask：清单拆子任务", () => {
  it("编号清单里各自的截止成为子任务，主标题取抬头", () => {
    const r = rec(
      "关于年度评优工作的通知\n1. 10月22日前提交个人申报表；\n2. 10月25日前完成部门推荐；\n3. 10月30日公示结果。",
    );
    expect(r.title).toBe("年度评优工作");
    expect(r.subtasks).toEqual([
      { title: "提交个人申报表", due: { date: "2026-10-22", time: null } },
      { title: "完成部门推荐", due: { date: "2026-10-25", time: null } },
      { title: "公示结果", due: { date: "2026-10-30", time: null } },
    ]);
  });

  it("抬头有截止、清单是要求：主任务取抬头事项，要求变成检查项", () => {
    const r = rec(
      "某某通知，2026年10月26日上交销售数据。具体要求如下：\n1. 按部门汇总；\n2. 附上同比环比分析。",
    );
    expect(r.title).toBe("上交销售数据");
    expect(r.subtasks.map((s) => s.title)).toEqual([
      "按部门汇总",
      "附上同比环比分析",
    ]);
  });

  it("同一行的「；2.」也能拆", () => {
    const r = rec("本周任务：1. 周三前交周报；2. 周五下午3点开复盘会");
    expect(r.subtasks).toHaveLength(2);
    expect(r.subtasks[1].due).toEqual({ date: "2026-10-23", time: "15:00" });
  });

  it("只有一项不算清单", () => {
    expect(rec("1. 明天交周报").subtasks).toEqual([]);
  });
});

describe("recognizeTask：其它", () => {
  it("相对日期 / 星期 / 中文数字 / HH:mm", () => {
    expect(rec("明天上午9点交周报").due).toEqual({
      date: "2026-10-20",
      time: "09:00",
    });
    expect(rec("下周三之前完成设计稿").due?.date).toBe("2026-10-28");
    expect(rec("十一月三号 14:30 复诊").due).toEqual({
      date: "2026-11-03",
      time: "14:30",
    });
  });

  it("只有时间没有日期：今天，已过则明天", () => {
    expect(rec("下午3点开会讨论").due).toEqual({
      date: "2026-10-19",
      time: "15:00",
    });
    expect(rec("早上8点晨跑").due).toEqual({
      date: "2026-10-20",
      time: "08:00",
    });
  });

  it("紧急词", () => {
    const r = rec("紧急！今天下班前把合同发给客户");
    expect(r.urgent).toBe(true);
    expect(r.important).toBe(true);
  });

  it("跨年", () => {
    const dec = new Date(2026, 11, 20, 10, 0, 0);
    expect(recognizeTask("1月5日前交年终总结", dec).due?.date).toBe(
      "2027-01-05",
    );
  });

  it("没有日期：不自信，标题取首句", () => {
    const r = rec("【重要】关于开展消防安全检查的通知\n各部门：请自查。");
    expect(r.title).toBe("开展消防安全检查");
    expect(r.due).toBeNull();
    expect(r.confident).toBe(false);
  });

  it("两个同身份同分日期：不自信（交给 AI 或用户挑）", () => {
    const r = rec("10月25日前交初稿，10月30日前交终稿");
    expect(r.confident).toBe(false);
  });

  it("非法日期 / 空文本", () => {
    expect(rec("2026年13月40日 测试").due).toBeNull();
    expect(rec("   ").title).toBe("");
  });
});
