import type { Editor, Range } from "@tiptap/core";
import { message } from "antd";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Pilcrow,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Minus,
  Code2,
  Table as TableIcon,
  ChevronRight,
  Info,
  Lightbulb,
  AlertTriangle,
  ShieldAlert,
  Link2,
  GitBranch,
  Sigma,
  Calculator,
  ImagePlus,
  Film,
  Globe,
  Columns2,
  Columns3,
  Columns4,
  type LucideIcon,
} from "lucide-react";
import { imageApi, videoApi } from "@/lib/api";
import { toKbAsset } from "@/lib/assetUrl";
import { parseEmbedUrl, SUPPORTED_PROVIDERS } from "./embedVideoProviders";

export interface SlashCommandItem {
  /** 唯一 key，用于 React 列表渲染 */
  key: string;
  /** 显示标题 */
  title: string;
  /** 副标题（描述） */
  subtitle?: string;
  /** 分组（在列表里渲染分隔标题） */
  group: string;
  /** 图标 */
  icon: LucideIcon;
  /** 搜索关键词（中英文/拼音首字母混合，用于模糊匹配） */
  keywords: string[];
  /** 右侧快捷键提示（仅展示，不真实绑定） */
  shortcut?: string;
  /** 实际执行：先把 `/查询词` 区间删掉，再执行编辑器命令 */
  command: (ctx: { editor: Editor; range: Range }) => void | Promise<void>;
}

/**
 * 媒体类命令依赖外部 noteId 上下文：
 * - getNoteId 函数式取当前 noteId（编辑器实例只创建一次，不能闭包捕获）
 * - ensureNoteId 在 noteId 缺失时按需建档（每日笔记首次写入场景）
 *   未提供时直接给提示并放弃插入。
 */
export interface SlashCommandBuildOptions {
  getNoteId: () => number | undefined;
  ensureNoteId: () => Promise<number> | undefined;
  /**
   * 弹出"嵌入网络视频"输入框，由 React 树里的 Modal 实现。
   * 返回用户输入的 URL（去空格），取消则返回 null。
   * 未配置时嵌入视频项会给提示并放弃。
   */
  requestEmbedUrl?: () => Promise<string | null>;
}

