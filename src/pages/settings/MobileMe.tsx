import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { message, Modal } from "antd";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Settings,
  Layers,
  GitFork,
  MessageSquareText,
  CloudUpload,
  Folder,
  FileArchive,
  Trash2,
  Moon,
  Palette,
  LockKeyhole,
  KeyRound,
  Boxes,
  Sparkles,
  Plug,
  Info,
  ChevronRight,
  RefreshCw,
} from "lucide-react";
import {
  systemApi,
  cardApi,
  trashApi,
  aiModelApi,
  promptApi,
  mobileUpdateApi,
} from "@/lib/api";
import type { DashboardStats } from "@/types";

/**
 * 移动端「我的」页（设计稿：10-me.html）
 *
 * 这是 5 Tab 之一，路由 /settings 在 isMobile=true 时渲染本组件。
 * 大部分二级入口（同步/导入/导出/外观/隐藏 PIN/Vault）暂不跳转 — 现状下他们大多是
 * 桌面专属功能，移动端要么走完整重写要么禁用。本页先把信息架构 + 数据搭起来，
 * 二级页跳转随后逐个 wire。
 */

interface CountStats {
  dueCards: number;
  trashCount: number;
  modelCount: number;
  promptCount: number;
}

export function MobileMe() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [counts, setCounts] = useState<CountStats>({
    dueCards: 0,
    trashCount: 0,
    modelCount: 0,
    promptCount: 0,
  });
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  /**
   * 检查更新：拉 update.json 比对版本。移动端没法热替换，有新版只能引导用户去下载新 APK。
   * 用户点"去下载" → openUrl(APK 直链/发布页) → 浏览器接管下载，下完点一下进系统安装器
   * （首次会提示"允许安装未知应用"，那是浏览器的权限）。
   */
  async function handleCheckUpdate() {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    try {
      const info = await mobileUpdateApi.check();
      if (!info.has_update) {
        message.success(`已是最新版本 v${info.current_version}`);
        return;
      }
      Modal.confirm({
        title: `发现新版本 v${info.latest_version}`,
        content: (
          <div className="text-sm">
            <div className="mb-2 text-slate-500">
              当前 v{info.current_version} → 最新 v{info.latest_version}
            </div>
            {info.notes && (
              <div className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs text-slate-700">
                {info.notes}
              </div>
            )}
            <div className="mt-2 text-xs text-slate-400">
              点"去下载"会在浏览器里下载新 APK，下载完点一下安装即可（首次需在系统里允许"安装未知应用"）。
            </div>
          </div>
        ),
        okText: "去下载",
        cancelText: "以后再说",
        onOk: async () => {
          try {
            await openUrl(info.download_url);
          } catch (e) {
            message.error(`打开下载链接失败：${e}`);
          }
        },
      });
    } catch (e) {
      message.error(`检查更新失败：${e}`);
    } finally {
      setCheckingUpdate(false);
    }
  }

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [s, due, trash, models, prompts] = await Promise.all([
          systemApi.getDashboardStats(),
          cardApi.listDue().catch(() => []),
          trashApi.list(1, 1).catch(() => ({
            items: [],
            total: 0,
            page: 1,
            page_size: 1,
          })),
          aiModelApi.list().catch(() => []),
          promptApi.list().catch(() => []),
        ]);
        if (!alive) return;
        setStats(s);
        setCounts({
          dueCards: (due as unknown[]).length,
          trashCount: trash.total ?? 0,
          modelCount: models.length,
          promptCount: prompts.length,
        });
      } catch (e) {
        console.error("[MobileMe] load failed:", e);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="text-slate-800">
      {/* 头部 banner */}
      <div className="bg-gradient-to-br from-[#1677FF] to-blue-700 px-5 pt-4 pb-12 text-white">
        <div className="flex items-start gap-4">
          <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-2xl bg-white/20 backdrop-blur">
            <img
              src="/app-icon.png"
              alt="知识库"
              className="h-full w-full object-cover"
            />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-xl font-bold">知识库</h2>
            <p className="mt-0.5 text-sm text-blue-100">
              个人知识库 · 共 {stats?.total_notes ?? 0} 篇
            </p>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              <span className="rounded bg-white/20 px-2 py-0.5">
                📝 {stats?.total_notes ?? 0} 笔记
              </span>
              <span className="rounded bg-white/20 px-2 py-0.5">
                🏷️ {stats?.total_tags ?? 0} 标签
              </span>
            </div>
          </div>
          <button
            onClick={() => navigate("/about")}
            aria-label="设置"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 active:bg-white/25"
          >
            <Settings size={18} />
          </button>
        </div>
      </div>

      {/* 数据统计卡（从 banner 下方上提） */}
      <div className="-mt-7 mx-4 grid grid-cols-3 gap-2">
        <StatCard
          value={counts.dueCards}
          label="今日待复习"
          color="text-slate-900"
        />
        <StatCard
          value={stats?.total_words ?? 0}
          label="总字数"
          color="text-slate-900"
        />
        <StatCard
          value={stats?.today_updated ?? 0}
          label="今日更新"
          color="text-green-600"
        />
      </div>

      {/* 学习与思考 */}
      <SectionLabel text="学习与思考" />
      <div className="px-4">
        <div className="grid grid-cols-3 gap-3">
          <LearnCard
            icon={<Layers size={20} className="text-purple-600" />}
            iconBg="bg-purple-100"
            label="闪卡复习"
            badge={counts.dueCards > 0 ? `${counts.dueCards} 待复` : undefined}
            badgeColor="text-purple-600 bg-purple-50"
            onClick={() => navigate("/cards")}
          />
          <LearnCard
            icon={<GitFork size={20} className="text-blue-600" />}
            iconBg="bg-blue-100"
            label="知识图谱"
            sub={`${stats?.total_notes ?? 0} 节点`}
            onClick={() => navigate("/graph")}
          />
          <LearnCard
            icon={<MessageSquareText size={20} className="text-[#FA8C16]" />}
            iconBg="bg-orange-100"
            label="Prompt 库"
            sub={`${counts.promptCount} 条`}
            onClick={() => navigate("/prompts")}
          />
        </div>
      </div>

      {/* 数据与同步 */}
      <SectionLabel text="数据与同步" />
      <ListGroup>
        <Row
          icon={<CloudUpload size={20} className="text-blue-500" />}
          label="云端同步"
          right={<span className="text-xs text-slate-400">WebDAV</span>}
          onClick={() => navigate("/sync")}
        />
        <Row
          icon={<Folder size={20} className="text-amber-500" />}
          label="导入笔记"
          right={<span className="text-xs text-slate-400">.md / .txt</span>}
          onClick={() => navigate("/quick-create")}
        />
        <Row
          icon={<FileArchive size={20} className="text-purple-500" />}
          label="导出 / 备份"
          info="桌面专属"
        />
        <Row
          icon={<Trash2 size={20} className="text-red-500" />}
          label="回收站"
          right={
            counts.trashCount > 0 ? (
              <span className="text-xs text-slate-400">
                {counts.trashCount} 项
              </span>
            ) : undefined
          }
          onClick={() => navigate("/trash")}
        />
      </ListGroup>

      {/* 外观与隐私 */}
      <SectionLabel text="外观与隐私" />
      <ListGroup>
        <Row
          icon={<Moon size={20} className="text-slate-700" />}
          label="深色模式"
          right={<span className="text-xs text-slate-400">跟随系统</span>}
          info="跟随系统设置，暂不支持手动切换"
        />
        <Row
          icon={<Palette size={20} className="text-pink-500" />}
          label="主题与字体"
          info="桌面专属"
        />
        <Row
          icon={<LockKeyhole size={20} className="text-red-500" />}
          label="隐藏笔记 PIN"
          onClick={() => navigate("/hidden")}
        />
        <Row
          icon={<KeyRound size={20} className="text-amber-500" />}
          label="笔记加密 Vault"
          info="桌面专属（移动端只读已加密笔记）"
        />
      </ListGroup>

      {/* 功能与扩展 */}
      <SectionLabel text="功能与扩展" />
      <ListGroup>
        <Row
          icon={<Boxes size={20} className="text-blue-500" />}
          label="功能模块"
          onClick={() => navigate("/feature-toggle")}
        />
        <Row
          icon={<Sparkles size={20} className="text-[#FA8C16]" />}
          label="AI 模型管理"
          right={
            <span className="text-xs text-slate-400">
              {counts.modelCount} 个
            </span>
          }
          onClick={() => navigate("/ai")}
        />
        <Row
          icon={<Plug size={20} className="text-blue-500" />}
          label="MCP 服务器"
          info="MCP 走子进程 sidecar，移动端沙盒禁止 spawn"
        />
        <Row
          icon={<RefreshCw size={20} className="text-green-600" />}
          label="检查更新"
          right={
            checkingUpdate ? (
              <span className="text-xs text-slate-400">检查中…</span>
            ) : undefined
          }
          onClick={() => void handleCheckUpdate()}
        />
        <Row
          icon={<Info size={20} className="text-slate-500" />}
          label="关于"
          right={<span className="text-xs text-slate-400">v1.7.1</span>}
          onClick={() => navigate("/about")}
        />
      </ListGroup>

      <div className="h-24" />
    </div>
  );
}

