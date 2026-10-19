/**
 * Callout 块的 React NodeView。
 *
 * 布局：左侧 emoji 图标（点击切换类型）+ 右侧多行内容。
 * 类型切换：点 emoji 弹下拉选 4 种类型，updateAttributes({ type })。
 * 编辑：内容区是 NodeViewContent，PM 接管编辑/选区。
 */
import { useState } from "react";
import {
  NodeViewContent,
  NodeViewWrapper,
  type NodeViewProps,
} from "@tiptap/react";
import { Dropdown } from "antd";
import { CALLOUT_PRESETS, type CalloutType } from "./Callout";

import { useEditorEditable } from "./useEditorEditable";
export function CalloutNodeView({ node, updateAttributes, editor }: NodeViewProps) {
  const type: CalloutType = (node.attrs.type as CalloutType) || "info";
  const preset = CALLOUT_PRESETS[type] ?? CALLOUT_PRESETS.info;
  const [_open, setOpen] = useState(false);
  void _open;

  const isEditable = useEditorEditable(editor);

  function stopMouseDown(e: React.MouseEvent) {
    e.stopPropagation();
  }

  return (
    <NodeViewWrapper
      className={`tiptap-callout tiptap-callout-${type}`}
      data-callout={type}
    >
      <Dropdown
        trigger={["click"]}
        placement="bottomLeft"
        disabled={!isEditable}
        onOpenChange={setOpen}
        menu={{
          items: (Object.keys(CALLOUT_PRESETS) as CalloutType[]).map((k) => ({
            key: k,
            label: (
              <span>
                <span style={{ marginRight: 8 }}>{CALLOUT_PRESETS[k].emoji}</span>
                {CALLOUT_PRESETS[k].label}
              </span>
            ),
          })),
          selectedKeys: [type],
          onClick: ({ key }) => updateAttributes({ type: key as CalloutType }),
        }}
      >
        <button
          type="button"
          className="tiptap-callout-icon"
          contentEditable={false}
          onMouseDown={stopMouseDown}
          title={`${preset.label}（点击切换类型）`}
        >
          {preset.emoji}
        </button>
      </Dropdown>
      <NodeViewContent className="tiptap-callout-body" />
    </NodeViewWrapper>
  );
}
