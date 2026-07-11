import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ChevronLeft,
  Pin,
  MoreVertical,
  Bold,
  Italic,
  Heading1,
  List,
  CheckSquare,
  Link as LinkIcon,
  Image as ImageIcon,
  Sparkles,
  Eye,
  Pencil,
} from "lucide-react";
import { message } from "antd";
import ReactMarkdown from "react-markdown";
import { noteApi, aiChatApi } from "@/lib/api";
import { useAppStore } from "@/store";
import type { Note } from "@/types";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";

/**
 * 移动端笔记编辑页（设计稿：02-note-edit.html）
 *
 * 路由：/notes/:id —— 在 isMobile=true 时通过 wrapper 加载本组件。
 *
 * 布局：fixed inset-0 全屏覆盖（盖住 MobileLayout 的 5 Tab + FAB）
 * - 顶栏：返回 + 居中标题（含已保存状态） + Pin + 更多
 * - 标题输入框
 * - 元信息：日期 / 字数 / 标签（暂只读，标签编辑下迭代）
 * - 内容编辑：纯文本 textarea（移动端 Markdown 源码模式）
 * - 底部 Markdown 工具栏（拇指热区）
 *
 * 自动保存：用户停止输入 1.2s 后调 update，避免每次按键都打 IPC。
 *
 * MVP 版暂不实现：
 * - Markdown 渲染预览（双视图切换）
 * - TipTap WYSIWYG（移动端键盘体验差）
 * - 反向链接显示（数据已有，UI 下迭代）
 * - 标签 / Pin / 隐藏 PIN 完整 UX
 */

const AUTOSAVE_DELAY_MS = 1200;
/** 保存成功后"已保存 刚刚"提示的可见时长 */
const SAVED_TOAST_MS = 2500;

/**
 * 顶栏状态机：
 * - idle:   不显示指示器（用户没在打字也没有最近的保存）
 * - dirty:  用户刚输入但还在 debounce 等待中 — 也不显示，避免噪音
 * - saving: 正在写后端 — 橙色 "保存中…"
 * - saved:  刚刚保存成功 — 绿色 "已保存 刚刚"，SAVED_TOAST_MS 后自动归 idle
 */
type SaveStatus = "idle" | "dirty" | "saving" | "saved";

