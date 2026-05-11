/**
 * IDEA 风格的"对比 / 合并"弹窗：左右两栏 CodeMirror MergeView，中缝带 ▶（把左侧变更块覆盖到右侧）。
 *
 * 约定：**右侧 = 最终结果**。
 *  - 剪贴板对比：左 = 剪贴板（只读），右 = 当前笔记 markdown（可编辑），▶ 把剪贴板的块拉进笔记
 *  - 笔记 vs 笔记：左 = 另一篇（可编辑），右 = 当前/目标笔记（可编辑），▶ 把另一篇的块拉进目标
 *
 * 保存：onSave 提供时右下角出现「保存更改」，回调拿到两侧编辑后的最终文本，由调用方决定怎么写回。
 */
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Modal, Space } from "antd";
import { MergeView } from "@codemirror/merge";
import { EditorView, lineNumbers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { useAppStore } from "@/store";

export interface DiffSide {
  label: string;
  value: string;
  editable: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  left: DiffSide;
  right: DiffSide;
  /** 提供则右下角显示「保存更改」按钮；回调拿到两侧编辑后的最终文本 */
  onSave?: (result: { left: string; right: string }) => Promise<void> | void;
  /** 「保存更改」下方的小字警告（如"将以 markdown 重新生成笔记内容，自定义块可能丢失"） */
  saveHint?: string;
}

// CodeMirror 主题：跟随 app 暗色 / 亮色；让编辑器填满固定高度容器并各自滚动
const sizingTheme = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { overflow: "auto" },
});
const darkTheme = EditorView.theme(
  {
    "&": { backgroundColor: "transparent", color: "var(--ant-color-text, #ddd)" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "#888",
      borderRight: "1px solid rgba(255,255,255,0.08)",
    },
    ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.04)" },
    ".cm-activeLineGutter": { backgroundColor: "rgba(255,255,255,0.06)" },
    ".cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "rgba(80,150,255,0.30)",
    },
    ".cm-cursor": { borderLeftColor: "#ddd" },
  },
  { dark: true },
);
const lightTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--ant-color-text, #222)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "#aaa",
    borderRight: "1px solid rgba(0,0,0,0.06)",
  },
});

function sideExtensions(editable: boolean, dark: boolean) {
  return [
    lineNumbers(),
    EditorView.lineWrapping,
    markdown(),
    sizingTheme,
    dark ? darkTheme : lightTheme,
    EditorView.editable.of(editable),
    ...(editable ? [] : [EditorState.readOnly.of(true)]),
  ];
}

export function DiffMergeModal({ open, onClose, left, right, onSave, saveHint }: Props) {
  const dark = useAppStore((s) => s.themeCategory) === "dark";
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mvRef = useRef<MergeView | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !hostRef.current) return;
    mvRef.current?.destroy();
    const mv = new MergeView({
      a: { doc: left.value, extensions: sideExtensions(left.editable, dark) },
      b: { doc: right.value, extensions: sideExtensions(right.editable, dark) },
      parent: hostRef.current,
      orientation: "a-b",
      // 中缝 ▶：把左(a)的变更块覆盖到右(b)。右侧 = 最终结果。
      revertControls: "a-to-b",
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 4 },
    });
    mvRef.current = mv;
    return () => {
      mv.destroy();
      mvRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, left.value, right.value, left.editable, right.editable, left.label, right.label, dark]);

  async function handleSave() {
    if (!onSave || !mvRef.current) return;
    const leftDoc = mvRef.current.a.state.doc.toString();
    const rightDoc = mvRef.current.b.state.doc.toString();
    setSaving(true);
    try {
      await onSave({ left: leftDoc, right: rightDoc });
      onClose();
    } catch (e) {
      // 调用方应在 onSave 内自行 message.error；这里兜底不吞异常的副作用
      console.error("[DiffMergeModal] onSave 失败:", e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={`${left.label}  ↔  ${right.label}`}
      width="92vw"
      style={{ top: 16, maxWidth: 1400 }}
      styles={{ body: { paddingTop: 8 } }}
      footer={
        <Space>
          <Button onClick={onClose}>取消</Button>
          {onSave && (
            <Button type="primary" loading={saving} onClick={handleSave}>
              保存更改
            </Button>
          )}
        </Space>
      }
    >
      <div
        style={{
          fontSize: 12,
          color: "var(--ant-color-text-secondary, #888)",
          marginBottom: 6,
        }}
      >
        左 = {left.label}
        {left.editable ? "" : "（只读）"}，右 = {right.label}
        {right.editable ? "" : "（只读）"}。中缝 ▶ 把左侧变更块覆盖到右侧；两栏均可直接编辑。
      </div>
      <div
        ref={hostRef}
        style={{
          height: "62vh",
          border: "1px solid var(--ant-color-border-secondary, #eee)",
          borderRadius: 6,
          overflow: "hidden",
        }}
      />
      {saveHint && onSave && (
        <Alert type="warning" showIcon banner style={{ marginTop: 8 }} message={saveHint} />
      )}
    </Modal>
  );
}
