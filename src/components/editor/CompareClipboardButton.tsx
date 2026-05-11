/**
 * 编辑器工具栏「对比剪贴板」按钮（类似 IDEA 的 Compare with Clipboard）
 *
 * 行为：
 *  - 编辑器里有选区 → 对比「选中文本」与「剪贴板文本」，并提供「用剪贴板替换选中文本」
 *  - 没有选区     → 对比「整篇笔记纯文本」与「剪贴板文本」（只读，不提供整篇替换，太危险）
 *
 * 纯前端：选区文本走 ProseMirror `doc.textBetween`，剪贴板走 `@tauri-apps/plugin-clipboard-manager`
 * （权限 `clipboard-manager:allow-read-text` 已在 capabilities 声明）。diff 渲染复用 `react-diff-viewer-continued`。
 */
import { useState } from "react";
import { Button, Empty, Modal, Segmented, Space, Tooltip, message } from "antd";
import { Diff } from "lucide-react";
import type { Editor } from "@tiptap/react";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued";
import { useAppStore } from "@/store";

interface Props {
  editor: Editor;
}

type DiffState = {
  /** 左侧（来自编辑器）文本 */
  left: string;
  /** 右侧（剪贴板）文本 */
  right: string;
  /** 本次是基于一个非空选区（→ 可以"用剪贴板替换选中"），还是整篇笔记（→ 只读） */
  fromSelection: boolean;
  /** 选区范围（fromSelection 时才有，用于替换） */
  range: { from: number; to: number } | null;
};

/** 取编辑器当前选区的纯文本；空选区返回 null */
function getSelectionText(editor: Editor): { text: string; from: number; to: number } | null {
  const { from, to, empty } = editor.state.selection;
  if (empty) return null;
  // blockSeparator "\n\n"：段落/标题/列表项等块之间补空行，diff 起来更直观
  const text = editor.state.doc.textBetween(from, to, "\n\n", "\n");
  return { text, from, to };
}

/** 取整篇笔记的纯文本 */
function getWholeNoteText(editor: Editor): string {
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n\n", "\n");
}

export function CompareClipboardButton({ editor }: Props) {
  const dark = useAppStore((s) => s.themeCategory) === "dark";
  const [data, setData] = useState<DiffState | null>(null);
  const [compareMode, setCompareMode] = useState<"words" | "lines">("words");

  async function handleOpen() {
    let clip = "";
    try {
      clip = (await readText()) ?? "";
    } catch {
      clip = "";
    }

    const sel = getSelectionText(editor);
    if (sel) {
      setData({ left: sel.text, right: clip, fromSelection: true, range: { from: sel.from, to: sel.to } });
    } else {
      setData({ left: getWholeNoteText(editor), right: clip, fromSelection: false, range: null });
    }
  }

  function close() {
    setData(null);
  }

  function applyClipboardToSelection() {
    if (!data || !data.range) return;
    const { from, to } = data.range;
    editor
      .chain()
      .focus()
      .insertContentAt({ from, to }, data.right)
      .run();
    message.success("已用剪贴板内容替换选中文本");
    close();
  }

  const bothEmpty = data && data.left.trim() === "" && data.right.trim() === "";
  const identical = data && data.left === data.right;

  return (
    <>
      <Tooltip title="与剪贴板对比（有选区→对比选中文本；无选区→对比整篇笔记）" mouseEnterDelay={0.5}>
        <Button type="text" size="small" icon={<Diff size={15} />} onClick={handleOpen} />
      </Tooltip>

      <Modal
        title={
          data?.fromSelection ? "选中文本 ↔ 剪贴板" : "整篇笔记 ↔ 剪贴板"
        }
        open={data !== null}
        onCancel={close}
        width="80vw"
        style={{ top: 24, maxWidth: 1100 }}
        footer={
          <Space>
            {data?.fromSelection && (
              <Button onClick={applyClipboardToSelection}>用剪贴板替换选中文本</Button>
            )}
            <Button type="primary" onClick={close}>
              关闭
            </Button>
          </Space>
        }
      >
        {data && (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: "var(--ant-color-text-secondary, #888)" }}>
                左 = {data.fromSelection ? "选中文本" : "整篇笔记"}，右 = 剪贴板
                {identical && !bothEmpty ? "（两者内容完全一致）" : ""}
              </span>
              <Segmented
                size="small"
                value={compareMode}
                onChange={(v) => setCompareMode(v as "words" | "lines")}
                options={[
                  { label: "按词", value: "words" },
                  { label: "按行", value: "lines" },
                ]}
              />
            </div>
            {bothEmpty ? (
              <Empty description="选中文本和剪贴板都为空" />
            ) : (
              <div
                style={{
                  maxHeight: "65vh",
                  overflow: "auto",
                  border: "1px solid var(--ant-color-border-secondary, #eee)",
                  borderRadius: 6,
                }}
              >
                <ReactDiffViewer
                  oldValue={data.left}
                  newValue={data.right}
                  splitView
                  useDarkTheme={dark}
                  compareMethod={compareMode === "words" ? DiffMethod.WORDS : DiffMethod.LINES}
                  leftTitle={data.fromSelection ? "选中文本" : "整篇笔记"}
                  rightTitle="剪贴板"
                />
              </div>
            )}
          </>
        )}
      </Modal>
    </>
  );
}
