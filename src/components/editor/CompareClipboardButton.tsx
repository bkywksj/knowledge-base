/**
 * 编辑器工具栏「与剪贴板对比」按钮（类似 IDEA 的 Compare with Clipboard）。
 *
 * 行为：打开对比/合并弹窗 —— 左 = 剪贴板（只读），右 = 当前笔记 markdown（可编辑）。
 * 中缝 ▶ 把剪贴板里的变更块拉进笔记；也可直接在右栏编辑。「保存更改」会用 markdown 重新生成笔记内容。
 *
 * 纯前端：剪贴板走 `@tauri-apps/plugin-clipboard-manager`（权限 `clipboard-manager:allow-read-text` 已声明），
 * 笔记 markdown 走 tiptap-markdown 注入的 `editor.storage.markdown`。
 */
import { useState } from "react";
import { Button, Tooltip, message } from "antd";
import { Diff } from "lucide-react";
import type { Editor } from "@tiptap/react";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { DiffMergeModal, type DiffSide } from "./DiffMergeModal";

interface Props {
  editor: Editor;
}

/** tiptap-markdown 注入的 storage.markdown（无 TS 声明） */
function getEditorMarkdown(editor: Editor): string {
  const storage = editor.storage as { markdown?: { getMarkdown: () => string } };
  return storage.markdown?.getMarkdown() ?? editor.getText({ blockSeparator: "\n\n" });
}

export function CompareClipboardButton({ editor }: Props) {
  const [open, setOpen] = useState(false);
  const [left, setLeft] = useState<DiffSide>({ label: "剪贴板", value: "", editable: false });
  const [right, setRight] = useState<DiffSide>({ label: "当前笔记 (markdown)", value: "", editable: true });

  async function handleOpen() {
    let clip = "";
    try {
      clip = (await readText()) ?? "";
    } catch {
      clip = "";
    }
    setLeft({ label: "剪贴板", value: clip, editable: false });
    setRight({ label: "当前笔记 (markdown)", value: getEditorMarkdown(editor), editable: true });
    setOpen(true);
  }

  return (
    <>
      <Tooltip title="与剪贴板对比 / 合并（左=剪贴板，右=当前笔记，可编辑）" mouseEnterDelay={0.5}>
        <Button type="text" size="small" icon={<Diff size={15} />} onClick={handleOpen} />
      </Tooltip>
      <DiffMergeModal
        open={open}
        onClose={() => setOpen(false)}
        left={left}
        right={right}
        saveHint="保存会用 markdown 重新生成整篇笔记，表格 / 批注 / 嵌入 / 折叠等自定义块可能不完全保留。"
        onSave={({ right: newMd }) => {
          // tiptap-markdown 让 setContent 接受 markdown 字符串
          editor.commands.setContent(newMd, { emitUpdate: true });
          message.success("已用合并结果更新笔记内容");
        }}
      />
    </>
  );
}
