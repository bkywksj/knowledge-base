import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

interface UseCommandResult<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  execute: (...args: unknown[]) => Promise<T | null>;
}

/**
 * 封装 Tauri invoke 调用，提供 loading/error 状态管理
 */
export function useCommand<T>(
  command: string,
  args?: Record<string, unknown>
): UseCommandResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const argsRef = useRef(args);
  argsRef.current = args;

  const execute = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<T>(command, argsRef.current);
      setData(result);
      return result;
    } catch (e) {
      const msg = typeof e === "string" ? e : String(e);
      setError(msg);
      return null;
    } finally {
      setLoading(false);
    }
  }, [command]);

  return { data, error, loading, execute };
}

/**
 * 安全调用 Tauri Command，带类型推断和错误处理
 */
export async function safeInvoke<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    const msg = typeof e === "string" ? e : String(e);
    console.error(`[Command] ${command} 失败:`, msg);
    throw new Error(msg);
  }
}
