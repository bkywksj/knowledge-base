import { useEffect, useRef, useState } from "react";
import { Search as SearchIcon } from "lucide-react";
import { searchApi } from "@/lib/api";
import type { SearchResult } from "@/types";
import { MSheet, PickRow } from "./MSheet";

export interface PickedNote {
  id: number;
  title: string;
}

/**
 * 手机端「选笔记」面板（多选）：AI 对话的「附加笔记」用。
 * 关键词为空时列出已选的笔记（可点掉）；输入后按标题 / 正文搜（与搜索页同一接口），点一下选中 / 取消。
 * 「完成」才把结果交回调用方，中途关掉不改动。
 */
export function NotePickerSheet({
  open,
  title = "附加笔记",
  caption,
  initial,
  max = 20,
  onDone,
  onClose,
}: {
  open: boolean;
  title?: string;
  caption?: string;
  initial: PickedNote[];
  /** 最多选几篇（附加笔记会整篇塞进上下文，太多会撑爆窗口） */
  max?: number;
  onDone: (notes: PickedNote[]) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<PickedNote[]>(initial);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!open) return;
    setPicked(initial);
    setQ("");
    setResults([]);
    // 打开时用的是当时的 initial；面板开着期间外部再变不覆盖用户的勾选
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const k = q.trim();
    if (!k) {
      setResults([]);
      return;
    }
    const my = ++seq.current;
    setLoading(true);
    const t = window.setTimeout(() => {
      searchApi
        .search(k, 30)
        .then((r) => my === seq.current && setResults(r))
        .catch(() => my === seq.current && setResults([]))
        .finally(() => my === seq.current && setLoading(false));
    }, 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const isPicked = (id: number) => picked.some((p) => p.id === id);
  function toggle(n: PickedNote) {
    setPicked((list) => (list.some((p) => p.id === n.id) ? list.filter((p) => p.id !== n.id) : list.length >= max ? list : [...list, n]));
  }

  const rows: PickedNote[] = q.trim() ? results.map((r) => ({ id: r.id, title: r.title || "未命名笔记" })) : picked;

  return (
    <MSheet
      open={open}
      title={title}
      caption={caption ?? `已选 ${picked.length} 篇${picked.length >= max ? `（最多 ${max} 篇）` : ""}`}
      onClose={onClose}
      footer={
        <div className="mt-3 flex items-center justify-end gap-3">
          <button type="button" className="m-tapx text-[15px] font-semibold" style={{ color: "var(--m-ink2)" }} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="m-btn"
            onClick={() => {
              onDone(picked);
              onClose();
            }}
          >
            完成
          </button>
        </div>
      }
    >
      <div className="mb-3 flex h-11 items-center gap-2 rounded-[var(--m-r-l)] px-3" style={{ background: "var(--m-well)" }}>
        <SearchIcon size={18} className="shrink-0" style={{ color: "var(--m-ink3)" }} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索笔记标题 / 正文"
          aria-label="搜索笔记"
          className="h-full min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-[var(--m-ink3)]"
          style={{ color: "var(--m-ink)" }}
        />
      </div>
      <div className="m-group max-h-[45vh] overflow-y-auto">
        {rows.length === 0 ? (
          <div className="m-t-meta py-6 text-center">
            {q.trim() ? (loading ? "搜索中…" : `没有匹配「${q.trim()}」的笔记`) : "输入关键词查找要附加的笔记"}
          </div>
        ) : (
          rows.map((n) => <PickRow key={n.id} label={n.title} active={isPicked(n.id)} onClick={() => toggle(n)} />)
        )}
      </div>
    </MSheet>
  );
}
