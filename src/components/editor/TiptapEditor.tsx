import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Highlight from "@tiptap/extension-highlight";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Typography from "@tiptap/extension-typography";
import { common, createLowlight } from "lowlight";
import { useEffect, useRef } from "react";
import { EditorToolbar } from "./EditorToolbar";
import { AiWriteMenu } from "./AiWriteMenu";

const lowlight = createLowlight(common);

/** 检测内容是否为 HTML（简单判断是否包含标签） */
function isHtml(str: string): boolean {
  return /<[a-z][\s\S]*>/i.test(str);
}

/** 将纯文本转为简单 HTML 段落 */
function textToHtml(text: string): string {
  if (!text.trim()) return "";
  return text
    .split("\n")
    .map((line) => `<p>${line || "<br>"}</p>`)
    .join("");
}

interface TiptapEditorProps {
  content: string;
  onChange: (html: string) => void;
  placeholder?: string;
}

export function TiptapEditor({
  content,
  onChange,
  placeholder = "开始写点什么...",
}: TiptapEditorProps) {
  const isExternalUpdate = useRef(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false, // 用 CodeBlockLowlight 替代
      }),
      Placeholder.configure({ placeholder }),
      Highlight.configure({ multicolor: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: "tiptap-link" },
      }),
      Underline,
      CodeBlockLowlight.configure({ lowlight }),
      Typography,
    ],
    content: isHtml(content) ? content : textToHtml(content),
    onUpdate: ({ editor }) => {
      if (!isExternalUpdate.current) {
        onChange(editor.getHTML());
      }
    },
  });

  // 外部 content 变化时同步（如初次加载）
  useEffect(() => {
    if (!editor) return;
    const htmlContent = isHtml(content) ? content : textToHtml(content);
    if (htmlContent !== editor.getHTML()) {
      isExternalUpdate.current = true;
      editor.commands.setContent(htmlContent, { emitUpdate: false });
      isExternalUpdate.current = false;
    }
  }, [content, editor]);

  if (!editor) return null;

  return (
    <div className="tiptap-wrapper" style={{ position: "relative" }}>
      <EditorToolbar editor={editor} />
      <EditorContent editor={editor} className="tiptap-content" />
      <AiWriteMenu editor={editor} />
    </div>
  );
}