const BASIC_SLASH_ITEMS: SlashCommandItem[] = [
  // ─── 基础块 ───
  {
    key: "paragraph",
    title: "正文",
    subtitle: "普通段落文本",
    group: "基础块",
    icon: Pilcrow,
    keywords: ["正文", "段落", "paragraph", "text", "p", "zw", "dl"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setParagraph().run();
    },
  },
  {
    key: "h1",
    title: "一级标题",
    subtitle: "大标题",
    group: "基础块",
    icon: Heading1,
    keywords: ["一级标题", "标题", "h1", "heading", "title", "bt", "yjbt"],
    shortcut: "Ctrl+1",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run();
    },
  },
  {
    key: "h2",
    title: "二级标题",
    group: "基础块",
    icon: Heading2,
    keywords: ["二级标题", "h2", "heading", "bt", "ejbt"],
    shortcut: "Ctrl+2",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run();
    },
  },
  {
    key: "h3",
    title: "三级标题",
    group: "基础块",
    icon: Heading3,
    keywords: ["三级标题", "h3", "heading", "bt", "sjbt"],
    shortcut: "Ctrl+3",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setHeading({ level: 3 }).run();
    },
  },
  {
    key: "h4",
    title: "四级标题",
    group: "基础块",
    icon: Heading4,
    keywords: ["四级标题", "h4", "heading", "bt", "sjbt"],
    shortcut: "Ctrl+4",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setHeading({ level: 4 }).run();
    },
  },
  {
    key: "blockquote",
    title: "引用",
    subtitle: "引用块",
    group: "基础块",
    icon: Quote,
    keywords: ["引用", "blockquote", "quote", "yy"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBlockquote().run();
    },
  },
  {
    key: "hr",
    title: "分割线",
    subtitle: "水平分割线",
    group: "基础块",
    icon: Minus,
    keywords: ["分割线", "horizontal", "rule", "hr", "divider", "fgx"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setHorizontalRule().run();
    },
  },

  // ─── 列表 ───
  {
    key: "bulletList",
    title: "无序列表",
    subtitle: "项目符号列表",
    group: "列表",
    icon: List,
    keywords: ["无序列表", "bullet", "list", "ul", "wxlb", "lb"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBulletList().run();
    },
  },
  {
    key: "orderedList",
    title: "有序列表",
    subtitle: "数字编号列表",
    group: "列表",
    icon: ListOrdered,
    keywords: ["有序列表", "ordered", "list", "ol", "yxlb", "lb"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleOrderedList().run();
    },
  },
  {
    key: "taskList",
    title: "任务列表",
    subtitle: "可勾选的待办列表",
    group: "列表",
    icon: ListTodo,
    keywords: ["任务列表", "task", "todo", "checklist", "rwlb", "dbsx"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleTaskList().run();
    },
  },

  // ─── 代码与表格 ───
  {
    key: "codeBlock",
    title: "代码块",
    subtitle: "支持语法高亮",
    group: "代码与表格",
    icon: Code2,
    keywords: ["代码块", "code", "block", "dmk"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run();
    },
  },
  {
    key: "table",
    title: "表格",
    subtitle: "插入 3×3 表格",
    group: "代码与表格",
    icon: TableIcon,
    keywords: ["表格", "table", "bg"],
    command: ({ editor, range }) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run();
    },
  },

  // ─── 提示框 ───
  {
    key: "callout-info",
    title: "信息提示",
    subtitle: "蓝色信息块",
    group: "提示框",
    icon: Info,
    keywords: ["信息", "info", "callout", "tsk", "xx"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleCallout("info").run();
    },
  },
  {
    key: "callout-tip",
    title: "成功提示",
    subtitle: "绿色提示块",
    group: "提示框",
    icon: Lightbulb,
    keywords: ["提示", "tip", "callout", "success", "ts", "cg"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleCallout("tip").run();
    },
  },
  {
    key: "callout-warning",
    title: "警告提示",
    subtitle: "黄色警告块",
    group: "提示框",
    icon: AlertTriangle,
    keywords: ["警告", "warning", "callout", "warn", "jg"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleCallout("warning").run();
    },
  },
  {
    key: "callout-danger",
    title: "危险提示",
    subtitle: "红色危险块",
    group: "提示框",
    icon: ShieldAlert,
    keywords: ["危险", "danger", "callout", "error", "wx"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleCallout("danger").run();
    },
  },

  // ─── 分栏 ───
  {
    key: "columns-2",
    title: "两栏",
    subtitle: "并排 2 列，如左图右文",
    group: "分栏",
    icon: Columns2,
    keywords: ["分栏", "两栏", "2栏", "并排", "columns", "column", "fl", "llfl"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setColumns(2).run();
    },
  },
  {
    key: "columns-3",
    title: "三栏",
    subtitle: "并排 3 列",
    group: "分栏",
    icon: Columns3,
    keywords: ["分栏", "三栏", "3栏", "并排", "columns", "column", "fl", "snfl"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setColumns(3).run();
    },
  },
  {
    key: "columns-4",
    title: "四栏",
    subtitle: "并排 4 列",
    group: "分栏",
    icon: Columns4,
    keywords: ["分栏", "四栏", "4栏", "并排", "columns", "column", "fl", "snfl"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setColumns(4).run();
    },
  },

  // ─── 高级 ───
  {
    key: "toggle",
    title: "折叠块",
    subtitle: "可展开/折叠的内容块",
    group: "高级",
    icon: ChevronRight,
    keywords: ["折叠", "toggle", "collapse", "fold", "zd", "zdk"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setToggle().run();
    },
  },
  {
    key: "mermaid",
    title: "Mermaid 流程图",
    subtitle: "插入 mermaid 代码块",
    group: "高级",
    icon: GitBranch,
    keywords: ["mermaid", "流程图", "图表", "lct", "tb"],
    command: ({ editor, range }) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
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
        .run();
    },
  },
  {
    key: "blockMath",
    title: "块级公式",
    subtitle: "$$ 包裹的 LaTeX 公式块",
    group: "高级",
    icon: Sigma,
    keywords: ["公式", "数学", "math", "latex", "block", "gs", "sx"],
    command: ({ editor, range }) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({ type: "blockMath", attrs: { latex: "" } })
        .run();
    },
  },
  {
    key: "inlineMath",
    title: "行内公式",
    subtitle: "$ 包裹的 LaTeX 行内公式",
    group: "高级",
    icon: Calculator,
    keywords: ["行内公式", "math", "inline", "latex", "hngs"],
    command: ({ editor, range }) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({ type: "inlineMath", attrs: { latex: "" } })
        .run();
    },
  },

  // ─── 知识库 ───
  {
    key: "wikiLink",
    title: "双链笔记引用",
    subtitle: "插入 [[ 触发笔记选择",
    group: "知识库",
    icon: Link2,
    keywords: ["双链", "引用", "wiki", "link", "笔记", "sl", "yy", "bj"],
    command: ({ editor, range }) => {
      // 先删 / 触发字符，再插入 [[，让 WikiLinkSuggestion 接管后续
      editor.chain().focus().deleteRange(range).insertContent("[[").run();
    },
  },
];

/**
 * 解析当前可用的 noteId：
 * - 优先用显式 getNoteId() 返回值
 * - 缺失时调 ensureNoteId() 按需建档（如每日笔记首次写入）
 * - 都拿不到则给用户提示并返回 null（调用方放弃插入）
 *
 * 与 EditorToolbar.insertImage / insertVideo 同款流程，便于斜杠菜单和工具栏行为一致。
 */
