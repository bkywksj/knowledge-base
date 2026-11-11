import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ChevronDown, CircleCheck, Circle, Clock, Search as SearchIcon, X, XCircle } from "lucide-react";
import { folderApi, searchApi, tagApi, taskApi } from "@/lib/api";
import { useAppStore } from "@/store";
import { relativeTime } from "@/lib/utils";
import { dueShortText, describeDueDate } from "@/lib/taskFilters";
import {
  buildSearchFilters,
  SEARCH_TIME_PRESETS,
  searchTimePresetRange,
  toDayRange,
  type SearchTimePreset,
} from "@/lib/searchFilters";
import type { Folder, SearchResult, Tag, TaskSearchHit } from "@/types";
import { MGroup, MSectionHeader, MTag } from "@/components/mobile/primitives";
import { MSheet, PickRow } from "@/components/mobile/MSheet";
import { FolderPickerSheet } from "@/components/mobile/FolderPickerSheet";

/**
 * 移动端搜索页（v4 原型 10 屏，对应 PC 搜索页）
 *
 * 路由 /search —— isMobile=true 时通过 wrapper 加载本组件。
 *
 * - 顶部：搜索框（自动聚焦 / 清空）+「取消」返回；关键词回写 ?q=（replace）
 * - 胶囊行：范围（全部 / 笔记 N / 待办 N）+ 筛选（时间 / 文件夹 / 标签 / 仅标题），规则与 PC 同一套（lib/searchFilters）
 * - 结果：待办在前（点进任务详情），笔记在后（点进笔记并定位到第一处命中）；关键词高亮
 * - 空关键词：最近搜索（与 PC 共用历史；有结果的搜索才入历史，打字中间态由 store 前缀合并）
 *
 * 300ms 防抖；连续输入时用序号丢弃过期响应。
 */

const DEBOUNCE_MS = 300;
/** 「全部」范围下每组先露这么多，多的引导切到对应范围 */
const ALL_PREVIEW = { tasks: 5, notes: 20 };

type Scope = "all" | "notes" | "tasks";

/** 文件夹树 → id 到「父 / 子」路径的映射（结果行显示所在位置） */
function folderPaths(tree: Folder[]): Map<number, string> {
  const out = new Map<number, string>();
  const walk = (nodes: Folder[], prefix: string) => {
    for (const n of nodes) {
      const path = prefix ? `${prefix} / ${n.name}` : n.name;
      out.set(n.id, path);
      const children = (n as Folder & { children?: Folder[] }).children;
      if (children?.length) walk(children, path);
    }
  };
  walk(tree, "");
  return out;
}

/** 多级标签拍平（父在前、子缩进） */
function flattenTags(tags: Tag[]): { t: Tag; depth: number }[] {
  const byParent = new Map<number | null, Tag[]>();
  for (const t of tags) byParent.set(t.parent_id ?? null, [...(byParent.get(t.parent_id ?? null) ?? []), t]);
  const out: { t: Tag; depth: number }[] = [];
  const seen = new Set<number>();
  const walk = (p: number | null, depth: number) => {
    for (const t of byParent.get(p) ?? []) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push({ t, depth });
      walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const t of tags) if (!seen.has(t.id)) out.push({ t, depth: 0 });
  return out;
}

