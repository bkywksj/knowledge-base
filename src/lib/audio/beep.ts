/**
 * 基于 Web Audio API 的合成蜂鸣音。
 *
 * 选用合成而非音频文件：免维护资源、CSP/asset-protocol 不掺和、跨平台一致。
 * 单次蜂鸣给"强烈级"提醒（应用内 Modal 弹出时叮一声）；循环蜂鸣给"紧急级"
 * 全屏接管窗口（响到用户处理为止）。
 */

let sharedCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (sharedCtx && sharedCtx.state !== "closed") return sharedCtx;
  try {
    sharedCtx = new AudioContext();
    return sharedCtx;
  } catch {
    return null;
  }
}

/**
 * 播放一段双音"叮叮"（约 0.5s）。安全：用户未交互过的窗口会被浏览器静音，
 * 此时 oscillator.start 不会抛错，只是静默——可接受
 */
export function beepOnce(): void {
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => {});
  }
  const now = ctx.currentTime;
  playTone(ctx, 880, now, 0.18);
  playTone(ctx, 1175, now + 0.22, 0.18);
}

function playTone(ctx: AudioContext, freq: number, startAt: number, duration: number) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  // ADSR：避免 click pop 噪声
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.35, startAt + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.05);
}

/**
 * 循环蜂鸣（紧急级用）。返回 stop 函数，必须在窗口关闭前调用以释放资源。
 *
 * intervalMs 默认 1500ms，对应 ~40 次/分钟，足够吵但不至于让用户立即想砸键盘
 *
 * @param maxDurationMs 可选的最长响铃时长（毫秒）。到点后自动停止响铃并回调 onAutoStop，
 *   但**不关闭窗口**——避免提醒声音无限循环吵人（默认不传 = 不封顶，老行为）。
 * @param onAutoStop 到达 maxDurationMs 自动停声时触发（手动 stop 不触发），
 *   供调用方更新 UI（如把铃铛切到静音态）。
 */
export function startBeepLoop(
  intervalMs = 1500,
  maxDurationMs?: number,
  onAutoStop?: () => void,
): () => void {
  let cancelled = false;
  let timer: number | undefined;
  let maxTimer: number | undefined;

  const clearAll = () => {
    if (timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
    if (maxTimer !== undefined) {
      window.clearTimeout(maxTimer);
      maxTimer = undefined;
    }
  };

  const tick = () => {
    if (cancelled) return;
    beepOnce();
  };
  tick();
  timer = window.setInterval(tick, intervalMs);

  // 到达封顶时长 → 自动停声（保留窗口），并通知调用方
  if (maxDurationMs !== undefined && maxDurationMs > 0) {
    maxTimer = window.setTimeout(() => {
      if (cancelled) return;
      cancelled = true;
      clearAll();
      onAutoStop?.();
    }, maxDurationMs);
  }

  return () => {
    cancelled = true;
    clearAll();
  };
}
