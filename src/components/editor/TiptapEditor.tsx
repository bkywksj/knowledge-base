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
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TextAlign } from "@tiptap/extension-text-align";
import ImageResize from "tiptap-extension-resize-image";
import { common, createLowlight } from "lowlight";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef, useCallback, useMemo } from "react";
import { message } from "antd";
import { theme as antdTheme } from "antd";
import { imageApi } from "@/lib/api";
import { EditorToolbar } from "./EditorToolbar";
import { AiWriteMenu } from "./AiWriteMenu";
import { WikiLinkDecoration } from "./WikiLinkDecoration";
import { WikiLinkSuggestion } from "./WikiLinkSuggestion";
import "tippy.js/dist/tippy.css";

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

/** 将 File 对象转为 base64（不含 data URL 前缀） */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // 去掉 "data:image/png;base64," 前缀
      const base64 = result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

interface TiptapEditorProps {
  content: string;
  onChange: (html: string) => void;
  placeholder?: string;
  /** 当前笔记 ID，用于图片保存 */
  noteId?: number;
  /** Ctrl/Cmd + 点击 [[标题]] 时触发（编辑器内 wiki 链接跳转） */
  onWikiLinkClick?: (title: string) => void;
}

export function TiptapEditor({
  content,
  onChange,
  placeholder = "开始写点什么...",
  noteId,
  onWikiLinkClick,
}: TiptapEditorProps) {
  const isExternalUpdate = useRef(false);

  // 用 ref 保持 onWikiLinkClick 最新引用，避免 Tiptap 扩展闭包过期
  const wikiClickRef = useRef(onWikiLinkClick);
  useEffect(() => {
    wikiClickRef.current = onWikiLinkClick;
  }, [onWikiLinkClick]);

  /** 处理图片文件：保存到本地并插入编辑器 */
  const handleImageFiles = useCallback(
    async (files: File[], editor: ReturnType<typeof useEditor>) => {
      if (!editor || !noteId) {
        message.warning("请先保存笔记后再插入图片");
        return;
      }

      for (const file of files) {
        if (!file.type.startsWith("image/")) continue;
        try {
          const base64 = await fileToBase64(file);
          const filePath = await imageApi.save(noteId, file.name, base64);
          const assetUrl = convertFileSrc(filePath);
          editor.chain().focus().insertContent({
            type: "imageResize",
            attrs: { src: assetUrl },
          }).run();
        } catch (e) {
          message.error(`图片插入失败: ${e}`);
        }
      }
    },
    [noteId],
  );

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false, // 用 CodeBlockLowlight 替代
        // Tiptap 3.x StarterKit 自带 link/underline，这里禁用以避免和下方
        // 手动 Link.configure / Underline 重复（控制台会打印 Duplicate extension names）
        link: false,
        underline: false,
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
      Table.configure({
        resizable: true,
        HTMLAttributes: { class: "tiptap-table" },
      }),
      TableRow,
      TableCell,
      TableHeader,
      TextAlign.configure({
        types: ["heading", "paragraph"],
      }),
      ImageResize.configure({
        inline: false,
        minWidth: 50,
        maxWidth: 1200,
      }),
      WikiLinkDecoration.configure({
        onClick: (title: string) => wikiClickRef.current?.(title),
      }),
      WikiLinkSuggestion,
    ],
    content: isHtml(content) ? content : textToHtml(content),
    onUpdate: ({ editor }) => {
      if (!isExternalUpdate.current) {
        onChange(editor.getHTML());
      }
    },
    editorProps: {
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files || []);
        const images = files.filter((f) => f.type.startsWith("image/"));
        if (images.length > 0) {
          handleImageFiles(images, editor);
          return true;
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const files = Array.from(event.dataTransfer?.files || []);
        const images = files.filter((f) => f.type.startsWith("image/"));
        if (images.length > 0) {
          event.preventDefault();
          handleImageFiles(images, editor);
          return true;
        }
        return false;
      },
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

  const { token } = antdTheme.useToken();

  // 编辑器统计信息
  const stats = useMemo(() => {
    if (!editor) return { chars: 0, words: 0, readingTime: "< 1 min" };
    const text = editor.getText();
    const chars = text.length;
    // 中文按字数，英文按空格分词
    const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    const nonCjk = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, " ");
    const engWords = nonCjk.split(/\s+/).filter((w) => w.length > 0).length;
    const words = cjkCount + engWords;
    // 按 400 字/分钟估算阅读时间
    const minutes = Math.ceil(words / 400);
    const readingTime = minutes < 1 ? "< 1 min" : `${minutes} min`;
    return { chars, words, readingTime };
  }, [editor, editor?.getText()]);

  if (!editor) return null;

  return (
    <div className="tiptap-wrapper" style={{ position: "relative" }}>
      <EditorToolbar editor={editor} noteId={noteId} />
      <EditorContent editor={editor} className="tiptap-content" />
      <AiWriteMenu editor={editor} />
      <div
        className="flex items-center gap-4 px-3 pt-4 pb-3 text-xs"
        style={{ color: token.colorTextTertiary }}
      >
        <span>{stats.words} 字</span>
        <span>{stats.chars} 字符</span>
        <span>{stats.readingTime} 阅读</span>
      </div>
    </div>
  );
}