export function MobileSearch() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const initialQ = params.get("q") ?? "";
  const recentSearches = useAppStore((s) => s.recentSearches);

  const [keyword, setKeyword] = useState(initialQ);
  const [scope, setScope] = useState<Scope>("all");
  const [notes, setNotes] = useState<SearchResult[]>([]);
  const [tasks, setTasks] = useState<TaskSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const [folders, setFolders] = useState<Folder[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [time, setTime] = useState<SearchTimePreset | null>(null);
  const [folderId, setFolderId] = useState<number | null>(null);
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [titleOnly, setTitleOnly] = useState(false);
  const [sheet, setSheet] = useState<"time" | "folder" | "tag" | null>(null);

  const debounceRef = useRef<number | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    folderApi.list().then(setFolders).catch(() => {});
    tagApi.list().then(setAllTags).catch(() => {});
  }, []);

  const filters = useMemo(
    () =>
      buildSearchFilters(
        {
          folders: folderId != null ? [folderId] : [],
          tags: tagIds,
          types: [],
          dateRange: time ? toDayRange(searchTimePresetRange(time)) : null,
          createdRange: null,
          titleOnly,
        },
        folders,
      ),
    [folderId, tagIds, time, titleOnly, folders],
  );
  const filtersKey = JSON.stringify(filters ?? {});

  const runSearch = useCallback(async (q: string, f: typeof filters) => {
    const seq = ++seqRef.current;
    const k = q.trim();
    if (!k) {
      setNotes([]);
      setTasks([]);
      setSearched(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    const [n, t] = await Promise.all([
      searchApi.search(k, 50, f).catch((e) => {
        console.error("[MobileSearch] notes failed:", e);
        return [] as SearchResult[];
      }),
      // 待办搜索没有筛选维度（同 PC）：只按关键词
      taskApi.search(k, 50).catch((e) => {
        console.error("[MobileSearch] tasks failed:", e);
        return [] as TaskSearchHit[];
      }),
    ]);
    if (seq !== seqRef.current) return;
    setNotes(n);
    setTasks(t);
    setSearched(true);
    setLoading(false);
    // 历史只在拿到任一结果时才记（同 PC）
    if (n.length + t.length > 0) useAppStore.getState().pushRecentSearch(k);
  }, []);

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => void runSearch(keyword, filters), DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
    // filtersKey 代替 filters 对象，避免每次渲染都重搜
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, filtersKey, runSearch]);

  // keyword 变化时同步到 URL（便于深链/返回）
  useEffect(() => {
    if (keyword) {
      setParams({ q: keyword }, { replace: true });
    } else if (params.has("q")) {
      setParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword]);

  const paths = useMemo(() => folderPaths(folders), [folders]);
  const flatTags = useMemo(() => flattenTags(allTags), [allTags]);
  const hasFilter = !!(time || folderId != null || tagIds.length || titleOnly);
  const q = keyword.trim();

  function clearFilters() {
    setTime(null);
    setFolderId(null);
    setTagIds([]);
    setTitleOnly(false);
  }

  const timeLabel = time ? SEARCH_TIME_PRESETS.find((p) => p.key === time)?.label : null;
  const folderLabel = folderId != null ? paths.get(folderId)?.split(" / ").pop() : null;
  const tagLabel = tagIds.length ? (tagIds.length === 1 ? allTags.find((t) => t.id === tagIds[0])?.name : `${tagIds.length} 个标签`) : null;

  const showTasks = scope !== "notes" && tasks.length > 0;
  const showNotes = scope !== "tasks" && notes.length > 0;
  const tasksShown = scope === "all" ? tasks.slice(0, ALL_PREVIEW.tasks) : tasks;
  const notesShown = scope === "all" ? notes.slice(0, ALL_PREVIEW.notes) : notes;
  const nothing = searched && !loading && notes.length + tasks.length === 0;

  return (
    <div className="mx-auto w-full max-w-[860px] pb-24">
      {/* 搜索框 + 取消 */}
      <div className="m-gutter flex items-center gap-3 pt-2">
        <div className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-[var(--m-r-l)] px-3" style={{ background: "var(--m-surface)" }}>
          <SearchIcon size={18} style={{ color: "var(--m-ink3)" }} className="shrink-0" />
          <input
            autoFocus
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索笔记 / 标题 / 正文"
            aria-label="搜索"
            enterKeyHint="search"
            className="h-full min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-[var(--m-ink3)]"
            style={{ color: "var(--m-ink)" }}
          />
          {keyword && (
            <button type="button" onClick={() => setKeyword("")} aria-label="清空" className="m-tapx flex h-6 w-6 shrink-0 items-center justify-center" style={{ color: "var(--m-ink3)" }}>
              <XCircle size={18} />
            </button>
          )}
        </div>
        <button type="button" className="m-tapx shrink-0 text-[15px] font-semibold" style={{ color: "var(--m-accent-ink)" }} onClick={() => navigate(-1)}>
          取消
        </button>
      </div>

      {/* 范围 + 筛选胶囊 */}
      <div className="m-gutter m-hscroll mt-3 flex items-center gap-2 pb-1">
        {q && (
          <>
            <ScopeChip on={scope === "all"} onClick={() => setScope("all")}>全部</ScopeChip>
            <ScopeChip on={scope === "notes"} onClick={() => setScope("notes")}>
              笔记 <span className="m-num">{notes.length}</span>
            </ScopeChip>
            <ScopeChip on={scope === "tasks"} onClick={() => setScope("tasks")}>
              待办 <span className="m-num">{tasks.length}</span>
            </ScopeChip>
            <span className="mx-1 h-5 w-px shrink-0" style={{ background: "var(--m-hair)" }} />
          </>
        )}
        <FilterChip label="时间" value={timeLabel} onClick={() => setSheet("time")} />
        <FilterChip label="文件夹" value={folderLabel} onClick={() => setSheet("folder")} />
        <FilterChip label="标签" value={tagLabel} onClick={() => setSheet("tag")} />
        <button
          type="button"
          className="m-chip shrink-0"
          aria-pressed={titleOnly}
          style={titleOnly ? { background: "var(--m-accent-soft2)", color: "var(--m-accent-ink)", fontWeight: 700 } : { background: "var(--m-surface)" }}
          onClick={() => setTitleOnly((v) => !v)}
        >
          仅标题
        </button>
      </div>
      {hasFilter && (
        <div className="m-gutter m-t-cap mt-1.5 flex items-center gap-2">
          <span>筛选只作用于笔记</span>
          <button type="button" className="m-tapx font-semibold" style={{ color: "var(--m-accent-ink)" }} onClick={clearFilters}>
            清除筛选
          </button>
        </div>
      )}

      <div className="m-gutter mt-4">
        {!q ? (
          recentSearches.length > 0 ? (
            <>
              <MSectionHeader
                className="mb-2 px-1"
                title="最近搜索"
                action={
                  <button type="button" className="m-tapx text-[14px] font-semibold" style={{ color: "var(--m-ink3)" }} onClick={() => useAppStore.getState().clearRecentSearches()}>
                    清空
                  </button>
                }
              />
              <MGroup>
                {recentSearches.map((s) => (
                  <div key={s} className="m-row m-row-icon pr-1">
                    <span className="flex w-6 shrink-0 justify-center" style={{ color: "var(--m-ink3)" }}>
                      <Clock size={18} />
                    </span>
                    <button type="button" className="min-w-0 flex-1 self-stretch truncate text-left text-[15px]" onClick={() => setKeyword(s)}>
                      {s}
                    </button>
                    <button type="button" aria-label={`删除「${s}」`} className="m-icon-btn shrink-0" style={{ color: "var(--m-ink3)" }} onClick={() => useAppStore.getState().removeRecentSearch(s)}>
                      <X size={18} />
                    </button>
                  </div>
                ))}
              </MGroup>
            </>
          ) : (
            <Hint text="搜索笔记的标题和正文，以及待办" sub="支持中文分词，输入即时搜索" />
          )
        ) : loading && !searched ? (
          <div className="m-t-meta py-10 text-center">搜索中…</div>
        ) : nothing ? (
          <Hint text={`未找到「${q}」`} sub={hasFilter ? "试试清除筛选，或换个关键词" : "换个关键词试试，或检查输入"} />
        ) : (
          <>
            {showTasks && (
              <section className="mb-6">
                <MSectionHeader
                  className="mb-2 px-1"
                  title="待办"
                  count={tasks.length}
                  action={
                    scope === "all" && tasks.length > ALL_PREVIEW.tasks ? (
                      <button type="button" className="m-tapx text-[14px] font-semibold" style={{ color: "var(--m-accent-ink)" }} onClick={() => setScope("tasks")}>
                        查看全部
                      </button>
                    ) : undefined
                  }
                />
                <MGroup>
                  {tasksShown.map((t, i) => (
                    <TaskHitRow key={t.id} hit={t} keyword={q} divider={i > 0} onClick={() => navigate(`/task-detail/${t.id}`)} />
                  ))}
                </MGroup>
              </section>
            )}
            {showNotes && (
              <section>
                <MSectionHeader
                  className="mb-2 px-1"
                  title="笔记"
                  count={notes.length}
                  action={
                    scope === "all" && notes.length > ALL_PREVIEW.notes ? (
                      <button type="button" className="m-tapx text-[14px] font-semibold" style={{ color: "var(--m-accent-ink)" }} onClick={() => setScope("notes")}>
                        查看全部
                      </button>
                    ) : undefined
                  }
                />
                <MGroup>
                  {notesShown.map((r, i) => (
                    <NoteHitRow
                      key={r.id}
                      hit={r}
                      keyword={q}
                      path={r.folder_id != null ? paths.get(r.folder_id) ?? "" : "未分类"}
                      divider={i > 0}
                      onClick={() => navigate(`/notes/${r.id}?q=${encodeURIComponent(q)}`)}
                    />
                  ))}
                </MGroup>
              </section>
            )}
            {!showTasks && !showNotes && (
              <Hint text={scope === "tasks" ? "没有匹配的待办" : "没有匹配的笔记"} sub="切到「全部」看看其它结果" />
            )}
          </>
        )}
      </div>

      {/* 时间 */}
      <MSheet open={sheet === "time"} title="更新时间" onClose={() => setSheet(null)}>
        <div className="m-group">
          <PickRow label="不限" active={time == null} onClick={() => { setTime(null); setSheet(null); }} />
          {SEARCH_TIME_PRESETS.map((p) => (
            <PickRow key={p.key} label={p.label} active={time === p.key} onClick={() => { setTime(p.key); setSheet(null); }} />
          ))}
        </div>
      </MSheet>

      {/* 文件夹（含子文件夹） */}
      <FolderPickerSheet
        open={sheet === "folder"}
        title="在哪个文件夹里搜（含子文件夹）"
        folders={folders}
        currentId={folderId}
        rootLabel="全部文件夹"
        onPick={setFolderId}
        onClose={() => setSheet(null)}
      />

      {/* 标签（多选，需同时含全部所选） */}
      <MSheet
        open={sheet === "tag"}
        title="标签"
        caption="可多选；笔记需同时带有全部所选标签"
        onClose={() => setSheet(null)}
        footer={
          <div className="mt-3 flex items-center gap-3">
            {tagIds.length > 0 && (
              <button type="button" className="m-tapx text-[15px] font-semibold" style={{ color: "var(--m-ink2)" }} onClick={() => setTagIds([])}>
                清除
              </button>
            )}
            <div className="flex-1" />
            <button type="button" className="m-btn" onClick={() => setSheet(null)}>
              完成
            </button>
          </div>
        }
      >
        <div className="m-group max-h-[50vh] overflow-y-auto">
          {flatTags.length === 0 ? (
            <div className="m-t-meta py-6 text-center">还没有标签</div>
          ) : (
            flatTags.map(({ t, depth }) => (
              <PickRow
                key={t.id}
                label={t.name}
                dot={t.color || "var(--m-ink4)"}
                indent={depth}
                extra={t.note_count}
                active={tagIds.includes(t.id)}
                onClick={() => setTagIds((ids) => (ids.includes(t.id) ? ids.filter((x) => x !== t.id) : [...ids, t.id]))}
              />
            ))
          )}
        </div>
      </MSheet>
    </div>
  );
}

function ScopeChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={on ? "m-chip is-on shrink-0" : "m-chip shrink-0"} style={on ? undefined : { background: "var(--m-surface)" }} onClick={onClick} aria-pressed={on}>
      {children}
    </button>
  );
}

/** 筛选胶囊：未选显示维度名 + ▾，已选显示当前值（主色浅底） */
function FilterChip({ label, value, onClick }: { label: string; value: string | null | undefined; onClick: () => void }) {
  const on = !!value;
  return (
    <button
      type="button"
      className="m-chip shrink-0 gap-1"
      style={on ? { background: "var(--m-accent-soft2)", color: "var(--m-accent-ink)", fontWeight: 700 } : { background: "var(--m-surface)" }}
      onClick={onClick}
      aria-label={on ? `${label}：${value}` : label}
    >
      <span className="max-w-[9em] truncate">{value || label}</span>
      <ChevronDown size={14} />
    </button>
  );
}

function TaskHitRow({ hit, keyword, divider, onClick }: { hit: TaskSearchHit; keyword: string; divider: boolean; onClick: () => void }) {
  const done = hit.status === 1;
  const due = describeDueDate(hit.dueDate, done);
  return (
    <button type="button" className="relative flex w-full items-start gap-3 px-4 py-3 text-left" onClick={onClick}>
      {divider && <span className="pointer-events-none absolute top-0 right-0 left-[52px] h-[0.5px]" style={{ background: "var(--m-hair)" }} />}
      <span className="mt-0.5 flex w-6 shrink-0 justify-center" style={{ color: done ? "var(--m-ok)" : "var(--m-ink3)" }}>
        {done ? <CircleCheck size={20} /> : <Circle size={20} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px]" style={done ? { color: "var(--m-ink3)", textDecoration: "line-through" } : { color: "var(--m-ink)" }}>
          <Highlight text={hit.title || "未命名任务"} keyword={keyword} />
        </span>
        {(hit.snippet || hit.dueDate || hit.priority === 0) && (
          <span className="mt-1 flex items-center gap-2">
            {hit.priority === 0 && !done && <MTag tone="bad">紧急</MTag>}
            {hit.dueDate && (
              <span className="m-t-meta m-num shrink-0" style={due.overdue ? { color: "var(--m-bad)", fontWeight: 600 } : undefined}>
                {dueShortText(hit.dueDate)}
              </span>
            )}
            {hit.snippet && (
              <span className="m-t-meta min-w-0 truncate">
                <Highlight text={hit.snippet} keyword={keyword} />
              </span>
            )}
          </span>
        )}
      </span>
    </button>
  );
}

