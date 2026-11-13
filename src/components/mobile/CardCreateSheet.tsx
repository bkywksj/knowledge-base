import { useEffect, useRef, useState } from "react";
import { message } from "antd";
import { FileText, X } from "lucide-react";
import { cardApi } from "@/lib/api";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";
import { MSheet } from "./MSheet";
import { NotePickerSheet, type PickedNote } from "./NotePickerSheet";

/**
 * 移动端「新建闪卡」底部面板。
 *
 * 两个入口共用：闪卡页右上角「＋」（空白新建，可选关联笔记）；
 * 笔记编辑器选中文字后的「转为闪卡」（正面预填选中文字，关联当前笔记）。
 * 此前移动端没有任何建卡入口，闪卡页永远是空的。
 */
export function CardCreateSheet({
  open,
  onClose,
  onCreated,
  initialFront = "",
  initialNote = null,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
  /** 正面预填（编辑器选中的文字） */
  initialFront?: string;
  /** 预先关联的笔记（从笔记里建卡时就是这篇） */
  initialNote?: PickedNote | null;
}) {
  const keyboardInset = useKeyboardInset();
  const backRef = useRef<HTMLTextAreaElement>(null);
  const frontRef = useRef<HTMLTextAreaElement>(null);
  const [front, setFront] = useState("");
  const [back, setBack] = useState("");
  const [note, setNote] = useState<PickedNote | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFront(initialFront.trim());
    setBack("");
    setNote(initialNote);
    // 正面已预填就直接让用户写答案；延迟聚焦：面板入场动画没完成时 Android WebView 拉不起键盘
    const t = window.setTimeout(() => (initialFront.trim() ? backRef : frontRef).current?.focus(), 120);
    return () => window.clearTimeout(t);
    // 只在打开时取一次初始值，开着期间外部变化不覆盖用户输入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit() {
    const f = front.trim();
    const b = back.trim();
    if (!f || !b || saving) return;
    setSaving(true);
    try {
      await cardApi.create({ front: f, back: b, noteId: note?.id ?? null });
      message.success("已生成闪卡");
      onCreated?.();
      onClose();
    } catch (e) {
      message.error(`生成失败：${e}`);
    } finally {
      setSaving(false);
    }
  }

  const fieldCls =
    "block min-h-[72px] max-h-40 w-full resize-none rounded-[var(--m-r-l)] px-3 py-2.5 text-[16px] leading-normal outline-none placeholder:text-[var(--m-ink3)]";
  const fieldStyle = { background: "var(--m-well)", color: "var(--m-ink)", fieldSizing: "content" } as React.CSSProperties;

  return (
    <>
      <MSheet
        open={open && !pickerOpen}
        title="新建闪卡"
        caption="复习时先看正面，回想后翻看反面"
        onClose={onClose}
        footer={
          <div className="mt-3 flex items-center justify-end gap-3" style={{ paddingBottom: keyboardInset }}>
            <button type="button" className="m-tapx text-[15px] font-semibold" style={{ color: "var(--m-ink2)" }} onClick={onClose}>
              取消
            </button>
            <button type="button" className="m-btn" disabled={!front.trim() || !back.trim() || saving} onClick={() => void submit()}>
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        }
      >
        <div className="m-t-cap mb-1.5">正面 · 问题</div>
        <textarea
          ref={frontRef}
          value={front}
          onChange={(e) => setFront(e.target.value)}
          placeholder="例如：TCP 三次握手第二步是？"
          aria-label="正面"
          className={fieldCls}
          style={fieldStyle}
        />
        <div className="m-t-cap mt-3 mb-1.5">反面 · 答案</div>
        <textarea
          ref={backRef}
          value={back}
          onChange={(e) => setBack(e.target.value)}
          placeholder="例如：服务端回 SYN+ACK"
          aria-label="反面"
          className={fieldCls}
          style={fieldStyle}
        />
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            className="m-tapx flex min-w-0 items-center gap-1.5 text-[14px]"
            style={{ color: note ? "var(--m-accent-ink)" : "var(--m-ink2)" }}
            onClick={() => setPickerOpen(true)}
          >
            <FileText size={16} className="shrink-0" />
            <span className="truncate">{note ? note.title : "关联笔记（可选）"}</span>
          </button>
          {note && (
            <button type="button" aria-label="取消关联" className="m-icon-btn shrink-0" onClick={() => setNote(null)}>
              <X size={16} />
            </button>
          )}
        </div>
      </MSheet>

      <NotePickerSheet
        open={open && pickerOpen}
        title="关联笔记"
        caption="选一篇，复习时可以回到原文"
        initial={note ? [note] : []}
        max={1}
        onDone={(list) => setNote(list[list.length - 1] ?? null)}
        onClose={() => setPickerOpen(false)}
      />
    </>
  );
}
