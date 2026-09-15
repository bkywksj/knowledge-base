/**
 * 待办提醒提示音引擎：预设合成音 + 用户自定义音频文件，统一一个播放入口。
 *
 * ## 两条播放通道
 * - **预设**（`soundPresets.ts`）→ Web Audio 实时合成，音量走 GainNode
 * - **自定义**（用户导入的 mp3/wav/…）→ `<audio src=convertFileSrc(abs)>`，音量走
 *   `HTMLMediaElement.volume`
 *
 * 自定义没有走 Web Audio 的 `decodeAudioData`，是因为那要 `fetch()` asset URL，
 * 而 `tauri.conf.json` 的 CSP 里 `connect-src` **不含** `asset:` / `http://asset.localhost`
 * （只有 `media-src` 含），fetch 会被直接拦掉。`<audio>` 元素走的是 media-src，能放。
 *
 * ## 失效兜底
 * 自定义文件被用户在资源管理器里删了 / 解码失败 → 自动回退到预设音再响一次。
 * 提醒响错 < 提醒不响：宁可换个音也不能静默失败，否则用户会错过待办还不知道为什么。
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import { configApi, reminderSoundApi } from "@/lib/api";
import {
  DEFAULT_PRESET_ID,
  DEFAULT_URGENT_PRESET_ID,
  getPreset,
  isPresetId,
  type ReminderPresetId,
} from "@/lib/audio/soundPresets";

export type SoundSpec =
  | { kind: "preset"; id: ReminderPresetId }
  | { kind: "custom"; fileName: string };

/** 提示音相关的全部用户设置（存在 app_config 表，跨窗口共享） */
export interface ReminderSoundSettings {
  /** 总开关。关掉后所有提醒都静音（弹窗/闪烁照旧） */
  enabled: boolean;
  /** 普通（强烈级）提醒用的音 */
  normal: SoundSpec;
  /** 紧急（全屏接管窗）循环响铃用的音 */
  urgent: SoundSpec;
  /** 主音量 0~1 */
  volume: number;
  /** 普通提醒连响几遍（1~5）。"不够明显"最直接的解法之一 */
  repeat: number;
}

// ─── 配置键 ──────────────────────────────────────────────────────────
export const CFG_ENABLED = "reminder_sound_enabled";
export const CFG_NORMAL = "reminder_sound_normal";
export const CFG_URGENT = "reminder_sound_urgent";
export const CFG_VOLUME = "reminder_sound_volume";
export const CFG_REPEAT = "reminder_sound_repeat";

export const DEFAULT_SETTINGS: ReminderSoundSettings = {
  enabled: true,
  normal: { kind: "preset", id: DEFAULT_PRESET_ID },
  urgent: { kind: "preset", id: DEFAULT_URGENT_PRESET_ID },
  volume: 0.8,
  repeat: 1,
};

/** 自定义音频相对预设的音量折算系数。
 * 预设合成音内部峰值约 0.5，而用户导入的成品音频基本都做过响度归一化（接近满幅），
 * 同一个主音量下直接播会比预设响一大截。乘个系数让两条通道听感接近，
 * 用户在"预设↔自定义"之间切换时不会被突然炸到。 */
const CUSTOM_GAIN_TRIM = 0.7;

// ─── 序列化：配置里存 `preset:<id>` / `custom:<文件名>` ────────────────

export function serializeSoundSpec(spec: SoundSpec): string {
  return spec.kind === "preset" ? `preset:${spec.id}` : `custom:${spec.fileName}`;
}

/**
 * 解析配置值。任何无法识别的值（老版本、手改过 DB、自定义文件名被清空）
 * 都回退到 `fallback`，绝不抛错 —— 解析失败导致提醒不响是最坏结果。
 */
export function parseSoundSpec(
  raw: string | null | undefined,
  fallback: ReminderPresetId,
): SoundSpec {
  const v = (raw ?? "").trim();
  if (v.startsWith("custom:")) {
    const fileName = v.slice("custom:".length).trim();
    if (fileName) return { kind: "custom", fileName };
    return { kind: "preset", id: fallback };
  }
  const id = v.startsWith("preset:") ? v.slice("preset:".length).trim() : v;
  return { kind: "preset", id: isPresetId(id) ? id : fallback };
}

