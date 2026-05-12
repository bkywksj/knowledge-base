/**
 * 单列（column）的 React NodeView。
 *
 * 只为了在每列右上角放一个「×」删除此列的按钮（hover 列时显示）。删到只剩 1 列时，
 * Columns 扩展里的 appendTransaction 会自动把分栏块解散成普通段落。
 *
 * 布局注意：列的横排 flex 由父级 .tiptap-columns-row 的内层 div 负责（见 global.css），
 * 这里 NodeViewWrapper 仍用 .tiptap-column 类当 flex item。
 */
import {
  NodeViewContent,
  NodeViewWrapper,
  type NodeViewProps,
} from "@tiptap/react";
import { Tooltip } from "antd";
import { X } from "lucide-react";

export function ColumnNodeView({ editor, getPos }: NodeViewProps) {
  const isEditable = editor?.isEditable !== false;

  function stopMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function deleteThisColumn() {
    const pos = typeof getPos === "function" ? getPos() : null;
    if (pos == null) return;
    const n = editor.state.doc.nodeAt(pos);
    if (!n || n.type.name !== "column") return;
    editor
      .chain()
      .focus()
      .deleteRange({ from: pos, to: pos + n.nodeSize })
      .run();
  }

  return (
    <NodeViewWrapper className="tiptap-column" data-column="true">
      {isEditable && (
        <Tooltip title="删除此列" mouseEnterDelay={0.4}>
          <button
            type="button"
            className="tiptap-column-del"
            contentEditable={false}
            onMouseDown={stopMouseDown}
            onClick={deleteThisColumn}
          >
            <X size={12} />
          </button>
        </Tooltip>
      )}
      <NodeViewContent className="tiptap-column-content" />
    </NodeViewWrapper>
  );
}