function LearnCard({
  icon,
  iconBg,
  label,
  badge,
  badgeColor,
  sub,
  onClick,
}: {
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  badge?: string;
  badgeColor?: string;
  sub?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center gap-1 rounded-2xl bg-white py-4 shadow-sm active:scale-95 transition-transform"
    >
      <div
        className={`flex h-10 w-10 items-center justify-center rounded-xl ${iconBg}`}
      >
        {icon}
      </div>
      <span className="text-xs font-medium text-slate-700">{label}</span>
      {badge && (
        <span
          className={`rounded-full px-1.5 text-[10px] font-medium ${badgeColor}`}
        >
          {badge}
        </span>
      )}
      {!badge && sub && <span className="text-[10px] text-slate-500">{sub}</span>}
    </button>
  );
}

function StatCard({
  value,
  label,
  color = "text-slate-900",
}: {
  value: number | string;
  label: string;
  color?: string;
}) {
  return (
    <div className="rounded-2xl bg-white py-3 text-center shadow-sm">
      <div className={`text-xl font-bold ${color}`}>{value}</div>
      <div className="mt-0.5 text-[11px] text-slate-500">{label}</div>
    </div>
  );
}

function SectionLabel({ text }: { text: string }) {
  return (
    <div className="px-4 pt-4 pb-2 text-xs font-medium text-slate-400">
      {text}
    </div>
  );
}

function ListGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4">
      <div className="divide-y divide-slate-100 rounded-2xl bg-white">
        {children}
      </div>
    </div>
  );
}

function Row({
  icon,
  label,
  right,
  onClick,
  info,
}: {
  icon: React.ReactNode;
  label: string;
  right?: React.ReactNode;
  onClick?: () => void;
  /** 仅信息提示（点击后弹 toast 解释为什么不可用），不显示 chevron */
  info?: string;
}) {
  const isInteractive = !!onClick && !info;
  const handleClick = () => {
    if (info) {
      message.info(info);
      return;
    }
    onClick?.();
  };
  return (
    <button
      onClick={handleClick}
      className={`flex w-full items-center gap-3 px-4 py-3 ${
        isInteractive ? "active:bg-slate-50" : "active:bg-slate-50"
      } ${info ? "opacity-70" : ""}`}
    >
      {icon}
      <span className="flex-1 text-left text-sm text-slate-800">{label}</span>
      {info ? (
        <span className="text-xs text-slate-400">不可用</span>
      ) : (
        right
      )}
      {isInteractive && (
        <ChevronRight size={16} className="text-slate-300" />
      )}
    </button>
  );
}

