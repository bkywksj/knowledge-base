import { useState, useCallback, useEffect, useMemo, useReducer } from "react";
import type { Editor } from "@tiptap/react";
import { Button, Divider, Tooltip, Modal, Input, message, Dropdown, Select, ColorPicker } from "antd";
import type { MenuProps } from "antd";
import {
  Bold,
  Italic,
  Underline,
  Highlighter,
  Code,
  Superscript as SuperscriptIcon,
  Subscript as SubscriptIcon,
  IndentIncrease,
  IndentDecrease,
  Eraser,
  Paintbrush,
  Baseline,
  PaintBucket,
  Lightbulb,
  ChevronsUpDown,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  CodeSquare,
  Sigma,
  Calculator,
  Minus,
  Undo2,
  Redo2,
  Link as LinkIcon,
  ImagePlus,
  Captions,
  Film,
  Globe,
  Paperclip,
  MapPin,
  Table as TableIcon,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Columns2,
  Columns3,
  Columns4,
  ChevronDown,
  Search,
  ListX,
} from "lucide-react";
import { hasManualNumber, stripManualNumber } from "@/lib/headingNumber";
import {
  cleanText,
  isBlankText,
  type TextCleanupRules,
} from "@/lib/editorCleanup";
import { open } from "@tauri-apps/plugin-dialog";
import { toKbAsset, toKbAssetHref } from "@/lib/assetUrl";
import { attachmentApi, imageApi, systemApi, videoApi } from "@/lib/api";
import {
  EDITOR_FONT_LABELS,
  EDITOR_FONT_STACKS,
  resolveEditorFontStack,
  type EditorFontPreset,
} from "@/store";
import { MicButton } from "@/components/MicButton";
import { insertVideoTimestamp } from "./VideoTimestamp";
import { EmojiPicker } from "./EmojiPicker";
import { AnnotationButton } from "./AnnotationButton";
import { TableButton } from "./TableButton";
import { CompareClipboardButton } from "./CompareClipboardButton";
import { CompareNotesButton } from "./CompareNotesButton";
import { parseEmbedUrl, SUPPORTED_PROVIDERS } from "./embedVideoProviders";
import { useFormatPainter } from "./useFormatPainter";
import { PluginKey } from "@tiptap/pm/state";
import type { DecorationSet } from "@tiptap/pm/view";
import { createFakeSelectionPlugin, setFakeSelection } from "./fakeSelection";