// ─── 设置读取（带进程内缓存） ──────────────────────────────────────────

let cached: ReminderSoundSettings | null = null;
let inflight: Promise<ReminderSoundSettings> | null = null;

/** 设置页改完调一次，让下次提醒立刻用新值（同一 webview 内有效） */
export function invalidateReminderSoundSettings(): void {
  cached = null;
  inflight = null;
}

/** 设置页保存后直接把新值灌进缓存，省掉一次往返 */
export function primeReminderSoundSettings(s: ReminderSoundSettings): void {
  cached = s;
  inflight = null;
}

/**
 * 读某个配置键；不存在（后端抛 NotFound）或读失败都返回 null。
 *
 * 只取自己这 5 个键、不用 `get_all_config`：后者会把整张 app_config（含 asr.api_key
 * 这类跟提示音毫不相干的条目）拉进这个模块，没必要。5 个 get 是并发发的，没多一轮往返。
 */
async function readKey(key: string): Promise<string | null> {
  try {
    return await configApi.get(key);
  } catch {
    return null;
  }
}

/** 读取提示音设置（进程内缓存 + 并发去重） */
export async function getReminderSoundSettings(): Promise<ReminderSoundSettings> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const [enabled, normal, urgent, volume, repeat] = await Promise.all([
        readKey(CFG_ENABLED),
        readKey(CFG_NORMAL),
        readKey(CFG_URGENT),
        readKey(CFG_VOLUME),
        readKey(CFG_REPEAT),
      ]);
      const s: ReminderSoundSettings = {
        enabled: enabled !== "0",
        normal: parseSoundSpec(normal, DEFAULT_PRESET_ID),
        urgent: parseSoundSpec(urgent, DEFAULT_URGENT_PRESET_ID),
        volume: volume === null ? DEFAULT_SETTINGS.volume : clampVolume(Number(volume)),
        repeat: repeat === null ? DEFAULT_SETTINGS.repeat : clampRepeat(Number(repeat)),
      };
      cached = s;
      return s;
    } catch (e) {
      // 兜底：理论上 readKey 已吞掉所有错误，这里防的是意料之外的异常——
      // 读配置失败绝不能让提醒哑掉，用默认值照响
      console.warn("[reminderSound] 读取提示音设置失败，使用默认值:", e);
      return DEFAULT_SETTINGS;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_SETTINGS.volume;
  return Math.min(1, Math.max(0, v));
}

export function clampRepeat(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_SETTINGS.repeat;
  return Math.min(5, Math.max(1, Math.round(v)));
}

// ─── AudioContext ────────────────────────────────────────────────────

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

// ─── 自定义音频路径解析（带缓存） ──────────────────────────────────────

/** fileName → asset URL。解析一次即可，文件不会在运行期换位置 */
const customUrlCache = new Map<string, string>();

async function resolveCustomUrl(fileName: string): Promise<string> {
  const hit = customUrlCache.get(fileName);
  if (hit) return hit;
  const abs = await reminderSoundApi.resolve(fileName);
  const url = convertFileSrc(abs);
  customUrlCache.set(fileName, url);
  return url;
}

/** 用户删除 / 重新导入自定义音后调，避免拿着失效 URL 播不出声 */
export function clearCustomSoundCache(fileName?: string): void {
  if (fileName) customUrlCache.delete(fileName);
  else customUrlCache.clear();
}

// ─── 播放 ────────────────────────────────────────────────────────────

export interface PlayOptions {
  /** 0~1 主音量 */
  volume?: number;
  /** 连响几遍，默认 1 */
  repeat?: number;
  /** 自定义音失效时回退到哪个预设 */
  fallbackPreset?: ReminderPresetId;
  /**
   * 这一次（含 repeat 遍）真正放完时回调。中途 stop **不会**触发。
   * 循环响铃靠它决定下一声什么时候起——自定义音频长度未知，只能等它自己报完。
   */
  onFinished?: () => void;
}

