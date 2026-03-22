import type { Editor } from "@tiptap/react";
import { Button, Divider, Tooltip, message } from "antd";
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Highlighter,
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  CodeSquare,
  Minus,
  Undo2,
  Redo2,
  Link as LinkIcon,
  Unlink,
  ImagePlus,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { imageApi } from "@/lib/api";

interface ToolbarProps {
  editor: Editor;
  noteId?: number;
}

interface ToolItem {
  icon: React.ReactNode;
  title: string;
  action: () => void;
  isActive?: () => boolean;
}

export function EditorToolbar({ editor, noteId }: ToolbarProps) {
  async function insertImage() {
    if (!noteId) {
      message.warning("请先保存笔记后再插入图片");
      return;
    }
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: "图片",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"],
        },
      ],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    for (const filePath of paths) {
      try {
        const savedPath = await imageApi.saveFromPath(noteId, filePath);
        const assetUrl = convertFileSrc(savedPath);
        editor.chain().focus().insertContent({
          type: "image",
          attrs: { src: assetUrl },
        }).run();
      } catch (e) {
        message.error(`图片插入失败: ${e}`);
      }
    }
  }

  function setLink() {
    const previousUrl = editor.getAttributes("link").href;
    const url = window.prompt("输入链接地址", previousUrl);
    if (url === null) return; // 取消
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }

  const groups: ToolItem[][] = [
    // 撤销/重做
    [
      {
        icon: <Undo2 size={15} />,
        title: "撤销",
        action: () => editor.chain().focus().undo().run(),
      },
      {
        icon: <Redo2 size={15} />,
        title: "重做",
        action: () => editor.chain().focus().redo().run(),
      },
    ],
    // 标题
    [
      {
        icon: <Heading1 size={15} />,
        title: "标题 1",
        action: () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
        isActive: () => editor.isActive("heading", { level: 1 }),
      },
      {
        icon: <Heading2 size={15} />,
        title: "标题 2",
        action: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
        isActive: () => editor.isActive("heading", { level: 2 }),
      },
      {
        icon: <Heading3 size={15} />,
        title: "标题 3",
        action: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
        isActive: () => editor.isActive("heading", { level: 3 }),
      },
    ],
    // 文本格式
    [
      {
        icon: <Bold size={15} />,
        title: "粗体",
        action: () => editor.chain().focus().toggleBold().run(),
        isActive: () => editor.isActive("bold"),
      },
      {
        icon: <Italic size={15} />,
        title: "斜体",
        action: () => editor.chain().focus().toggleItalic().run(),
        isActive: () => editor.isActive("italic"),
      },
      {
        icon: <Underline size={15} />,
        title: "下划线",
        action: () => editor.chain().focus().toggleUnderline().run(),
        isActive: () => editor.isActive("underline"),
      },
      {
        icon: <Strikethrough size={15} />,
        title: "删除线",
        action: () => editor.chain().focus().toggleStrike().run(),
        isActive: () => editor.isActive("strike"),
      },
      {
        icon: <Highlighter size={15} />,
        title: "高亮",
        action: () => editor.chain().focus().toggleHighlight().run(),
        isActive: () => editor.isActive("highlight"),
      },
      {
        icon: <Code size={15} />,
        title: "行内代码",
        action: () => editor.chain().focus().toggleCode().run(),
        isActive: () => editor.isActive("code"),
      },
    ],
    // 列表 & 引用
    [
      {
        icon: <List size={15} />,
        title: "无序列表",
        action: () => editor.chain().focus().toggleBulletList().run(),
        isActive: () => editor.isActive("bulletList"),
      },
      {
        icon: <ListOrdered size={15} />,
        title: "有序列表",
        action: () => editor.chain().focus().toggleOrderedList().run(),
        isActive: () => editor.isActive("orderedList"),
      },
      {
        icon: <ListTodo size={15} />,
        title: "任务列表",
        action: () => editor.chain().focus().toggleTaskList().run(),
        isActive: () => editor.isActive("taskList"),
      },
      {
        icon: <Quote size={15} />,
        title: "引用",
        action: () => editor.chain().focus().toggleBlockquote().run(),
        isActive: () => editor.isActive("blockquote"),
      },
      {
        icon: <CodeSquare size={15} />,
        title: "代码块",
        action: () => editor.chain().focus().toggleCodeBlock().run(),
        isActive: () => editor.isActive("codeBlock"),
      },
    ],
    // 链接 & 媒体
    [
      {
        icon: <LinkIcon size={15} />,
        title: "插入链接",
        action: setLink,
        isActive: () => editor.isActive("link"),
      },
      {
        icon: <Unlink size={15} />,
        title: "移除链接",
        action: () => editor.chain().focus().unsetLink().run(),
      },
      {
        icon: <ImagePlus size={15} />,
        title: "插入图片",
        action: insertImage,
      },
      {
        icon: <Minus size={15} />,
        title: "分割线",
        action: () => editor.chain().focus().setHorizontalRule().run(),
      },
    ],
  ];

  return (
    <div className="tiptap-toolbar">
      {groups.map((group, gi) => (
        <span key={gi} className="inline-flex items-center">
          {gi > 0 && (
            <Divider type="vertical" style={{ height: 20, margin: "0 2px" }} />
          )}
          {group.map((item, ii) => (
            <Tooltip key={ii} title={item.title} mouseEnterDelay={0.5}>
              <Button
                type="text"
                size="small"
                icon={item.icon}
                onClick={item.action}
                className={item.isActive?.() ? "toolbar-btn-active" : ""}
                style={{ width: 28, height: 28, padding: 0 }}
              />
            </Tooltip>
          ))}
        </span>
      ))}
    </div>
  );
}
