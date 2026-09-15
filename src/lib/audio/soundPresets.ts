/**
 * 待办提醒内置提示音预设（Web Audio 实时合成）。
 *
 * ## 为什么全部合成、不打包音频文件
 * - 零资源体积、零 CSP / asset 协议纠缠（合成走 AudioContext，不经过网络层）
 * - 跨平台音色完全一致，不依赖系统解码器（Linux WebKitGTK 常缺 mp3/aac 解码）
 * - 用户想要"真实音效"时可以自己导入文件（见 reminderSound.ts 的 custom 分支）
 *
 * ## 音量口径
 * 每个预设内部的 `peak` 是**相对峰值**（0~1），最终还要乘设置里的主音量。
 * 方波 / 锯齿波谐波多、听感比同峰值的正弦响得多，所以它们的 peak 会明显调低，
 * 让各预设在同一主音量下听感接近，用户切换预设时不会被突然吵到。
 */

export type ReminderPresetId =
  | "ding"
  | "chime"
  | "bell"
  | "alarm"
  | "digital"
  | "siren"
  | "marimba"
  | "drop"
  | "knock";

export interface ReminderPreset {
  id: ReminderPresetId;
  /** 设置页下拉展示名 */
  label: string;
  /** 一句话音色描述，帮用户不试听也能大致选对 */
  hint: string;
  /** 完整时长（毫秒）。循环响铃时用它决定最小间隔，避免上一声没放完就叠下一声 */
  durationMs: number;
  /** 把这段音渲染进给定的 AudioContext（dest 已经是主音量节点） */
  render: (r: RenderTarget) => void;
}

export interface RenderTarget {
  ctx: AudioContext;
  dest: AudioNode;
  /** 起始时刻（ctx.currentTime 坐标系） */
  t0: number;
}

interface ToneOptions {
  /** 相对 t0 的偏移（秒） */
  at: number;
  dur: number;
  freq: number;
  /** 给定时在 dur 内指数滑到该频率（水滴 / 下滑音用） */
  freqTo?: number;
  type?: OscillatorType;
  peak?: number;
  /** 起振时间，默认 8ms。太短会有 click pop，太长听感发闷 */
  attack?: number;
}

/** 单个振荡器音，带 ADSR 包络（指数衰减，避免爆音） */
function tone(r: RenderTarget, o: ToneOptions): void {
  const start = r.t0 + o.at;
  const osc = r.ctx.createOscillator();
  const gain = r.ctx.createGain();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(o.freq, start);
  if (o.freqTo !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqTo), start + o.dur);
  }
  const peak = Math.max(0.0002, o.peak ?? 0.5);
  const attack = Math.min(o.attack ?? 0.008, o.dur * 0.4);
  // exponentialRamp 不能碰 0，统一用 0.0001 当"静音底"
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + o.dur);
  osc.connect(gain).connect(r.dest);
  osc.start(start);
  // 多留 50ms 再 stop：节点自动断开由 GC 负责，提前 stop 会把尾音削掉
  osc.stop(start + o.dur + 0.05);
}

/** 按折线路径扫频（警笛用）。points = [[相对 t0 的秒, 频率], ...] */
function sweep(
  r: RenderTarget,
  points: Array<[number, number]>,
  o: { type?: OscillatorType; peak?: number },
): void {
  if (points.length < 2) return;
  const start = r.t0 + points[0][0];
  const end = r.t0 + points[points.length - 1][0];
  const osc = r.ctx.createOscillator();
  const gain = r.ctx.createGain();
  osc.type = o.type ?? "sawtooth";
  osc.frequency.setValueAtTime(points[0][1], start);
  for (const [t, f] of points.slice(1)) {
    osc.frequency.linearRampToValueAtTime(f, r.t0 + t);
  }
  const peak = o.peak ?? 0.3;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.03);
  gain.gain.setValueAtTime(peak, end - 0.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  osc.connect(gain).connect(r.dest);
  osc.start(start);
  osc.stop(end + 0.05);
}

/** 白噪声缓冲区按 AudioContext 缓存一份（敲击音用），避免每次响都重新生成 1 秒样本 */
const noiseCache = new WeakMap<AudioContext, AudioBuffer>();

function getNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const cached = noiseCache.get(ctx);
  if (cached) return cached;
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noiseCache.set(ctx, buf);
  return buf;
}

/** 低通滤过的噪声脉冲，用来做"笃笃"的敲击感 */
function knockBurst(
  r: RenderTarget,
  o: { at: number; dur: number; peak: number; cutoff: number },
): void {
  const start = r.t0 + o.at;
  const src = r.ctx.createBufferSource();
  src.buffer = getNoiseBuffer(r.ctx);
  const filter = r.ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = o.cutoff;
  filter.Q.value = 6;
  const gain = r.ctx.createGain();
  gain.gain.setValueAtTime(o.peak, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + o.dur);
  src.connect(filter).connect(gain).connect(r.dest);
  src.start(start);
  src.stop(start + o.dur + 0.02);
}

/**
 * 预设表。顺序即设置页下拉顺序：从柔和到刺耳，方便用户按"想被吵到什么程度"挑。
 */
