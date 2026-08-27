import { useEffect, useRef } from "react";
import {
  accumulateWheelSteps,
  resetOnDirectionChange,
} from "@/lib/wheelZoomStep";

interface Options {
  /** 监听哪个元素上的滚轮（一般是编辑器滚动容器）；null 时不挂 */
  target: HTMLElement | null;
  /** 走一档时回调，delta 为 +1 / -1（可能一次多档） */
  onStep: (delta: number) => void;
  /** Ctrl/⌘ + 0 复位回调；不传则不注册 */
  onReset?: () => void;
  /** 关掉整个功能（用户在设置里禁用时） */
  disabled?: boolean;
}

/**
 * Ctrl/⌘ + 滚轮 缩放编辑区字号；Ctrl/⌘ + 0 复位。
 *
 * 🔴 两个必须注意的点：
 *
 * 1. **`{ passive: false }` 不能省**。默认 wheel 监听是 passive 的，
 *    调 preventDefault 无效（浏览器只会打一条警告），于是 WebView 自己的
 *    页面缩放**同时**触发 —— 字号和整页缩放叠加，画面会很诡异。
 *
 * 2. **步进必须累加**（见 lib/wheelZoomStep.ts）。触控板一次轻划连发几十个
 *    wheel 事件，逐个跳档会让字号瞬间冲到上限。
 */
export function useCtrlWheelZoom({
  target,
  onStep,
  onReset,
  disabled,
}: Options) {
  // 用 ref 存回调，避免调用方每次渲染传新函数导致监听反复解绑重挂
  const onStepRef = useRef(onStep);
  const onResetRef = useRef(onReset);
  onStepRef.current = onStep;
  onResetRef.current = onReset;

  const accRef = useRef(0);

  useEffect(() => {
    if (!target || disabled) return;

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      // 必须在 passive:false 下才真正生效，见上方说明
      e.preventDefault();

      accRef.current = resetOnDirectionChange(accRef.current, e.deltaY);
      const { steps, rest } = accumulateWheelSteps(accRef.current, e.deltaY);
      accRef.current = rest;
      if (steps !== 0) onStepRef.current(steps);
    };

    target.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      target.removeEventListener("wheel", onWheel);
      accRef.current = 0;
    };
  }, [target, disabled]);

  useEffect(() => {
    if (disabled || !onReset) return;
    const onKey = (e: KeyboardEvent) => {
      // "0" 与小键盘 "0"（code=Numpad0）都认
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key !== "0" && e.code !== "Numpad0") return;
      e.preventDefault();
      onResetRef.current?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [disabled, onReset]);
}
