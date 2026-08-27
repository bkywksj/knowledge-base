import { describe, it, expect } from "vitest";
import {
  accumulateWheelSteps,
  resetOnDirectionChange,
  WHEEL_STEP_THRESHOLD,
} from "./wheelZoomStep";

describe("Ctrl+滚轮 步进累加", () => {
  it("鼠标滚轮一格（deltaY=100）正好走一档", () => {
    // 向下滚 = 缩小 = -1
    expect(accumulateWheelSteps(0, WHEEL_STEP_THRESHOLD)).toEqual({
      steps: -1,
      rest: 0,
    });
    // 向上滚 = 放大 = +1
    expect(accumulateWheelSteps(0, -WHEEL_STEP_THRESHOLD)).toEqual({
      steps: 1,
      rest: 0,
    });
  });

  it("触控板细碎事件攒够才走一档（否则一划就冲到上限）", () => {
    let acc = 0;
    let fired = 0;
    // 模拟触控板：20 个 deltaY=-8 的事件，总量 -160
    for (let i = 0; i < 20; i++) {
      const r = accumulateWheelSteps(acc, -8);
      acc = r.rest;
      fired += r.steps;
    }
    // 总量 160 → 只该走 1 档，余 60
    expect(fired).toBe(1);
    expect(acc).toBe(-60);
  });

  it("不足阈值不动，余量累计保留", () => {
    const r1 = accumulateWheelSteps(0, -40);
    expect(r1.steps).toBe(0);
    expect(r1.rest).toBe(-40);
    const r2 = accumulateWheelSteps(r1.rest, -40);
    expect(r2.steps).toBe(0);
    expect(r2.rest).toBe(-80);
    const r3 = accumulateWheelSteps(r2.rest, -40);
    expect(r3.steps).toBe(1); // -120 → 1 档
    expect(r3.rest).toBe(-20);
  });

  it("一次大 delta 可以走多档", () => {
    expect(accumulateWheelSteps(0, -350)).toEqual({ steps: 3, rest: -50 });
  });

  it("deltaY=0 不动", () => {
    expect(accumulateWheelSteps(30, 0)).toEqual({ steps: 0, rest: 30 });
  });
});

describe("方向翻转清零", () => {
  it("同向时余量保留", () => {
    expect(resetOnDirectionChange(-60, -10)).toBe(-60);
    expect(resetOnDirectionChange(60, 10)).toBe(60);
  });

  it("反向时立即清零（否则手感发粘）", () => {
    // 先向下攒了 +80，改向上滚：那 80 不该抵消用户想放大的意图
    expect(resetOnDirectionChange(80, -10)).toBe(0);
    expect(resetOnDirectionChange(-80, 10)).toBe(0);
  });

  it("余量为 0 或 delta 为 0 时原样返回", () => {
    expect(resetOnDirectionChange(0, -10)).toBe(0);
    expect(resetOnDirectionChange(50, 0)).toBe(50);
  });

  it("翻转后重新攒满仍是一档（组合验证）", () => {
    let acc = 80; // 之前向下攒的
    acc = resetOnDirectionChange(acc, -100); // 翻转 → 清零
    const r = accumulateWheelSteps(acc, -100);
    expect(r.steps).toBe(1);
  });
});
