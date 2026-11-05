import { useEffect, useState, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  X,
  Zap,
  Image as ImageIcon,
  Camera,
  Mic,
  Sparkles,
  Hash,
  FolderOpen,
  Check,
} from "lucide-react";
import { message } from "antd";
import { configApi, dailyApi, noteApi } from "@/lib/api";
import { useAppStore } from "@/store";

/**
 * 移动端「闪念捕获」页（设计稿：15-quick-capture.html）
 *
 * 路由 /quick-capture —— 移动端专用，进入后整个屏幕橙色渐变沉浸式输入。
 *
 * 特点：
 * - 全屏覆盖（fixed inset-0 z-50），不显示底栏 / FAB
 * - 自动保存草稿到 app_config（key=quick_capture_draft），下次进入还原
 * - 保存：把草稿追加到今日笔记（getOrCreate） + 清空草稿 → 跳到主页
 *
 * 工具栏占位（暂未实装，弹 toast）：
 * - 图片 / 相机 / 麦克风（ASR）/ AI 整理 / 添加标签
 */

const DRAFT_KEY = "quick_capture_draft";
const DRAFT_AUTOSAVE_MS = 800;

export default function QuickCapturePage() {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [draftSavedAt, setDraftSavedAt] = useState<Date | null>(null);
  const [savingMain, setSavingMain] = useState(false);
  const startedAt = useRef(Date.now());
  const [elapsed, setElapsed] = useState("00:00");

  const debounceRef = useRef<number | null>(null);
  // 防 React 闭包陷阱
  const textRef = useRef("");

  // 加载草稿
  useEffect(() => {
    void (async () => {
      try {
        const draft = await configApi.get(DRAFT_KEY);
        if (draft) {
          setText(draft);
          textRef.current = draft;
        }
      } catch (e) {
        console.error("[QuickCapture] load draft failed:", e);
      }
    })();
  }, []);

  // 计时器
  useEffect(() => {
    const id = window.setInterval(() => {
      const sec = Math.floor((Date.now() - startedAt.current) / 1000);
      const m = String(Math.floor(sec / 60)).padStart(2, "0");
      const s = String(sec % 60).padStart(2, "0");
      setElapsed(`${m}:${s}`);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  // 草稿自动保存（debounce）
  const persistDraft = useCallback(async (val: string) => {
    try {
      await configApi.set(DRAFT_KEY, val);
      setDraftSavedAt(new Date());
    } catch (e) {
      console.error("[QuickCapture] save draft failed:", e);
    }
  }, []);

  function onChange(v: string) {
    textRef.current = v;
    setText(v);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      // 用 ref 读最新值
      void persistDraft(textRef.current);
    }, DRAFT_AUTOSAVE_MS);
  }

  async function clearDraft() {
    try {
      await configApi.delete(DRAFT_KEY);
    } catch {
      // 忽略：删除草稿失败不影响主流程
    }
  }

  async function handleSave() {
    const latest = textRef.current.trim();
    if (!latest || savingMain) return;
    setSavingMain(true);
    try {
      // 落到今日日记：在原有 content 后追加
      const today = new Date();
      const dateStr = `${today.getFullYear()}-${String(
        today.getMonth() + 1,
      ).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const note = await dailyApi.getOrCreate(dateStr);
      const time = today.toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      });
      const append = `\n\n---\n\n💭 **闪念 · ${time}**\n\n${latest}\n`;
      const newContent = (note.content || "") + append;
      await noteApi.update(note.id, {
        title: note.title,
        content: newContent,
        folder_id: note.folder_id,
      });
      await clearDraft();
      useAppStore.getState().bumpNotesRefresh();
      message.success("已记到今天的日记");
      navigate("/", { replace: true });
    } catch (e) {
      message.error(`保存失败: ${e}`);
    } finally {
      setSavingMain(false);
    }
  }

  function handleClose() {
    // 关闭不丢草稿（草稿已写入），用户下次进来还能恢复
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      void persistDraft(textRef.current);
    }
    navigate(-1);
  }

  const wordCount = text.length;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-gradient-to-br from-amber-500 via-orange-500 to-amber-600"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      {/* 顶栏 */}
      <header className="flex h-12 items-center justify-between px-3 shrink-0">
        <button
          onClick={handleClose}
          aria-label="关闭"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-white/20 backdrop-blur"
        >
          <X size={20} className="text-white" />
        </button>
        <div className="flex items-center gap-1.5 text-xs text-white/90">
          <Zap size={12} />
          <span>闪念捕获 · 自动保存草稿</span>
        </div>
        <div className="w-10" />
      </header>

      {/* 主体 */}
      <main className="flex-1 px-5 py-4 flex flex-col min-h-0">
        <div className="mb-3">
          <div className="text-3xl font-bold text-white leading-tight">
            脑子里有个想法？
          </div>
          <div className="mt-1 text-sm text-white/80">
            说出来或写下来，稍后再整理 💭
          </div>
        </div>

        {/* 输入卡 */}
        <div className="flex flex-1 flex-col rounded-3xl bg-white p-5 shadow-2xl min-h-0">
          <textarea
            value={text}
            onChange={(e) => onChange(e.target.value)}
            placeholder={"比如…\n\n移动端 AI Tab 应该比 PC 更突出\n「剪藏 + 提问」组合操作 ——\n用户在地铁上读到一段文字，\n截图 + 问 AI 摘要 + 存为笔记\n一气呵成。"}
            className="w-full flex-1 resize-none bg-transparent text-base leading-relaxed text-slate-800 outline-none placeholder:text-slate-300 min-h-0"
            autoFocus
          />

          {/* 状态栏 */}
          <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-400">
            <div className="flex items-center gap-3">
              <span>{wordCount} 字</span>
              {draftSavedAt && (
                <span className="flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                  已自动保存
                </span>
              )}
            </div>
            <span>{elapsed}</span>
          </div>

          {/* 工具栏（占位） */}
          <div className="mt-3 flex items-center gap-2">
            <ToolButton onClick={() => message.info("图片插入待开发")}>
              <ImageIcon size={20} className="text-slate-600" />
            </ToolButton>
            <ToolButton onClick={() => message.info("相机待开发")}>
              <Camera size={20} className="text-slate-600" />
            </ToolButton>
            <ToolButton onClick={() => message.info("语音录入待开发")}>
              <Mic size={20} className="text-slate-600" />
            </ToolButton>
            <ToolButton onClick={() => message.info("AI 整理待开发")}>
              <Sparkles size={20} className="text-orange-600" />
            </ToolButton>
            <div className="flex-1" />
            <ToolButton onClick={() => message.info("标签待开发")}>
              <Hash size={20} className="text-slate-600" />
            </ToolButton>
          </div>
        </div>

        {/* 保存目标提示 */}
        <div className="mt-3 flex items-center gap-3 rounded-2xl bg-white/15 px-4 py-3 text-white backdrop-blur">
          <FolderOpen size={18} />
          <div className="flex-1 text-sm">
            保存到 <strong>📅 今天的日记</strong>
          </div>
        </div>

        {/* 底部主操作 */}
        <div
          className="mt-4 grid grid-cols-2 gap-3"
          style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
        >
          <button
            onClick={handleClose}
            className="rounded-2xl bg-white/20 py-3 text-sm font-medium text-white backdrop-blur active:bg-white/30"
          >
            关闭
          </button>
          <button
            onClick={handleSave}
            disabled={!text.trim() || savingMain}
            className="flex items-center justify-center gap-1.5 rounded-2xl bg-white py-3 font-bold text-orange-600 shadow-lg active:scale-95 transition-transform disabled:opacity-50"
          >
            <Check size={16} />
            {savingMain ? "保存中…" : "保存到今日"}
          </button>
        </div>
      </main>
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
      onClick={onClick}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-100 active:bg-slate-200"
    >
      {children}
    </button>
  );
}
