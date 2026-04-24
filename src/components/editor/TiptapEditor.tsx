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
// tiptap-markdown 未提供 TS 声明，用 import 后以 any 访问
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { Markdown } from "tiptap-markdown";

/** 从编辑器读出 Markdown 字符串（tiptap-markdown 注入的 storage 无类型） */
function getEditorMarkdown(editor: { storage: unknown }): string {
  const storage = editor.storage as { markdown?: { getMarkdown: () => string } };
  return storage.markdown?.getMarkdown() ?? "";
}
import { common, createLowlight } from "lowlight";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef, useCallback, useState } from "react";
import { message } from "antd";
import { theme as antdTheme } from "antd";
import { imageApi } from "@/lib/api";
import { EditorToolbar } from "./EditorToolbar";
import { AiWriteMenu } from "./AiWriteMenu";
import { WikiLinkDecoration } from "./WikiLinkDecoration";
import { WikiLinkSuggestion } from "./WikiLinkSuggestion";
import "tippy.js/dist/tippy.css";

const lowlight = createLowlight(common);

/**
 * 从 Clipboard/DataTransfer 收集所有图片文件。
 * Why: 部分来源（浏览器、某些 IM 工具）`files` 只给第一个，但 `items[]` 里齐全；
 *      用 Map<File> 去重避免两边都给时重复插入。
 */
