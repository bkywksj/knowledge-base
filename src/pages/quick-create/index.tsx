import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  PenLine,
  Zap,
  CalendarDays,
  Layers,
  CheckSquare,
  Upload,
  Mic,
  Camera,
  Link as LinkIcon,
  LayoutTemplate,
} from "lucide-react";
import { Modal, Input, message } from "antd";
import { noteApi, dailyApi } from "@/lib/api";
import { useAppStore } from "@/store";

/**
 * 移动端「新建」抽屉式落地页（设计稿：14-quick-create.html）
 *
 * 路由 /quick-create —— 仅移动端用，桌面端不会到这个路径。
 * 入口：MobileLayout 全局蓝色 + FAB 在「主页 / 笔记 / 待办 / 我的」 4 个 tab 下都点击此页
 *
 * 提供 2 大块主操作 + 6 个来源入口 + 2 个其他类型，命中即跳到对应编辑器或弹提示。
 *
 * 当前实现：
 * - 空白笔记 / 今日笔记：直接 createNote / getOrCreate 后跳编辑器
 * - 闪念捕获：跳 /quick-capture（待实现，先占位）
 * - 网页剪藏 / 模板 / 语音 / 拍照 / 导入文件：暂提示「待开发」
 * - 新建任务：跳 /tasks（移动端待办列表，新增 Modal 走桌面入口）
 * - 新闪卡：仅在功能模块开启后可用（暂只跳 /cards）
 */

