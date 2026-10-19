/**
 * Toggle NodeView：▶ 三角图标控制折叠 + summary + content。
 *
 * - 用 NodeViewContent 容器渲染所有子节点（toggleSummary + toggleContent）
 * - ▶ 图标 contentEditable=false，点击切换 attrs.open
 * - 通过 data-open 属性 + CSS 控制内容区显隐（ProseMirror 仍然管理 doc）
 */
import {
  NodeViewContent,
  NodeViewWrapper,
  type NodeViewProps,
} from "@tiptap/react";
import { ChevronRight } from "lucide-react";

import { useEditorEditable } from "./useEditorEditable";
export function ToggleNodeView({ node, updateAttributes, editor }: NodeViewProps) {
  const open = node.attrs.open !== false;
  const isEditable = useEditorEditable(editor);

  function toggleOpen(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    updateAttributes({ open: !open });
  }

  function stopMouseDown(e: React.MouseEvent) {
    e.stopPropagation();
  }

  return (
    <NodeViewWrapper
      className="tiptap-toggle"
      data-open={open ? "true" : "false"}
    >
      <button
        type="button"
        className="tiptap-toggle-arrow"
        contentEditable={false}
        onMouseDown={stopMouseDown}
        onClick={toggleOpen}
        title={open ? "折叠" : "展开"}
        disabled={!isEditable && false} // 折叠按钮即使在只读时也允许点
      >
        <ChevronRight
          size={14}
          style={{
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 0.15s ease",
          }}
        />
      </button>
      {/* NodeViewContent 渲染 toggleSummary + toggleContent 两个子节点 */}
      <NodeViewContent className="tiptap-toggle-children" />
    </NodeViewWrapper>
  );
}