export function MobileNoteEditor() {
  const navigate = useNavigate();
  const { id: idParam } = useParams<{ id: string }>();
  const noteId = Number(idParam);
  const keyboardInset = useKeyboardInset(); // 键盘弹出时顶起底部工具栏，避免遮挡

  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [pinning, setPinning] = useState(false);
  /** 编辑(源码) / 预览(Markdown 渲染) 切换 */
  const [previewMode, setPreviewMode] = useState(false);
  /** 点 AI 按钮 → 新建对话 + 附本笔记，过程中防重复点 */
  const [askingAi, setAskingAi] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  /** "已保存 刚刚" 自动隐藏定时器 */
  const savedHideTimerRef = useRef<number | null>(null);
  /**
   * title / content 的 ref 镜像 — 解决 React 闭包陷阱：
   * onChange 内同步调用 scheduleSave 时，setState 还没生效，
   * 当前渲染作用域里的 title 仍是旧值。useCallback 的 doSave
   * 也只能读到旧值。改用 ref 由 doSave 直接读，可保证拿到最新。
   */
  const titleRef = useRef("");
  const contentRef = useRef("");

  const load = useCallback(async () => {
    if (!noteId || Number.isNaN(noteId)) return;
    try {
      const n = await noteApi.get(noteId);
      setNote(n);
      setTitle(n.title);
      setContent(n.content || "");
      titleRef.current = n.title;
      contentRef.current = n.content || "";
      dirtyRef.current = false;
      setStatus("idle");
    } catch (e) {
      message.error(`加载笔记失败: ${e}`);
    }
  }, [noteId]);

  useEffect(() => {
    void load();
  }, [load]);

  const doSave = useCallback(async () => {
    if (!note || !dirtyRef.current) return;
    setStatus("saving");
    try {
      // 直接从 ref 读最新值，避免闭包陷阱（用户在 1.2s debounce
      // 期间多敲了几个字，state 已更新但 doSave closure 还是旧的）
      await noteApi.update(note.id, {
        title: titleRef.current,
        content: contentRef.current,
        folder_id: note.folder_id,
      });
      dirtyRef.current = false;
      setStatus("saved");
      // 在 SAVED_TOAST_MS 后自动归 idle
      if (savedHideTimerRef.current) {
        window.clearTimeout(savedHideTimerRef.current);
      }
      savedHideTimerRef.current = window.setTimeout(() => {
        // 只有在仍是 saved 时才归 idle（用户期间又改了 → 保留 dirty/saving）
        setStatus((s) => (s === "saved" ? "idle" : s));
      }, SAVED_TOAST_MS);
    } catch (e) {
      message.error(`保存失败: ${e}`);
      setStatus("idle");
    }
    // 仅依赖 note —— title/content 通过 ref 读，无需进 deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note]);

  // debounced 自动保存
  function scheduleSave() {
    dirtyRef.current = true;
    setStatus("dirty");
    // 取消"已保存"的隐藏倒计时（用户已经又开始编辑了）
    if (savedHideTimerRef.current) {
      window.clearTimeout(savedHideTimerRef.current);
      savedHideTimerRef.current = null;
    }
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      void doSave();
    }, AUTOSAVE_DELAY_MS);
  }

  /**
   * 立即落盘 + 通知列表刷新。
   * 返回按钮调用：用户回到列表前必须看到最新数据，否则会出现"返回时仍是旧数据"的错觉。
   */
  async function flushAndExit() {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (savedHideTimerRef.current) {
      window.clearTimeout(savedHideTimerRef.current);
      savedHideTimerRef.current = null;
    }
    if (dirtyRef.current) {
      await doSave();
    }
    // 通知全局监听者刷新列表（MobileNotes 用 notesRefreshTick 重新拉数据）
    useAppStore.getState().bumpNotesRefresh();
    navigate(-1);
  }

  // 离开页面（非"返回按钮"路径，如 swipe back）兜底保存
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      if (savedHideTimerRef.current)
        window.clearTimeout(savedHideTimerRef.current);
      if (dirtyRef.current) {
        // 异步落盘 + 让监听者刷新（拿到的数据可能仍是旧的，但 bumpNotesRefresh 会
        // 在 await 完成后触发再次刷新）
        void doSave().then(() => {
          useAppStore.getState().bumpNotesRefresh();
        });
      } else {
        // 没改也敲一下，确保返回时列表展示最新（防御性）
        useAppStore.getState().bumpNotesRefresh();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handlePin() {
    if (!note || pinning) return;
    setPinning(true);
    try {
      const next = await noteApi.togglePin(note.id);
      setNote({ ...note, is_pinned: next });
    } catch (e) {
      message.error(`切换置顶失败: ${e}`);
    } finally {
      setPinning(false);
    }
  }

  /**
   * "针对本笔记问 AI"：先把未落盘的改动 flush，再新建一个 AI 对话并把本笔记挂上去，
   * 然后跳到聊天页。后端每次 sendMessage 会按 attached_note_ids 拉笔记拼进 system prompt，
   * 用户进去就能直接"解读 / 续写 / 翻译这篇笔记"。
   */
  async function askAiAboutNote() {
    if (!note || askingAi) return;
    setAskingAi(true);
    try {
      // 1) 先落盘当前编辑，确保 AI 拿到最新内容
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (dirtyRef.current) await doSave();
      // 2) 新建对话（标题用笔记名，方便日后辨认）+ 挂载本笔记
      const convTitle = (titleRef.current || "未命名笔记").slice(0, 30);
      const conv = await aiChatApi.createConversation(`关于：${convTitle}`);
      await aiChatApi.setAttachedNotes(conv.id, [note.id]);
      // 3) 通知列表刷新（这篇可能改过标题）再跳聊天页
      useAppStore.getState().bumpNotesRefresh();
      navigate(`/ai-chat/${conv.id}`);
    } catch (e) {
      message.error(`创建 AI 对话失败: ${e}`);
      setAskingAi(false);
    }
  }

  function insertAtCursor(prefix: string, suffix = "") {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const before = content.slice(0, start);
    const selected = content.slice(start, end);
    const after = content.slice(end);
    const next = before + prefix + selected + suffix + after;
    contentRef.current = next;
    setContent(next);
    scheduleSave();
    // 选中文本恢复，光标移到 prefix 之后
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const pos = start + prefix.length + selected.length;
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(pos, pos);
      }
    });
  }

  function insertLineStart(prefix: string) {
    const ta = textareaRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    const before = content.slice(0, pos);
    const lineStart = before.lastIndexOf("\n") + 1;
    const next =
      content.slice(0, lineStart) + prefix + content.slice(lineStart);
    contentRef.current = next;
    setContent(next);
    scheduleSave();
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const newPos = pos + prefix.length;
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(newPos, newPos);
      }
    });
  }

  if (Number.isNaN(noteId)) {
    return (
      <div className="p-4 text-center text-sm text-slate-400">
        笔记 ID 无效
      </div>
    );
  }

  const wordCount = content.length;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-white"
      style={{
        paddingTop: "env(safe-area-inset-top, 0px)",
        paddingBottom: keyboardInset,
      }}
    >
      {/* 顶栏 */}
      <header className="flex h-12 items-center justify-between border-b border-slate-200 bg-white px-2 shrink-0">
        <button
          onClick={() => void flushAndExit()}
          aria-label="返回"
          className="flex h-10 w-10 items-center justify-center"
        >
          <ChevronLeft size={24} className="text-slate-700" />
        </button>
        <div className="flex flex-col items-center min-w-0 flex-1 leading-tight">
          <span className="truncate text-sm font-semibold text-slate-900">
            编辑笔记
          </span>
          {/* 状态指示器：仅在 saving / saved 时显示，dirty 与 idle 都隐藏（避免噪音） */}
          <SaveBadge status={status} />
        </div>
        <div className="flex">
          <button
            onClick={() => setPreviewMode((v) => !v)}
            aria-label={previewMode ? "回到编辑" : "预览渲染"}
            className="flex h-10 w-10 items-center justify-center"
          >
            {previewMode ? (
              <Pencil size={19} className="text-[#1677FF]" />
            ) : (
              <Eye size={20} className="text-slate-500" />
            )}
          </button>
          <button
            onClick={handlePin}
            aria-label={note?.is_pinned ? "取消置顶" : "置顶"}
            className="flex h-10 w-10 items-center justify-center"
          >
            <Pin
              size={20}
              className={
                note?.is_pinned ? "text-amber-500 fill-amber-500" : "text-slate-400"
              }
            />
          </button>
          <button
            aria-label="更多"
            className="flex h-10 w-10 items-center justify-center"
          >
            <MoreVertical size={20} className="text-slate-700" />
          </button>
        </div>
      </header>

      {/* 编辑区 */}
      <main className="flex-1 overflow-y-auto px-4 py-3">
        <input
          value={title}
          onChange={(e) => {
            const v = e.target.value;
            titleRef.current = v;
            setTitle(v);
            scheduleSave();
          }}
          placeholder="无标题笔记"
          className="w-full text-2xl font-bold text-slate-900 outline-none placeholder:text-slate-300 bg-transparent"
        />

        <div className="mt-2 mb-3 flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <span>
            {note ? new Date(note.updated_at).toLocaleDateString("zh-CN") : "—"}
            {" · "}
            {wordCount} 字
          </span>
          {note?.is_hidden && (
            <span className="rounded bg-red-50 px-2 py-0.5 text-red-600">
              已隐藏
            </span>
          )}
          {note?.is_encrypted && (
            <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-600">
              已加密
            </span>
          )}
        </div>

        {previewMode ? (
          // 渲染预览（只读）。复用全局 .ai-markdown 样式（标题/列表/代码块等，与 AI 回复一致）
          content.trim() ? (
            <div
              className="ai-markdown text-[15px] leading-relaxed text-slate-800"
              style={{ minHeight: "calc(100vh - 280px)" }}
            >
              <ReactMarkdown>{content}</ReactMarkdown>
            </div>
          ) : (
            <div className="py-8 text-center text-sm text-slate-300">
              （还没有内容，切回编辑模式开始写）
            </div>
          )
        ) : (
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => {
              const v = e.target.value;
              contentRef.current = v;
              setContent(v);
              scheduleSave();
            }}
            placeholder="在这里写下你的想法..."
            className="w-full resize-none border-none bg-transparent text-[15px] leading-relaxed text-slate-700 outline-none"
            style={{ minHeight: "calc(100vh - 280px)" }}
          />
        )}
      </main>

      {/* 底部 Markdown 工具栏 —— 预览模式下隐藏（无可编辑内容，避免误触） */}
      {!previewMode && (
        <footer
          className="border-t border-slate-200 bg-white"
          style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
        >
          <div className="flex items-center gap-1 overflow-x-auto px-2 py-2 scrollbar-none">
            <ToolButton onClick={() => insertAtCursor("**", "**")}>
              <Bold size={20} className="text-slate-600" />
            </ToolButton>
            <ToolButton onClick={() => insertAtCursor("*", "*")}>
              <Italic size={20} className="text-slate-600" />
            </ToolButton>
            <ToolButton onClick={() => insertLineStart("# ")}>
              <Heading1 size={20} className="text-slate-600" />
            </ToolButton>
            <ToolButton onClick={() => insertLineStart("- ")}>
              <List size={20} className="text-slate-600" />
            </ToolButton>
            <ToolButton onClick={() => insertLineStart("- [ ] ")}>
              <CheckSquare size={20} className="text-slate-600" />
            </ToolButton>
            <ToolButton onClick={() => insertAtCursor("[[", "]]")}>
              <LinkIcon size={20} className="text-slate-600" />
            </ToolButton>
            <ToolButton onClick={() => insertAtCursor("![](", ")")}>
              <ImageIcon size={20} className="text-slate-600" />
            </ToolButton>
            {/* AI：新建对话并把本笔记挂上去，进去就能"问关于这篇笔记的事" */}
            <button
              onClick={() => void askAiAboutNote()}
              disabled={askingAi}
              aria-label="针对本笔记问 AI"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-orange-50 active:bg-orange-100 disabled:opacity-50"
            >
              <Sparkles size={20} className="text-[#FA8C16]" />
            </button>
          </div>
        </footer>
      )}
    </div>
  );
}

function ToolButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      // mousedown / touchstart 阶段阻止默认 — 否则点击工具按钮会让 textarea 失焦，
      // selectionStart 重置为 0，所有插入都跑到文档开头，看起来像"按钮没生效"。
      onMouseDown={(e) => e.preventDefault()}
      onTouchStart={(e) => e.preventDefault()}
      onClick={onClick}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg active:bg-slate-100"
    >
      {children}
    </button>
  );
}

function SaveBadge({ status }: { status: SaveStatus }) {
  if (status === "saving") {
    return (
      <span className="mt-0.5 text-[10px] text-orange-600">保存中…</span>
    );
  }
  if (status === "saved") {
    return (
      <span className="mt-0.5 text-[10px] text-green-600">已保存 · 刚刚</span>
    );
  }
  // idle / dirty 都不显示，留出 14px 占位避免标题跳动
  return <span className="mt-0.5 h-3.5 text-[10px]" aria-hidden />;
}
