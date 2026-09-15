import { describe, expect, it } from "vitest";

import {
  clampRepeat,
  clampVolume,
  parseSoundSpec,
  serializeSoundSpec,
  type SoundSpec,
} from "./reminderSound";
import { REMINDER_PRESETS } from "./soundPresets";

/**
 * 配置值 ↔ SoundSpec 的解析是提示音链路唯一的"脏输入"入口：
 * app_config 表可被同步 / 外部工具 / 老版本写入任意字符串，
 * 解析一旦抛错或返回 undefined，到点提醒就彻底不响 —— 比响错严重得多。
 * 所以这里重点覆盖各种畸形输入都能落到合法预设上。
 */
describe("parseSoundSpec", () => {
  it("识别 preset: 前缀与裸预设 id", () => {
    expect(parseSoundSpec("preset:bell", "ding")).toEqual({ kind: "preset", id: "bell" });
    // 裸 id 是老配置形态，仍要兼容
    expect(parseSoundSpec("bell", "ding")).toEqual({ kind: "preset", id: "bell" });
  });

  it("识别 custom: 前缀并保留原文件名（含空格/中文/点）", () => {
    expect(parseSoundSpec("custom:我的 铃声.v2.mp3", "ding")).toEqual({
      kind: "custom",
      fileName: "我的 铃声.v2.mp3",
    });
  });

  it.each([
    ["", "空字符串"],
    ["   ", "纯空白"],
    ["preset:", "空预设 id"],
    ["preset:nope", "不存在的预设"],
    ["custom:", "空文件名"],
    ["custom:   ", "全空白文件名"],
    ["{}", "垃圾值"],
  ])("畸形输入 %s（%s）回退到 fallback", (raw) => {
    expect(parseSoundSpec(raw, "alarm")).toEqual({ kind: "preset", id: "alarm" });
  });

  it("null / undefined 回退到 fallback", () => {
    expect(parseSoundSpec(null, "chime")).toEqual({ kind: "preset", id: "chime" });
    expect(parseSoundSpec(undefined, "chime")).toEqual({ kind: "preset", id: "chime" });
  });

  it("序列化后再解析应还原（所有预设 + 自定义）", () => {
    const specs: SoundSpec[] = [
      ...REMINDER_PRESETS.map((p) => ({ kind: "preset" as const, id: p.id })),
      { kind: "custom", fileName: "alarm-1.wav" },
    ];
    for (const spec of specs) {
      expect(parseSoundSpec(serializeSoundSpec(spec), "ding")).toEqual(spec);
    }
  });
});

describe("clampVolume / clampRepeat", () => {
  it("音量夹到 0~1，非法值回默认", () => {
    expect(clampVolume(0.5)).toBe(0.5);
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(3)).toBe(1);
    expect(clampVolume(Number.NaN)).toBe(0.8);
  });

  it("连响次数夹到 1~5 且取整，非法值回默认", () => {
    expect(clampRepeat(3)).toBe(3);
    expect(clampRepeat(0)).toBe(1);
    expect(clampRepeat(99)).toBe(5);
    expect(clampRepeat(2.4)).toBe(2);
    expect(clampRepeat(Number.NaN)).toBe(1);
  });
});

describe("预设表自身", () => {
  it("id 唯一且时长为正（时长参与循环响铃的间隔计算，为 0 会导致叠音）", () => {
    const ids = REMINDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of REMINDER_PRESETS) {
      expect(p.durationMs).toBeGreaterThan(0);
      expect(p.label.length).toBeGreaterThan(0);
    }
  });
});
