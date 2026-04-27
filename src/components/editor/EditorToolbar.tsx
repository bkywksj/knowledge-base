import { useState, useCallback } from "react";
import type { Editor } from "@tiptap/react";
import { Button, Divider, Tooltip, Modal, Input, message, Dropdown } from "antd";
import type { MenuProps } from "antd";
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
  Table as TableIcon,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  Rows3,
  Columns3,
  Trash2,
  ChevronDown,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { imageApi } from "@/lib/api";

interface ToolbarProps {
  editor: Editor;
  noteId?: number;
  /** 与 TiptapEditor 的同名 prop 含义一致：noteId 缺失时用它按需建档 */
  ensureNoteId?: () => Promise<number>;
}

interface ToolItem {
  icon: React.ReactNode;
  title: string;
  /** 普通按钮的点击；带 dropdownItems 时由下拉菜单各 item 自己 onClick，可省略 */
  action?: () => void;
  isActive?: () => boolean;
  /** T-017: 提供后按钮渲染为 Dropdown trigger，菜单展示 dropdownItems */
  dropdownItems?: MenuProps["items"];
}

export function EditorToolbar({ editor, noteId, ensureNoteId }: ToolbarProps) {
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  async function insertImage() {
    // 与 TiptapEditor.handleImageFiles 行为对齐：优先显式 noteId，
    // 缺失时尝试 ensureNoteId（日记按需建档），仍拿不到才 warning
    let effectiveNoteId = noteId;
    if (!effectiveNoteId && ensureNoteId) {
      try {
        effectiveNoteId = await ensureNoteId();
      } catch (e) {
        message.error(`图片插入失败: ${e}`);
        return;
      }
    }
    if (!effectiveNoteId) {
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
        const savedPath = await imageApi.saveFromPath(effectiveNoteId, filePath);
        const assetUrl = convertFileSrc(savedPath);
        editor.chain().focus().insertContent({
          type: "imageResize",
          attrs: { src: assetUrl },
        }).run();
      } catch (e) {
        message.error(`图片插入失败: ${e}`);
      }
    }
  }

  const openLinkModal = useCallback(() => {
    const previousUrl = editor.getAttributes("link").href || "";
    setLinkUrl(previousUrl);
    setLinkModalOpen(true);
  }, [editor]);

  const handleLinkConfirm = useCallback(() => {
    const url = linkUrl.trim();
    if (!url) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    }
    setLinkModalOpen(false);
    setLinkUrl("");
  }, [editor, linkUrl]);

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
        icon: (
          <span className="inline-flex items-center gap-0.5">
            <CodeSquare size={15} />
            <ChevronDown size={11} style={{ opacity: 0.6 }} />
          </span>
        ),
        title: "代码块",
        isActive: () => editor.isActive("codeBlock"),
        dropdownItems: [
          {
            key: "code-plain",
            icon: <CodeSquare size={14} />,
            label: "普通代码块",
            onClick: () => editor.chain().focus().toggleCodeBlock().run(),
          },
          {
            key: "code-mermaid",
            icon: <CodeSquare size={14} />,
            label: "Mermaid 流程图",
            onClick: () =>
              editor
                .chain()
                .focus()
                .insertContent({
                  type: "codeBlock",
                  attrs: { language: "mermaid" },
                  content: [
                    {
                      type: "text",
                      text: "flowchart TD\n  A[开始] --> B{判断}\n  B -- 是 --> C[执行]\n  B -- 否 --> D[结束]",
                    },
                  ],
                })
                .run(),
          },
        ],
      },
    ],
    // 对齐
    [
      {
        icon: <AlignLeft size={15} />,
        title: "左对齐",
        action: () => editor.chain().focus().setTextAlign("left").run(),
        isActive: () => editor.isActive({ textAlign: "left" }),
      },
      {
        icon: <AlignCenter size={15} />,
        title: "居中",
        action: () => editor.chain().focus().setTextAlign("center").run(),
        isActive: () => editor.isActive({ textAlign: "center" }),
      },
      {
        icon: <AlignRight size={15} />,
        title: "右对齐",
        action: () => editor.chain().focus().setTextAlign("right").run(),
        isActive: () => editor.isActive({ textAlign: "right" }),
      },
      {
        icon: <AlignJustify size={15} />,
        title: "两端对齐",
        action: () => editor.chain().focus().setTextAlign("justify").run(),
        isActive: () => editor.isActive({ textAlign: "justify" }),
      },
    ],
    // 表格 — T-017 全部命令折叠到 Dropdown 菜单，避免工具栏过挤
    [
      {
        icon: (
          <span className="inline-flex items-center gap-0.5">
            <TableIcon size={15} />
            <ChevronDown size={11} style={{ opacity: 0.6 }} />
          </span>
        ),
        title: "表格",
        isActive: () => editor.isActive("table"),
        dropdownItems: [
          {
            key: "insert",
            icon: <TableIcon size={14} />,
            label: "插入 3×3 表格",
            onClick: () =>
              editor
                .chain()
                .focus()
                .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                .run(),
          },
          { type: "divider" },
          {
            key: "add-col",
            icon: <Columns3 size={14} />,
            label: "在右侧加列",
            disabled: !editor.can().addColumnAfter(),
            onClick: () => editor.chain().focus().addColumnAfter().run(),
          },
          {
            key: "add-row",
            icon: <Rows3 size={14} />,
            label: "在下方加行",
            disabled: !editor.can().addRowAfter(),
            onClick: () => editor.chain().focus().addRowAfter().run(),
          },
          { type: "divider" },
          {
            key: "merge-cells",
            label: "合并单元格",
            disabled: !editor.can().mergeCells(),
            onClick: () => editor.chain().focus().mergeCells().run(),
          },
          {
            key: "split-cell",
            label: "拆分单元格",
            disabled: !editor.can().splitCell(),
            onClick: () => editor.chain().focus().splitCell().run(),
          },
          { type: "divider" },
          {
            key: "delete-row",
            label: "删除当前行",
            disabled: !editor.can().deleteRow(),
            onClick: () => editor.chain().focus().deleteRow().run(),
          },
          {
            key: "delete-col",
            label: "删除当前列",
            disabled: !editor.can().deleteColumn(),
            onClick: () => editor.chain().focus().deleteColumn().run(),
          },
          { type: "divider" },
          {
            key: "toggle-header-row",
            label: "切换首行表头",
            disabled: !editor.can().toggleHeaderRow(),
            onClick: () => editor.chain().focus().toggleHeaderRow().run(),
          },
          {
            key: "toggle-header-col",
            label: "切换首列表头",
            disabled: !editor.can().toggleHeaderColumn(),
            onClick: () => editor.chain().focus().toggleHeaderColumn().run(),
          },
          { type: "divider" },
          {
            key: "delete-table",
            icon: <Trash2 size={14} />,
            label: "删除整个表格",
            danger: true,
            disabled: !editor.can().deleteTable(),
            onClick: () => editor.chain().focus().deleteTable().run(),
          },
        ],
      },
    ],
    // 链接 & 媒体
    [
      {
        icon: <LinkIcon size={15} />,
        title: "插入链接",
        action: openLinkModal,
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
    <>
      <div className="tiptap-toolbar">
        {groups.map((group, gi) => (
          <span key={gi} className="inline-flex items-center">
            {gi > 0 && (
              <Divider type="vertical" style={{ height: 20, margin: "0 2px" }} />
            )}
            {group.map((item, ii) => {
              const btn = (
                <Button
                  type="text"
                  size="small"
                  icon={item.icon}
                  onClick={item.dropdownItems ? undefined : item.action}
                  className={item.isActive?.() ? "toolbar-btn-active" : ""}
                  style={{
                    minWidth: 28,
                    height: 28,
                    padding: item.dropdownItems ? "0 4px" : 0,
                  }}
                />
              );
              if (item.dropdownItems) {
                return (
                  <Tooltip
                    key={ii}
                    title={item.title}
                    mouseEnterDelay={0.5}
                  >
                    <Dropdown
                      menu={{ items: item.dropdownItems }}
                      trigger={["click"]}
                      placement="bottomLeft"
                    >
                      {btn}
                    </Dropdown>
                  </Tooltip>
                );
              }
              return (
                <Tooltip key={ii} title={item.title} mouseEnterDelay={0.5}>
                  {btn}
                </Tooltip>
              );
            })}
          </span>
        ))}
      </div>

      <Modal
        title="插入链接"
        open={linkModalOpen}
        onOk={handleLinkConfirm}
        onCancel={() => { setLinkModalOpen(false); setLinkUrl(""); }}
        okText="确定"
        cancelText="取消"
        width={420}
        destroyOnClose
      >
        <Input
          placeholder="请输入链接地址，如 https://example.com"
          value={linkUrl}
          onChange={(e) => setLinkUrl(e.target.value)}
          onPressEnter={handleLinkConfirm}
          autoFocus
        />
        <div className="mt-2 text-xs" style={{ color: "var(--ant-color-text-quaternary)" }}>
          留空并确定将移除当前链接
        </div>
      </Modal>
    </>
  );
}
