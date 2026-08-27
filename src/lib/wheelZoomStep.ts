/**
 * Ctrl + 滚轮缩放的「步进累加器」。
 *
 * 为什么需要累加而不是一个 wheel 事件跳一档：
 * 触控板的惯性滚动**一次轻划会连发几十个 wheel 事件**（每个 deltaY 只有几像素）。
 * 若每个事件都跳一档，字号会从 15 直接飙到上限，完全不可控。
 * 鼠标滚轮则相反：一格通常就是 deltaY=100（或 ±120），要保证一格正好一档。
 *
 * 于是：累加 deltaY，每攒够 {@link WHEEL_STEP_THRESHOLD} 就走一档，余量留到下次。
 * 阈值取 100 = 鼠标滚轮一格，既保证"滚一格动一档"，又让触控板需要划一段才动一档。
 */

/** 攒够多少 deltaY 走一档 */
export const WHEEL_STEP_THRESHOLD = 100;

export interface WheelStepResult {
  /** 本次应该走几档（正=放大，负=缩小，0=还没攒够） */
  steps: number;
  /** 消化掉整档后剩下的余量，调用方需保存下来带入下次 */
  rest: number;
}

/**
 * @param accumulated 上次剩下的余量
 * @param deltaY      本次 wheel 事件的 deltaY（向下滚为正）
 *
 * 注意方向：**向上滚（deltaY 为负）= 放大**，与浏览器 / VS Code / Office 一致。
 */
export function accumulateWheelSteps(
  accumulated: number,
  deltaY: number,
): WheelStepResult {
  const total = accumulated + deltaY;
  // 向零取整：-150 → -1 档、+150 → +1 档，余 ±50 留到下次
  const steps = Math.trunc(total / WHEEL_STEP_THRESHOLD);
  if (steps === 0) return { steps: 0, rest: total };
  return {
    // deltaY 向下为正 = 缩小，所以取反
    steps: -steps,
    rest: total - steps * WHEEL_STEP_THRESHOLD,
  };
}

/**
 * 方向翻转时立即清空余量。
 *
 * 不清的话：先向下攒了 +80（没到 100），再改向上滚，前 80 会抵消掉用户
 * 想放大的意图，需要多滚一格才有反应，手感"发粘"。
 */
export function resetOnDirectionChange(
  accumulated: number,
  deltaY: number,
): number {
  if (accumulated === 0 || deltaY === 0) return accumulated;
  const sameDirection = accumulated > 0 === deltaY > 0;
  return sameDirection ? accumulated : 0;
}
