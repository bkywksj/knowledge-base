/**
 * 笔记列表里"与另一篇笔记对比…" —— 给定一篇笔记，选第二篇，进合并视图。
 *
 * 两侧都是普通笔记（content 本就是 markdown），两栏可编辑，中缝 ▶ 把左侧变更块覆盖到右侧。
 * 「保存更改」只把真改动过的那一侧 noteApi.update 写回。不依赖编辑器。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { App as AntdApp, Modal, Select } from "antd";
import { noteApi } from "@/lib/api";
import type { Note } from "@/types";
import { DiffMergeModal } from "./LazyDiffMergeModal";
import type { DiffSide } from "./DiffMergeModal";
import { tidyNoteMarkdown } from "./markdownDiffUtil";

interface Props {
  /** 第一篇笔记 id；为 null 时本组件不渲染任何东西 */
  firstNoteId: number | null;
  /** 第二篇 id；提供则跳过选择器直接进合并视图（列表多选两篇用） */
  secondNoteId?: number | null;
  onClose: () => void;
}

export function NoteComparePicker({ firstNoteId, secondNoteId, onClose }: Props) {
  const { message } = AntdApp.useApp();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [options, setOptions] = useState<{ value: number; label: string }[]>([]);
  const [loadingOpts, setLoadingOpts] = useState(false);

  const [mergeOpen, setMergeOpen] = useState(false);
  const [left, setLeft] = useState<DiffSide>({ label: "", value: "", editable: true });
  const [right, setRight] = useState<DiffSide>({ label: "", value: "", editable: true });
  const noteARef = useRef<Note | null>(null);
  const noteBRef = useRef<Note | null>(null);
  const baseARef = useRef<string>("");
  const baseBRef = useRef<string>("");

  // 用两篇笔记进合并视图（tidy markdown + 记录 base 用于"只写改动过的一侧"）
  const startMerge = useCallback((a: Note, b: Note) => {
    noteARef.current = a;
    noteBRef.current = b;
    const aMd = tidyNoteMarkdown(a.content);
    const bMd = tidyNoteMarkdown(b.content);
    baseARef.current = aMd;
    baseBRef.current = bMd;
    setLeft({ label: a.title || `笔记 #${a.id}`, value: aMd, editable: true });
    setRight({ label: b.title || `笔记 #${b.id}`, value: bMd, editable: true });
    setPickerOpen(false);
    setMergeOpen(true);
  }, []);

  // firstNoteId 变化 → 拉第一篇；给了 secondNoteId 就直接对比，否则打开选择器
  useEffect(() => {
    if (firstNoteId == null) return;
    (async () => {
      try {
        const a = await noteApi.get(firstNoteId);
        if (a.is_encrypted) {
          message.warning("该笔记已加密，无法在此对比");
          onClose();
          return;
        }
        if (secondNoteId != null) {
          const b = await noteApi.get(secondNoteId);
          if (b.is_encrypted) {
            message.warning("所选笔记中有已加密的，无法在此对比");
            onClose();
            return;
          }
          startMerge(a, b);
        } else {
          noteARef.current = a;
          setPickerOpen(true);
        }
      } catch (e) {
        message.error(`打开笔记失败：${e}`);
        onClose();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstNoteId, secondNoteId]);

  const loadOptions = useCallback(
    async (keyword?: string) => {
      setLoadingOpts(true);
      try {
        const page = await noteApi.list({ keyword: keyword || null, page_size: 30 });
        setOptions(
          page.items
            .filter((n) => n.id !== firstNoteId && !n.is_encrypted)
            .map((n) => ({ value: n.id, label: n.title || `（无标题 #${n.id}）` })),
        );
      } catch (e) {
        message.error(`加载笔记列表失败：${e}`);
      } finally {
        setLoadingOpts(false);
      }
    },
    [firstNoteId, message],
  );

  useEffect(() => {
    if (pickerOpen) void loadOptions();
  }, [pickerOpen, loadOptions]);

  async function pickSecond(secondId: number) {
    const a = noteARef.current;
    if (!a) return;
    try {
      const b = await noteApi.get(secondId);
      if (b.is_encrypted) {
        message.warning("该笔记已加密，无法在此对比");
        return;
      }
      startMerge(a, b);
    } catch (e) {
      message.error(`打开笔记失败：${e}`);
    }
  }

  async function handleSave({ left: editedA, right: editedB }: { left: string; right: string }) {
    const a = noteARef.current;
    const b = noteBRef.current;
    let touched = false;
    if (a && editedA !== baseARef.current) {
      await noteApi.update(a.id, { title: a.title, content: editedA, folder_id: a.folder_id ?? null });
      touched = true;
    }
    if (b && editedB !== baseBRef.current) {
      await noteApi.update(b.id, { title: b.title, content: editedB, folder_id: b.folder_id ?? null });
      touched = true;
    }
    message.success(touched ? "已保存合并结果" : "没有更改，未保存");
  }

  function closeAll() {
    setPickerOpen(false);
    setMergeOpen(false);
    onClose();
  }

  if (firstNoteId == null) return null;

  return (
    <>
      <Modal
        title="选择要对比的第二篇笔记"
        open={pickerOpen}
        onCancel={closeAll}
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
          onChange={(v) => void pickSecond(v as number)}
        />
        <div style={{ fontSize: 12, color: "var(--ant-color-text-secondary, #888)", marginTop: 8 }}>
          打开对比视图后，中缝 ▶ 把左侧变更块覆盖到右侧；两栏都可直接编辑，保存只写回改动过的一侧。
        </div>
      </Modal>

      <DiffMergeModal
        open={mergeOpen}
        onClose={closeAll}
        left={left}
        right={right}
        saveHint="两篇笔记都会以编辑后的内容（markdown）直接保存。若其中某篇当前在编辑器里打开，保存后请重新打开它以看到更新。"
        onSave={handleSave}
      />
    </>
  );
}