function collectImageFiles(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  const seen = new Set<File>();
  const out: File[] = [];
  const push = (f: File | null) => {
    if (f && f.type.startsWith("image/") && !seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  };
  if (dt.items) {
    for (let i = 0; i < dt.items.length; i++) {
      const item = dt.items[i];
      if (item.kind === "file") push(item.getAsFile());
    }
  }
  if (dt.files) {
    for (let i = 0; i < dt.files.length; i++) push(dt.files[i]);
  }
  return out;
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
  /** 笔记内容（Markdown 字符串） */
  content: string;
  /** 保存回调，参数为 Markdown 字符串 */
  onChange: (markdown: string) => void;
  placeholder?: string;
  /** 当前笔记 ID，用于图片保存 */
  noteId?: number;
  /**
   * 当 noteId 缺失时，图片插入前调用此回调拉出一个 noteId（例如每日笔记
   * 首次写内容前还未 getOrCreate）。返回 Promise<number>；调用方负责
   * 同步自己的 noteId 状态。
   */
  ensureNoteId?: () => Promise<number>;
  /** Ctrl/Cmd + 点击 [[标题]] 时触发（编辑器内 wiki 链接跳转） */
  onWikiLinkClick?: (title: string) => void;
}

export function TiptapEditor({
  content,
  onChange,
  placeholder = "开始写点什么...",
  noteId,
  ensureNoteId,
  onWikiLinkClick,
}: TiptapEditorProps) {
  const isExternalUpdate = useRef(false);

  // 用 ref 保持 onWikiLinkClick 最新引用，避免 Tiptap 扩展闭包过期
  const wikiClickRef = useRef(onWikiLinkClick);
  // ensureNoteId 同样用 ref：它常是组件每次渲染新建的闭包，不能进依赖数组
  const ensureNoteIdRef = useRef(ensureNoteId);
  ensureNoteIdRef.current = ensureNoteId;
  useEffect(() => {
    wikiClickRef.current = onWikiLinkClick;
  }, [onWikiLinkClick]);

  // onUpdate 防抖：每次按键都序列化整篇文档（O(doc size)）代价不低，长笔记在 WKWebView 上肉眼可感。
  // 用 ref 承载最新 onChange，避免依赖变化重建 editor；用 timer ref 做 300ms 尾触发，
  // unmount / editor blur 时强制 flush，保证保存按钮永远能拿到最新 markdown。
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingEditorRef = useRef<{ storage: unknown } | null>(null);
  const flushNow = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const pending = pendingEditorRef.current;
    if (pending) {
      pendingEditorRef.current = null;
      onChangeRef.current(getEditorMarkdown(pending));
    }
  }, []);

  /** 处理图片文件：并发保存后一次性批量插入编辑器 */
  const handleImageFiles = useCallback(
    async (files: File[], editor: ReturnType<typeof useEditor>) => {
      if (!editor) return;

      // 优先用显式 noteId；不存在时尝试 ensureNoteId（例如每日笔记自动建档）
      let effectiveNoteId = noteId;
      if (!effectiveNoteId && ensureNoteIdRef.current) {
        try {
          effectiveNoteId = await ensureNoteIdRef.current();
        } catch (e) {
          message.error(`图片插入失败: ${e}`);
          return;
        }
      }
      if (!effectiveNoteId) {
        message.warning("请先保存笔记后再插入图片");
        return;
      }

      const images = files.filter((f) => f.type.startsWith("image/"));
      console.log("[image-drop] received files:", images.length, images.map((f) => f.name));

      // Why: 原版在 for-await 里每次 insertContent，会让 onUpdate 连环触发、debounce 反复刷新；
      //      且 Tiptap 在同一批次中对同一 src 的 node 行为不稳定。改成全部保存完后一次性插入。
      const results = await Promise.all(
        images.map(async (file) => {
          try {
            const base64 = await fileToBase64(file);
            const filePath = await imageApi.save(effectiveNoteId!, file.name, base64);
            return { ok: true as const, filePath, name: file.name };
          } catch (e) {
            return { ok: false as const, err: String(e), name: file.name };
          }
        }),
      );

      const nodes: { type: string; attrs: { src: string } }[] = [];
      for (const r of results) {
        if (r.ok) {
          console.log("[image-drop] saved:", r.name, "=>", r.filePath);
          nodes.push({
            type: "imageResize",
            attrs: { src: convertFileSrc(r.filePath) },
          });
        } else {
          message.error(`图片插入失败(${r.name}): ${r.err}`);
        }
      }
      if (nodes.length === 0) return;

      // 去重：若 Rust 侧仍返回了相同 filePath（比如旧二进制没重编），至少提示用户
      const uniqueSrc = new Set(nodes.map((n) => n.attrs.src));
      if (uniqueSrc.size !== nodes.length) {
        console.warn(
          "[image-drop] 后端返回了重复路径（旧二进制？）",
          nodes.map((n) => n.attrs.src),
        );
      }

      editor.chain().focus().insertContent(nodes).run();
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
      // Markdown 序列化/反序列化：setContent 吃 Markdown，editor.storage.markdown.getMarkdown() 吐 Markdown
      Markdown.configure({
        html: true,               // 允许内联 HTML 片段（表格等复杂结构）
        tightLists: true,         // 紧凑列表
        bulletListMarker: "-",
        linkify: true,
        breaks: false,
        transformPastedText: true,
        transformCopiedText: false,
      }),
    ],
    content,
    onUpdate: ({ editor }) => {
      if (isExternalUpdate.current) return;
      pendingEditorRef.current = editor;
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        const pending = pendingEditorRef.current;
        if (pending) {
          pendingEditorRef.current = null;
          onChangeRef.current(getEditorMarkdown(pending));
        }
      }, 300);
    },
    onBlur: () => {
      // 失焦立即 flush，避免用户切走 / 点击保存后读到 300ms 之内的旧内容
      flushNow();
    },
    editorProps: {
      handlePaste: (_view, event) => {
        const images = collectImageFiles(event.clipboardData);
        if (images.length > 0) {
          handleImageFiles(images, editor);
          return true;
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const images = collectImageFiles(event.dataTransfer);
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
    const current = getEditorMarkdown(editor);
    if (content !== current) {
      isExternalUpdate.current = true;
      editor.commands.setContent(content, { emitUpdate: false });
      isExternalUpdate.current = false;
    }
  }, [content, editor]);

  // unmount 时强制 flush 防抖中的最后一次编辑，避免切 tab / 跳转时丢失末尾未传给父组件的内容
  useEffect(() => {
    return () => {
      flushNow();
    };
  }, [flushNow]);

  const { token } = antdTheme.useToken();

  // 编辑器统计信息：打字时不实时算，停顿 300ms 后再遍历整篇。
  // 旧实现把 `editor.getText()` 放在 useMemo 依赖里，每次 render 都要 O(n) 遍历文档 +
  // 2 次全文正则替换；长笔记在 Mac WKWebView 上会明显卡顿。
  const [stats, setStats] = useState({ chars: 0, words: 0, readingTime: "< 1 min" });
  useEffect(() => {
    if (!editor) {
      setStats({ chars: 0, words: 0, readingTime: "< 1 min" });
      return;
    }
    const timer = setTimeout(() => {
      const text = editor.getText();
      const chars = text.length;
      // 中文按字数，英文按空格分词
      const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
      const nonCjk = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, " ");
      const engWords = nonCjk.split(/\s+/).filter((w) => w.length > 0).length;
      const words = cjkCount + engWords;
      // 按 400 字/分钟估算阅读时间
      const minutes = Math.ceil(words / 400);
      setStats({
        chars,
        words,
        readingTime: minutes < 1 ? "< 1 min" : `${minutes} min`,
      });
    }, 300);
    return () => clearTimeout(timer);
    // 依赖 content prop：父组件在 onChange 后会更新 content，
    // 这反过来表示编辑器内容刚刚变过，此时触发一次 debounced 重算即可。
  }, [editor, content]);

  if (!editor) return null;

  return (
    <div className="tiptap-wrapper" style={{ position: "relative" }}>
      <EditorToolbar editor={editor} noteId={noteId} ensureNoteId={ensureNoteId} />
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