async function resolveNoteId(
  opts: SlashCommandBuildOptions,
): Promise<number | null> {
  let id = opts.getNoteId();
  if (!id) {
    try {
      const fresh = await opts.ensureNoteId();
      if (typeof fresh === "number") id = fresh;
    } catch (e) {
      message.error(`插入失败: ${e}`);
      return null;
    }
  }
  if (!id) {
    message.warning("请先保存笔记后再插入媒体");
    return null;
  }
  return id;
}

/**
 * 媒体类命令工厂：图片 / 本地视频。
 * 嵌入网络视频需要 URL 输入弹窗，跨编辑器扩展层通信成本高，暂不进斜杠菜单
 * （仍保留在工具栏）。
 */
function createMediaSlashItems(
  opts: SlashCommandBuildOptions,
): SlashCommandItem[] {
  return [
    {
      key: "image",
      title: "图片",
      subtitle: "从本地选择图片插入",
      group: "媒体",
      icon: ImagePlus,
      keywords: ["图片", "image", "picture", "tp", "tx"],
      command: async ({ editor, range }) => {
        // 立刻删掉触发字符，再走异步 — 避免对话框期间编辑器残留 "/"
        editor.chain().focus().deleteRange(range).run();

        const noteId = await resolveNoteId(opts);
        if (!noteId) return;

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
            const relPath = await imageApi.saveFromPath(noteId, filePath);
            editor
              .chain()
              .focus()
              .insertContent({
                type: "imageResize",
                attrs: { src: toKbAsset(relPath) },
              })
              .run();
          } catch (e) {
            message.error(`图片插入失败: ${e}`);
          }
        }
      },
    },
    {
      key: "video",
      title: "本地视频",
      subtitle: "从本地选择视频插入",
      group: "媒体",
      icon: Film,
      keywords: ["视频", "video", "media", "sp"],
      command: async ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).run();

        const noteId = await resolveNoteId(opts);
        if (!noteId) return;

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
            const relPath = await videoApi.saveFromPath(noteId, filePath);
            editor
              .chain()
              .focus()
              .insertContent({
                type: "video",
                attrs: {
                  src: toKbAsset(relPath),
                  id: Math.random().toString(36).slice(2, 10),
                },
              })
              .run();
          } catch (e) {
            message.error(`视频插入失败: ${e}`);
          }
        }
      },
    },
    {
      key: "embedVideo",
      title: "嵌入网络视频",
      subtitle: `粘贴 ${SUPPORTED_PROVIDERS} 链接`,
      group: "媒体",
      icon: Globe,
      keywords: [
        "嵌入视频",
        "embed",
        "video",
        "online",
        "youtube",
        "bilibili",
        "wlsp",
        "qrsp",
      ],
      command: async ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).run();

        if (!opts.requestEmbedUrl) {
          message.warning("当前编辑器未配置嵌入视频弹窗");
          return;
        }
        const raw = await opts.requestEmbedUrl();
        if (!raw) return;
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
        message.success(`已嵌入${parsed.providerName}视频`);
      },
    },
  ];
}

/**
 * 组装最终斜杠命令列表：基础静态项 + 依赖 noteId 的媒体项。
 * 媒体组按 "代码与表格 → 媒体 → 提示框" 的顺序插入到正确位置，
 * 让 SlashCommandList 的 group 渲染顺序符合直觉。
 */
export function buildSlashCommandItems(
  opts: SlashCommandBuildOptions,
): SlashCommandItem[] {
  const media = createMediaSlashItems(opts);
  // 在第一个 group 为"提示框"的项之前插入媒体组
  const insertAt = BASIC_SLASH_ITEMS.findIndex((it) => it.group === "提示框");
  if (insertAt < 0) return [...BASIC_SLASH_ITEMS, ...media];
  return [
    ...BASIC_SLASH_ITEMS.slice(0, insertAt),
    ...media,
    ...BASIC_SLASH_ITEMS.slice(insertAt),
  ];
}

/**
 * 模糊匹配：query 在 title 或任意 keyword 中作为子串出现即命中。
 * 大小写不敏感，trim 处理。
 *
 * Why: 不引入 fuse.js / pinyin-pro 重型依赖，命令清单只有 ~20 条，
 *      includes 足够。命中后按"标题前缀匹配 > 关键词前缀 > 子串"排序。
 */
export function filterSlashItems(
  items: SlashCommandItem[],
  rawQuery: string,
): SlashCommandItem[] {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return items;

  const scored: Array<{ item: SlashCommandItem; score: number }> = [];
  for (const item of items) {
    const title = item.title.toLowerCase();
    const kws = item.keywords.map((k) => k.toLowerCase());

    let score = -1;
    if (title.startsWith(q)) score = 100;
    else if (kws.some((k) => k.startsWith(q))) score = 80;
    else if (title.includes(q)) score = 50;
    else if (kws.some((k) => k.includes(q))) score = 30;

    if (score >= 0) scored.push({ item, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}