/**
 * 播放一次（或连响 repeat 遍）提示音。返回的 stop 用于中途打断。
 *
 * 同步返回 stop（而不是 Promise）是为了让调用方在 React 的 cleanup 里直接用；
 * 自定义音的异步解析在内部自己处理，解析期间调用 stop 也会正确取消。
 */
export function playSound(spec: SoundSpec, opts: PlayOptions = {}): () => void {
  const volume = clampVolume(opts.volume ?? DEFAULT_SETTINGS.volume);
  const repeat = clampRepeat(opts.repeat ?? 1);
  const fallback = opts.fallbackPreset ?? DEFAULT_PRESET_ID;
  const onFinished = opts.onFinished;
  if (volume <= 0) {
    // 静音也要报完成，否则循环响铃会卡在这里不再调度
    onFinished?.();
    return () => {};
  }

  if (spec.kind === "preset") {
    return playPreset(spec.id, volume, repeat, onFinished);
  }

  let cancelled = false;
  let stopInner: (() => void) | null = null;
  const toFallback = () => {
    if (cancelled) return;
    stopInner = playPreset(fallback, volume, repeat, onFinished);
  };
  void (async () => {
    try {
      const url = await resolveCustomUrl(spec.fileName);
      if (cancelled) return;
      stopInner = playCustom(url, volume, repeat, {
        // 播放期出错（解码失败 / 文件损坏）→ 补一遍预设，别让提醒静默
        onError: toFallback,
        onFinished,
      });
    } catch (e) {
      console.warn(`[reminderSound] 自定义提示音 ${spec.fileName} 不可用，回退预设:`, e);
      clearCustomSoundCache(spec.fileName);
      toFallback();
    }
  })();

  return () => {
    cancelled = true;
    stopInner?.();
  };
}

/** 合成预设音，repeat 遍之间留 120ms 间隙，听感上是"连响"而不是糊成一片 */
function playPreset(
  id: ReminderPresetId,
  volume: number,
  repeat: number,
  onFinished?: () => void,
): () => void {
  const ctx = getCtx();
  if (!ctx) {
    // 拿不到 AudioContext（极老 WebView / 被禁用）→ 立刻报完成，别卡住循环
    onFinished?.();
    return () => {};
  }
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});

  const preset = getPreset(id);
  const master = ctx.createGain();
  master.gain.value = volume;
  master.connect(ctx.destination);

  const gap = 0.12;
  const step = preset.durationMs / 1000 + gap;
  const t0 = ctx.currentTime + 0.02; // 留一点调度余量，避免首声被削
  for (let i = 0; i < repeat; i++) {
    preset.render({ ctx, dest: master, t0: t0 + i * step });
  }

  // 合成音时长是已知的，直接定时报完成（Web Audio 没有"播完"事件）
  let stopped = false;
  const doneTimer = window.setTimeout(
    () => {
      if (!stopped) onFinished?.();
    },
    step * repeat * 1000 + 30,
  );

  return () => {
    stopped = true;
    window.clearTimeout(doneTimer);
    // 20ms 淡出后断开：直接 disconnect 会"咔"一声
    try {
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.linearRampToValueAtTime(0, now + 0.02);
      window.setTimeout(() => master.disconnect(), 60);
    } catch {
      try {
        master.disconnect();
      } catch {
        /* 已断开 */
      }
    }
  };
}

/**
 * 播放自定义音频文件。
 *
 * `onError` 交给调用方决定是否回退预设；`onFinished` 在**真正播完**（含 repeat 遍）时触发，
 * 循环响铃靠它接上下一声 —— 自定义文件可能 3 秒也可能 30 秒，按固定间隔轮询一定会切音。
 * 出错时只走 onError（回退的预设自己会报 onFinished），不重复触发。
 */
