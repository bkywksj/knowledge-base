import { useState, useRef, useEffect, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Input,
  Button,
  Empty,
  Spin,
  Segmented,
  TreeSelect,
  Select,
  DatePicker,
  Switch,
  Popover,
  theme as antdTheme,
  type InputRef,
} from "antd";
import {
  Search as SearchIcon,
  CheckSquare,
  AlertTriangle,
  Check,
  Filter as FilterIcon,
  ChevronDown,
  FileText,
  PenTool,
  Folder as FolderIcon,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import dayjs from "dayjs";
import {
  parseSearchUrl,
  writeSearchUrl,
} from "@/lib/searchUrlState";
import { searchApi, taskApi, folderApi, tagApi } from "@/lib/api";
import { MicButton } from "@/components/MicButton";
import { useAppStore } from "@/store";
import { highlightText, highlightFocusedSnippet } from "@/lib/highlight";
import { buildFolderPath } from "@/lib/folderPath";
import { relativeTime } from "@/lib/utils";
import { resolveBrowseSelection, type BrowseSelection } from "@/lib/searchBrowse";
import { SearchBrowse, type SearchBrowseHandle } from "./SearchBrowse";
import type {
  SearchResult,
  TaskSearchHit,
  SearchFilters,
  Folder,
  Tag,
  NoteType,
} from "@/types";

/** 笔记结果单行高度估算（含 title + snippet + 日期三行 + 上下 padding） */
const ESTIMATED_ROW_HEIGHT = 76;
/** "全部" 模式下笔记最多展示这么多条，再多就让用户切到「笔记」Tab 看全 */
const ALL_MODE_NOTES_PREVIEW = 20;

type Scope = "all" | "notes" | "tasks";

/** 把文件夹树拍平成"该节点 + 全部子孙"的 id 列表 */
function collectSubtreeIds(folders: Folder[], targetIds: number[]): number[] {
  const out = new Set<number>();
  const walk = (nodes: Folder[], inside: boolean) => {
    for (const n of nodes) {
      const hit = inside || targetIds.includes(n.id);
      if (hit) out.add(n.id);
      const children = (n as Folder & { children?: Folder[] }).children;
      if (children?.length) walk(children, hit);
    }
  };
  walk(folders, false);
  return [...out];
}

/**
 * RangePicker 给出的 [起, 止] 日期串 → 后端要的时间范围（任一端为空返回 null = 不筛选）。
 *
 * 后端比的是 notes 表的 `YYYY-MM-DD HH:MM:SS`，补上时分秒才能让"选到今天"
 * 含当天全部笔记，而不是卡在 00:00:00。
 */
function toDayRange(strs: [string, string]): [string, string] | null {
  return strs[0] && strs[1] ? [`${strs[0]} 00:00:00`, `${strs[1]} 23:59:59`] : null;
}

/**
 * 组装成后端要的 filters。
 *
 * 🔴 没勾的维度必须**省略字段**而不是传 `[]` —— 后端 fail-closed，
 * 空数组表示"勾了但没选中"会直接返回零结果（见 types/SearchFilters 注释）。
 * 抽成纯函数：外部跳转时要按 URL 里的新条件立刻搜，不能等 state 更新后再读 useMemo。
 */
function buildSearchFilters(
  s: {
    folders: number[];
    tags: number[];
    types: NoteType[];
    dateRange: [string, string] | null;
    createdRange: [string, string] | null;
    titleOnly: boolean;
  },
  folderTree: Folder[],
): SearchFilters | undefined {
  const f: SearchFilters = {};
  if (s.folders.length > 0) {
    // 选了「工作」应当含其下所有子文件夹，否则用户会觉得"明明在这个目录里却搜不到"。
    // 🔴 从 URL 恢复时文件夹树可能还没拉到：此时子树展开会得到 []，后端 fail-closed 直接零结果。
    //    先用选中的 id 本身，树到了 filtersKey 变化会自动按子树重搜。
    f.folderIds =
      folderTree.length > 0 ? collectSubtreeIds(folderTree, s.folders) : s.folders;
  }
  if (s.tags.length > 0) f.tagIds = s.tags;
  if (s.types.length > 0) f.noteTypes = s.types;
  if (s.dateRange) {
    f.updatedAfter = s.dateRange[0];
    f.updatedBefore = s.dateRange[1];
  }
  if (s.createdRange) {
    f.createdAfter = s.createdRange[0];
    f.createdBefore = s.createdRange[1];
  }
  // 只在勾选时才传：不勾 = 省略字段，保持与旧版请求完全一致
  if (s.titleOnly) f.titleOnly = true;
  return Object.keys(f).length > 0 ? f : undefined;
}

function DesktopSearchPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { token } = antdTheme.useToken();
  // 进入页面时从 URL 恢复条件：点进笔记再返回、刷新都不丢（见 lib/searchUrlState）
  const [initialUrl] = useState(() => parseSearchUrl(searchParams));

  const [query, setQuery] = useState(initialUrl.q);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [taskResults, setTaskResults] = useState<TaskSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** 本页最后一次写进 URL 的 q：区分「自己写回」和「外部跳转」（见读 URL 的 effect） */
  const lastWrittenQRef = useRef(initialUrl.q);
  /** 外部跳转那一轮跳过写回 URL */
  const skipNextUrlWriteRef = useRef(false);
  const searchSeqRef = useRef(0);
  /** 最近一次发起搜索的关键词 + 条件，防止条件 state 追上来后重复搜 */
  const lastSearchRef = useRef<{ q: string; filtersKey: string } | null>(null);

  // ─── 筛选（P1-2）────────────────────────────────
  const [folders, setFolders] = useState<Folder[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [pickedFolders, setPickedFolders] = useState<number[]>(initialUrl.folders);
  const [pickedTags, setPickedTags] = useState<number[]>(initialUrl.tags);
  const [pickedTypes, setPickedTypes] = useState<NoteType[]>(initialUrl.types);
  const [dateRange, setDateRange] = useState<[string, string] | null>(() =>
    initialUrl.updated ? toDayRange(initialUrl.updated) : null,
  );
  const [createdRange, setCreatedRange] = useState<[string, string] | null>(() =>
    initialUrl.created ? toDayRange(initialUrl.created) : null,
  );
  const [titleOnly, setTitleOnly] = useState(initialUrl.titleOnly);
  const [uncategorized, setUncategorized] = useState(initialUrl.uncategorized);
  const inputRef = useRef<InputRef>(null);
  const browseRef = useRef<SearchBrowseHandle>(null);
  const enabledViews = useAppStore((s) => s.enabledViews);

  // v4：筛选条搜索后常驻，结果行还要显示文件夹路径 → 进页面就拉文件夹树和标签（两张小表）
  useEffect(() => {
    folderApi.list().then(setFolders).catch(() => {});
    tagApi.list().then(setTags).catch(() => {});
  }, []);

  /** 组装成后端要的 filters（规则见 buildSearchFilters） */
  const filters = useMemo<SearchFilters | undefined>(
    () =>
      buildSearchFilters(
        {
          folders: pickedFolders,
          tags: pickedTags,
          types: pickedTypes,
          dateRange,
          createdRange,
          titleOnly,
        },
        folders,
      ),
    [pickedFolders, pickedTags, pickedTypes, dateRange, createdRange, titleOnly, folders],
  );

  const activeFilterCount =
    (pickedFolders.length > 0 ? 1 : 0) +
    (pickedTags.length > 0 ? 1 : 0) +
    (pickedTypes.length > 0 ? 1 : 0) +
    (dateRange ? 1 : 0) +
    (createdRange ? 1 : 0) +
    (titleOnly ? 1 : 0);

  function clearFilters() {
    setPickedFolders([]);
    setPickedTags([]);
    setPickedTypes([]);
    setDateRange(null);
    setCreatedRange(null);
    setTitleOnly(false);
  }

  // 筛选变化后立即用当前关键词重搜（用户改了条件却要再敲一次回车是很别扭的）
  const filtersKey = JSON.stringify(filters ?? {});
  useEffect(() => {
    if (!searched || !query.trim()) return;
    // 外部跳转时已经按新条件搜过了，条件 state 随后才更新到这里，别再搜一遍
    const last = lastSearchRef.current;
    if (last && last.q === query.trim() && last.filtersKey === filtersKey) return;
    doSearch(query.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  // URL ?type= 决定 Scope：缺省 "all"
  const scope = ((searchParams.get("type") ?? "all") as Scope);

  // 虚拟滚动只在「笔记」单 Tab 下启用（"全部" 时只展示前 20 条预览，无需虚拟化）
  const scrollParentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: scope === "notes" ? results.length : 0,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 6,
  });

  // URL ?q= 驱动搜索：外部（SearchPanel 点历史 / 首页搜索框直达）改变 URL 时
  // 同步输入框并触发重搜；用户在输入框 typing 走下方本地 debounce，不走这里
  //
  // 🔴 读 URL 和写 URL 两个 effect 在同一次提交里都会跑：外部跳转那一轮 query 还是旧值，
  //    写回 effect 若照常执行会把旧 q 写回去，下一轮读 effect 又把旧 q 当成"外部跳转"，
  //    关键词就在新旧之间来回切、反复搜。所以用 lastWrittenQRef 记住本页最后写进 URL 的 q：
  //    与它相同 = 自己写的，忽略；不同才是外部跳转，并让写回 effect 跳过这一轮。
  const urlQ = (searchParams.get("q") ?? "").trim();
  useEffect(() => {
    if (!urlQ || urlQ === lastWrittenQRef.current) return;
    lastWrittenQRef.current = urlQ;
    skipNextUrlWriteRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    // 外部跳转（侧栏历史 / 首页搜索框 / 后退）按 URL 里的条件来：只带 q 就等于清空筛选。
    // 否则沿用旧筛选，用户看不出结果被过滤了，会以为搜不到
    const next = parseSearchUrl(searchParams);
    const nextDate = next.updated ? toDayRange(next.updated) : null;
    const nextCreated = next.created ? toDayRange(next.created) : null;
    setQuery(urlQ);
    setPickedFolders(next.folders);
    setPickedTags(next.tags);
    setPickedTypes(next.types);
    setDateRange(nextDate);
    setCreatedRange(nextCreated);
    setTitleOnly(next.titleOnly);
    setUncategorized(next.uncategorized);
    doSearch(
      urlQ,
      buildSearchFilters(
        {
          folders: next.folders,
          tags: next.tags,
          types: next.types,
          dateRange: nextDate,
          createdRange: nextCreated,
          titleOnly: next.titleOnly,
        },
        folders,
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlQ]);

  // 首次进入：URL 里带着关键词（含从笔记返回）就按恢复的条件搜一次
  useEffect(() => {
    if (initialUrl.q) doSearch(initialUrl.q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 条件变化 → 写回 URL（replace，不往历史栈里塞记录，后退仍是回到上一页）
  useEffect(() => {
    // 外部跳转那一轮的 state 还是旧的，写回会把新 URL 覆盖掉（见上方读 URL 的 effect）
    if (skipNextUrlWriteRef.current) {
      skipNextUrlWriteRef.current = false;
      return;
    }
    lastWrittenQRef.current = query.trim();
    const day = (r: [string, string] | null): [string, string] | null =>
      r ? [r[0].slice(0, 10), r[1].slice(0, 10)] : null;
    const next = writeSearchUrl(searchParams, {
      q: query,
      folders: pickedFolders,
      tags: pickedTags,
      types: pickedTypes,
      updated: day(dateRange),
      created: day(createdRange),
      titleOnly,
      uncategorized,
    });
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [
    query,
    pickedFolders,
    pickedTags,
    pickedTypes,
    dateRange,
    createdRange,
    titleOnly,
    uncategorized,
    searchParams,
    setSearchParams,
  ]);

  /** 并发拉笔记 + 待办；任意一边失败不阻塞另一边 */
  async function doSearch(keyword: string, f: SearchFilters | undefined = filters) {
    // 请求序号：连续输入 / 改条件会有多个请求同时在跑，慢的旧结果回来不能盖掉新结果
    const seq = ++searchSeqRef.current;
    lastSearchRef.current = { q: keyword, filtersKey: JSON.stringify(f ?? {}) };
    setLoading(true);
    setSearched(true);
    const [notes, tasks] = await Promise.all([
      searchApi.search(keyword, undefined, f).catch((e) => {
        console.error("笔记搜索失败:", e);
        return [] as SearchResult[];
      }),
      taskApi.search(keyword, 50).catch((e) => {
        console.error("待办搜索失败:", e);
        return [] as TaskSearchHit[];
      }),
    ]);
    if (seq !== searchSeqRef.current) return;
    setResults(notes);
    setTaskResults(tasks);
    // 历史只在拿到任一结果时才记（避免空查询污染）
    if (notes.length + tasks.length > 0) {
      useAppStore.getState().pushRecentSearch(keyword);
    }
    setLoading(false);
  }

  function handleInputChange(value: string) {
    setQuery(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!value.trim()) {
      // 作废还在跑的请求，免得清空后旧结果又冒出来
      searchSeqRef.current++;
      lastSearchRef.current = null;
      setLoading(false);
      setResults([]);
      setTaskResults([]);
      setSearched(false);
      return;
    }
    // 搜索筛选表达不了「未分类」，继续留着选中会让人以为结果被限定在未分类里
    setUncategorized(false);
    timerRef.current = setTimeout(() => {
      doSearch(value.trim());
    }, 300);
  }

  /**
   * 三列选中项就存在筛选条件里（规则见 resolveBrowseSelection）。
   * 选完把焦点还给搜索框：可以接着打字缩小范围，也可以直接用方向键选文件。
   */
  function selectBrowse(next: BrowseSelection) {
    setUncategorized(next.kind === "uncategorized");
    setPickedFolders(next.kind === "folder" ? [next.id] : []);
    setPickedTags(next.kind === "tag" ? [next.id] : []);
    inputRef.current?.focus();
  }

  /** 文件夹或标签被删后 URL 里可能还留着旧 id，这时回到最近列表，别显示一个空列表 */
  const browseSelection = useMemo<BrowseSelection>(() => {
    const picked = resolveBrowseSelection({
      uncategorized,
      folders: pickedFolders,
      tags: pickedTags,
    });
    if (picked.kind === "folder" && folders.length > 0 && buildFolderPath(folders, picked.id).length === 0) {
      return { kind: "recent" };
    }
    if (picked.kind === "tag" && tags.length > 0 && !tags.some((t) => t.id === picked.id)) {
      return { kind: "recent" };
    }
    return picked;
  }, [uncategorized, pickedFolders, pickedTags, folders, tags]);

  /** 切换 Tab：写回 URL，保持 ?q= 不变以维持历史/分享链接 */
  function setScope(next: Scope) {
    const sp = new URLSearchParams(searchParams);
    if (next === "all") sp.delete("type");
    else sp.set("type", next);
    setSearchParams(sp, { replace: true });
  }

  const showNotes = scope === "all" || scope === "notes";
  const showTasks = scope === "all" || scope === "tasks";
  const totalHits = results.length + taskResults.length;
  // 笔记和待办都有结果时才需要分组标题；只有一类时它和胶囊里的数字重复，白占一行
  const showGroupHeads = scope === "all" && results.length > 0 && taskResults.length > 0;
  // "全部" 模式下笔记只展示 preview，超出由"查看全部"链接引导切到笔记 Tab
  const notesToRender =
    scope === "all" ? results.slice(0, ALL_MODE_NOTES_PREVIEW) : results;

  /** 文件夹 id → 「父 / 子」路径（结果行右侧小标签用） */
  const folderPathOf = (id: number | null) =>
    id == null ? "未分类" : buildFolderPath(folders, id).map((f) => f.name).join(" / ") || "未分类";

  /** 「时间 ▾」快捷区间（作用于修改时间）；创建时间只走下拉里的自定义 */
  const timePresets = useMemo(() => {
    const today = dayjs();
    const f = (d: dayjs.Dayjs) => d.format("YYYY-MM-DD");
    return [
      { label: "今天", range: [f(today), f(today)] as [string, string] },
      { label: "最近 7 天", range: [f(today.subtract(6, "day")), f(today)] as [string, string] },
      { label: "最近 30 天", range: [f(today.subtract(29, "day")), f(today)] as [string, string] },
      { label: "今年", range: [f(today.startOf("year")), f(today)] as [string, string] },
    ];
  }, []);
  const [timeOpen, setTimeOpen] = useState(false);
  const timeLabel = useMemo(() => {
    const parts: string[] = [];
    if (dateRange) {
      const a = dateRange[0].slice(0, 10);
      const b = dateRange[1].slice(0, 10);
      const hit = timePresets.find((p) => p.range[0] === a && p.range[1] === b);
      parts.push(hit ? hit.label : `${a.slice(5)} ~ ${b.slice(5)}`);
    }
    if (createdRange) parts.push("按创建时间");
    return parts.length > 0 ? parts.join(" · ") : "全部时间";
  }, [dateRange, createdRange, timePresets]);
  const pickerValue = (r: [string, string] | null): [dayjs.Dayjs, dayjs.Dayjs] | null =>
    r ? [dayjs(r[0].slice(0, 10)), dayjs(r[1].slice(0, 10))] : null;

  return (
    // v4 原型：搜索卡片 · 筛选卡片 · 结果胶囊 · 结果卡片；结果区自己滚动，上面三块不动
    <div className="kb-search-page">
      {/* 搜索框（原型 .sbar）：输入 · 语音 · 清除 ｜ 仅搜标题 · 搜索 */}
      <div className="kb-search-bar">
        <Input
          size="large"
          variant="borderless"
          placeholder="搜索笔记内容 / 待办标题…"
          prefix={<SearchIcon size={18} />}
          suffix={
            <MicButton
              size="small"
              stripTrailingPunctuation
              onTranscribed={(text) =>
                handleInputChange(query ? `${query} ${text}` : text)
              }
            />
          }
          ref={inputRef}
          value={query}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (query.trim() || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
            e.preventDefault();
            browseRef.current?.move(e.key === "ArrowDown" ? 1 : -1);
          }}
          onPressEnter={() => {
            if (!query.trim() && browseRef.current?.openActive()) return;
            handleInputChange(query);
          }}
          allowClear
          autoFocus={!query}
        />
        <span className="kb-search-sep" />
        {/* 原来藏在筛选面板里；放到这里随手可切（只影响笔记结果） */}
        <label className="kb-search-titleonly" title="只匹配笔记标题，不搜正文">
          <Switch size="small" checked={titleOnly} onChange={setTitleOnly} />
          仅搜标题
        </label>
        <Button
          type="primary"
          className="kb-bar-btn-p"
          // antd 默认在两个汉字间插空格（「搜 索」），原型没有
          autoInsertSpace={false}
          onClick={() => handleInputChange(query)}
        >
          搜索
        </Button>
      </div>

      {/* 结果胶囊 + 筛选条合成一行（原来各占一行，小窗口里结果区只剩五六条）。
          胶囊放最左边；筛选只作用于笔记，待办 Tab 下只留胶囊 */}
      {searched && (
        <div className="kb-filter-bar">
          <div className="kb-task-chips">
            {(
              [
                ["all", "全部", totalHits],
                ["notes", "笔记", results.length],
                ["tasks", "待办", taskResults.length],
              ] as const
            ).map(([k, label, n]) => (
              <button
                key={k}
                type="button"
                className={scope === k ? "kb-task-chip is-on" : "kb-task-chip"}
                onClick={() => setScope(k)}
              >
                {label}
                <b>{n}</b>
              </button>
            ))}
          </div>
          {scope !== "tasks" && (
          <>
          <span className="kb-search-sep" />
          <span className="kb-filter-title">
            <FilterIcon size={14} />
            筛选
          </span>
          <span className="kb-filter-lb">文件夹</span>
          <TreeSelect
            style={{ minWidth: 160, maxWidth: 240 }}
            multiple
            treeCheckable
            showCheckedStrategy={TreeSelect.SHOW_PARENT}
            maxTagCount={1}
            value={pickedFolders}
            onChange={(v) => setPickedFolders(v as number[])}
            treeData={folders as unknown as Record<string, unknown>[]}
            fieldNames={{ label: "name", value: "id", children: "children" }}
            placeholder="全部"
            allowClear
            treeNodeFilterProp="name"
          />
          <span className="kb-filter-lb">标签（需同时含有）</span>
          <Select
            style={{ minWidth: 150, maxWidth: 240 }}
            mode="multiple"
            maxTagCount={1}
            value={pickedTags}
            onChange={setPickedTags}
            options={tags.map((t) => ({ label: t.name, value: t.id }))}
            placeholder="全部"
            allowClear
            optionFilterProp="label"
          />
          <span className="kb-filter-lb">时间</span>
          <Popover
            trigger="click"
            placement="bottomLeft"
            arrow={false}
            open={timeOpen}
            onOpenChange={setTimeOpen}
            content={
              <div className="kb-date-menu">
                <div
                  className={!dateRange && !createdRange ? "kb-date-opt is-on" : "kb-date-opt"}
                  onClick={() => {
                    setDateRange(null);
                    setCreatedRange(null);
                    setTimeOpen(false);
                  }}
                >
                  全部时间
                </div>
                {timePresets.map((p) => (
                  <div
                    key={p.label}
                    className={timeLabel.startsWith(p.label) ? "kb-date-opt is-on" : "kb-date-opt"}
                    onClick={() => {
                      setDateRange(toDayRange(p.range));
                      setTimeOpen(false);
                    }}
                  >
                    修改于{p.label}
                  </div>
                ))}
                {/* 原来的两组自定义区间原样保留（受控：选快捷项后这里同步显示） */}
                <div className="kb-date-custom">
                  <span>修改时间</span>
                  <DatePicker.RangePicker
                    size="small"
                    value={pickerValue(dateRange)}
                    onChange={(_, strs) => setDateRange(toDayRange(strs))}
                    placeholder={["从", "至"]}
                    getPopupContainer={(el) => el.parentElement ?? document.body}
                  />
                  <span>创建时间</span>
                  <DatePicker.RangePicker
                    size="small"
                    value={pickerValue(createdRange)}
                    onChange={(_, strs) => setCreatedRange(toDayRange(strs))}
                    placeholder={["从", "至"]}
                    getPopupContainer={(el) => el.parentElement ?? document.body}
                  />
                </div>
              </div>
            }
          >
            <Button className={dateRange || createdRange ? "kb-bar-btn is-on" : "kb-bar-btn"}>
              {timeLabel}
              <ChevronDown size={12} />
            </Button>
          </Popover>
          <span className="kb-filter-lb">类型</span>
          {/* 只有笔记 / 白板两种：单选与原多选等价（两个都选 = 全部） */}
          <Segmented
            size="small"
            // 原型 .seg：30 高、圆角 8、选中白底描边（与编辑器模式切换同款）
            className="kb-mode-seg"
            value={pickedTypes.length === 1 ? pickedTypes[0] : "all"}
            onChange={(v) => setPickedTypes(v === "all" ? [] : [v as NoteType])}
            options={[
              { value: "all", label: "全部" },
              { value: "markdown", label: "笔记" },
              { value: "whiteboard", label: "白板" },
            ]}
          />
          <span className="flex-1" />
          {activeFilterCount > 0 && (
            <a className="kb-filter-clear" onClick={clearFilters}>
              清空全部筛选条件
            </a>
          )}
          </>
          )}
        </div>
      )}

      {/* 结果区 */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Spin size="large" tip="搜索中..." />
        </div>
      ) : !searched ? (
        <SearchBrowse
          ref={browseRef}
          folders={folders}
          tags={tags}
          showTags={enabledViews.has("tags")}
          selection={browseSelection}
          onSelect={selectBrowse}
        />
      ) : totalHits === 0 ? (
        <Empty
          description={`未找到与 "${query}" 相关的内容`}
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      ) : (
        // 单一滚动容器（整块卡片）；笔记 Tab 下用虚拟化，其它 Tab 直接渲染
        <div ref={scrollParentRef} className="kb-search-board">
          {/* 笔记分组 */}
          {showNotes && results.length > 0 && (
            <section>
              {showGroupHeads && <SectionHeader label="笔记" count={results.length} />}
              {scope === "notes" ? (
                // 笔记 Tab：虚拟滚动（千级结果不卡）
                <div
                  style={{
                    height: virtualizer.getTotalSize(),
                    width: "100%",
                    position: "relative",
                  }}
                >
                  {virtualizer.getVirtualItems().map((vItem) => {
                    const item = results[vItem.index];
                    return (
                      <div
                        key={item.id}
                        data-index={vItem.index}
                        ref={virtualizer.measureElement}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${vItem.start}px)`,
                        }}
                      >
                        <NoteRow
                          item={item}
                          keyword={query}
                          folderPath={folderPathOf(item.folder_id)}
                          onClick={() =>
                            navigate(
                              `/notes/${item.id}?q=${encodeURIComponent(query)}`,
                            )
                          }
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                // 全部 Tab：只渲染预览前 N 条，多余的引导切 Tab
                <>
                  {notesToRender.map((item) => (
                    <NoteRow
                      key={item.id}
                      item={item}
                      keyword={query}
                      folderPath={folderPathOf(item.folder_id)}
                      onClick={() =>
                        navigate(
                          `/notes/${item.id}?q=${encodeURIComponent(query)}`,
                        )
                      }
                    />
                  ))}
                  {results.length > ALL_MODE_NOTES_PREVIEW && (
                    <div className="py-2 text-center">
                      <a
                        onClick={() => setScope("notes")}
                        style={{ fontSize: 12, color: token.colorPrimary }}
                      >
                        查看全部 {results.length} 条笔记 →
                      </a>
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          {/* 待办分组（"全部" 或 "待办" Tab 显示）；原型里排在笔记后面 */}
          {showTasks && taskResults.length > 0 && (
            <section>
              {showGroupHeads && <SectionHeader label="待办" count={taskResults.length} />}
              {taskResults.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  keyword={query}
                  onClick={() => navigate(`/tasks?taskId=${task.id}`)}
                />
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/** 分组标题（原型 .grp：卡片内的小标题） */
function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="kb-task-sec-head">
      {label}
      <b>{count}</b>
    </div>
  );
}

/** 笔记结果行（原型 .sr）：类型图标块 · 标题 + 高亮摘要 ｜ 文件夹小标签 · 相对时间 */
function NoteRow({
  item,
  keyword,
  folderPath,
  onClick,
}: {
  item: SearchResult;
  keyword: string;
  folderPath: string;
  onClick: () => void;
}) {
  const isBoard = item.note_type === "whiteboard";
  return (
    <div className="kb-sr-row" onClick={onClick}>
      <span className={isBoard ? "kb-sr-ico is-info" : "kb-sr-ico"}>
        {isBoard ? <PenTool size={15} /> : <FileText size={15} />}
      </span>
      <div className="kb-sr-main">
        <div className="kb-sr-title">{highlightText(item.title, keyword)}</div>
        {/* 2 行截断让高亮大概率落在可见区域，避免单行被截走 */}
        <div className="kb-sr-snippet">
          {isBoard && !item.snippet ? "白板" : highlightFocusedSnippet(item.snippet, keyword)}
        </div>
      </div>
      <span className="kb-sr-folder" title={folderPath}>
        <FolderIcon size={12} />
        {folderPath}
      </span>
      <span className="kb-sr-time" title={item.updated_at.slice(0, 16)}>
        {relativeTime(item.updated_at)}
      </span>
    </div>
  );
}

/** 待办结果行：状态图标块 · 标题 + 说明 ｜ 截止日期 */
function TaskRow({
  task,
  keyword,
  onClick,
}: {
  task: TaskSearchHit;
  keyword: string;
  onClick: () => void;
}) {
  const done = task.status === 1;
  const urgent = task.priority === 0;
  const due = task.dueDate?.slice(0, 10) ?? null;
  return (
    <div className="kb-sr-row" onClick={onClick}>
      <span className={done ? "kb-sr-ico is-ok" : urgent ? "kb-sr-ico is-err" : "kb-sr-ico is-ok"}>
        {done ? <Check size={15} /> : urgent ? <AlertTriangle size={15} /> : <CheckSquare size={15} />}
      </span>
      <div className="kb-sr-main">
        <div className={done ? "kb-sr-title is-done" : "kb-sr-title"}>
          {task.title ? highlightText(task.title, keyword) : "无标题"}
        </div>
        <div className="kb-sr-snippet is-one">
          {[done ? "已完成" : urgent ? "紧急" : "", task.snippet].filter(Boolean).join(" · ") || "待办"}
        </div>
      </div>
      {due && <span className="kb-sr-time">{due}</span>}
    </div>
  );
}

import { useIsMobile } from "@/hooks/useIsMobile";
import { MobileSearch } from "./MobileSearch";

export default function SearchPage() {
  const isMobile = useIsMobile();
  return isMobile ? <MobileSearch /> : <DesktopSearchPage />;
}
