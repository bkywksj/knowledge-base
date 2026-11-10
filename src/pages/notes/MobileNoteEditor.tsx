import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Bold,
  ChevronLeft,
  CodeXml,
  Copy,
  Ellipsis,
  EyeOff,
  Folder as FolderIcon,
  FolderInput,
  Heading,
  Highlighter,
  Image as ImageIcon,
  Italic,
  KeyboardOff,
  Link,
  List,
  ListChecks,
  Lock,
  Pin,
  Redo2,
  Sparkles,
  Trash2,
  Undo2,
} from "lucide-react";
import { message } from "antd";
import { aiChatApi, folderApi, imageApi, linkApi, noteApi, tagApi, trashApi } from "@/lib/api";
import { useAppStore } from "@/store";
import type { Folder, Note, Tag } from "@/types";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";
import { resolveNoteTitle } from "@/lib/noteTitle";
import { fileToBase64 } from "@/lib/quickNote";
import { toKbAsset } from "@/lib/assetUrl";
import { TiptapEditor } from "@/components/editor/TiptapEditor";
import { ActionSheet, type ActionSheetItem } from "@/components/mobile/ActionSheet";
import { FolderPickerSheet } from "@/components/mobile/FolderPickerSheet";
import { LinkBadge } from "@/components/mobile/primitives";

/**
 * 移动端笔记编辑页（v4 原型第 04 / 06 屏；功能底稿 docs/tasks/mobile-v4-feature-inventory.md）
 *
 * 路由：/notes/:id —— isMobile=true 时由 wrapper 加载；fixed 全屏盖住底部 Tab。
 *
 * 正文改用与 PC 同一套富文本编辑器 TiptapEditor（原来是纯文本框编辑 Markdown 源码）：
 * - 存储格式不变：TiptapEditor 读写的同样是 Markdown，两端互相打开不会变样
 * - PC 的整排工具栏在手机上放不下 → hideToolbar，改用贴在键盘上方的格式条（拿 editor 实例直接下命令）
 * - 「…」里保留「源码模式」开关 = 原来的文本框：富文本在个别输入法下出问题时，用户仍能继续写
 * - 加密笔记手机端解不了密，拿到的是占位内容 → 只读，防止把占位内容存回去
 *
 * 自动保存：停止输入 1.2s 后保存；返回按钮立即落盘；离开页面（手势返回等）兜底保存。
 */

const AUTOSAVE_DELAY_MS = 1200;
/** 保存成功后「已保存」提示的可见时长 */
const SAVED_TOAST_MS = 2500;

/**
 * 顶栏状态机：
 * - idle:   不显示指示器
 * - dirty:  刚输入、还在 debounce —— 也不显示，避免噪音
 * - saving: 正在写后端 —— 「保存中…」
 * - saved:  刚刚保存成功 —— 「已保存」，SAVED_TOAST_MS 后自动归 idle
 */
type SaveStatus = "idle" | "dirty" | "saving" | "saved";

const SOURCE_MODE_KEY = "kb-mobile-source-mode";

function findPath(list: Folder[], id: number, trail: Folder[] = []): Folder[] | null {
  for (const f of list) {
    const next = [...trail, f];
    if (f.id === id) return next;
    if (f.children?.length) {
      const hit = findPath(f.children, id, next);
      if (hit) return hit;
    }
  }
  return null;
}

