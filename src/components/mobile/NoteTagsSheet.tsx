import { useEffect, useMemo, useState } from "react";
import { Plus, Search, X } from "lucide-react";
import { message } from "antd";
import { tagApi } from "@/lib/api";
import type { Tag } from "@/types";
import { tagDot } from "@/lib/tagColor";
import { MSheet } from "./MSheet";

/**
 * 手机编辑页的标签编辑：点标签行打开。
 * - 上面是这篇笔记已有的标签，点 × 移除
 * - 下面搜索全部标签，点一下加上；搜不到同名的就给「新建标签并添加」
 * 每一步直接调后端（addToNote / removeFromNote / create），和 PC 标签栏一样即时生效，没有「保存」按钮。
 */
export function NoteTagsSheet({
  open,
  onClose,
  noteId,
  tags,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  noteId: number;
  /** 当前笔记的标签 */
  tags: Tag[];
  onChange: (next: Tag[]) => void;
}) {
  const [all, setAll] = useState<Tag[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQ("");
    tagApi
      .list()
      .then(setAll)
      .catch((e) => message.error(`读取标签失败: ${e}`));
  }, [open]);

  const attached = useMemo(() => new Set(tags.map((t) => t.id)), [tags]);
  const kw = q.trim().toLowerCase();
  const candidates = useMemo(
    () => all.filter((t) => !attached.has(t.id) && (!kw || t.name.toLowerCase().includes(kw))).sort((a, b) => b.note_count - a.note_count),
    [all, attached, kw],
  );
  const exact = kw ? all.some((t) => t.name.toLowerCase() === kw) : true;

  async function add(t: Tag) {
    if (busy) return;
    setBusy(true);
    try {
      await tagApi.addToNote(noteId, t.id);
      onChange([...tags, t]);
      setQ("");
    } catch (e) {
      message.error(`添加标签失败: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(t: Tag) {
    if (busy) return;
    setBusy(true);
    try {
      await tagApi.removeFromNote(noteId, t.id);
      onChange(tags.filter((x) => x.id !== t.id));
    } catch (e) {
      message.error(`移除标签失败: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function createAndAdd() {
    const name = q.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const t = await tagApi.create(name);
      setAll((prev) => [...prev, t]);
      await tagApi.addToNote(noteId, t.id);
      onChange([...tags, t]);
      setQ("");
    } catch (e) {
      message.error(`新建标签失败: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <MSheet open={open} title="标签" caption="改动即时生效" onClose={onClose} cancelText="完成">
      {tags.length > 0 ? (
        <div className="flex flex-wrap gap-2 px-1">
          {tags.map((t) => (
            <span key={t.id} className="inline-flex h-9 items-center gap-1.5 rounded-[var(--m-r-m)] pl-3 text-[14px]" style={{ background: "var(--m-surface)", color: "var(--m-ink)" }}>
              <span className="m-dot" style={{ width: 8, height: 8, background: tagDot(t.color) }} />
              {t.name}
              <button type="button" aria-label={`移除标签「${t.name}」`} className="m-tapx flex h-9 w-8 items-center justify-center" style={{ color: "var(--m-ink3)" }} disabled={busy} onClick={() => void remove(t)}>
                <X size={16} />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="m-t-cap px-1">这篇笔记还没有标签</div>
      )}

      <label className="mt-4 flex h-11 items-center gap-2 rounded-[var(--m-r-l)] px-3" style={{ background: "var(--m-surface)" }}>
        <Search size={18} style={{ color: "var(--m-ink3)" }} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (candidates[0]) void add(candidates[0]);
            else if (!exact) void createAndAdd();
          }}
          placeholder="搜索或新建标签"
          maxLength={50}
          className="h-full min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-[var(--m-ink3)]"
          style={{ color: "var(--m-ink)" }}
        />
      </label>

      <div className="m-group mt-3 max-h-[36vh] overflow-y-auto">
        {!exact && (
          <button type="button" className="m-row m-row-icon" disabled={busy} onClick={() => void createAndAdd()}>
            <span className="flex w-6 shrink-0 justify-center" style={{ color: "var(--m-accent-ink)" }}>
              <Plus size={20} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[15px]" style={{ color: "var(--m-accent-ink)" }}>
              新建标签「{q.trim()}」并添加
            </span>
          </button>
        )}
        {candidates.map((t) => (
          <button key={t.id} type="button" className="m-row m-row-icon" disabled={busy} onClick={() => void add(t)}>
            <span className="flex w-6 shrink-0 justify-center">
              <span className="m-dot" style={{ background: tagDot(t.color) }} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[15px]">{t.name}</span>
            <span className="m-t-meta m-num shrink-0">{t.note_count} 篇</span>
          </button>
        ))}
        {exact && candidates.length === 0 && <div className="m-t-meta py-6 text-center">{kw ? "已经加上了" : "没有更多标签了"}</div>}
      </div>
    </MSheet>
  );
}
