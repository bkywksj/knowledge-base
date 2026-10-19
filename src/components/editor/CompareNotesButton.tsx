/**
 * 编辑器工具栏「与其他笔记对比」按钮。
 *
 * 流程：点按钮 → 弹笔记选择器（搜索）→ 选中某篇 → 打开合并视图：
 *   左 = 选中的那篇笔记（可编辑，content 本就是 markdown），右 = 当前笔记 markdown（可编辑，= 最终结果）。
 * 中缝 ▶ 把另一篇的变更块拉进当前笔记。「保存更改」分别写回两侧（只有真改了才写）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Modal, Select, Tooltip, message } from "antd";
import { FileDiff } from "lucide-react";
import type { Editor } from "@tiptap/react";
import { noteApi } from "@/lib/api";
import type { Note } from "@/types";
import { DiffMergeModal } from "./LazyDiffMergeModal";
import type { DiffSide } from "./DiffMergeModal";

interface Props {
  editor: Editor;
  /** 当前笔记 id；用于排除自身、保存时写回 */
  noteId?: number;
}

function getEditorMarkdown(editor: Editor): string {
  const storage = editor.storage as { markdown?: { getMarkdown: () => string } };
  return storage.markdown?.getMarkdown() ?? editor.getText({ blockSeparator: "\n\n" });
}

export function CompareNotesButton({ editor, noteId }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [options, setOptions] = useState<{ value: number; label: string }[]>([]);
  const [loadingOpts, setLoadingOpts] = useState(false);

  // 合并视图状态
  const [mergeOpen, setMergeOpen] = useState(false);
  const [left, setLeft] = useState<DiffSide>({ label: "", value: "", editable: true });
  const [right, setRight] = useState<DiffSide>({ label: "当前笔记", value: "", editable: true });
  const otherNoteRef = useRef<Note | null>(null);
  const baseRightRef = useRef<string>("");

  const loadOptions = useCallback(
    async (keyword?: string) => {
      setLoadingOpts(true);
      try {
        const page = await noteApi.list({ keyword: keyword || null, page_size: 30 });
        setOptions(
          page.items
            .filter((n) => n.id !== noteId && !n.is_encrypted)
            .map((n) => ({ value: n.id, label: n.title || `（无标题 #${n.id}）` })),
        );
      } catch (e) {
        message.error(`加载笔记列表失败：${e}`);
      } finally {
        setLoadingOpts(false);
      }
    },
    [noteId],
  );

  useEffect(() => {
    if (pickerOpen) void loadOptions();
  }, [pickerOpen, loadOptions]);

  async function pickNote(otherId: number) {
    try {
      const other = await noteApi.get(otherId);
      if (other.is_encrypted) {
        message.warning("该笔记已加密，无法在此对比");
        return;
      }
      otherNoteRef.current = other;
      const curMd = getEditorMarkdown(editor);
      baseRightRef.current = curMd;
      setLeft({ label: other.title || `笔记 #${otherId}`, value: other.content, editable: true });
      setRight({ label: "当前笔记 (markdown)", value: curMd, editable: true });
      setPickerOpen(false);
      setMergeOpen(true);
    } catch (e) {
      message.error(`打开笔记失败：${e}`);
    }
  }

  async function handleSave({ left: editedLeft, right: editedRight }: { left: string; right: string }) {
    const other = otherNoteRef.current;
    let touched = false;
    // 另一篇笔记：content 本就是 markdown，直接保存
    if (other && editedLeft !== other.content) {
      await noteApi.update(other.id, {
        title: other.title,
        content: editedLeft,
        folder_id: other.folder_id ?? null,
      });
      touched = true;
    }
    // 当前笔记：用 markdown 重新渲染编辑器（autosave 会持久化）
    if (editedRight !== baseRightRef.current) {
      editor.commands.setContent(editedRight, { emitUpdate: true });
      touched = true;
    }
    message.success(touched ? "已保存合并结果" : "没有更改，未保存");
  }

  return (
    <>
      <Tooltip title="与其他笔记对比 / 合并" mouseEnterDelay={0.5}>
        <Button type="text" size="small" icon={<FileDiff size={15} />} onClick={() => setPickerOpen(true)} />
      </Tooltip>

      <Modal
        title="选择要对比的笔记"
        open={pickerOpen}
        onCancel={() => setPickerOpen(false)}
        footer={null}
        width={460}
      >
        <Select
          showSearch
          autoFocus
          style={{ width: "100%" }}
          placeholder="搜索笔记标题…"
          loading={loadingOpts}
          filterOption={false}
          onSearch={(v) => void loadOptions(v)}
          options={options}
          notFoundContent={loadingOpts ? "加载中…" : "无匹配笔记"}
          onChange={(v) => void pickNote(v as number)}
        />
        <div style={{ fontSize: 12, color: "var(--ant-color-text-secondary, #888)", marginTop: 8 }}>
          选中后会打开对比视图：左 = 该笔记，右 = 当前笔记（= 最终结果）。
        </div>
      </Modal>

      <DiffMergeModal
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
        left={left}
        right={right}
        saveHint="「当前笔记」会用 markdown 重新生成内容（表格 / 批注 / 嵌入 / 折叠等自定义块可能不完全保留）；另一篇笔记直接以新内容保存。只改动过的那一侧才会被写回。"
        onSave={handleSave}
      />
    </>
  );
}