export function MobileNoteEditor() {
  const navigate = useNavigate();
  const { id: idParam } = useParams<{ id: string }>();
  const noteId = Number(idParam);
  // 从搜索结果进来会带 ?q=：交给编辑器自动展开查找条并定位到第一处命中（同 PC）
  const [searchParams] = useSearchParams();
  const initialSearch = (searchParams.get("q") ?? "").trim() || undefined;
  const keyboardInset = useKeyboardInset(); // 键盘弹出时整列顶到键盘上方

  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  /** 交给编辑器的初始内容：只在加载、切换源码模式时更新；打字时不回灌，免得光标跳动 */
  const [editorSeed, setEditorSeed] = useState("");
  const [seedKey, setSeedKey] = useState(0);
  const [sourceText, setSourceText] = useState("");
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [readingMode, setReadingMode] = useState(false);
  const [sourceMode, setSourceMode] = useState(() => localStorage.getItem(SOURCE_MODE_KEY) === "1");
  const [askingAi, setAskingAi] = useState(false);
  const [words, setWords] = useState(0);
  const [backlinks, setBacklinks] = useState(0);
  const [tags, setTags] = useState<Tag[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [editor, setEditor] = useState<any | null>(null);
  const [, forceRender] = useState(0);

  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const savedHideTimerRef = useRef<number | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  /** title / content 的 ref 镜像：doSave 直接读最新值，避开 setState 还没生效的闭包陷阱 */
  const titleRef = useRef("");
  const contentRef = useRef("");
  const noteRef = useRef<Note | null>(null);

  const readOnly = !!note?.is_encrypted;

  const load = useCallback(async () => {
    if (!noteId || Number.isNaN(noteId)) return;
    try {
      const n = await noteApi.get(noteId);
      setNote(n);
      noteRef.current = n;
      setTitle(n.title);
      setEditorSeed(n.content || "");
      setSeedKey((k) => k + 1);
      setSourceText(n.content || "");
      titleRef.current = n.title;
      contentRef.current = n.content || "";
      dirtyRef.current = false;
      setStatus("idle");
      setWords(n.word_count);
      if (n.is_encrypted) setReadingMode(true);
    } catch (e) {
      message.error(`加载笔记失败: ${e}`);
    }
    // 链入数 / 标签 / 文件夹树：附属信息，失败不影响编辑
    linkApi.getBacklinks(noteId).then((l) => setBacklinks(l.length)).catch(() => {});
    tagApi.getNoteTags(noteId).then(setTags).catch(() => {});
    folderApi.list().then(setFolders).catch(() => {});
  }, [noteId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 格式条要显示「当前是否加粗 / 列表」等高亮：编辑器每次事务后重绘一次
  useEffect(() => {
    if (!editor) return;
    const onTx = () => forceRender((n) => n + 1);
    editor.on("transaction", onTx);
    return () => editor.off("transaction", onTx);
  }, [editor]);

  const doSave = useCallback(async () => {
    const n = noteRef.current;
    if (!n || !dirtyRef.current || n.is_encrypted) return;
    setStatus("saving");
    try {
      await noteApi.update(n.id, {
        // 标题空时按正文首行 / 时间兜底，与桌面端一致，避免库里存成空标题
        title: resolveNoteTitle(titleRef.current, contentRef.current),
        content: contentRef.current,
        folder_id: n.folder_id,
      });
      dirtyRef.current = false;
      setStatus("saved");
      if (savedHideTimerRef.current) window.clearTimeout(savedHideTimerRef.current);
      savedHideTimerRef.current = window.setTimeout(() => {
        // 期间又改了就保留 dirty / saving
        setStatus((s) => (s === "saved" ? "idle" : s));
      }, SAVED_TOAST_MS);
    } catch (e) {
      message.error(`保存失败: ${e}`);
      setStatus("idle");
    }
  }, []);

  function scheduleSave() {
    dirtyRef.current = true;
    setStatus("dirty");
    if (savedHideTimerRef.current) {
      window.clearTimeout(savedHideTimerRef.current);
      savedHideTimerRef.current = null;
    }
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => void doSave(), AUTOSAVE_DELAY_MS);
  }

  /** 立即落盘（返回、跳走、问 AI 前都要先调） */
  async function flush() {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (dirtyRef.current) await doSave();
  }

  /** 返回：用户回到列表前必须落盘，否则列表还是旧数据 */
  async function flushAndExit() {
    if (savedHideTimerRef.current) {
      window.clearTimeout(savedHideTimerRef.current);
      savedHideTimerRef.current = null;
    }
    await flush();
    useAppStore.getState().bumpNotesRefresh();
    navigate(-1);
  }

  // 离开页面（手势返回等非按钮路径）兜底保存
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      if (savedHideTimerRef.current) window.clearTimeout(savedHideTimerRef.current);
      if (dirtyRef.current) {
        void doSave().then(() => useAppStore.getState().bumpNotesRefresh());
      } else {
        useAppStore.getState().bumpNotesRefresh();
      }
    };
  }, [doSave]);

  async function togglePin() {
    const n = noteRef.current;
    if (!n) return;
    try {
      const next = await noteApi.togglePin(n.id);
      const updated = { ...n, is_pinned: next };
      setNote(updated);
      noteRef.current = updated;
      message.success(next ? "已置顶" : "已取消置顶");
    } catch (e) {
      message.error(`切换置顶失败: ${e}`);
    }
  }

  async function toggleHidden() {
    const n = noteRef.current;
    if (!n) return;
    try {
      await noteApi.setHidden(n.id, !n.is_hidden);
      const updated = { ...n, is_hidden: !n.is_hidden };
      setNote(updated);
      noteRef.current = updated;
      message.success(updated.is_hidden ? "已隐藏，可在「隐藏笔记」里找到" : "已取消隐藏");
    } catch (e) {
      message.error(`操作失败: ${e}`);
    }
  }

  async function moveTo(folderId: number | null) {
    const n = noteRef.current;
    if (!n) return;
    try {
      await flush();
      await noteApi.moveToFolder(n.id, folderId);
      const updated = { ...n, folder_id: folderId };
      setNote(updated);
      noteRef.current = updated;
      message.success("已移动");
    } catch (e) {
      message.error(`移动失败: ${e}`);
    }
  }

  async function deleteNote() {
    const n = noteRef.current;
    if (!n) return;
    try {
      // 删之前先把当前编辑落盘，回收站里还原出来是最新内容
      await flush();
      await trashApi.softDelete(n.id);
      dirtyRef.current = false;
      message.success("已移到回收站");
      useAppStore.getState().bumpNotesRefresh();
      navigate(-1);
    } catch (e) {
      message.error(String(e));
    }
  }

  function copyText(text: string, ok: string) {
    navigator.clipboard
      .writeText(text)
      .then(() => message.success(ok))
      .catch(() => message.error("复制失败"));
  }

  /** 切源码模式：两边的内容互相交接，确保切换前后正文一致 */
  function setSource(on: boolean) {
    if (on === sourceMode) return;
    if (on) {
      setSourceText(contentRef.current);
    } else {
      setEditorSeed(contentRef.current);
      setSeedKey((k) => k + 1);
    }
    setSourceMode(on);
    localStorage.setItem(SOURCE_MODE_KEY, on ? "1" : "0");
  }

  /**
   * 「针对本笔记问 AI」：先落盘，再新建 AI 对话并挂上本笔记，跳到聊天页。
   * 后端每次 sendMessage 会按 attached_note_ids 拉笔记拼进上下文。
   */
  async function askAiAboutNote() {
    const n = noteRef.current;
    if (!n || askingAi) return;
    setAskingAi(true);
    try {
      await flush();
      const convTitle = (titleRef.current || "未命名笔记").slice(0, 30);
      const conv = await aiChatApi.createConversation(`关于：${convTitle}`);
      await aiChatApi.setAttachedNotes(conv.id, [n.id]);
      useAppStore.getState().bumpNotesRefresh();
      navigate(`/ai-chat/${conv.id}`);
    } catch (e) {
      message.error(`创建 AI 对话失败: ${e}`);
      setAskingAi(false);
    }
  }

  /** 正文里的双链：有 id 直接跳；没有 id 按标题搜索（与 PC 的兜底同向） */
  async function openWikiLink(linkTitle: string, id?: number) {
    await flush();
    if (id) navigate(`/notes/${id}`);
    else navigate(`/search?q=${encodeURIComponent(linkTitle)}`);
  }

  /**
   * 插图片：安卓的系统文件对话框返回 content:// 地址，按路径保存会失败，
   * 所以用 <input type=file> 读出内容，走 imageApi.save（PC 粘贴图片也是这条路）
   */
  async function insertImages(files: FileList | null) {
    const n = noteRef.current;
    if (!files || !n || !editor) return;
    for (const file of Array.from(files)) {
      try {
        const base64 = await fileToBase64(file);
        const rel = await imageApi.save(n.id, file.name, base64);
        editor.chain().focus().insertContent({ type: "imageResize", attrs: { src: toKbAsset(rel) } }).run();
      } catch (e) {
        message.error(`图片插入失败: ${e}`);
      }
    }
    if (imageInputRef.current) imageInputRef.current.value = "";
  }

  if (Number.isNaN(noteId)) {
    return <div className="m-t-meta p-4 text-center">笔记 ID 无效</div>;
  }

  const folderPath = note?.folder_id != null ? findPath(folders, note.folder_id) : null;
  const folderLabel = note?.is_daily ? "日记" : folderPath ? folderPath.map((f) => f.name).join(" / ") : "未分类";
  const showFormatBar = !readingMode && !readOnly && !sourceMode && !!editor;

  const moreItems: ActionSheetItem[] = [
    {
      key: "source",
      label: "源码模式",
      icon: <CodeXml size={20} />,
      extra: sourceMode ? "已开启" : "关闭",
      onClick: () => (readOnly ? message.info("加密笔记手机端只读") : setSource(!sourceMode)),
    },
    { key: "move", label: "移动到…", icon: <FolderInput size={20} />, onClick: () => setMoveOpen(true) },
    { key: "wiki", label: "复制 wiki 链接", icon: <Link size={20} />, onClick: () => copyText(`[[${titleRef.current}]]`, "已复制 wiki 链接") },
    { key: "copy-id", label: "复制笔记 ID", icon: <Copy size={20} />, onClick: () => copyText(String(noteId), `已复制 ID：${noteId}`) },
    { key: "delete", label: "删除笔记", icon: <Trash2 size={20} />, danger: true, onClick: () => void deleteNote() },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: "var(--m-surface)", paddingTop: "env(safe-area-inset-top, 0px)", paddingBottom: keyboardInset }}
    >
      {/* 顶栏：返回 · 保存状态 · 编辑/阅读 · 问 AI · 更多 */}
      <header className="flex h-12 shrink-0 items-center pl-1 pr-1.5">
        <button type="button" onClick={() => void flushAndExit()} aria-label="返回" className="m-icon-btn">
          <ChevronLeft size={24} />
        </button>
        <SaveBadge status={status} />
        <div className="flex-1" />
        {!readOnly && (
          <div className="flex rounded-[var(--m-r-l)] p-0.5" style={{ background: "var(--m-well)" }} role="tablist" aria-label="编辑或阅读">
            {[
              { key: false, label: "编辑" },
              { key: true, label: "阅读" },
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                role="tab"
                aria-selected={readingMode === o.key}
                onClick={() => setReadingMode(o.key)}
                className="m-tapx h-[30px] rounded-[var(--m-r-m)] px-3 text-[13px]"
                style={readingMode === o.key ? { background: "var(--m-surface)", color: "var(--m-ink)", fontWeight: 700 } : { color: "var(--m-ink3)" }}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}
        <button type="button" aria-label="针对本笔记问 AI" disabled={askingAi} onClick={() => void askAiAboutNote()} className="m-icon-btn" style={{ color: "var(--m-accent-ink)" }}>
          <Sparkles size={20} />
        </button>
        <button type="button" aria-label="更多" onClick={() => setMoreOpen(true)} className="m-icon-btn">
          <Ellipsis size={20} />
        </button>
      </header>

      <main className="m-px flex-1 overflow-y-auto pb-16">
        <input
          value={title}
          readOnly={readOnly || readingMode}
          onChange={(e) => {
            titleRef.current = e.target.value;
            setTitle(e.target.value);
            scheduleSave();
          }}
          placeholder="无标题笔记"
          className="w-full bg-transparent pt-3 text-[26px] font-bold leading-snug outline-none placeholder:text-[var(--m-ink4)]"
          style={{ color: "var(--m-ink)", letterSpacing: "-0.01em" }}
        />

        {/* 文件夹（点击移动）· 标签 · 链入 */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="m-tapx inline-flex h-[22px] max-w-[60%] items-center gap-1 rounded-[var(--m-r-s)] px-2 text-[12px]"
            style={{ background: "var(--m-well)", color: "var(--m-ink2)" }}
            onClick={() => setMoveOpen(true)}
            disabled={note?.is_daily}
          >
            <FolderIcon size={13} className="shrink-0" />
            <span className="truncate">{folderLabel}</span>
          </button>
          {/* 标签色是用户自定义的，直接当文字色在暗色主题下可能看不清 → 色点 + 中性字 */}
          {tags.map((t) => (
            <span key={t.id} className="m-tag" style={{ background: "var(--m-well)", color: "var(--m-ink2)" }}>
              <span className="m-dot" style={{ width: 6, height: 6, background: t.color || "var(--m-ink4)" }} />
              {t.name}
            </span>
          ))}
          {note?.is_pinned && (
            <span className="m-tag" style={{ background: "var(--m-accent-soft2)", color: "var(--m-accent-ink)" }}>
              <Pin size={12} /> 置顶
            </span>
          )}
          {note?.is_hidden && (
            <span className="m-tag" style={{ background: "var(--m-bad-soft)", color: "var(--m-bad)" }}>
              已隐藏
            </span>
          )}
          {backlinks > 0 && <span className="ml-auto"><LinkBadge>链入 {backlinks}</LinkBadge></span>}
        </div>
        <div className="m-t-cap m-num mt-2">
          {note ? `更新于 ${new Date(note.updated_at).toLocaleDateString("zh-CN")}` : "—"} · {words.toLocaleString()} 字
        </div>

        {readOnly && (
          <div className="mt-4 flex items-start gap-2 rounded-[var(--m-r-l)] p-3 text-[14px] leading-[1.6]" style={{ background: "var(--m-warn-soft)", color: "var(--m-warn)" }}>
            <Lock size={16} className="mt-0.5 shrink-0" />
            这篇笔记已加密，手机端暂不能解密编辑，请在桌面端打开。
          </div>
        )}

        <div className="m-editor-body mt-5">
          {sourceMode && !readOnly ? (
            <textarea
              value={sourceText}
              readOnly={readingMode}
              onChange={(e) => {
                contentRef.current = e.target.value;
                setSourceText(e.target.value);
                setWords(e.target.value.replace(/\s/g, "").length);
                scheduleSave();
              }}
              placeholder="在这里写下你的想法…（Markdown 源码）"
              className="w-full resize-none bg-transparent font-mono text-[15px] leading-[1.75] outline-none"
              style={{ color: "var(--m-ink)", minHeight: "55vh" }}
            />
          ) : note ? (
            <TiptapEditor
              key={seedKey}
              content={editorSeed}
              onChange={(md) => {
                if (readOnly) return;
                contentRef.current = md;
                scheduleSave();
              }}
              placeholder="在这里写下你的想法…"
              noteId={note.id}
              readingMode={readingMode || readOnly}
              hideToolbar
              showFooterStats={false}
              onStats={(s) => setWords(s.words)}
              onEditorReady={setEditor}
              initialSearch={initialSearch}
              onWikiLinkClick={(t, id) => void openWikiLink(t, id)}
            />
          ) : null}
        </div>
      </main>

      {/* 键盘上方的格式条：常用项钉住、可横滑（阅读 / 源码 / 只读时不显示） */}
      {showFormatBar && (
        <div
          className="m-hscroll flex h-12 shrink-0 items-center px-1"
          style={{ background: "var(--m-page)", borderTop: "0.5px solid var(--m-hair)", paddingBottom: keyboardInset ? 0 : "env(safe-area-inset-bottom, 0px)" }}
        >
          {/* 标题按钮依次轮换：一级 → 二级 → 三级 → 正文（旧版这个按钮插的是一级标题，保留） */}
          <FmtBtn
            label={editor.isActive("heading", { level: 1 }) ? "二级标题" : editor.isActive("heading", { level: 2 }) ? "三级标题" : editor.isActive("heading", { level: 3 }) ? "正文" : "一级标题"}
            active={editor.isActive("heading")}
            onClick={() => {
              const c = editor.chain().focus();
              if (editor.isActive("heading", { level: 1 })) c.setHeading({ level: 2 }).run();
              else if (editor.isActive("heading", { level: 2 })) c.setHeading({ level: 3 }).run();
              else if (editor.isActive("heading", { level: 3 })) c.setParagraph().run();
              else c.setHeading({ level: 1 }).run();
            }}
          >
            <Heading size={20} />
          </FmtBtn>
          <FmtBtn label="加粗" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}>
            <Bold size={20} />
          </FmtBtn>
          <FmtBtn label="斜体" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}>
            <Italic size={20} />
          </FmtBtn>
          <FmtBtn label="无序列表" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}>
            <List size={20} />
          </FmtBtn>
          <FmtBtn label="任务列表" active={editor.isActive("taskList")} onClick={() => editor.chain().focus().toggleTaskList().run()}>
            <ListChecks size={20} />
          </FmtBtn>
          <FmtBtn label="高亮" active={editor.isActive("highlight")} onClick={() => editor.chain().focus().toggleHighlight().run()}>
            <Highlighter size={20} />
          </FmtBtn>
          <FmtBtn label="插入图片" onClick={() => imageInputRef.current?.click()}>
            <ImageIcon size={20} />
          </FmtBtn>
          {/* 输入 [[ 触发双链候选，和 PC 一样 */}
          <FmtBtn label="双链" onClick={() => editor.chain().focus().insertContent("[[").run()}>
            <Link size={20} />
          </FmtBtn>
          <FmtBtn label="撤销" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}>
            <Undo2 size={20} />
          </FmtBtn>
          <FmtBtn label="重做" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}>
            <Redo2 size={20} />
          </FmtBtn>
          <FmtBtn label="收起键盘" onClick={() => editor.commands.blur()}>
            <KeyboardOff size={20} />
          </FmtBtn>
        </div>
      )}
      <input ref={imageInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => void insertImages(e.target.files)} />

      <ActionSheet
        open={moreOpen}
        title={title || "未命名笔记"}
        subtitle={`${words.toLocaleString()} 字${backlinks > 0 ? ` · 链入 ${backlinks}` : ""}`}
        grid={[
          { key: "pin", label: note?.is_pinned ? "已置顶" : "置顶", icon: <Pin size={22} />, active: !!note?.is_pinned, onClick: () => void togglePin() },
          { key: "hide", label: note?.is_hidden ? "已隐藏" : "隐藏", icon: <EyeOff size={22} />, active: !!note?.is_hidden, onClick: () => void toggleHidden() },
        ]}
        items={moreItems}
        onClose={() => setMoreOpen(false)}
      />

      <FolderPickerSheet
        open={moveOpen}
        title="移动到…"
        folders={folders}
        currentId={note?.folder_id ?? null}
        rootLabel="未分类"
        onPick={(id) => void moveTo(id)}
        onClose={() => setMoveOpen(false)}
      />
    </div>
  );
}

/** 格式条按钮：pointerdown 阻止默认 —— 否则点按钮会让编辑器失焦、键盘收起、选区丢失 */
function FmtBtn({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onPointerDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="m-icon-btn disabled:opacity-35"
      style={active ? { background: "var(--m-accent-soft2)", color: "var(--m-accent-ink)" } : undefined}
    >
      {children}
    </button>
  );
}

function SaveBadge({ status }: { status: SaveStatus }) {
  if (status === "saving") return <span className="m-t-cap">保存中…</span>;
  if (status === "saved")
    return (
      <span className="m-t-cap flex items-center gap-1.5">
        <span className="m-dot" style={{ width: 6, height: 6, background: "var(--m-ok)" }} />
        已保存
      </span>
    );
  return null;
}
