/**
 * YAML front-matter 属性卡片。
 *
 * 平时逐行显示键值；可编辑时点卡片切成 YAML 文本框，失焦时提交，按 Esc 放弃，清空即删除。
 * 内容不合法时不提交，保留草稿并提示，避免写回后下次又解析成分割线和标题。
 *
 * 切换时卡片不跳动：文本框与键值行同字号同行高，并以切换前的高度为最小高度。
 * YAML 行数多于键值行（如多行列表）时才会变高，否则内容就得在小框里滚动。
 */
import { useRef, useState } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Input, message } from "antd";
import { buildFrontMatter, frontMatterEntries, frontMatterInner } from "@/lib/frontMatter";
import { useEditorEditable } from "./useEditorEditable";

export function FrontMatterNodeView({ node, updateAttributes, deleteNode, editor }: NodeViewProps) {
  const raw = String(node.attrs.raw ?? "");
  const isEditable = useEditorEditable(editor);
  const rowsRef = useRef<HTMLDListElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [minHeight, setMinHeight] = useState<number>();

  function startEditing() {
    // 拖选文字复制时松开鼠标也会触发 click，不能因此切走
    if (isEditable && window.getSelection()?.isCollapsed !== false) {
      setMinHeight(rowsRef.current?.offsetHeight);
      setDraft(frontMatterInner(raw));
    }
  }

  function cancel() {
    setDraft(null);
    setInvalid(false);
  }

  function commit() {
    if (draft === null) return;
    if (draft.trim() === "") {
      deleteNode();
      return;
    }
    const next = buildFrontMatter(draft);
    if (!next) {
      setInvalid(true);
      message.error("属性格式不正确，未保存：每个顶层行需要是 key: value，且不能包含 --- 行。按 Esc 还原。");
      return;
    }
    if (next !== raw) updateAttributes({ raw: next });
    cancel();
  }

  return (
    <NodeViewWrapper
      className={invalid ? "tiptap-front-matter is-invalid" : "tiptap-front-matter"}
      contentEditable={false}
    >
      {draft !== null && isEditable ? (
        <Input.TextArea
          className="tiptap-front-matter-input"
          variant="borderless"
          value={draft}
          autoFocus
          autoSize
          spellCheck={false}
          style={{ minHeight }}
          onChange={(e) => {
            setDraft(e.target.value);
            setInvalid(false);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") cancel();
          }}
        />
      ) : (
        <dl
          ref={rowsRef}
          className={isEditable ? "tiptap-front-matter-rows is-editable" : "tiptap-front-matter-rows"}
          onClick={startEditing}
        >
          {frontMatterEntries(raw).map((entry, index) => (
            <div className="tiptap-front-matter-row" key={`${index}-${entry.key}`}>
              <dt>{entry.key}</dt>
              <dd>{entry.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </NodeViewWrapper>
  );
}
