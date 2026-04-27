import { useState, useCallback } from "react";
import type { Editor } from "@tiptap/react";
import { Button, Divider, Tooltip, Modal, Input, message, Dropdown, Select, ColorPicker } from "antd";
import type { MenuProps } from "antd";
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Highlighter,
  Code,
  Superscript as SuperscriptIcon,
  Subscript as SubscriptIcon,
  IndentIncrease,
  IndentDecrease,
  Eraser,
  Baseline,
  PaintBucket,
  Lightbulb,
  ChevronsUpDown,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  CodeSquare,
  Minus,
  Undo2,
  Redo2,
  Link as LinkIcon,
  ImagePlus,
  Captions,
  Film,
  Paperclip,
  MapPin,
  Table as TableIcon,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Rows3,
  Columns3,
  Trash2,
  ChevronDown,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { attachmentApi, imageApi, videoApi } from "@/lib/api";
import { insertVideoTimestamp } from "./VideoTimestamp";
import { EditorStats } from "./EditorStats";
import { EmojiPicker } from "./EmojiPicker";

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
  /** 完全自定义渲染（颜色选择 / Select 下拉等非 Button 控件用），提供则跳过默认 Button 渲染 */
  customRender?: () => React.ReactNode;
}

export function EditorToolbar({ editor, noteId, ensureNoteId }: ToolbarProps) {
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  /** 时间戳弹窗 state */
  const [tsModalOpen, setTsModalOpen] = useState(false);
  const [tsVideoId, setTsVideoId] = useState<string>("");
  const [tsTimeText, setTsTimeText] = useState<string>("00:00");
  /** 图注 / Alt 弹窗：选中图片 → 编辑 caption（图注）和 alt（替代文本） */
  const [captionModalOpen, setCaptionModalOpen] = useState(false);
  const [captionDraft, setCaptionDraft] = useState("");
  const [altDraft, setAltDraft] = useState("");

  function openCaptionModal() {
    if (!editor.isActive("imageResize")) {
      message.info("请先点击一张图片再编辑图注");
      return;
    }
    const attrs = editor.getAttributes("imageResize");
    setCaptionDraft(String(attrs.caption ?? ""));
    setAltDraft(String(attrs.alt ?? ""));
    setCaptionModalOpen(true);
  }

  function applyCaption() {
    const caption = captionDraft.trim();
    const alt = altDraft.trim();
    editor
      .chain()
      .focus()
      .updateAttributes("imageResize", {
        caption: caption || null,
        alt: alt || null,
      })
      .run();
    setCaptionModalOpen(false);
  }
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

  /** 与 insertImage 对称：从文件选择器导入视频走 saveFromPath（零拷贝），
   *  插入 video node。复用 TiptapEditor 已有的 VideoNode 渲染。
   *  视频文件大（GB 级），用 saveFromPath 而非 base64 上传，避免主进程内存爆。 */
  async function insertVideo() {
    let effectiveNoteId = noteId;
    if (!effectiveNoteId && ensureNoteId) {
      try {
        effectiveNoteId = await ensureNoteId();
      } catch (e) {
        message.error(`视频插入失败: ${e}`);
        return;
      }
    }
    if (!effectiveNoteId) {
      message.warning("请先保存笔记后再插入视频");
      return;
    }
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: "视频",
          extensions: ["mp4", "mov", "webm", "m4v", "ogv", "mkv", "avi"],
        },
      ],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    for (const filePath of paths) {
      try {
        const savedPath = await videoApi.saveFromPath(effectiveNoteId, filePath);
        const assetUrl = convertFileSrc(savedPath);
        editor.chain().focus().insertContent({
          type: "video",
          attrs: { src: assetUrl, id: Math.random().toString(36).slice(2, 10) },
        }).run();
      } catch (e) {
        message.error(`视频插入失败: ${e}`);
      }
    }
  }

  /** 与 insertVideo 对称：从文件选择器选附件 → saveFromPath 零拷贝 →
   *  插入 `📎 文件名 (大小)` Link 节点（与 TiptapEditor 拖入逻辑同款渲染，
   *  保持 markdown 序列化零改造）。
   *  PDF/Office/ZIP/音视频/通用文件都走这里；exe/bat 等被后端黑名单拦掉。 */
  async function insertAttachment() {
    let effectiveNoteId = noteId;
    if (!effectiveNoteId && ensureNoteId) {
      try {
        effectiveNoteId = await ensureNoteId();
      } catch (e) {
        message.error(`附件插入失败: ${e}`);
        return;
      }
    }
    if (!effectiveNoteId) {
      message.warning("请先保存笔记后再插入附件");
      return;
    }
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: "附件",
          // 与后端 mime_for_ext 列表对齐；不含 exe/bat（后端黑名单）
          extensions: [
            "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
            "zip", "rar", "7z", "tar", "gz",
            "mp3", "wav", "ogg", "flac", "m4a",
            "csv", "json", "xml", "yaml", "yml", "txt", "md",
          ],
        },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];

    const nodes: Array<
      | { type: "text"; text: string; marks: Array<{ type: "link"; attrs: { href: string } }> }
      | { type: "text"; text: string }
    > = [];
    for (const filePath of paths) {
      try {
        const info = await attachmentApi.saveFromPath(effectiveNoteId, filePath);
        const label = `📎 ${info.fileName} (${formatSize(info.size)})`;
        const href = pathToFileUrl(info.path);
        nodes.push({ type: "text", text: label, marks: [{ type: "link", attrs: { href } }] });
        nodes.push({ type: "text", text: "\n" });
      } catch (e) {
        message.error(`附件插入失败: ${e}`);
      }
    }
    if (nodes.length > 0) {
      editor.chain().focus().insertContent(nodes).run();
    }
  }

  /** 收集当前文档所有 video 节点（含 id + 显示名 + src 文件名），给时间戳弹窗下拉用 */
  function collectVideosInDoc(): Array<{ id: string; label: string; src: string }> {
    const list: Array<{ id: string; label: string; src: string }> = [];
    let autoIdx = 0;
    editor.state.doc.descendants((n) => {
      if (n.type.name !== "video") return true;
      autoIdx += 1;
      const id = String(n.attrs.id ?? "");
      const userLabel = String(n.attrs.label ?? "");
      const src = String(n.attrs.src ?? "");
      const label = userLabel || `视频 ${autoIdx}`;
      list.push({ id, label, src });
      return true;
    });
    return list;
  }

  /** 打开"插入时间戳"弹窗：自动选中第一个视频 */
  function openTimestampModal() {
    const videos = collectVideosInDoc();
    if (videos.length === 0) {
      message.warning("当前笔记还没有视频，请先插入视频");
      return;
    }
    const valid = videos.filter((v) => v.id);
    if (valid.length === 0) {
      message.warning("视频缺少 ID。请重新打开此笔记触发自动补 ID 后再试");
      return;
    }
    setTsVideoId(valid[0].id);
    setTsTimeText("00:00");
    setTsModalOpen(true);
  }

  /** 弹窗确认：解析 mm:ss / hh:mm:ss → 秒数 → insertVideoTimestamp */
  function handleTimestampConfirm() {
    const seconds = parseTimeToSeconds(tsTimeText);
    if (seconds == null) {
      message.error("时间格式不对，请用 mm:ss 或 hh:mm:ss（如 01:40）");
      return;
    }
    const videos = collectVideosInDoc();
    const target = videos.find((v) => v.id === tsVideoId);
    if (!target) {
      message.error("未找到选中的视频");
      return;
    }
    insertVideoTimestamp(editor, {
      videoId: tsVideoId,
      seconds,
      label: `📹 ${target.label} · ${formatTimeShort(seconds)}`,
    });
    setTsModalOpen(false);
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
    // 标题（H1–H6 + 正文）下拉
    [
      {
        icon: null,
        title: "段落格式",
        customRender: () => (
          <Dropdown
            trigger={["click"]}
            placement="bottomLeft"
            menu={{
              items: [
                { key: "p",  label: <span>正文</span> },
                { key: "h1", label: <span style={{ fontSize: 18, fontWeight: 700 }}>H1 一级标题</span> },
                { key: "h2", label: <span style={{ fontSize: 16, fontWeight: 700 }}>H2 二级标题</span> },
                { key: "h3", label: <span style={{ fontSize: 15, fontWeight: 600 }}>H3 三级标题</span> },
                { key: "h4", label: <span style={{ fontSize: 14, fontWeight: 600 }}>H4 四级标题</span> },
                { key: "h5", label: <span style={{ fontSize: 13 }}>H5 五级标题</span> },
                { key: "h6", label: <span style={{ fontSize: 13 }}>H6 六级标题</span> },
              ],
              onClick: ({ key }) => applyBlockType(editor, key as BlockType),
              selectedKeys: [getCurrentBlockType(editor)],
            }}
          >
            <Button
              type="text"
              size="small"
              style={{ minWidth: 72, height: 28, padding: "0 6px" }}
            >
              <span className="inline-flex items-center gap-1">
                {labelOfBlockType(getCurrentBlockType(editor))}
                <ChevronDown size={12} style={{ opacity: 0.6 }} />
              </span>
            </Button>
          </Dropdown>
        ),
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
      {
        icon: <SuperscriptIcon size={15} />,
        title: "上标",
        action: () => editor.chain().focus().toggleSuperscript().run(),
        isActive: () => editor.isActive("superscript"),
      },
      {
        icon: <SubscriptIcon size={15} />,
        title: "下标",
        action: () => editor.chain().focus().toggleSubscript().run(),
        isActive: () => editor.isActive("subscript"),
      },
    ],
    // 颜色 / 字号 / 行高
    [
      {
        icon: null,
        title: "字体颜色",
        customRender: () => (
          <Tooltip title="字体颜色" mouseEnterDelay={0.5}>
            <ColorPicker
              size="small"
              value={(editor.getAttributes("textStyle").color as string) || "#000000"}
              onChange={(c) => {
                const hex = c.toHexString();
                editor.chain().focus().setColor(hex).run();
              }}
              presets={[
                {
                  label: "常用",
                  colors: [
                    "#000000", "#595959", "#8c8c8c", "#bfbfbf", "#ffffff",
                    "#ff4d4f", "#fa8c16", "#fadb14", "#52c41a", "#1677ff",
                    "#722ed1", "#eb2f96",
                  ],
                },
              ]}
            >
              <Button
                type="text"
                size="small"
                icon={<Baseline size={15} />}
                style={{ minWidth: 28, height: 28, padding: 0 }}
              />
            </ColorPicker>
          </Tooltip>
        ),
      },
      {
        icon: null,
        title: "背景颜色",
        customRender: () => (
          <Tooltip title="背景颜色" mouseEnterDelay={0.5}>
            <ColorPicker
              size="small"
              value={(editor.getAttributes("highlight").color as string) || "#ffe58f"}
              onChange={(c) => {
                const hex = c.toHexString();
                editor.chain().focus().toggleHighlight({ color: hex }).run();
              }}
              presets={[
                {
                  label: "常用",
                  colors: [
                    "#ffe58f", "#ffadd2", "#b7eb8f", "#91d5ff", "#ffd6e7",
                    "#fff1b8", "#d9f7be", "#bae7ff", "#f0f5ff", "#fff7e6",
                  ],
                },
              ]}
            >
              <Button
                type="text"
                size="small"
                icon={<PaintBucket size={15} />}
                style={{ minWidth: 28, height: 28, padding: 0 }}
              />
            </ColorPicker>
          </Tooltip>
        ),
      },
      {
        icon: null,
        title: "字号",
        customRender: () => {
          const cur = (editor.getAttributes("textStyle").fontSize as string) || "";
          return (
            <Dropdown
              trigger={["click"]}
              placement="bottomLeft"
              menu={{
                items: [
                  { key: "__clear__", label: "默认字号" },
                  { type: "divider" } as const,
                  ...FONT_SIZE_OPTIONS.map((o) => ({ key: o.value, label: o.label })),
                ],
                selectedKeys: cur ? [cur] : ["__clear__"],
                onClick: ({ key }) => {
                  if (key === "__clear__") {
                    editor.chain().focus().unsetFontSize().run();
                  } else {
                    editor.chain().focus().setFontSize(key).run();
                  }
                },
              }}
            >
              <Button type="text" size="small" style={{ minWidth: 56, height: 28, padding: "0 6px" }}>
                <span className="inline-flex items-center gap-1">
                  {cur ? cur.replace("px", "") : "字号"}
                  <ChevronDown size={12} style={{ opacity: 0.6 }} />
                </span>
              </Button>
            </Dropdown>
          );
        },
      },
      {
        icon: null,
        title: "行间距",
        customRender: () => {
          const cur =
            (editor.getAttributes("paragraph").lineHeight as string) ||
            (editor.getAttributes("heading").lineHeight as string) ||
            "";
          return (
            <Dropdown
              trigger={["click"]}
              placement="bottomLeft"
              menu={{
                items: [
                  { key: "__clear__", label: "默认行高" },
                  { type: "divider" } as const,
                  ...LINE_HEIGHT_OPTIONS.map((o) => ({ key: o.value, label: o.label })),
                ],
                selectedKeys: cur ? [cur] : ["__clear__"],
                onClick: ({ key }) => {
                  if (key === "__clear__") {
                    editor.chain().focus().unsetLineHeight().run();
                  } else {
                    editor.chain().focus().setLineHeight(key).run();
                  }
                },
              }}
            >
              <Button type="text" size="small" style={{ minWidth: 56, height: 28, padding: "0 6px" }}>
                <span className="inline-flex items-center gap-1">
                  {cur ? cur : "行高"}
                  <ChevronDown size={12} style={{ opacity: 0.6 }} />
                </span>
              </Button>
            </Dropdown>
          );
        },
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
            <Lightbulb size={15} />
            <ChevronDown size={11} style={{ opacity: 0.6 }} />
          </span>
        ),
        title: "Callout 提示框",
        isActive: () => editor.isActive("callout"),
        dropdownItems: [
          {
            key: "callout-info",
            label: <span><span style={{ marginRight: 6 }}>ℹ️</span>信息</span>,
            onClick: () => editor.chain().focus().toggleCallout("info").run(),
          },
          {
            key: "callout-tip",
            label: <span><span style={{ marginRight: 6 }}>💡</span>提示</span>,
            onClick: () => editor.chain().focus().toggleCallout("tip").run(),
          },
          {
            key: "callout-warning",
            label: <span><span style={{ marginRight: 6 }}>⚠️</span>警告</span>,
            onClick: () => editor.chain().focus().toggleCallout("warning").run(),
          },
          {
            key: "callout-danger",
            label: <span><span style={{ marginRight: 6 }}>❌</span>危险</span>,
            onClick: () => editor.chain().focus().toggleCallout("danger").run(),
          },
        ],
      },
      {
        icon: <ChevronsUpDown size={15} />,
        title: "折叠块",
        action: () => editor.chain().focus().setToggle().run(),
      },
      {
        icon: null,
        title: "插入 Emoji",
        customRender: () => <EmojiPicker editor={editor} />,
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
        title: "插入链接（在选中链接上点击 → 弹窗留空确定可移除）",
        action: openLinkModal,
        isActive: () => editor.isActive("link"),
      },
      {
        icon: <ImagePlus size={15} />,
        title: "插入图片",
        action: insertImage,
      },
      {
        icon: <Captions size={15} />,
        title: "图注 / Alt（先选中图片）",
        action: openCaptionModal,
        isActive: () => editor.isActive("imageResize"),
      },
      {
        icon: <Film size={15} />,
        title: "插入视频",
        action: insertVideo,
      },
      {
        icon: <MapPin size={15} />,
        title: "插入视频时间戳",
        action: openTimestampModal,
      },
      {
        icon: <Paperclip size={15} />,
        title: "插入附件（PDF/Office/ZIP 等）",
        action: insertAttachment,
      },
      {
        icon: <Minus size={15} />,
        title: "分割线",
        action: () => editor.chain().focus().setHorizontalRule().run(),
      },
    ],
    // 缩进 + 清除格式
    [
      {
        icon: <IndentDecrease size={15} />,
        title: "减少缩进",
        action: () => editor.chain().focus().outdent().run(),
      },
      {
        icon: <IndentIncrease size={15} />,
        title: "增加缩进",
        action: () => editor.chain().focus().indent().run(),
      },
      {
        icon: <Eraser size={15} />,
        title: "清除格式",
        action: () =>
          editor.chain().focus().unsetAllMarks().clearNodes().run(),
      },
    ],
  ];

  /**
   * 阻止 toolbar 内 mousedown 默认 focus 切换。
   * Why: 用户在编辑器选中文本后点 toolbar 按钮 / Select / ColorPicker 时，
   *      浏览器原生行为会把 focus 移到目标元素 → ProseMirror selection
   *      虽然数据上还在，但浏览器不再渲染选区蓝色高亮（视觉上"失焦"）。
   *      preventDefault mousedown 能阻止 focus 切换，但不影响 click 事件，
   *      antd Select/ColorPicker 仍能正常打开 popup。Modal/portal 弹层位于
   *      document.body 末尾，事件不会冒泡到这里，互不影响。
   */
  function handleToolbarMouseDown(e: React.MouseEvent) {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
    // antd Select / ColorPicker 依赖 mousedown 默认行为打开 popup，跳过这些
    // （它们自己内部 focus 处理；onChange 时我们再 chain().focus() 恢复 editor）
    if (t.closest(".ant-select, .ant-color-picker, .ant-select-selector, .ant-popover")) {
      return;
    }
    e.preventDefault();
  }

  return (
    <>
      <div className="tiptap-toolbar" onMouseDown={handleToolbarMouseDown}>
        {groups.map((group, gi) => (
          <span key={gi} className="inline-flex items-center">
            {gi > 0 && (
              <Divider orientation="vertical" style={{ height: 18, margin: "0 1px", borderColor: "var(--ant-color-border-secondary, #f0f0f0)" }} />
            )}
            {group.map((item, ii) => {
              if (item.customRender) {
                return (
                  <span key={ii} className="inline-flex items-center">
                    {item.customRender()}
                  </span>
                );
              }
              const btn = (
                <Button
                  type="text"
                  size="small"
                  icon={item.icon}
                  onClick={item.dropdownItems ? undefined : item.action}
                  className={item.isActive?.() ? "toolbar-btn-active" : ""}
                  style={{
                    // 带 dropdownItems 双图标按钮宽 40，普通单图标 26 紧凑
                    minWidth: item.dropdownItems ? 40 : 26,
                    height: 26,
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
        {/* 右侧字数统计：占位 spacer 推到最右 + Popover hover 详细 */}
        <span style={{ flex: 1, minWidth: 8 }} />
        <EditorStats editor={editor} />
      </div>

      <Modal
        title="插入链接"
        open={linkModalOpen}
        onOk={handleLinkConfirm}
        onCancel={() => { setLinkModalOpen(false); setLinkUrl(""); }}
        okText="确定"
        cancelText="取消"
        width={420}
        destroyOnHidden
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

      {/* 插入视频时间戳弹窗 */}
      <Modal
        title="插入视频时间戳"
        open={tsModalOpen}
        onOk={handleTimestampConfirm}
        onCancel={() => setTsModalOpen(false)}
        okText="插入"
        cancelText="取消"
        width={460}
        destroyOnHidden
      >
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-xs" style={{ color: "var(--ant-color-text-secondary)" }}>
              选择视频
            </div>
            <Select
              style={{ width: "100%" }}
              value={tsVideoId}
              onChange={(v) => setTsVideoId(v)}
              options={collectVideosInDoc()
                .filter((v) => v.id)
                .map((v) => ({
                  value: v.id,
                  label: `${v.label} · ${shortFileName(v.src)}`,
                }))}
            />
          </div>
          <div>
            <div className="mb-1 text-xs" style={{ color: "var(--ant-color-text-secondary)" }}>
              时间（mm:ss 或 hh:mm:ss）
            </div>
            <Input
              value={tsTimeText}
              onChange={(e) => setTsTimeText(e.target.value)}
              onPressEnter={handleTimestampConfirm}
              placeholder="如 01:40 或 1:23:45"
              autoFocus
            />
            <div className="mt-1 text-xs" style={{ color: "var(--ant-color-text-quaternary)" }}>
              提示：在视频块顶部点「📍 加时间戳」可一键采用当前播放位置
            </div>
          </div>
        </div>
      </Modal>

      {/* 图注 / Alt 弹窗：选中图片后用 */}
      <Modal
        title="编辑图注与替代文本"
        open={captionModalOpen}
        onCancel={() => setCaptionModalOpen(false)}
        onOk={applyCaption}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, marginBottom: 4 }}>图注（caption）</div>
            <Input.TextArea
              value={captionDraft}
              onChange={(e) => setCaptionDraft(e.target.value)}
              autoSize={{ minRows: 2, maxRows: 4 }}
              placeholder="例：图 1：系统架构图"
              autoFocus
            />
          </div>
          <div>
            <div style={{ fontSize: 12, marginBottom: 4 }}>
              替代文本（alt，无障碍 / 搜索用）
            </div>
            <Input
              value={altDraft}
              onChange={(e) => setAltDraft(e.target.value)}
              placeholder="不显示给用户，但搜索引擎和读屏器会读"
            />
          </div>
          <div
            className="text-xs"
            style={{ color: "var(--ant-color-text-quaternary)", lineHeight: 1.5 }}
          >
            提示：只有"图注"非空时，导出 markdown 才会落 HTML &lt;figure&gt; 块；
            否则保持标准 ![alt](url) 写法，与其他笔记工具兼容。
          </div>
        </div>
      </Modal>
    </>
  );
}

// ─── 段落格式下拉 helpers ─────────────────────────

type BlockType = "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

function getCurrentBlockType(editor: Editor): BlockType {
  for (let lv = 1; lv <= 6; lv++) {
    if (editor.isActive("heading", { level: lv })) {
      return `h${lv}` as BlockType;
    }
  }
  return "p";
}

function labelOfBlockType(t: BlockType): string {
  if (t === "p") return "正文";
  return t.toUpperCase();
}

function applyBlockType(editor: Editor, type: BlockType): void {
  if (type === "p") {
    editor.chain().focus().setParagraph().run();
    return;
  }
  const lv = parseInt(type.slice(1), 10);
  if (lv >= 1 && lv <= 6) {
    editor
      .chain()
      .focus()
      .setHeading({ level: lv as 1 | 2 | 3 | 4 | 5 | 6 })
      .run();
  }
}

const FONT_SIZE_OPTIONS = [
  { value: "12px", label: "12" },
  { value: "13px", label: "13" },
  { value: "14px", label: "14" },
  { value: "15px", label: "15" },
  { value: "16px", label: "16" },
  { value: "18px", label: "18" },
  { value: "20px", label: "20" },
  { value: "24px", label: "24" },
  { value: "30px", label: "30" },
  { value: "36px", label: "36" },
  { value: "48px", label: "48" },
];

const LINE_HEIGHT_OPTIONS = [
  { value: "1", label: "1.0" },
  { value: "1.15", label: "1.15" },
  { value: "1.4", label: "1.4" },
  { value: "1.6", label: "1.6" },
  { value: "1.8", label: "1.8" },
  { value: "2", label: "2.0" },
];

/** 解析 mm:ss 或 hh:mm:ss 文本为秒数；非法返回 null */
function parseTimeToSeconds(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":").map((p) => p.trim());
  if (parts.some((p) => !/^\d+$/.test(p))) return null;
  if (parts.length === 1) {
    return parseInt(parts[0], 10);
  }
  if (parts.length === 2) {
    const [m, s] = parts.map((p) => parseInt(p, 10));
    if (s >= 60) return null;
    return m * 60 + s;
  }
  if (parts.length === 3) {
    const [h, m, s] = parts.map((p) => parseInt(p, 10));
    if (m >= 60 || s >= 60) return null;
    return h * 3600 + m * 60 + s;
  }
  return null;
}

/** 秒数 → 短格式（mm:ss 或 h:mm:ss） */
function formatTimeShort(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
  return `${pad(m)}:${pad(sec)}`;
}

/** 取 src 路径里的文件名（视频路径太长时下拉里更可读） */
function shortFileName(src: string): string {
  if (!src) return "(未命名)";
  try {
    const decoded = decodeURIComponent(src);
    const last = decoded.split(/[\\/]/).pop() || decoded;
    return last.length > 40 ? last.slice(0, 37) + "..." : last;
  } catch {
    return src.slice(-40);
  }
}

/** 字节数 → 人类可读（与 TiptapEditor.humanSize 同实现，避免跨文件 import） */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** 绝对路径 → file:// URL（与 TiptapEditor.pathToFileUrl 同实现） */
function pathToFileUrl(absPath: string): string {
  const normalized = absPath.replace(/\\/g, "/");
  const encoded = normalized.split("/").map((seg) => encodeURIComponent(seg)).join("/");
  return normalized.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`;
}
