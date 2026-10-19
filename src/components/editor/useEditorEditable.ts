import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";

/**
 * 订阅编辑器的可编辑状态。
 *
 * 为什么不能直接读 `editor.isEditable`：阅读模式切换走的是 `editor.setEditable()`，
 * 它不产生 transaction，React NodeView 不会因此重新渲染 —— 在渲染时读一次的值会过期，
 * 结果是「从编辑切到阅读后，表格工具条 / 代码块语言选择仍然能用」，误改后还会被自动保存。
 *
 * Tiptap 3 的 `setEditable(editable, emitUpdate = true)` 会 emit `update`，这里订阅它；
 * 顺带订阅 `transaction`，覆盖其它改动 editable 的路径。
 */
export function useEditorEditable(editor: Editor | null | undefined): boolean {
  const [editable, setEditable] = useState(() => editor?.isEditable !== false);

  useEffect(() => {
    if (!editor) return;
    const sync = () => setEditable(editor.isEditable !== false);
    sync();
    editor.on("update", sync);
    editor.on("transaction", sync);
    return () => {
      editor.off("update", sync);
      editor.off("transaction", sync);
    };
  }, [editor]);

  return editable;
}
