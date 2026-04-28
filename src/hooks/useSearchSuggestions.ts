import { useEffect, useRef, useState } from "react";
import { searchApi, taskApi } from "@/lib/api";
import type { SearchResult, TaskSearchHit } from "@/types";

interface Options {
  /** 待办最多返回几条；默认 10 */
  taskLimit?: number;
  /** 关键词防抖时长（ms）；默认 200 */
  debounceMs?: number;
}

interface Result {
  notes: SearchResult[];
  tasks: TaskSearchHit[];
  loading: boolean;
}

/**
 * 顶栏 Ctrl+K 命令面板 / 首页搜索 dropdown 共用的搜索建议 hook。
 *
 * 行为：
 * - 关键词为空 → 立即清空结果，不发请求
 * - 非空 → 防抖 N ms 后并发调 searchApi.search + taskApi.search
 * - 任意一边失败用 catch 兜成空数组，不影响另一边
 *
 * 不返回 selectedIndex / 键盘导航：那是各 UI 自己的事情（dropdown 和 Modal 行为不同）。
 */
export function useSearchSuggestions(keyword: string, opts?: Options): Result {
  const taskLimit = opts?.taskLimit ?? 10;
  const debounceMs = opts?.debounceMs ?? 200;

  const [notes, setNotes] = useState<SearchResult[]>([]);
  const [tasks, setTasks] = useState<TaskSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    const kw = keyword.trim();
    if (!kw) {
      setNotes([]);
      setTasks([]);
      setLoading(false);
      return;
    }

    timerRef.current = setTimeout(async () => {
      setLoading(true);
      const [n, t] = await Promise.all([
        searchApi.search(kw).catch(() => [] as SearchResult[]),
        taskApi.search(kw, taskLimit).catch(() => [] as TaskSearchHit[]),
      ]);
      setNotes(n);
      setTasks(t);
      setLoading(false);
    }, debounceMs);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [keyword, taskLimit, debounceMs]);

  return { notes, tasks, loading };
}
