/**
 * 静音自动停止 Hook (轻量 VAD)。
 *
 * 在录音激活期间，若已检测到说话（level 越过 threshold），随后连续静音
 * silenceMs 毫秒，且整段时长 ≥ minSpeakMs，则触发 onSilence。
 *
 * 与 tauri-cc 同款阈值：threshold=0.03 / silenceMs=1500 / minSpeakMs=500。
 *
 * 设计：复用调用方传入的 level（来自 useAudioLevel 的归一化 0-1 频谱平均），
 * 避免重复创建 AudioContext / AnalyserNode。
 *
 * @param level     当前音量电平（0-1，由 useAudioLevel 提供）
 * @param active    是否处于录音状态（false 时自动重置内部计时）
 * @param onSilence 静音超时回调（通常调用 stopRecording）；幂等即可
 */
import { useEffect, useRef } from "react";

interface Options {
  /** 静音阈值，默认 0.03 */
  threshold?: number;
  /** 持续静音多久触发，默认 1500ms */
  silenceMs?: number;
  /** 最短录音时长（避免开头噪声立即触发），默认 500ms */
  minSpeakMs?: number;
  /** 检测周期，默认 120ms（足够灵敏，开销低） */
  checkIntervalMs?: number;
}

export function useSilenceAutoStop(
  level: number,
  active: boolean,
  onSilence: () => void,
  options: Options = {},
) {
  const {
    threshold = 0.03,
    silenceMs = 1500,
    minSpeakMs = 500,
    checkIntervalMs = 120,
  } = options;

  // 用 ref 持有最新回调，避免 onSilence 引用变化导致 interval 重建
  const onSilenceRef = useRef(onSilence);
  onSilenceRef.current = onSilence;

  const hasSpokenRef = useRef(false);
  const lastVoiceAtRef = useRef(0);
  const startAtRef = useRef(0);
  const firedRef = useRef(false);

  // level 更新：维护"是否说过话"和"上次有声时间"
  useEffect(() => {
    if (!active) return;
    if (level > threshold) {
      hasSpokenRef.current = true;
      lastVoiceAtRef.current = Date.now();
    }
  }, [level, active, threshold]);

  // active 切换：启动/重置 interval
  useEffect(() => {
    if (!active) {
      hasSpokenRef.current = false;
      lastVoiceAtRef.current = 0;
      startAtRef.current = 0;
      firedRef.current = false;
      return;
    }
    startAtRef.current = Date.now();
    hasSpokenRef.current = false;
    lastVoiceAtRef.current = 0;
    firedRef.current = false;

    const id = window.setInterval(() => {
      if (firedRef.current) return;
      const now = Date.now();
      if (
        hasSpokenRef.current &&
        lastVoiceAtRef.current > 0 &&
        now - lastVoiceAtRef.current >= silenceMs &&
        now - startAtRef.current >= minSpeakMs
      ) {
        firedRef.current = true;
        onSilenceRef.current();
      }
    }, checkIntervalMs);

    return () => window.clearInterval(id);
  }, [active, silenceMs, minSpeakMs, checkIntervalMs]);
}
