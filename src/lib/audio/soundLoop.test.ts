import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 循环响铃（紧急待办置顶弹窗）的调度测试。
 *
 * 为什么值得单测：这是整条提示音链路里唯一「停了就静默失败」的地方 ——
 * 紧急闹铃少响一声用户不会发现，直到错过一个重要待办。链式调度（等上一声报完
 * → 静默 gap → 起下一声）比 setInterval 更容易在某个分支上断掉，必须钉死。
 *
 * 测试环境是 node（见 vitest.config.ts），所以这里自己搭一套最小的
 * `window` + `AudioContext` 替身：只实现 reminderSound.ts 真正用到的那几个方法，
 * 靠"创建了几个振荡器"来判断响了几声。
 */

let oscCreated = 0;
let oscStarted = 0;

class FakeParam {
  value = 0;
  setValueAtTime() {
    return this;
  }
  exponentialRampToValueAtTime() {
    return this;
  }
  linearRampToValueAtTime() {
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
}

class FakeNode {
  connect(next: FakeNode) {
    return next;
  }
  disconnect() {}
}

class FakeOscillator extends FakeNode {
  type = "sine";
  frequency = new FakeParam();
  start() {
    oscStarted++;
  }
  stop() {}
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeAudioContext {
  currentTime = 0;
  state = "running";
  destination = new FakeNode();
  createOscillator() {
    oscCreated++;
    return new FakeOscillator();
  }
  createGain() {
    return new FakeGain();
  }
  resume() {
    return Promise.resolve();
  }
}

/** 拿一份全新的模块实例：模块级缓存了 AudioContext 与设置，跨用例必须隔离 */
async function freshModule() {
  vi.resetModules();
  return import("./reminderSound");
}

beforeEach(() => {
  oscCreated = 0;
  oscStarted = 0;
  // window === globalThis，这样 window.setTimeout 就是 vi 假定时器接管的那一个
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { window?: unknown }).window;
  delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
});

// 「叮咚」= 2 个振荡器一声；时长 450ms，连响间隙 120ms → 一声报完在 600ms 时
const OSC_PER_RING = 2;
const RING_DONE_MS = 600;

describe("startSoundLoop", () => {
  it("第一声立即响，之后每『放完 + gap』响一次", async () => {
    const { startSoundLoop } = await freshModule();
    const stop = startSoundLoop({ kind: "preset", id: "ding" }, { volume: 1, gapMs: 1000 });

    expect(oscCreated).toBe(OSC_PER_RING);
    expect(oscStarted).toBe(OSC_PER_RING);

    // 音还没放完 → 不该有下一声
    vi.advanceTimersByTime(RING_DONE_MS - 1);
    expect(oscCreated).toBe(OSC_PER_RING);

    // 放完了，但 gap 还没走完 → 仍然安静（关键：不能像 setInterval 那样压着上一声）
    vi.advanceTimersByTime(1 + 999);
    expect(oscCreated).toBe(OSC_PER_RING);

    // gap 到点 → 第二声
    vi.advanceTimersByTime(1);
    expect(oscCreated).toBe(OSC_PER_RING * 2);

    // 再走一整轮 → 第三声
    vi.advanceTimersByTime(RING_DONE_MS + 1000);
    expect(oscCreated).toBe(OSC_PER_RING * 3);

    stop();
  });

  it("stop 之后彻底不再响", async () => {
    const { startSoundLoop } = await freshModule();
    const stop = startSoundLoop({ kind: "preset", id: "ding" }, { volume: 1, gapMs: 500 });
    expect(oscCreated).toBe(OSC_PER_RING);

    stop();
    vi.advanceTimersByTime(60_000);
    expect(oscCreated).toBe(OSC_PER_RING);
  });

  it("到达 maxDurationMs 自动停声并回调 onAutoStop（窗口由调用方保留）", async () => {
    const { startSoundLoop } = await freshModule();
    const onAutoStop = vi.fn();
    startSoundLoop(
      { kind: "preset", id: "ding" },
      { volume: 1, gapMs: 400, maxDurationMs: 3_000, onAutoStop },
    );

    vi.advanceTimersByTime(2_999);
    expect(onAutoStop).not.toHaveBeenCalled();
    const ringsBeforeCap = oscCreated;
    expect(ringsBeforeCap).toBeGreaterThan(OSC_PER_RING); // 封顶前确实循环了

    vi.advanceTimersByTime(1);
    expect(onAutoStop).toHaveBeenCalledTimes(1);

    // 封顶后不再新增响铃
    vi.advanceTimersByTime(60_000);
    expect(oscCreated).toBe(ringsBeforeCap);
    expect(onAutoStop).toHaveBeenCalledTimes(1);
  });

  it("音量为 0 时不起循环（用户把音量拉到 0 = 静音）", async () => {
    const { startSoundLoop } = await freshModule();
    const stop = startSoundLoop({ kind: "preset", id: "ding" }, { volume: 0 });
    vi.advanceTimersByTime(30_000);
    expect(oscCreated).toBe(0);
    stop();
  });

  it("长音（钟声 1.75s）也要等它放完再排下一声", async () => {
    const { startSoundLoop } = await freshModule();
    // 钟声 4 个振荡器一声
    const stop = startSoundLoop({ kind: "preset", id: "bell" }, { volume: 1, gapMs: 1000 });
    expect(oscCreated).toBe(4);

    // 旧的固定 1.5s 轮询会在这里就压上第二声 —— 现在必须还是安静
    vi.advanceTimersByTime(1_500);
    expect(oscCreated).toBe(4);

    // 1750 + 120 + 30 = 1900ms 报完，再 +1000ms gap
    vi.advanceTimersByTime(1_900 - 1_500 + 1_000);
    expect(oscCreated).toBe(8);
    stop();
  });
});

describe("playSound 连响", () => {
  it("repeat=3 一次排 3 遍（普通提醒『连响 3 遍』）", async () => {
    const { playSound } = await freshModule();
    playSound({ kind: "preset", id: "ding" }, { volume: 1, repeat: 3 });
    expect(oscCreated).toBe(OSC_PER_RING * 3);
  });

  it("放完后回调 onFinished；中途 stop 则不回调", async () => {
    const { playSound } = await freshModule();
    const done = vi.fn();
    playSound({ kind: "preset", id: "ding" }, { volume: 1, onFinished: done });
    vi.advanceTimersByTime(RING_DONE_MS);
    expect(done).toHaveBeenCalledTimes(1);

    const done2 = vi.fn();
    const stop = playSound({ kind: "preset", id: "ding" }, { volume: 1, onFinished: done2 });
    stop();
    vi.advanceTimersByTime(10_000);
    expect(done2).not.toHaveBeenCalled();
  });
});
