import { useEffect, useRef, useState } from "react";
import { Input, Modal, message } from "antd";
import type { TextAreaRef } from "antd/es/input/TextArea";
import { cardApi } from "@/lib/api";
import { useIsMobile } from "@/hooks/useIsMobile";
import { CardCreateSheet } from "@/components/mobile/CardCreateSheet";

/**
 * 选中文字「转为闪卡」的弹窗：正面预填选中的文字，补上反面就保存，自动关联当前笔记。
 *
 * 之前只能先给文字加批注、再在批注上右键转卡（反面 = 批注），手机上没有右键，等于建不了卡。
 * 手机用底部面板（CardCreateSheet，可改关联笔记），电脑用居中对话框。
 */
export function MakeCardDialog({
  front,
  noteId,
  onClose,
}: {
  /** 选中的文字；null = 关闭 */
  front: string | null;
  noteId?: number;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  const open = front != null;

  if (isMobile) {
    return (
      <CardCreateSheet
        open={open}
        onClose={onClose}
        initialFront={front ?? ""}
        initialNote={noteId != null ? { id: noteId, title: "当前笔记" } : null}
      />
    );
  }
  return <DesktopMakeCardModal open={open} initialFront={front ?? ""} noteId={noteId} onClose={onClose} />;
}

function DesktopMakeCardModal({
  open,
  initialFront,
  noteId,
  onClose,
}: {
  open: boolean;
  initialFront: string;
  noteId?: number;
  onClose: () => void;
}) {
  const [front, setFront] = useState("");
  const [back, setBack] = useState("");
  const [saving, setSaving] = useState(false);
  const backRef = useRef<TextAreaRef>(null);

  useEffect(() => {
    if (!open) return;
    setFront(initialFront.trim());
    setBack("");
  }, [open, initialFront]);

  async function submit() {
    const f = front.trim();
    const b = back.trim();
    if (!f || !b || saving) return;
    setSaving(true);
    try {
      await cardApi.create({ front: f, back: b, noteId: noteId ?? null });
      message.success("已生成闪卡，前往「复习」查看");
      onClose();
    } catch (e) {
      message.error(`生成失败：${e}`);
    } finally {
      setSaving(false);
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <Modal
      open={open}
      title="转为闪卡"
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      okButtonProps={{ disabled: !front.trim() || !back.trim() }}
      onOk={() => void submit()}
      onCancel={onClose}
      afterOpenChange={(v) => v && backRef.current?.focus()}
      destroyOnHidden
    >
      <div className="flex flex-col gap-3">
        <div>
          <div className="mb-1 text-xs opacity-70">正面（问题 / 提示）</div>
          <Input.TextArea value={front} onChange={(e) => setFront(e.target.value)} onKeyDown={onKeyDown} autoSize={{ minRows: 2, maxRows: 6 }} />
        </div>
        <div>
          <div className="mb-1 text-xs opacity-70">反面（答案）</div>
          <Input.TextArea
            ref={backRef}
            value={back}
            onChange={(e) => setBack(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="写下答案，Ctrl + Enter 保存"
            autoSize={{ minRows: 3, maxRows: 8 }}
          />
        </div>
      </div>
    </Modal>
  );
}
