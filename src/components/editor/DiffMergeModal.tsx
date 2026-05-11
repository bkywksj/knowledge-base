/**
 * "对比 / 合并"弹窗：左右两栏 CodeMirror MergeView，中缝带 ▶（把左侧变更块覆盖到右侧）。
 *
 * 约定：**右侧 = 最终结果**。
 *  - 剪贴板对比：左 = 剪贴板（只读），右 = 当前笔记内容（可编辑），▶ 把剪贴板的块拉进笔记
 *  - 笔记 vs 笔记：左 = 另一篇（可编辑），右 = 当前/目标笔记（可编辑），▶ 把另一篇的块拉进目标
 *
 * 保存：onSave 提供时右下角出现「保存更改」，回调拿到两侧编辑后的最终文本，由调用方决定怎么写回。
 *
 * `@codemirror/merge` 的设计（看它源码 baseTheme 才搞明白）：
 *  - 内部强制 `.cm-editor`/`.cm-scroller` 为 `height:auto !important; overflow-y:visible !important` ——
 *    即两侧编辑器**长到内容全高、自己不内部滚动**，整块 merge 视图由**外层容器**统一滚（只有一个滚动条，
 *    并排两侧一起滚；这库做不出"左右独立滚"，所以没有"是否同步滚动"的开关）。
 *    所以这里 host div 设 `overflow:auto` 当滚动容器，**不要**给 `.cm-mergeView*` 设 height。
 *  - 不开 `EditorView.lineWrapping`：靠像素级 spacer 对齐行，某侧换行另一侧不换就错位 → 不换行 + 横向滚。
 *  - antd Modal 开场 scale 动画里 CM 量到的是缩放后的尺寸 → `afterOpenChange(true)` 后再 `requestMeasure()`。
 *  - 文本先 `\r\n` → `\n`，否则一边带 `\r` 会被判成"整篇每行都变了"。
 *
 * MergeView 是命令式 DOM 库：host div 用 state（callback ref）记下来，再用 useEffect 在「host 挂载 / 两侧内容
 * 或可编辑性 / 主题」变化时**原地**销毁+重建（不重挂 Modal，所以切换"Markdown 源码/纯文本"不会闪一下重弹窗）。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
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
  /** 标题下方说明行右侧的额外控件（如剪贴板对比的「Markdown 源码 / 纯文本」切换） */
  headerExtra?: ReactNode;
}

const normalizeEol = (s: string) => s.replace(/\r\n/g, "\n");

const baseSideTheme = EditorView.theme({
  ".cm-scroller": { fontFamily: "inherit", fontSize: "13px" },
  ".cm-content": { paddingBottom: "8px" },
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
    markdown(),
    baseSideTheme,
    dark ? darkTheme : lightTheme,
    EditorView.editable.of(editable),
    ...(editable ? [] : [EditorState.readOnly.of(true)]),
  ];
}

export function DiffMergeModal({ open, onClose, left, right, onSave, saveHint, headerExtra }: Props) {
  const dark = useAppStore((s) => s.themeCategory) === "dark";
  const [hostEl, setHostEl] = useState<HTMLDivElement | null>(null);
  const mvRef = useRef<MergeView | null>(null);
  const [saving, setSaving] = useState(false);

  // host 挂载 / 两侧内容或可编辑性 / 主题 变化 → 原地销毁+重建 MergeView（不重挂 Modal）
  useEffect(() => {
    if (!hostEl) return;
    const mv = new MergeView({
      a: { doc: normalizeEol(left.value), extensions: sideExtensions(left.editable, dark) },
      b: { doc: normalizeEol(right.value), extensions: sideExtensions(right.editable, dark) },
      parent: hostEl,
      orientation: "a-b",
      revertControls: "a-to-b", // 中缝 ▶：把左(a)的变更块覆盖到右(b)。右侧 = 最终结果。
      highlightChanges: true,
      gutter: true,
    });
    mvRef.current = mv;
    // 双 rAF：等 Modal 布局/动画稳定后强制 CM 重量尺寸（不然 spacer 高度算错、内容显示不全）
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        mv.a.requestMeasure();
        mv.b.requestMeasure();
      }),
    );
    return () => {
      cancelAnimationFrame(id);
      mv.destroy();
      if (mvRef.current === mv) mvRef.current = null;
    };
  }, [hostEl, left.value, right.value, left.editable, right.editable, dark]);

  async function handleSave() {
    if (!onSave || !mvRef.current) return;
    const leftDoc = mvRef.current.a.state.doc.toString();
    const rightDoc = mvRef.current.b.state.doc.toString();
    setSaving(true);
    try {
      await onSave({ left: leftDoc, right: rightDoc });
      onClose();
    } catch (e) {
      console.error("[DiffMergeModal] onSave 失败:", e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      destroyOnClose
      afterOpenChange={(o) => {
        if (o)
          requestAnimationFrame(() => {
            mvRef.current?.a.requestMeasure();
            mvRef.current?.b.requestMeasure();
          });
      }}
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
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          fontSize: 12,
          color: "var(--ant-color-text-secondary, #888)",
          marginBottom: 6,
        }}
      >
        <span>
          左 = {left.label}
          {left.editable ? "" : "（只读）"}，右 = {right.label}
          {right.editable ? "" : "（只读）"}。中缝 ▶ 把左侧变更块覆盖到右侧；两栏均可直接编辑（行不换行，可横向滚）。
        </span>
        {headerExtra && <span style={{ flexShrink: 0 }}>{headerExtra}</span>}
      </div>
      <div
        ref={setHostEl}
        style={{
          maxHeight: "66vh",
          minHeight: "200px",
          overflow: "auto",
          border: "1px solid var(--ant-color-border-secondary, #eee)",
          borderRadius: 6,
        }}
      />
      {saveHint && onSave && (
        <Alert type="warning" showIcon banner style={{ marginTop: 8 }} message={saveHint} />
      )}
    </Modal>
  );
}
