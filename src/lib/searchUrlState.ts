/**
 * 搜索页条件 ⇄ URL 查询参数。
 *
 * 为什么要进 URL：搜索页条件原本只在组件 state 里，点进笔记时页面被卸载，
 * 返回后条件全丢、结果变回不带筛选的 50 条（群反馈）。写进 URL 后，后退 / 刷新都能原样恢复，
 * 和待办页 `?filter=`、笔记列表 `?folder=` 同一套做法。
 *
 * 参数（都可省略，省略 = 不筛选）：
 *   q  关键词              f  文件夹 id，逗号分隔     t  标签 id，逗号分隔
 *   nt 笔记类型，逗号分隔   ud 修改时间 `起~止`        cd 创建时间 `起~止`（YYYY-MM-DD）
 *   to `1` = 仅搜标题
 * `type`（Tab）由页面自己管，这里原样保留。
 */
import type { NoteType } from "@/types";

export interface SearchUrlState {
  q: string;
  folders: number[];
  tags: number[];
  types: NoteType[];
  /** [起, 止]，YYYY-MM-DD */
  updated: [string, string] | null;
  created: [string, string] | null;
  titleOnly: boolean;
}

const NOTE_TYPES: NoteType[] = ["markdown", "whiteboard"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseIds(raw: string | null): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function parseRange(raw: string | null): [string, string] | null {
  if (!raw) return null;
  const [a, b] = raw.split("~");
  return a && b && DAY_RE.test(a) && DAY_RE.test(b) ? [a, b] : null;
}

export function parseSearchUrl(sp: URLSearchParams): SearchUrlState {
  return {
    q: (sp.get("q") ?? "").trim(),
    folders: parseIds(sp.get("f")),
    tags: parseIds(sp.get("t")),
    types: (sp.get("nt") ?? "")
      .split(",")
      .filter((s): s is NoteType => (NOTE_TYPES as string[]).includes(s)),
    updated: parseRange(sp.get("ud")),
    created: parseRange(sp.get("cd")),
    titleOnly: sp.get("to") === "1",
  };
}

/** 在原参数基础上写入搜索条件（保留 type 等其它参数），空条件删掉对应键 */
export function writeSearchUrl(
  base: URLSearchParams,
  s: SearchUrlState,
): URLSearchParams {
  const sp = new URLSearchParams(base);
  const put = (key: string, val: string) =>
    val ? sp.set(key, val) : sp.delete(key);
  put("q", s.q.trim());
  put("f", s.folders.join(","));
  put("t", s.tags.join(","));
  put("nt", s.types.join(","));
  put("ud", s.updated ? `${s.updated[0]}~${s.updated[1]}` : "");
  put("cd", s.created ? `${s.created[0]}~${s.created[1]}` : "");
  put("to", s.titleOnly ? "1" : "");
  return sp;
}

export function hasActiveFilters(s: SearchUrlState): boolean {
  return (
    s.folders.length > 0 ||
    s.tags.length > 0 ||
    s.types.length > 0 ||
    !!s.updated ||
    !!s.created ||
    s.titleOnly
  );
}