function NoteHitRow({ hit, keyword, path, divider, onClick }: { hit: SearchResult; keyword: string; path: string; divider: boolean; onClick: () => void }) {
  return (
    <button type="button" className="relative block w-full px-4 py-3 text-left" onClick={onClick}>
      {divider && <span className="pointer-events-none absolute top-0 right-0 left-4 h-[0.5px]" style={{ background: "var(--m-hair)" }} />}
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold" style={{ color: "var(--m-ink)" }}>
          <Highlight text={hit.title || "未命名笔记"} keyword={keyword} />
        </span>
        {hit.note_type === "whiteboard" && <MTag tone="info">白板</MTag>}
      </span>
      {hit.snippet && (
        <span className="m-t-meta mt-1 line-clamp-2" style={{ color: "var(--m-ink2)" }}>
          <Highlight text={hit.snippet} keyword={keyword} />
        </span>
      )}
      <span className="m-t-cap mt-1.5 flex items-center gap-1.5">
        <span className="min-w-0 truncate">{path}</span>
        <span className="shrink-0">· {relativeTime(hit.updated_at)}</span>
      </span>
    </button>
  );
}

/** 关键词高亮（不区分大小写）：主色浅底 + 主色字，暗色主题下也可读 */
function Highlight({ text, keyword }: { text: string; keyword: string }) {
  const k = keyword.trim();
  if (!k) return <>{text}</>;
  const lower = text.toLowerCase();
  const kl = k.toLowerCase();
  const parts: { t: string; hit: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(kl, i);
    if (idx < 0) {
      parts.push({ t: text.slice(i), hit: false });
      break;
    }
    if (idx > i) parts.push({ t: text.slice(i, idx), hit: false });
    parts.push({ t: text.slice(idx, idx + k.length), hit: true });
    i = idx + k.length;
  }
  return (
    <>
      {parts.map((p, idx) =>
        p.hit ? (
          <mark key={idx} className="rounded-[3px] px-0.5" style={{ background: "var(--m-accent-soft2)", color: "var(--m-accent-ink)", fontWeight: 700 }}>
            {p.t}
          </mark>
        ) : (
          <span key={idx}>{p.t}</span>
        ),
      )}
    </>
  );
}

function Hint({ text, sub }: { text: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-16">
      <SearchIcon size={32} style={{ color: "var(--m-ink4)" }} />
      <span className="m-t-body" style={{ color: "var(--m-ink2)" }}>{text}</span>
      {sub && <span className="m-t-cap">{sub}</span>}
    </div>
  );
}
