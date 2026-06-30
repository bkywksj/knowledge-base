import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ChevronLeft, Search as SearchIcon, XCircle } from "lucide-react";
import { searchApi } from "@/lib/api";
import type { SearchResult } from "@/types";

/**
 * 移动端搜索页（设计稿：03-search.html）
 *
 * 路由 /search —— isMobile=true 时通过 wrapper 加载本组件。
 *
 * 行为：
 * - 顶栏：返回 + 搜索 input（带清空按钮）
 * - 输入 keyword 后 300ms debounce 调 search_notes
 * - 命中片段用 <mark> 高亮
 * - 点击结果跳 /notes/:id
 * - 空 keyword 时显示提示语，长度=1 时也搜（FTS 中文 trigram 友好）
 *
 * MVP 不做：
 * - 标题/正文/标签 子过滤 chip（暂不细分）
 * - AI 智能补充（设计稿橙色卡片，留待 RAG 接入）
 * - 搜索历史（暂不持久化）
 */

const DEBOUNCE_MS = 300;

export function MobileSearch() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const initialQ = params.get("q") ?? "";

  const [keyword, setKeyword] = useState(initialQ);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const debounceRef = useRef<number | null>(null);

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      setSearched(false);
      return;
    }
    setLoading(true);
    try {
      const list = await searchApi.search(q.trim(), 50);
      setResults(list);
      setSearched(true);
    } catch (e) {
      console.error("[MobileSearch] failed:", e);
      setResults([]);
      setSearched(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // debounce 触发
  useEffect(() => {
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
    }
    debounceRef.current = window.setTimeout(() => {
      void runSearch(keyword);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [keyword, runSearch]);

  // keyword 变化时同步到 URL（便于深链/返回）
  useEffect(() => {
    if (keyword) {
      setParams({ q: keyword }, { replace: true });
    } else if (params.has("q")) {
      setParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword]);

  return (
    <div className="text-slate-800">
      {/* 搜索栏 */}
      <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2">
        <button
          onClick={() => navigate(-1)}
          aria-label="返回"
          className="flex h-10 w-10 shrink-0 items-center justify-center"
        >
          <ChevronLeft size={24} className="text-slate-700" />
        </button>
        <div className="flex h-10 flex-1 items-center gap-2 rounded-xl bg-slate-100 px-3">
          <SearchIcon size={16} className="text-slate-400" />
          <input
            autoFocus
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索笔记 / 标题 / 正文"
            className="flex-1 bg-transparent text-sm outline-none"
          />
          {keyword && (
            <button
              onClick={() => setKeyword("")}
              aria-label="清空"
              className="flex h-6 w-6 items-center justify-center"
            >
              <XCircle size={16} className="text-slate-400" />
            </button>
          )}
        </div>
      </div>

      {/* 结果 */}
      <div className="bg-slate-50 min-h-[60vh] pb-24">
        {!keyword.trim() ? (
          <EmptyHint
            icon={<SearchIcon size={32} className="text-slate-300" />}
            text="搜索笔记标题 / 正文"
            sub="支持中文分词，输入即时搜索"
          />
        ) : loading && results.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-slate-400">
            搜索中…
          </div>
        ) : searched && results.length === 0 ? (
          <EmptyHint
            icon={<SearchIcon size={32} className="text-slate-300" />}
            text={`未找到「${keyword}」`}
            sub="换个关键词试试，或检查输入"
          />
        ) : (
          <>
            <div className="px-4 pt-3 pb-1 text-xs font-medium text-slate-400">
              搜索结果 · {results.length} 篇
            </div>
            {results.map((r) => (
              <ResultCard
                key={r.id}
                result={r}
                keyword={keyword}
                onClick={() =>
                  navigate(`/notes/${r.id}?q=${encodeURIComponent(keyword)}`)
                }
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function ResultCard({
  result,
  keyword,
  onClick,
}: {
  result: SearchResult;
  keyword: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="block w-full px-4 mb-2 text-left active:opacity-80"
    >
      <div className="rounded-2xl bg-white p-4">
        <h3 className="text-base font-semibold text-slate-900 line-clamp-1">
          <Highlight text={result.title || "未命名笔记"} keyword={keyword} />
        </h3>
        {result.snippet && (
          <p className="mt-1 line-clamp-2 text-sm text-slate-500">
            <Highlight text={result.snippet} keyword={keyword} />
          </p>
        )}
        <div className="mt-2 flex items-center gap-2 text-xs text-slate-400">
          <span className="ml-auto">
            {new Date(result.updated_at).toLocaleDateString("zh-CN", {
              month: "numeric",
              day: "numeric",
            })}
          </span>
        </div>
      </div>
    </button>
  );
}

/** 简易关键词高亮（不区分大小写，按 keyword 切分包 mark） */
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
          <mark
            key={idx}
            className="rounded-sm bg-amber-100 px-0.5 text-amber-800"
          >
            {p.t}
          </mark>
        ) : (
          <span key={idx}>{p.t}</span>
        ),
      )}
    </>
  );
}

function EmptyHint({
  icon,
  text,
  sub,
}: {
  icon: React.ReactNode;
  text: string;
  sub?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-16 text-slate-400">
      {icon}
      <span className="text-sm">{text}</span>
      {sub && <span className="text-xs text-slate-300">{sub}</span>}
    </div>
  );
}