export const REMINDER_PRESETS: ReminderPreset[] = [
  {
    id: "ding",
    label: "叮咚（默认）",
    hint: "两声清脆正弦，短促不扰人",
    durationMs: 450,
    render: (r) => {
      tone(r, { at: 0, dur: 0.18, freq: 880 });
      tone(r, { at: 0.22, dur: 0.18, freq: 1175 });
    },
  },
  {
    id: "chime",
    label: "风铃",
    hint: "三音上行，尾音悠长",
    durationMs: 900,
    render: (r) => {
      tone(r, { at: 0, dur: 0.5, freq: 1318.5, type: "triangle", peak: 0.42 });
      tone(r, { at: 0.12, dur: 0.5, freq: 1568, type: "triangle", peak: 0.42 });
      tone(r, { at: 0.24, dur: 0.62, freq: 2093, type: "triangle", peak: 0.38 });
    },
  },
  {
    id: "bell",
    label: "钟声",
    hint: "基音加泛音，衰减近 2 秒，穿透力强",
    durationMs: 1750,
    render: (r) => {
      // 泛音列按真实钟体的非谐波比例排，越高的泛音衰减越快
      tone(r, { at: 0, dur: 1.65, freq: 523.25, peak: 0.5, attack: 0.004 });
      tone(r, { at: 0, dur: 1.1, freq: 1046.5, peak: 0.26, attack: 0.004 });
      tone(r, { at: 0, dur: 0.7, freq: 1567.98, peak: 0.13, attack: 0.004 });
      tone(r, { at: 0, dur: 0.35, freq: 2637, peak: 0.07, attack: 0.003 });
    },
  },
  {
    id: "alarm",
    label: "闹铃（响亮）",
    hint: "方波六连，最像手机闹钟，容易注意到",
    durationMs: 850,
    render: (r) => {
      for (let i = 0; i < 6; i++) {
        tone(r, {
          at: i * 0.12,
          dur: 0.085,
          freq: i % 2 === 0 ? 880 : 1108.7,
          type: "square",
          peak: 0.3,
          attack: 0.004,
        });
      }
    },
  },
  {
    id: "digital",
    label: "电子哔",
    hint: "高频方波四连，尖锐扎耳，最不容易漏听",
    durationMs: 520,
    render: (r) => {
      for (let i = 0; i < 4; i++) {
        tone(r, {
          at: i * 0.115,
          dur: 0.065,
          freq: 2093,
          type: "square",
          peak: 0.24,
          attack: 0.003,
        });
      }
    },
  },
  {
    id: "siren",
    label: "警笛",
    hint: "来回扫频，最吵，建议只给紧急待办用",
    durationMs: 1450,
    render: (r) => {
      sweep(
        r,
        [
          [0, 620],
          [0.35, 1450],
          [0.7, 620],
          [1.05, 1450],
          [1.4, 620],
        ],
        { type: "sawtooth", peak: 0.22 },
      );
    },
  },
  {
    id: "marimba",
    label: "木琴",
    hint: "三音琶音，温和不突兀",
    durationMs: 780,
    render: (r) => {
      [523.25, 659.25, 783.99].forEach((f, i) => {
        const at = i * 0.14;
        tone(r, { at, dur: 0.45, freq: f, peak: 0.45, attack: 0.005 });
        // 叠一层四倍频短泛音，做出木质敲击的"点"
        tone(r, { at, dur: 0.16, freq: f * 4, peak: 0.1, attack: 0.003 });
      });
    },
  },
  {
    id: "drop",
    label: "水滴",
    hint: "两滴下滑音，安静环境里很清晰",
    durationMs: 620,
    render: (r) => {
      tone(r, { at: 0, dur: 0.28, freq: 1400, freqTo: 420, peak: 0.5 });
      tone(r, { at: 0.32, dur: 0.24, freq: 1700, freqTo: 520, peak: 0.38 });
    },
  },
  {
    id: "knock",
    label: "敲击",
    hint: "低沉的两下叩击，不刺耳但有存在感",
    durationMs: 380,
    render: (r) => {
      knockBurst(r, { at: 0, dur: 0.1, peak: 0.7, cutoff: 320 });
      knockBurst(r, { at: 0.18, dur: 0.1, peak: 0.6, cutoff: 300 });
    },
  },
];

const PRESET_BY_ID = new Map(REMINDER_PRESETS.map((p) => [p.id, p]));

export const DEFAULT_PRESET_ID: ReminderPresetId = "ding";
/** 紧急提醒默认用更吵的：它是"必须被打断"的场景 */
export const DEFAULT_URGENT_PRESET_ID: ReminderPresetId = "alarm";

/** 按 id 取预设；id 无效（老配置 / 手改过 DB）时回退默认，保证提醒一定有声 */
export function getPreset(id: string | null | undefined): ReminderPreset {
  return PRESET_BY_ID.get((id ?? "") as ReminderPresetId) ?? PRESET_BY_ID.get(DEFAULT_PRESET_ID)!;
}

export function isPresetId(id: string): id is ReminderPresetId {
  return PRESET_BY_ID.has(id as ReminderPresetId);
}
