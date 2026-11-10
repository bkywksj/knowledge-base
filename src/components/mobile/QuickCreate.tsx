import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Input, Modal, message } from "antd";
import {
  ChevronRight,
  ClipboardPaste,
  FileInput,
  FilePlus2,
  Folder as FolderIcon,
  Globe,
  Layers,
  LayoutTemplate,
  Zap,
} from "lucide-react";
import { dailyApi, folderApi, noteApi, templateApi } from "@/lib/api";
import { appendQuickNoteToDaily } from "@/lib/mobileQuickNote";
import { quickTextToNote } from "@/lib/quickNote";
import { todayYmd } from "@/lib/utils";
import { useAppStore } from "@/store";
import type { Folder, NoteTemplate } from "@/types";
import { KingKongIcon } from "./KingKongIcons";
import { FolderPickerSheet } from "./FolderPickerSheet";
import { MGroup } from "./primitives";

/**
 * 手机端「新建」（v4 原型第 13 屏）。两种用法共用这一份：
 * - FAB 点开的底部面板（QuickCreateSheet）—— 不跳页面，在当前页上弹出
 * - /quick-create 整页（QuickCreatePanel）—— 「我的 → 导入笔记」等深链还会进来
 *
 * 入口与功能底稿对照：空白笔记 / 今日日记 / 剪藏网页 / 导入文件 / 新建待办 / 闪念捕获 保留；
 * 「从模板」原来只提示待开发 → 接上模板接口；「新闪卡」改为按复习模块开关显示；
 * 「语音笔记」「拍照扫描」手机端还没有对应能力（语音识别、云端识字 T-M025 未做），先不放入口；
 * 新增「记一笔」（追加到今天日记，同首页）与「剪贴板内容建笔记」（同 PC 托盘）。
 */

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

interface PanelProps {
  /** 新笔记默认建在哪个文件夹（null = 未分类），用户可在面板里改 */
  defaultFolderId?: number | null;
  /** 动作完成、要跳走前调用（面板形态用来关闭自己） */
  onDone?: () => void;
  /** 整页形态跳编辑器用 replace，避免返回时又回到新建页 */
  replaceOnNavigate?: boolean;
}