interface ToolbarProps {
  editor: Editor;
  noteId?: number;
  /** 与 TiptapEditor 的同名 prop 含义一致：noteId 缺失时用它按需建档 */
  ensureNoteId?: () => Promise<number>;
  /** 唤起编辑器内查找替换浮条；缺省则不渲染搜索按钮（用于不需要搜索的嵌入场景，如设置弹窗的模板编辑器） */
  onOpenSearch?: () => void;
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

export function EditorToolbar({ editor, noteId, ensureNoteId, onOpenSearch }: ToolbarProps) {
  const formatPainter = useFormatPainter(editor);

  // ─── 格式规整：从网页 / Word / 微信复制来的内容常常一身毛病 ───────────
  // 每条规则一次 transaction 完成，Ctrl+Z 能整体撤销。
  // 代码块和行内 code 一律跳过——那里的空格有语义，动了就错。

  /** 删除连续空段落（连着的只保留第一个） */
  function dropBlankParagraphs() {
    const { state, view } = editor;
    const tr = state.tr;
    const ranges: { from: number; to: number }[] = [];
    let prevBlank = false;
    state.doc.forEach((node, offset) => {
      const blank =
        node.type.name === "paragraph" && isBlankText(node.textContent ?? "");
      if (blank && prevBlank) ranges.push({ from: offset, to: offset + node.nodeSize });
      prevBlank = blank;
    });
    if (ranges.length === 0) {
      message.info("没有多余空行");
      return;
    }
    // 从后往前删，避免前面的删除让后面的偏移失效
    for (let i = ranges.length - 1; i >= 0; i -= 1) {
      tr.delete(ranges[i].from, ranges[i].to);
    }
    view.dispatch(tr);
    message.success(`已删除 ${ranges.length} 个多余空行`);
  }

  /** 按规则清洗所有正文文字 */
  function cleanAllText(rules: TextCleanupRules, label: string) {
    const { state, view, schema } = editor;
    const tr = state.tr;
    let count = 0;
    state.doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return true;
      // 行内 code / 代码块内的空格有语义，跳过
      if (node.marks.some((m) => m.type.name === "code")) return true;
      if (state.doc.resolve(pos).parent.type.name === "codeBlock") return false;
      const cleaned = cleanText(node.text, rules);
      if (cleaned === node.text) return true;
      const from = tr.mapping.map(pos);
      const to = tr.mapping.map(pos + node.text.length);
      tr.replaceWith(from, to, cleaned ? schema.text(cleaned, node.marks) : []);
      count += 1;
      return true;
    });
    if (count === 0) {
      message.info(`没有需要${label}的内容`);
      return;
    }
    view.dispatch(tr);
    message.success(`已${label} ${count} 处`);
  }

  /** 清除字号 / 颜色 / 高亮，保留粗体斜体链接等语义标记 */
  function clearVisualStyles() {
    const { from, to } = editor.state.selection;
    editor
      .chain()
      .focus()
      .selectAll()
      .unsetMark("textStyle")
      .unsetHighlight()
      .setTextSelection({ from, to })
      .run();
    message.success("已清除字号 / 颜色 / 高亮");
  }

  /** 清除标题正文里手写的「1.1」「一、」「第一章」序号 */
  function stripHeadingNumbers() {
    const { state, view } = editor;
    const tr = state.tr;
    let count = 0;
    state.doc.descendants((node, pos) => {
      if (node.type.name !== "heading") return true;
      // 只认标题第一个 text 子节点：编号一定在开头，按 text 长度算删除区间才精确
      // （标题里可能夹着行内公式 / 图片，用 textContent 算偏移会删错位置）
      const first = node.firstChild;
      if (!first?.isText || !first.text) return false;
      if (!hasManualNumber(first.text)) return false;
      const stripped = stripManualNumber(first.text);
      if (stripped === first.text) return false;
      const removed = first.text.length - stripped.length;
      const from = tr.mapping.map(pos + 1);
      tr.delete(from, from + removed);
      count += 1;
      return false;
    });
    if (count === 0) {
      message.info("没有找到自带编号的标题");
      return;
    }
    view.dispatch(tr);
    message.success(`已清除 ${count} 个标题的手写编号`);
  }
  // 订阅 editor 的 selection / transaction 事件，让 toolbar 跟随光标位置刷新：
  // 段落格式下拉的 label（getCurrentBlockType）和按钮 active 高亮（isActive）
  // 都依赖最新 editor 状态，但 EditorToolbar 自身没有 React state 联动，
  // 必须主动 forceUpdate 才能让光标在标题/正文之间移动时下拉文本同步变化。
  // 用 RAF 节流避免连续 transaction（如打字）触发过多重渲染。
  const [, forceTick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        forceTick();
      });
    };
    editor.on("selectionUpdate", schedule);
    editor.on("transaction", schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      editor.off("selectionUpdate", schedule);
      editor.off("transaction", schedule);
    };
  }, [editor]);
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
  /** 嵌入网络视频弹窗：粘贴 B站/YouTube/腾讯/优酷链接 → iframe 节点 */
  const [embedModalOpen, setEmbedModalOpen] = useState(false);
  const [embedUrlInput, setEmbedUrlInput] = useState("");
  /** 「字体」下拉的系统字体列表（模块级单飞缓存，多个编辑器实例只枚举一次） */
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void loadSystemFontsOnce().then((fonts) => {
      if (alive) setSystemFonts(fonts);
    });
    return () => {
      alive = false;
    };
  }, []);
  // 伪选区 plugin：生命周期跟随工具栏挂载，供字体下拉打开时标出选区
  useEffect(() => {
    const plugin = createFakeSelectionPlugin(TOOLBAR_FAKE_SELECTION_KEY);
    editor.registerPlugin(plugin);
    return () => {
      editor.unregisterPlugin(TOOLBAR_FAKE_SELECTION_KEY);
    };
  }, [editor]);
  /**
   * 「字体」下拉选项。value 直接是**完整 CSS font-family 值**，与 textStyle mark
   * 里存的东西同构，选中态判定就是一次字符串相等，不需要维护 ID ↔ 字体链的反查表。
   * 预设里的 `system`（空 stack）跳过——它和「默认」是一回事。
   */
  const fontFamilyOptions = useMemo(() => {
    const preset = (Object.keys(EDITOR_FONT_LABELS) as EditorFontPreset[])
      .filter((key) => !!EDITOR_FONT_STACKS[key])
      .map((key) => ({
        value: EDITOR_FONT_STACKS[key],
        searchText: `${EDITOR_FONT_LABELS[key]} ${key}`,
        label: (
          <span style={{ fontFamily: EDITOR_FONT_STACKS[key] }}>
            {EDITOR_FONT_LABELS[key]}
          </span>
        ),
      }));
    const system = systemFonts.map((name) => ({
      value: resolveEditorFontStack(name),
      searchText: name,
      label: (
        <span style={{ fontFamily: `"${name.replace(/["\\]/g, "")}"` }}>
          {name}
        </span>
      ),
    }));
    const clear = {
      value: FONT_FAMILY_CLEAR,
      searchText: "默认 清除字体 default",
      label: <span>默认（清除字体）</span>,
    };
    return system.length > 0
      ? [
          { label: "默认", options: [clear] },
          { label: "预设", options: preset },
          { label: `系统字体（${system.length}）`, options: system },
        ]
      : [
          { label: "默认", options: [clear] },
          { label: "预设", options: preset },
        ];
  }, [systemFonts]);


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
        const relPath = await imageApi.saveFromPath(effectiveNoteId, filePath);
        editor.chain().focus().insertContent({
          type: "imageResize",
          attrs: { src: toKbAsset(relPath) },
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
        const relPath = await videoApi.saveFromPath(effectiveNoteId, filePath);
        editor.chain().focus().insertContent({
          type: "video",
          attrs: { src: toKbAsset(relPath), id: Math.random().toString(36).slice(2, 10) },
        }).run();
      } catch (e) {
        message.error(`视频插入失败: ${e}`);
      }
    }
  }

  /** 嵌入网络视频：解析 URL → iframe 节点。
   *  与 insertVideo 不同，这里不落本地文件，纯靠 iframe 在线播放。
   *  支持 B站 / YouTube / 腾讯视频 / 优酷（详见 embedVideoProviders.ts）。 */
  function handleEmbedConfirm() {
    const raw = embedUrlInput.trim();
    if (!raw) {
      message.warning("请输入视频链接");
      return;
    }
    const parsed = parseEmbedUrl(raw);
    if (!parsed) {
      message.error(`无法识别的链接，目前支持：${SUPPORTED_PROVIDERS}`);
      return;
    }
    editor
      .chain()
      .focus()
      .setEmbedVideo({
        src: parsed.embedUrl,
        originalUrl: parsed.originalUrl,
        provider: parsed.provider,
      })
      .run();
    setEmbedUrlInput("");
    setEmbedModalOpen(false);
    message.success(`已嵌入${parsed.providerName}视频`);
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
        // info.path 是相对 data_dir 的 POSIX 路径；存 kb-asset:// 跨数据目录可移植。
        // 用 toKbAssetHref（percent-encode）：附件链接的 URL 不经序列化编码，文件名含空格
        // 会破坏 markdown 链接（重开降级成纯文本 + 漏同步）。见 assetUrl.ts 注释。
        const href = toKbAssetHref(info.path);
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
                { key: "p",  label: <span>正文</span>, extra: <span className="text-xs opacity-50">Ctrl 0</span> },
                { key: "h1", label: <span style={{ fontSize: 18, fontWeight: 700 }}>H1 一级标题</span>, extra: <span className="text-xs opacity-50">Ctrl 1</span> },
                { key: "h2", label: <span style={{ fontSize: 16, fontWeight: 700 }}>H2 二级标题</span>, extra: <span className="text-xs opacity-50">Ctrl 2</span> },
                { key: "h3", label: <span style={{ fontSize: 15, fontWeight: 600 }}>H3 三级标题</span>, extra: <span className="text-xs opacity-50">Ctrl 3</span> },
                { key: "h4", label: <span style={{ fontSize: 14, fontWeight: 600 }}>H4 四级标题</span>, extra: <span className="text-xs opacity-50">Ctrl 4</span> },
                { key: "h5", label: <span style={{ fontSize: 13 }}>H5 五级标题</span>, extra: <span className="text-xs opacity-50">Ctrl 5</span> },
                { key: "h6", label: <span style={{ fontSize: 13 }}>H6 六级标题</span>, extra: <span className="text-xs opacity-50">Ctrl 6</span> },
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
        // 删除线：lucide 的 Strikethrough 在 15px 下笔画糊成一团、辨识度差，
        // 改成带 line-through 的文字「S」，跟左边 B / I / U 三个字母按钮成套（Notion / 语雀同款）
        icon: (
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              lineHeight: 1,
              textDecoration: "line-through",
            }}
          >
            S
          </span>
        ),
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
        // 批注按钮：自带 Modal + 全局快捷键监听 + 右键菜单事件接收
        icon: null,
        title: "批注",
        customRender: () => <AnnotationButton editor={editor} />,
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
    // 输入辅助（单独成组，与文本格式 / 颜色字号区分；后续可在此追加 AI 续写等）
    [
      {
        icon: null,
        title: "语音输入",
        customRender: () => (
          <MicButton
            onTranscribed={(text) =>
              editor.chain().focus().insertContent(text).run()
            }
          />
        ),
      },
      {
        // 与剪贴板对比 / 合并（左=剪贴板，右=当前笔记 markdown，可编辑）
        icon: null,
        title: "对比剪贴板",
        customRender: () => <CompareClipboardButton editor={editor} />,
      },
      {
        // 与其他笔记对比 / 合并
        icon: null,
        title: "对比其他笔记",
        customRender: () => <CompareNotesButton editor={editor} noteId={noteId} />,
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
        title: "字体",
        customRender: () => {
          const cur =
            (editor.getAttributes("textStyle").fontFamily as string) || "";
          return (
            <Tooltip title="字体（作用于选中文字）" mouseEnterDelay={0.5}>
              <Select
                size="small"
                showSearch
                value={cur || FONT_FAMILY_CLEAR}
                style={{ width: 128 }}
                // 选中态只显示首个字体名，不把整条 fallback 链塞进 128px 的框里
                labelRender={({ value }) => (
                  <span>{shortFontLabel(String(value))}</span>
                )}
                filterOption={(input, option) => {
                  const opt = option as
                    | { searchText?: string; value?: string }
                    | undefined;
                  const t = String(opt?.searchText ?? opt?.value ?? "");
                  return t.toLowerCase().includes(input.trim().toLowerCase());
                }}
                options={fontFamilyOptions}
                // 打开时铺伪选区（Select 会夺焦，原生蓝底会消失），关闭即清
                onOpenChange={(open) => {
                  const { from, to } = editor.state.selection;
                  setFakeSelection(
                    editor,
                    TOOLBAR_FAKE_SELECTION_KEY,
                    open && from !== to ? { from, to } : null,
                  );
                }}
                onChange={(v) => {
                  if (v === FONT_FAMILY_CLEAR) {
                    editor.chain().focus().unsetFontFamily().run();
                  } else {
                    editor.chain().focus().setFontFamily(String(v)).run();
                  }
                  // chain().focus() 已把真实选区还回来，伪选区就该退场，免得叠成两层
                  setFakeSelection(editor, TOOLBAR_FAKE_SELECTION_KEY, null);
                }}
              />
            </Tooltip>
          );
        },
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
        icon: (
          <span className="inline-flex items-center gap-0.5">
            <Columns2 size={15} />
            <ChevronDown size={11} style={{ opacity: 0.6 }} />
          </span>
        ),
        title: "分栏布局（左图右文等）",
        isActive: () => editor.isActive("columns"),
        dropdownItems: [
          {
            key: "columns-2",
            icon: <Columns2 size={14} />,
            label: "两栏",
            onClick: () => editor.chain().focus().setColumns(2).run(),
          },
          {
            key: "columns-3",
            icon: <Columns3 size={14} />,
            label: "三栏",
            onClick: () => editor.chain().focus().setColumns(3).run(),
          },
          {
            key: "columns-4",
            icon: <Columns4 size={14} />,
            label: "四栏",
            onClick: () => editor.chain().focus().setColumns(4).run(),
          },
          {
            key: "columns-5",
            icon: <Columns4 size={14} />,
            label: "五栏",
            onClick: () => editor.chain().focus().setColumns(5).run(),
          },
        ],
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
      // 公式（LaTeX / KaTeX）：下拉选行内 / 块级，插入空公式占位并聚焦，
      // 用户直接输入 LaTeX；不用再手敲 $ / $$，提升可发现性（斜杠菜单也有同款项）。
      {
        icon: (
          <span className="inline-flex items-center gap-0.5">
            <Sigma size={15} />
            <ChevronDown size={11} style={{ opacity: 0.6 }} />
          </span>
        ),
        title: "公式（LaTeX）",
        isActive: () =>
          editor.isActive("inlineMath") || editor.isActive("blockMath"),
        dropdownItems: [
          {
            key: "math-inline",
            icon: <Calculator size={14} />,
            label: "行内公式 $…$",
            onClick: () =>
              editor
                .chain()
                .focus()
                .insertContent({ type: "inlineMath", attrs: { latex: "" } })
                .run(),
          },
          {
            key: "math-block",
            icon: <Sigma size={14} />,
            label: "块级公式 $$…$$",
            onClick: () =>
              editor
                .chain()
                .focus()
                .insertContent({ type: "blockMath", attrs: { latex: "" } })
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
    // 表格 — 整块交给 TableButton：点击按钮直接在浮层里选行列插入（含网格 + 自定义行列），
    // 光标在表格内时浮层下方展示编辑命令。icon/title 仅为满足类型，customRender 优先生效。
    [
      {
        icon: <TableIcon size={15} />,
        title: "表格",
        customRender: () => <TableButton editor={editor} />,
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
        icon: <Globe size={15} />,
        title: "嵌入网络视频（B站 / YouTube / 腾讯 / 优酷）",
        action: () => {
          setEmbedUrlInput("");
          setEmbedModalOpen(true);
        },
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
    // 缩进 + 格式刷 + 清除格式
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
        icon: null,
        title: "格式刷",
        // customRender:格式刷需要 onClick(once) + onDoubleClick(persist) 两个事件,
        // 走通用 ToolItem.action 路径覆盖不了。Tooltip 标题随 mode 变化提示用户当前态。
        customRender: () => {
          const tip =
            formatPainter.mode === "persist"
              ? "格式刷已锁定（连续应用，按 Esc 或再次单击退出）"
              : formatPainter.mode === "once"
                ? "格式刷已激活（选中目标文本应用一次）"
                : "格式刷：单击吸取格式应用一次，双击进入连续模式（Esc 退出）";
          return (
            <Tooltip title={tip} mouseEnterDelay={0.5}>
              <Button
                type="text"
                size="small"
                icon={<Paintbrush size={15} />}
                onClick={formatPainter.pickOnce}
                onDoubleClick={formatPainter.pickPersist}
                className={
                  formatPainter.mode !== "idle" ? "toolbar-btn-active" : ""
                }
                style={{ minWidth: 26, height: 26, padding: 0 }}
              />
            </Tooltip>
          );
        },
      },
      {
        icon: <Eraser size={15} />,
        title: "清除格式",
        action: () =>
          editor.chain().focus().unsetAllMarks().clearNodes().run(),
      },
      {
        icon: <ListX size={15} />,
        title: "格式规整（清理从别处复制来的内容）",
        dropdownItems: [
          {
            key: "cleanup-all",
            label: "一键规整（空行 + 空格 + 中英文间距）",
            onClick: () => {
              dropBlankParagraphs();
              cleanAllText(
                { trim: true, squeeze: true, cjkSpacing: true },
                "规整",
              );
            },
          },
          { type: "divider" },
          {
            key: "cleanup-blank",
            label: "删除多余空行",
            onClick: dropBlankParagraphs,
          },
          {
            key: "cleanup-spaces",
            label: "去除首尾空格 / 压缩连续空格",
            onClick: () => cleanAllText({ trim: true, squeeze: true }, "整理空格"),
          },
          {
            key: "cleanup-cjk",
            label: "中英文之间补空格",
            onClick: () => cleanAllText({ cjkSpacing: true }, "补空格"),
          },
          { type: "divider" },
          {
            key: "cleanup-styles",
            label: "清除字号 / 颜色 / 高亮（保留粗体等）",
            onClick: clearVisualStyles,
          },
          {
            // AI 生成 / 从 Word 粘来的标题常自带「1.1」「一、」，与自动编号叠成
            // 「1.1.1 1.1 公司定位」。清掉手写那层，交给自动编号统一管理。
            key: "cleanup-heading-number",
            label: "清除标题内手写编号（1.1 / 一、/ 第一章）",
            onClick: stripHeadingNumbers,
          },
        ],
      },
      ...(onOpenSearch
        ? [
            {
              icon: <Search size={15} />,
              title: "查找替换 (Ctrl+F / Ctrl+H)",
              action: onOpenSearch,
            } satisfies ToolItem,
          ]
        : []),
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

  // ── 单个工具项渲染（普通按钮 / 下拉按钮 / 自定义控件） ──
  const renderItem = (item: ToolItem, ii: number) => {
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
        <Tooltip key={ii} title={item.title} mouseEnterDelay={0.5}>
          <Dropdown menu={{ items: item.dropdownItems }} trigger={["click"]} placement="bottomLeft">
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
  };
  const renderGroup = (group: ToolItem[], gi: number, leadingDivider: boolean) => (
    <span key={gi} data-tb-group className="inline-flex items-center">
      {leadingDivider && (
        <Divider
          orientation="vertical"
          style={{ height: 18, margin: "0 1px", borderColor: "var(--ant-color-border-secondary, #f0f0f0)" }}
        />
      )}
      {group.map((item, ii) => renderItem(item, ii))}
    </span>
  );

  return (
    <>
      <div className="tiptap-toolbar" onMouseDown={handleToolbarMouseDown}>
        {groups.map((group, gi) => renderGroup(group, gi, gi > 0))}
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

      {/* 嵌入网络视频弹窗：粘贴 URL → iframe */}
      <Modal
        title="嵌入网络视频"
        open={embedModalOpen}
        onOk={handleEmbedConfirm}
        onCancel={() => setEmbedModalOpen(false)}
        okText="嵌入"
        cancelText="取消"
        width={520}
        destroyOnHidden
      >
        <div className="space-y-2">
          <Input
            value={embedUrlInput}
            onChange={(e) => setEmbedUrlInput(e.target.value)}
            onPressEnter={handleEmbedConfirm}
            placeholder="粘贴视频链接，如 https://www.bilibili.com/video/BVxxx"
            autoFocus
          />
          <div
            className="text-xs"
            style={{
              color: "var(--ant-color-text-quaternary)",
              lineHeight: 1.6,
            }}
          >
            支持平台：{SUPPORTED_PROVIDERS}
            <br />
            提示：嵌入视频依赖联网播放，离线时无法观看；导出 HTML
            会保留嵌入，导出 Markdown 也可保留 iframe 标签。
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
    // 标题不能存在于列表项内：listItem/taskItem 的 content 要求首子节点是 paragraph，
    // 光标在有序/无序/任务列表里时直接 setHeading 会被 schema 拒绝而静默失败（用户点 H1/H2 没反应）。
    // 先反复 liftListItem 把光标从（可能多级嵌套的）列表里完全抬出来，再设标题。
    let guard = 0;
    while (guard < 10) {
      const inTask = editor.isActive("taskItem");
      const inList = editor.isActive("listItem");
      if (!inTask && !inList) break;
      const ok = editor
        .chain()
        .focus()
        .liftListItem(inTask ? "taskItem" : "listItem")
        .run();
      if (!ok) break;
      guard += 1;
    }
    editor
      .chain()
      .focus()
      .setHeading({ level: lv as 1 | 2 | 3 | 4 | 5 | 6 })
      .run();
  }
}

/** 「字体」下拉里代表"清除字体"的哨兵 value（不可能与真实 font-family 值撞车） */
const FONT_FAMILY_CLEAR = "__clear__";

/**
 * 工具栏用的伪选区 key。
 *
 * antd Select 打开时靠内部 focus 拉起 popup，`handleToolbarMouseDown` 的
 * preventDefault 对它无效（所以那里显式跳过了 .ant-select）—— 编辑器一失焦，
 * 浏览器就不再画选区蓝底，用户看着像"刚选的字没了"，回去重点一下反而真丢。
 * 下拉打开期间铺一层伪选区，选完即清。与 AI 写作菜单各用各的 key，互不干扰。
 */
const TOOLBAR_FAKE_SELECTION_KEY = new PluginKey<DecorationSet>(
  "kb-toolbar-fake-selection",
);

/**
 * 把一条 font-family 值压成一个短标签：只取首个字体名并去掉引号。
 * 用于下拉的选中态显示——完整 fallback 链动辄上百字符，塞不进工具栏。
 * 从 Word / 网页粘进来的字体（不在选项里）也能靠这个显示出"是什么字体"。
 */
function shortFontLabel(value: string): string {
  if (!value || value === FONT_FAMILY_CLEAR) return "字体";
  const first = value.split(",")[0]?.trim() ?? "";
  return first.replace(/^["']|["']$/g, "") || "字体";
}

/**
 * 系统已装字体的模块级单飞缓存。
 *
 * 枚举一次要跑到 Rust 侧读系统字体表，而工具栏会随每个编辑器实例挂载
 * （笔记页 / 日记页 / 弹出窗），没必要各枚举一遍。失败（移动端无此 Command）
 * 时缓存空数组 → 下拉只剩预设，不反复重试。
 */
let systemFontsPromise: Promise<string[]> | null = null;
function loadSystemFontsOnce(): Promise<string[]> {
  if (!systemFontsPromise) {
    systemFontsPromise = systemApi.listSystemFonts().catch(() => []);
  }
  return systemFontsPromise;
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