export default function QuickCreatePage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [clipOpen, setClipOpen] = useState(false);
  const [clipUrl, setClipUrl] = useState("");
  const [clipping, setClipping] = useState(false);

  /**
   * 移动端单文件导入：用 HTML5 <input type=file> 打开系统文件选择器
   * （Tauri Mobile 的 WebView 直接支持，不需要走 tauri-plugin-dialog）
   * 读 .md/.txt 文本 → 创建笔记 → 跳编辑器
   */
  function pickFile() {
    fileInputRef.current?.click();
  }

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      // 文件名去后缀做标题
      const title = file.name.replace(/\.(md|markdown|txt)$/i, "");
      const note = await noteApi.create({
        title: title || "导入的笔记",
        content: text,
      });
      useAppStore.getState().bumpNotesRefresh();
      message.success(`已导入：${title}`);
      navigate(`/notes/${note.id}`, { replace: true });
    } catch (err) {
      message.error(`导入失败: ${err}`);
    } finally {
      // 重置 input value，允许再次选同一文件
      e.target.value = "";
    }
  }

  function openClip() {
    // 自动从剪贴板拿 URL（移动端 WebView 多数支持 navigator.clipboard.readText）
    setClipUrl("");
    setClipOpen(true);
    void (async () => {
      try {
        const text = await navigator.clipboard?.readText();
        if (text && /^https?:\/\//i.test(text.trim())) {
          setClipUrl(text.trim());
        }
      } catch {
        // 用户拒绝授权剪贴板，留空让用户手动粘贴
      }
    })();
  }

  async function submitClip() {
    const url = clipUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      message.error("URL 必须以 http(s):// 开头");
      return;
    }
    setClipping(true);
    try {
      const note = await noteApi.clipUrl(url);
      useAppStore.getState().bumpNotesRefresh();
      message.success("已剪藏");
      setClipOpen(false);
      navigate(`/notes/${note.id}`, { replace: true });
    } catch (e) {
      message.error(`剪藏失败: ${e}`);
    } finally {
      setClipping(false);
    }
  }

  async function createBlank() {
    try {
      const note = await noteApi.create({ title: "无标题笔记", content: "" });
      useAppStore.getState().bumpNotesRefresh();
      navigate(`/notes/${note.id}`, { replace: true });
    } catch (e) {
      message.error(`创建失败: ${e}`);
    }
  }

  async function openTodayDaily() {
    try {
      const today = new Date();
      const dateStr = `${today.getFullYear()}-${String(
        today.getMonth() + 1,
      ).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const note = await dailyApi.getOrCreate(dateStr);
      useAppStore.getState().bumpNotesRefresh();
      navigate(`/notes/${note.id}`, { replace: true });
    } catch (e) {
      message.error(`打开失败: ${e}`);
    }
  }

  return (
    <div className="text-slate-800">
      {/* 顶栏 */}
      <header className="flex h-12 items-center justify-between border-b border-slate-200 bg-white px-2">
        <button
          onClick={() => navigate(-1)}
          aria-label="返回"
          className="flex h-10 w-10 items-center justify-center"
        >
          <ChevronLeft size={24} className="text-slate-700" />
        </button>
        <h1 className="text-base font-semibold">新建</h1>
        <div className="w-10" />
      </header>

      <div className="bg-slate-50 pb-12">
        {/* 最常用 */}
        <div className="px-4 pt-4 pb-2 text-xs font-medium text-slate-400">
          最常用
        </div>
        <div className="grid grid-cols-2 gap-3 px-4 pb-3">
          <BigCard
            gradient="from-blue-500 to-blue-700"
            icon={<PenLine size={26} />}
            title="空白笔记"
            sub="直接开始写"
            onClick={createBlank}
          />
          <BigCard
            gradient="from-amber-500 to-orange-500"
            icon={<Zap size={26} />}
            title="闪念捕获"
            sub="瞬间记录"
            onClick={() => navigate("/quick-capture")}
          />
        </div>

        {/* 从来源创建笔记 */}
        <SectionLabel text="从来源创建笔记" />
        <ListGroup>
          <Row
            icon={<LayoutTemplate size={20} className="text-purple-600" />}
            iconBg="bg-purple-100"
            title="从模板"
            sub="读书笔记 / 会议纪要 / 周报…"
            onClick={() => message.info("移动端模板功能待开发")}
          />
          <Row
            icon={<CalendarDays size={20} className="text-green-600" />}
            iconBg="bg-green-100"
            title="今日笔记"
            sub="追加到当天日记"
            onClick={openTodayDaily}
          />
          <Row
            icon={<LinkIcon size={20} className="text-cyan-600" />}
            iconBg="bg-cyan-100"
            title="网页剪藏"
            badge="智能"
            sub="粘贴链接 → 自动抓成 markdown"
            onClick={openClip}
          />
          <Row
            icon={<Mic size={20} className="text-red-600" />}
            iconBg="bg-red-100"
            title="语音笔记"
            sub="说话即转文字（需 ASR）"
            onClick={() => message.info("移动端语音录入待开发")}
          />
          <Row
            icon={<Camera size={20} className="text-pink-600" />}
            iconBg="bg-pink-100"
            title="拍照 / 扫描"
            sub="OCR 文字识别后入库"
            onClick={() => message.info("移动端拍照待开发")}
          />
          <Row
            icon={<Upload size={20} className="text-slate-600" />}
            iconBg="bg-slate-100"
            title="导入文件"
            sub="选 .md / .markdown / .txt 文件转为笔记"
            onClick={pickFile}
          />
        </ListGroup>

        {/* 其他 */}
        <SectionLabel text="其他" />
        <ListGroup>
          <Row
            icon={<CheckSquare size={20} className="text-orange-600" />}
            iconBg="bg-orange-100"
            title="新建任务"
            sub="到「今日待办」中"
            onClick={() => navigate("/tasks")}
          />
          <Row
            icon={<Layers size={20} className="text-indigo-600" />}
            iconBg="bg-indigo-100"
            title="新闪卡"
            sub="复习记忆卡片（默认未启用）"
            onClick={() => navigate("/cards")}
          />
        </ListGroup>

        <div className="px-4 py-4 text-center text-[11px] text-slate-400">
          💡 主页底部 + 按钮可呼出此页
        </div>
      </div>

      {/* 隐藏的文件选择器（导入文件行点击时触发） */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".md,.markdown,.txt,text/markdown,text/plain"
        onChange={onFilePicked}
        className="hidden"
      />

      {/* 网页剪藏 Modal */}
      <Modal
        title="网页剪藏"
        open={clipOpen}
        onCancel={() => setClipOpen(false)}
        onOk={submitClip}
        okText={clipping ? "抓取中…" : "剪藏"}
        cancelText="取消"
        okButtonProps={{ loading: clipping, disabled: !clipUrl.trim() }}
        destroyOnClose
      >
        <Input
          autoFocus
          value={clipUrl}
          onChange={(e) => setClipUrl(e.target.value)}
          placeholder="https://..."
          onPressEnter={submitClip}
        />
        <div className="mt-2 text-xs text-slate-400">
          已自动从剪贴板抓 URL；后端直连原网页 → readability 提取正文 → 转 markdown 入库，正文图片一并下载到本地
        </div>
      </Modal>
    </div>
  );
}

function BigCard({
  gradient,
  icon,
  title,
  sub,
  onClick,
}: {
  gradient: string;
  icon: React.ReactNode;
  title: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-start rounded-2xl bg-gradient-to-br ${gradient} p-4 text-left text-white shadow-sm active:scale-[0.98] transition-transform`}
    >
      <div className="mb-3">{icon}</div>
      <div className="text-base font-semibold">{title}</div>
      <div className="mt-0.5 text-[11px] opacity-80">{sub}</div>
    </button>
  );
}

function SectionLabel({ text }: { text: string }) {
  return (
    <div className="px-4 pt-2 pb-1 text-xs font-medium text-slate-400">
      {text}
    </div>
  );
}

function ListGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-4 mb-2 divide-y divide-slate-100 rounded-2xl bg-white">
      {children}
    </div>
  );
}

function Row({
  icon,
  iconBg,
  title,
  sub,
  badge,
  onClick,
}: {
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  sub: string;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-slate-50"
    >
      <div
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${iconBg}`}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-medium text-slate-800">
          {title}
          {badge && (
            <span className="rounded bg-cyan-50 px-1.5 py-0.5 text-[9px] font-medium text-cyan-700">
              {badge}
            </span>
          )}
        </div>
        <div className="text-[11px] text-slate-500">{sub}</div>
      </div>
      <ChevronRight size={16} className="shrink-0 text-slate-300" />
    </button>
  );
}