export function QuickCreatePanel({ defaultFolderId = null, onDone, replaceOnNavigate = false }: PanelProps) {
  const navigate = useNavigate();
  const cardsEnabled = useAppStore((s) => s.enabledViews.has("cards"));
  const [folderId, setFolderId] = useState<number | null>(defaultFolderId);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [pickFolder, setPickFolder] = useState(false);
  const [templates, setTemplates] = useState<NoteTemplate[] | null>(null);
  const [clipOpen, setClipOpen] = useState(false);
  const [clipUrl, setClipUrl] = useState("");
  const [clipping, setClipping] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    folderApi.list().then(setFolders).catch(() => {});
  }, []);

  const folderLabel = folderId != null ? (findPath(folders, folderId) ?? []).map((f) => f.name).join(" / ") || "文件夹" : "未分类";

  function go(path: string) {
    onDone?.();
    navigate(path, { replace: replaceOnNavigate });
  }
  function openNote(id: number) {
    useAppStore.getState().bumpNotesRefresh();
    go(`/notes/${id}`);
  }

  async function createBlank() {
    try {
      const note = await noteApi.create({ title: "无标题笔记", content: "", folder_id: folderId });
      openNote(note.id);
    } catch (e) {
      message.error(`创建失败: ${e}`);
    }
  }

  async function openTodayDaily() {
    try {
      const note = await dailyApi.getOrCreate(todayYmd());
      openNote(note.id);
    } catch (e) {
      message.error(`打开失败: ${e}`);
    }
  }

  async function saveQuickNote() {
    if (!noteText.trim() || noteSaving) return;
    setNoteSaving(true);
    try {
      await appendQuickNoteToDaily(noteText);
      message.success("已记到今天的日记");
      useAppStore.getState().bumpNotesRefresh();
      setNoteText("");
      setNoteOpen(false);
      onDone?.();
    } catch (e) {
      message.error(`保存失败: ${e}`);
    } finally {
      setNoteSaving(false);
    }
  }

  async function fromClipboard() {
    let text = "";
    try {
      text = (await navigator.clipboard?.readText()) ?? "";
    } catch {
      // 用户拒绝剪贴板授权
    }
    if (!text.trim()) {
      message.info("剪贴板里没有文字");
      return;
    }
    try {
      // 第一行当标题，其余为正文（与 PC 随手记「存为新笔记」同规则）
      const { title, content } = quickTextToNote(text);
      const note = await noteApi.create({ title, content, folder_id: folderId });
      message.success("已从剪贴板新建笔记");
      openNote(note.id);
    } catch (e) {
      message.error(`创建失败: ${e}`);
    }
  }

  async function openTemplates() {
    try {
      const list = await templateApi.list();
      if (list.length === 0) {
        message.info("还没有模板，可以在桌面端「设置 → 模板」里添加");
        return;
      }
      setTemplates(list);
    } catch (e) {
      message.error(`读取模板失败: ${e}`);
    }
  }

  async function fromTemplate(t: NoteTemplate) {
    try {
      const note = await templateApi.createNoteFromTemplate(t.id, undefined, folderId);
      setTemplates(null);
      openNote(note.id);
    } catch (e) {
      message.error(`创建失败: ${e}`);
    }
  }

  function openClip() {
    setClipUrl("");
    setClipOpen(true);
    // 剪贴板里是网址就预填（用户拒绝授权就留空手动粘）
    void navigator.clipboard
      ?.readText()
      .then((t) => {
        if (t && /^https?:\/\//i.test(t.trim())) setClipUrl(t.trim());
      })
      .catch(() => {});
  }

  async function submitClip() {
    const url = clipUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      message.error("网址必须以 http(s):// 开头");
      return;
    }
    setClipping(true);
    try {
      const note = await noteApi.clipUrl(url);
      message.success("已剪藏");
      setClipOpen(false);
      openNote(note.id);
    } catch (e) {
      message.error(`剪藏失败: ${e}`);
    } finally {
      setClipping(false);
    }
  }

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const title = file.name.replace(/\.(md|markdown|txt)$/i, "");
      const note = await noteApi.create({ title: title || "导入的笔记", content: text, folder_id: folderId });
      message.success(`已导入：${title}`);
      openNote(note.id);
    } catch (err) {
      message.error(`导入失败: ${err}`);
    } finally {
      e.target.value = ""; // 允许再次选同一个文件
    }
  }

  const rows: { key: string; icon: React.ReactNode; label: string; extra?: string; onClick: () => void }[] = [
    { key: "tpl", icon: <LayoutTemplate size={18} />, label: "从模板新建", onClick: () => void openTemplates() },
    { key: "clip-text", icon: <ClipboardPaste size={18} />, label: "剪贴板内容建笔记", onClick: () => void fromClipboard() },
    { key: "web", icon: <Globe size={18} />, label: "剪藏网页", onClick: openClip },
    { key: "import", icon: <FileInput size={18} />, label: "导入文件", extra: "md / txt", onClick: () => fileInputRef.current?.click() },
    { key: "capture", icon: <Zap size={18} />, label: "闪念捕获", onClick: () => go("/quick-capture") },
    ...(cardsEnabled ? [{ key: "card", icon: <Layers size={18} />, label: "新闪卡", onClick: () => go("/cards") }] : []),
  ];

  return (
    <>
      <div className="m-px flex items-baseline pt-1">
        <span className="m-t-sec">新建</span>
        <button type="button" className="m-tapx m-t-cap ml-auto flex min-w-0 items-center gap-1" onClick={() => setPickFolder(true)}>
          <FolderIcon size={14} className="shrink-0" />
          <span className="truncate">建在：{folderLabel}</span>
          <span className="shrink-0 font-bold" style={{ color: "var(--m-accent-ink)" }}>更改</span>
        </button>
      </div>

      <div className="m-px mt-4">
        <button
          type="button"
          onClick={() => void createBlank()}
          className="flex w-full items-center gap-3.5 rounded-[var(--m-r-xl)] p-4 text-left active:opacity-85"
          style={{ background: "var(--m-btn)", color: "var(--m-on-accent)" }}
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--m-r-l)]" style={{ background: "rgba(255,255,255,.18)" }}>
            <FilePlus2 size={22} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[16px] font-bold">空白笔记</span>
            <span className="block truncate text-[13px] opacity-85">建在「{folderLabel}」</span>
          </span>
          <ChevronRight size={18} className="opacity-80" />
        </button>
      </div>

      <div className="mx-4 mt-2.5">
        <MGroup className="grid grid-cols-3 py-1">
          <button type="button" className="m-kk py-3.5" onClick={() => setNoteOpen(true)}>
            <KingKongIcon kind="note" />
            记一笔
          </button>
          <button type="button" className="m-kk py-3.5" onClick={() => go("/tasks?new=1")}>
            <KingKongIcon kind="todo" />
            待办
          </button>
          <button type="button" className="m-kk py-3.5" onClick={() => void openTodayDaily()}>
            <KingKongIcon kind="daily" />
            今日日记
          </button>
        </MGroup>
      </div>

      <div className="m-px mt-3">
        <MGroup>
          {rows.map((r) => (
            <button key={r.key} type="button" className="m-row m-row-icon" onClick={r.onClick}>
              <span className="flex w-6 shrink-0 justify-center" style={{ color: "var(--m-ink2)" }}>
                {r.icon}
              </span>
              <span className="min-w-0 flex-1 truncate text-[15px]">{r.label}</span>
              {r.extra && <span className="m-t-meta">{r.extra}</span>}
            </button>
          ))}
        </MGroup>
      </div>

      <input ref={fileInputRef} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden onChange={onFilePicked} />

      <FolderPickerSheet
        open={pickFolder}
        title="新笔记建在…"
        folders={folders}
        currentId={folderId}
        rootLabel="未分类"
        onPick={setFolderId}
        onClose={() => setPickFolder(false)}
      />

      {/* 模板列表 */}
      {templates && (
        <div className="m-sheet-mask" role="dialog" aria-modal="true">
          <div className="m-sheet-backdrop" onClick={() => setTemplates(null)} />
          <div className="m-sheet">
            <div className="m-sheet-grabber" />
            <div className="m-px m-t-sec pt-1 pb-3">从模板新建</div>
            <div className="m-px">
              <MGroup>
                {templates.map((t) => (
                  <button key={t.id} type="button" className="m-row block py-3 text-left" onClick={() => void fromTemplate(t)}>
                    <span className="m-t-title block truncate">{t.name}</span>
                    {t.description && <span className="m-t-meta block truncate">{t.description}</span>}
                  </button>
                ))}
              </MGroup>
              <MGroup className="mt-3">
                <button type="button" className="m-row justify-center text-[15px] font-semibold" style={{ color: "var(--m-ink2)" }} onClick={() => setTemplates(null)}>
                  取消
                </button>
              </MGroup>
            </div>
          </div>
        </div>
      )}

      {/* 记一笔：追加到今天的日记 */}
      <Modal
        open={noteOpen}
        title="记一笔"
        okText="记下"
        cancelText="取消"
        onOk={saveQuickNote}
        onCancel={() => setNoteOpen(false)}
        okButtonProps={{ disabled: !noteText.trim(), loading: noteSaving }}
        destroyOnHidden
        centered
      >
        <Input.TextArea
          autoFocus
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          autoSize={{ minRows: 3, maxRows: 8 }}
          placeholder="追加到今天的日记，自动加时间"
          style={{ fontSize: 16 }}
        />
      </Modal>

      {/* 剪藏网页 */}
      <Modal
        open={clipOpen}
        title="剪藏网页"
        okText={clipping ? "抓取中…" : "剪藏"}
        cancelText="取消"
        onOk={submitClip}
        onCancel={() => setClipOpen(false)}
        okButtonProps={{ disabled: !clipUrl.trim(), loading: clipping }}
        destroyOnHidden
        centered
      >
        <Input
          autoFocus
          value={clipUrl}
          onChange={(e) => setClipUrl(e.target.value)}
          onPressEnter={submitClip}
          placeholder="https://"
          style={{ fontSize: 16 }}
        />
        <div className="m-t-cap mt-2">抓取正文存成一篇笔记，图片会下载到本地。</div>
      </Modal>
    </>
  );
}

/** FAB 点开的底部面板 */
export function QuickCreateSheet({ open, onClose, defaultFolderId }: { open: boolean; onClose: () => void; defaultFolderId?: number | null }) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="m-sheet-mask" role="dialog" aria-modal="true" aria-label="新建">
      <div className="m-sheet-backdrop" onClick={onClose} />
      <div className="m-sheet">
        <div className="m-sheet-grabber" />
        <QuickCreatePanel defaultFolderId={defaultFolderId} onDone={onClose} />
      </div>
    </div>
  );
}