function playCustom(
  url: string,
  volume: number,
  repeat: number,
  cb: { onError: () => void; onFinished?: () => void },
): () => void {
  let left = repeat;
  let cancelled = false;
  let errored = false;
  const audio = new Audio(url);
  audio.volume = clampVolume(volume * CUSTOM_GAIN_TRIM);
  audio.preload = "auto";

  const fail = (e: unknown) => {
    if (cancelled || errored) return;
    errored = true;
    console.warn("[reminderSound] 自定义提示音播放失败:", e);
    cb.onError();
  };

  const kick = () => {
    if (cancelled) return;
    audio.currentTime = 0;
    audio.play().catch(fail);
  };

  audio.addEventListener("ended", () => {
    if (cancelled || errored) return;
    left -= 1;
    if (left > 0) kick();
    else cb.onFinished?.();
  });
  audio.addEventListener("error", () => fail(audio.error));
  kick();

  return () => {
    cancelled = true;
    try {
      audio.pause();
      audio.src = "";
    } catch {
      /* 元素已回收 */
    }
  };
}

// ─── 循环响铃（紧急提醒窗用） ────────────────────────────────────────

export interface LoopOptions extends PlayOptions {
  /** 上一声**放完**到下一声开始的静默间隔（毫秒），默认 1100 */
  gapMs?: number;
  /** 最长响多久（毫秒）；到点自动停声并回调 onAutoStop。不传 = 不封顶 */
  maxDurationMs?: number;
  onAutoStop?: () => void;
}

/**
 * 循环响铃，返回 stop 函数（必须在窗口关闭前调用以释放资源）。
 *
 * ## 为什么不是 setInterval
 * 早期版本按固定 1.5s 轮询，对"叮咚"这种 0.45s 的短音刚好，但：
 * - 钟声（1.75s）/ 警笛（1.45s）会被下一声压上来，糊成一团噪音
 * - 用户导入的自定义音频长度完全未知，3 秒的铃声每 1.5s 就被砍一刀
 *
 * 改成「等这一声报完 → 静默 gapMs → 起下一声」的链式调度，多长的音都不会被切。
 */
export function startSoundLoop(spec: SoundSpec, opts: LoopOptions = {}): () => void {
  const volume = clampVolume(opts.volume ?? DEFAULT_SETTINGS.volume);
  if (volume <= 0) return () => {};

  const gap = Math.max(200, opts.gapMs ?? 1100);

  let cancelled = false;
  let stopCurrent: (() => void) | null = null;
  let timer: number | undefined;
  let maxTimer: number | undefined;

  const clearAll = () => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    if (maxTimer !== undefined) {
      window.clearTimeout(maxTimer);
      maxTimer = undefined;
    }
  };

  const tick = () => {
    if (cancelled) return;
    stopCurrent?.();
    stopCurrent = playSound(spec, {
      volume,
      repeat: 1,
      fallbackPreset: opts.fallbackPreset ?? DEFAULT_URGENT_PRESET_ID,
      onFinished: () => {
        if (cancelled) return;
        timer = window.setTimeout(tick, gap);
      },
    });
  };
  tick();

  if (opts.maxDurationMs !== undefined && opts.maxDurationMs > 0) {
    maxTimer = window.setTimeout(() => {
      if (cancelled) return;
      cancelled = true;
      clearAll();
      stopCurrent?.();
      opts.onAutoStop?.();
    }, opts.maxDurationMs);
  }

  return () => {
    cancelled = true;
    clearAll();
    stopCurrent?.();
  };
}

// ─── 给业务侧的两个便捷入口 ──────────────────────────────────────────

/** 普通（强烈级）待办提醒：读设置 → 按设置连响。总开关关闭时什么也不做 */
export async function playNormalReminder(): Promise<void> {
  const s = await getReminderSoundSettings();
  if (!s.enabled) return;
  playSound(s.normal, {
    volume: s.volume,
    repeat: s.repeat,
    fallbackPreset: DEFAULT_PRESET_ID,
  });
}

/** 紧急待办循环响铃：读设置 → 起循环。总开关关闭时返回空 stop */
export async function startUrgentReminderLoop(
  maxDurationMs: number,
  onAutoStop?: () => void,
): Promise<() => void> {
  const s = await getReminderSoundSettings();
  if (!s.enabled) return () => {};
  return startSoundLoop(s.urgent, {
    volume: s.volume,
    gapMs: 1100,
    maxDurationMs,
    onAutoStop,
    fallbackPreset: DEFAULT_URGENT_PRESET_ID,
  });
}
