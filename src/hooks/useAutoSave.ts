import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 自动保存状态机：
 *  - idle   ：加载中 / 未被动过
 *  - dirty  ：值刚改过，防抖计时中
 *  - saving ：保存请求飞在路上
 *  - saved  ：已成功入库
 *  - error  ：最近一次保存失败（error 字段有详情，可点 flush 重试）
 */
export type AutoSaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

export interface UseAutoSaveOptions<T> {
  /** 当前需要保存的值（通常是 {title, content} 这种对象） */
  value: T;
  /** 真正的入库函数；抛错 → status="error" */
  save: (value: T) => Promise<void>;
  /** 是否启用自动保存；false 期间（如 loading）不调度 */
  enabled?: boolean;
  /** 防抖延迟，默认 1200ms */
  delay?: number;
}

export interface UseAutoSaveReturn {
  status: AutoSaveStatus;
  /** 最近一次成功保存的时间 */
  lastSavedAt: Date | null;
  /** 最近一次失败的错误信息 */
  error: string | null;
  /** 立即保存（跳过防抖），返回 Promise 可 await */
  flush: () => Promise<void>;
}

/**
 * 防抖自动保存 Hook。
 *
 * 行为：
 *  1. `value` 变化 → 防抖 `delay` ms 后调用 `save(value)`
 *  2. `enabled` 从 false → true 时，把当前值视为"已保存基线"
 *     （用于加载数据完成后不把默认值当成脏数据误保存）
 *  3. unmount 时 fire-and-forget 触发一次 flush 兜底
 *     （覆盖路由切换、关闭 Tab 等场景）
 *  4. flush 可手动调用，跳过防抖，立即同步保存
 *  5. 保存并发控制：保存期间收到新值会排队，结束后立即保存最新值
 */
export function useAutoSave<T>({
  value,
  save,
  enabled = true,
  delay = 1200,
}: UseAutoSaveOptions<T>): UseAutoSaveReturn {
  const [status, setStatus] = useState<AutoSaveStatus>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 保持对最新 save / value 的引用，避免闭包陷阱
  const saveRef = useRef(save);
  saveRef.current = save;
  const valueRef = useRef(value);
  valueRef.current = value;

  // 已成功保存的值（序列化），用于判断是否真的变了
  const savedSerRef = useRef<string>(JSON.stringify(value));
  const savingRef = useRef(false);
  const pendingValueRef = useRef<T | null>(null);
  const timerRef = useRef<number | null>(null);

  const doSave = useCallback(async (v: T) => {
    // 保存期间有并发请求 → 记下最新值，当前保存结束后自动追保一次
    if (savingRef.current) {
      pendingValueRef.current = v;
      return;
    }
    savingRef.current = true;
    setStatus("saving");
    try {
      await saveRef.current(v);
      savedSerRef.current = JSON.stringify(v);
      setLastSavedAt(new Date());
      setError(null);
      setStatus("saved");
    } catch (e) {
      setError(String(e));
      setStatus("error");
    } finally {
      savingRef.current = false;
      if (pendingValueRef.current !== null) {
        const next = pendingValueRef.current;
        pendingValueRef.current = null;
        if (JSON.stringify(next) !== savedSerRef.current) {
          void doSave(next);
        }
      }
    }
  }, []);

  // enabled 从 false → true 时：把当前 value 作为"已保存基线"，
  // 避免数据加载完成的瞬间把默认值误当做用户修改保存一次。
  const prevEnabledRef = useRef(enabled);
  useEffect(() => {
    if (enabled && !prevEnabledRef.current) {
      savedSerRef.current = JSON.stringify(valueRef.current);
      setStatus("idle");
    }
    prevEnabledRef.current = enabled;
  }, [enabled]);

  // value 变化 → 防抖调度保存
  useEffect(() => {
    if (!enabled) return;
    const curSer = JSON.stringify(value);
    if (curSer === savedSerRef.current) return;

    setStatus("dirty");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void doSave(valueRef.current);
    }, delay);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [value, enabled, delay, doSave]);

  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (JSON.stringify(valueRef.current) === savedSerRef.current) return;
    await doSave(valueRef.current);
  }, [doSave]);

  // unmount 兜底：fire-and-forget 触发一次 flush。
  // 覆盖点侧边栏换路由 / 关 Tab 等不会调用 flush 的场景。
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    return () => {
      void flushRef.current();
    };
  }, []);

  return { status, lastSavedAt, error, flush };
}
