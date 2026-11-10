import { describe, expect, it } from "vitest";
import { dailyToPlainLines, parseDailyTimeline } from "./dailyTimeline";

describe("parseDailyTimeline", () => {
  it("首页「记一笔」的 HTML 写法", () => {
    const c = "<p><strong>[09:12]</strong> 过了一遍群反馈</p><p><strong>[14:30]</strong> 手机端 &lt;重做&gt;<br>第二行</p>";
    expect(parseDailyTimeline(c)).toEqual({
      entries: [
        { time: "09:12", text: "过了一遍群反馈" },
        { time: "14:30", text: "手机端 <重做>" },
      ],
      rest: ["第二行"],
    });
  });

  it("编辑器存回的 Markdown 写法（含转义方括号）", () => {
    const c = "# 今天\n\n**[09:12]** 修好了 [[md 属性块解析]]\n\n**\\[9:05\\]** 早起\n\n普通一段";
    expect(parseDailyTimeline(c)).toEqual({
      entries: [
        { time: "09:12", text: "修好了 [[md 属性块解析]]" },
        { time: "09:05", text: "早起" },
      ],
      rest: ["今天", "普通一段"],
    });
  });

  it("闪念捕获的 callout：时间单独一行，正文归它，callout 之后的段落不被吞", () => {
    const c = '前言\n\n<div data-callout="info"><p>🕐 10:20</p><p>想法一</p><p>想法二</p></div>\n\n后记';
    expect(parseDailyTimeline(c)).toEqual({
      entries: [{ time: "10:20", text: "想法一\n想法二" }],
      rest: ["前言", "后记"],
    });
  });

  it("callout 经编辑器存成 > 引用块后也认", () => {
    const c = "> [!info]\n> 🕐 10:20\n> 想法一\n\n> 普通引用\n\n后记";
    expect(parseDailyTimeline(c)).toEqual({
      entries: [{ time: "10:20", text: "想法一" }],
      rest: ["普通引用", "后记"],
    });
  });

  it("空内容 / 只有时间没有正文", () => {
    expect(parseDailyTimeline("")).toEqual({ entries: [], rest: [] });
    expect(parseDailyTimeline(null)).toEqual({ entries: [], rest: [] });
    expect(parseDailyTimeline("<p><strong>[09:00]</strong></p>")).toEqual({ entries: [], rest: [] });
  });
});

describe("dailyToPlainLines", () => {
  it("去掉列表 / 任务 / 链接 / 图片 / 强调标记，保留双链", () => {
    expect(dailyToPlainLines("- [x] 完成 **A**\n1. 看 [文档](https://x.y)\n![](a.png)\n---\n[[笔记]]")).toEqual([
      "完成 A",
      "看 文档",
      "[图片]",
      "[[笔记]]",
    ]);
  });
});
