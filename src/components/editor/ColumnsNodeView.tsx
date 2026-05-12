/**
 * Columns 分栏块的 React NodeView。
 *
 * 渲染：顶部一条**常驻**操作栏（不靠 hover、不用绝对定位，避免被父级 overflow
 * 裁掉看不见）—— 左边「⠿ 分栏 · N列」标识，右边按钮：加一列 / 删除整个分栏块；
 * 下面是 flex 横排的列内容（NodeViewContent 接管）。
 *
 * 为什么需要 NodeView：column 节点是 isolating 的，光标 Backspace/Delete 出不去，
 * 单靠键盘很难删掉整块（已踩坑）。这里给一个永远可见的「删除分栏」按钮兜底。
 */
import {
  NodeViewContent,
  NodeViewWrapper,
  type NodeViewProps,
} from "@tiptap/react";
import { Tooltip } from "antd";
import { GripHorizontal, Minus, Plus, Trash2 } from "lucide-react";

export function ColumnsNodeView({ editor, node, getPos }: NodeViewProps) {
  const isEditable = editor?.isEditable !== false;
  const colCount = node.childCount;

  function stopMouseDown(e: React.MouseEvent) {
    // 阻止把 focus / selection 抢走（与工具栏按钮同款处理）
    e.preventDefault();
    e.stopPropagation();
  }

  function currentNodeRange(): { from: number; to: number } | null {
    const pos = typeof getPos === "function" ? getPos() : null;
    if (pos == null) return null;
    const n = editor.state.doc.nodeAt(pos);
    if (!n || n.type.name !== node.type.name) return null;
    return { from: pos, to: pos + n.nodeSize };
  }

  function addColumn() {
    const range = currentNodeRange();
    if (!range) return;
    // 在 columns 闭合标签前插入一个新列（含空段落）
    editor
      .chain()
      .focus()
      .insertContentAt(range.to - 1, {
        type: "column",
        content: [{ type: "paragraph" }],
      })
      .run();
  }

  function removeLastColumn() {
    const range = currentNodeRange();
    if (!range) return;
    const n = editor.state.doc.nodeAt(range.from);
    if (!n || n.childCount < 2 || !n.lastChild) return; // 至少留 1 列（剩 1 列会被自动解散）
    const lastTo = range.to - 1; // columns 闭合标签前 = 最后一列的结束位置
    const lastFrom = lastTo - n.lastChild.nodeSize;
    editor.chain().focus().deleteRange({ from: lastFrom, to: lastTo }).run();
  }

  function deleteColumns() {
    const range = currentNodeRange();
    if (!range) return;
    editor.chain().focus().deleteRange(range).run();
  }

  return (
    <NodeViewWrapper className="tiptap-columns-block" data-columns="true">
      {isEditable && (
        <div className="tiptap-columns-bar" contentEditable={false}>
          <span className="tiptap-columns-bar-label">
            <GripHorizontal size={12} />
            分栏 · {colCount}列
          </span>
          <span className="tiptap-columns-bar-actions">
            {colCount > 1 && (
              <Tooltip title="减少一列（删最后一列）" mouseEnterDelay={0.4}>
                <button
                  type="button"
                  className="tiptap-columns-btn"
                  onMouseDown={stopMouseDown}
                  onClick={removeLastColumn}
                >
                  <Minus size={13} />
                </button>
              </Tooltip>
            )}
            {colCount < 5 && (
              <Tooltip title="加一列" mouseEnterDelay={0.4}>
                <button
                  type="button"
                  className="tiptap-columns-btn"
                  onMouseDown={stopMouseDown}
                  onClick={addColumn}
                >
                  <Plus size={13} />
                </button>
              </Tooltip>
            )}
            <Tooltip title="删除整个分栏" mouseEnterDelay={0.4}>
              <button
                type="button"
                className="tiptap-columns-btn tiptap-columns-btn-danger"
                onMouseDown={stopMouseDown}
                onClick={deleteColumns}
              >
                <Trash2 size={13} />
              </button>
            </Tooltip>
          </span>
        </div>
      )}
      {/* 注意：@tiptap/react 会在这个元素里再塞一个 <div data-node-view-content-react>
          才放真正的列节点，所以横排 flex 要打在那个内层 div 上（见 global.css）。 */}
      <NodeViewContent className="tiptap-columns-row" />
    </NodeViewWrapper>
  );
}
