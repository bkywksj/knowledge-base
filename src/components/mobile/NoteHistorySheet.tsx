import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, RotateCcw, Save } from "lucide-react";
import { Modal, message } from "antd";
import { noteApi } from "@/lib/api";
import type { NoteSnapshotMeta, SnapshotReason } from "@/types";
import { MSheet } from "./MSheet";

/**
 * 手机编辑页「更多 → 历史版本」。
 *
 * PC 的 NoteSnapshotDrawer 是左列表右正文的宽抽屉（min(1040px, 92vw)），手机放不下 → 改成两步：
 * 版本列表（时间 · 来源 · 大小）→ 点开看正文 → 恢复。接口、文案与 PC 一致：
 * - 「存档当前版本」= createSnapshot，内容与上一份相同时不重复存
 * - 恢复前后端会先把当前版本另存一份，点错了还能滚回来
 * 打开前由编辑页先把未保存的改动落盘（同 PC），否则恢复会冲掉没存的内容、存档也存不到最新。
 */

const REASON_LABEL: Record<SnapshotReason, { text: string; bg: string; fg: string }> = {
  auto: { text: "自动", bg: "var(--m-well)", fg: "var(--m-ink2)" },
  manual: { text: "手动存档", bg: "var(--m-info-soft)", fg: "var(--m-info)" },
  before_restore: { text: "恢复前备份", bg: "var(--m-warn-soft)", fg: "var(--m-warn)" },
};

/** 人话时间：今天只显示时刻，更早带上日期（同 PC） */
function formatStamp(raw: string): string {
  const d = new Date(raw.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return raw;
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameDay ? `今天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function NoteHistorySheet({
  open,
  onClose,
  noteId,
  onRestored,
}: {
  open: boolean;
  onClose: () => void;
  noteId: number;
  /** 恢复成功后用新正文重灌编辑器 —— 页面上那份已经是旧的了 */
  onRestored: (content: string) => void;
}) {
  const [list, setList] = useState<NoteSnapshotMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<NoteSnapshotMeta | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setList(await noteApi.listSnapshots(noteId));
    } catch (e) {
      message.error(`读取历史版本失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [noteId]);

  // 每次打开都重拉：关着的这段时间里笔记还在保存，列表随时会变长
  useEffect(() => {
    if (!open) {
      setSelected(null);
      setPreview(null);
      return;
    }
    void load();
  }, [open, load]);

  useEffect(() => {
    if (!selected) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    noteApi
      .getSnapshot(selected.id)
      .then((s) => !cancelled && setPreview(s.content))
      .catch((e) => {
        if (cancelled) return;
        message.error(`加载这一版失败: ${e}`);
        setSelected(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  async function manualSave() {
    try {
      const saved = await noteApi.createSnapshot(noteId);
      message.success(saved ? "已存档当前版本" : "内容与上一份存档相同，无需重复存");
      if (saved) await load();
    } catch (e) {
      message.error(`存档失败: ${e}`);
    }
  }

  function restore() {
    if (!selected || restoring) return;
    Modal.confirm({
      title: "恢复到这一版？",
      content: "当前正文会先自动存档一份，恢复后还能再滚回来。标题不变。",
      okText: "恢复",
      cancelText: "取消",
      centered: true,
      onOk: async () => {
        setRestoring(true);
        try {
          const note = await noteApi.restoreSnapshot(noteId, selected.id);
          message.success("已恢复到这一版（当前版本已自动存档，可再滚回来）");
          onRestored(note.content);
          onClose();
        } catch (e) {
          message.error(`恢复失败: ${e}`);
        } finally {
          setRestoring(false);
        }
      },
    });
  }

  // ── 第二步：看某一版的正文 ──
  if (selected) {
    const r = REASON_LABEL[selected.reason] ?? REASON_LABEL.auto;
    return (
      <MSheet
        open={open}
        title={formatStamp(selected.created_at)}
        caption={`${r.text} · ${formatBytes(selected.byte_size)} · 只读预览，恢复不改标题`}
        onClose={onClose}
        footer={
          <div className="mt-3 flex gap-2">
            <button type="button" className="m-btn flex-1" style={{ background: "var(--m-surface)", color: "var(--m-ink)" }} onClick={() => setSelected(null)}>
              <ChevronLeft size={18} /> 版本列表
            </button>
            <button type="button" className="m-btn flex-1" disabled={preview === null || restoring} onClick={restore}>
              <RotateCcw size={18} /> 恢复此版本
            </button>
          </div>
        }
      >
        {/* 按纯文本显示（同 PC）：要回答的是「那一版到底写了什么」，空行、列表符号这些常被误删的东西要看得见 */}
        <div className="m-group max-h-[50vh] overflow-y-auto px-4 py-3">
          {preview === null ? (
            <div className="m-t-meta py-6 text-center">加载中…</div>
          ) : (
            <pre className="m-0 whitespace-pre-wrap break-words text-[14px] leading-[1.7]" style={{ fontFamily: "inherit", color: "var(--m-ink)" }}>
              {preview || "（空）"}
            </pre>
          )}
        </div>
      </MSheet>
    );
  }

  // ── 第一步：版本列表 ──
  return (
    <MSheet open={open} title="历史版本" caption="保存时自动留底；点一版查看正文、恢复" onClose={onClose}>
      <div className="m-group">
        <button type="button" className="m-row m-row-icon" onClick={() => void manualSave()}>
          <span className="flex w-6 shrink-0 justify-center" style={{ color: "var(--m-accent-ink)" }}>
            <Save size={20} />
          </span>
          <span className="min-w-0 flex-1 text-[15px]" style={{ color: "var(--m-accent-ink)" }}>存档当前版本</span>
        </button>
      </div>
      <div className="m-group mt-3 max-h-[45vh] overflow-y-auto">
        {loading && list.length === 0 ? (
          <div className="m-t-meta py-8 text-center">加载中…</div>
        ) : list.length === 0 ? (
          <div className="m-t-meta py-8 text-center">还没有历史版本</div>
        ) : (
          list.map((it) => {
            const r = REASON_LABEL[it.reason] ?? REASON_LABEL.auto;
            return (
              <button key={it.id} type="button" className="m-row" onClick={() => setSelected(it)}>
                <span className="m-num min-w-0 flex-1 truncate text-[15px]">{formatStamp(it.created_at)}</span>
                <span className="m-tag shrink-0" style={{ background: r.bg, color: r.fg }}>{r.text}</span>
                <span className="m-t-meta m-num w-[64px] shrink-0 text-right">{formatBytes(it.byte_size)}</span>
              </button>
            );
          })
        )}
      </div>
    </MSheet>
  );
}
