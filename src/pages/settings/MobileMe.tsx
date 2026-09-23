import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { message, Modal, Progress } from "antd";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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
import {
  MOBILE_UPDATE_PROGRESS_EVENT,
  type DashboardStats,
  type MobileDownloadProgress,
  type MobileUpdateInfo,
} from "@/types";
import { useAppStore } from "@/store";

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
  /** 非 null = 正在下载该版本的 APK，弹进度对话框 */
  const [downloading, setDownloading] = useState<MobileUpdateInfo | null>(null);
  const [progress, setProgress] = useState<MobileDownloadProgress>({
    downloaded: 0,
    total: 0,
    percent: 0,
  });
  /** 进度事件的 unlisten，组件卸载时兜底清理（下载途中切 Tab 不该泄漏监听） */
  const unlistenRef = useRef<UnlistenFn | null>(null);
  /** 启动静默检查发现的新版（同时驱动「我的」Tab 的小红点） */
  const pendingUpdate = useAppStore((s) => s.mobileUpdateAvailable);

  useEffect(
    () => () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
    },
    [],
  );

  /**
   * App 内下载 + 安装新版 APK。
   *
   * 相比老的「openUrl 丢给浏览器」，这条路径全程留在 App 内：进度条可见、断点续传、
   * 下完直接拉起系统安装器。最后那个系统确认框是 Android 强制的，绕不过去。
   *
   * 「允许安装未知应用」是 Android 8.0+ 的单应用开关，应用不能自己授予 —— 没授权时
   * 先引导用户去设置页开，回来再点一次。
   *
   * 任何一环失败都回退到浏览器下载（老路径），至少不把用户堵死。
   */
  async function downloadAndInstall(info: MobileUpdateInfo) {
    // 下载地址可能是 release 发布页（update-mobile.json 没给直链时的回落），
    // 那种页面下不了 APK，直接交给浏览器
    if (!info.download_url.toLowerCase().endsWith(".apk")) {
      await openUrl(info.download_url);
      return;
    }

    setProgress({ downloaded: 0, total: 0, percent: 0 });
    setDownloading(info);
    try {
      unlistenRef.current?.();
      unlistenRef.current = await listen<MobileDownloadProgress>(
        MOBILE_UPDATE_PROGRESS_EVENT,
        (e) => setProgress(e.payload),
      );

      const apkPath = await mobileUpdateApi.download(
        info.download_url,
        info.latest_version,
      );

      // 装之前先确认权限，省得拉起安装器被系统静默拒绝、用户一脸懵
      const allowed = await mobileUpdateApi.canInstall().catch(() => false);
      if (!allowed) {
        setDownloading(null);
        Modal.confirm({
          title: "需要允许安装未知应用",
          content: (
            <div className="text-sm text-slate-600">
              新版已下载完成。Android 要求你在系统设置里给「知识库」单独打开「允许安装未知应用」，
              打开后返回本页再点一次「检查更新」即可安装。
            </div>
          ),
          okText: "去设置",
          cancelText: "以后再说",
          onOk: () =>
            mobileUpdateApi
              .openInstallPermissionSettings()
              .catch((e) => message.error(`打开设置页失败：${e}`)),
        });
        return;
      }

      await mobileUpdateApi.install(apkPath);
      setDownloading(null);
      // 安装器已接手，红点该撤了 —— 装完重启 App 会重新静默检查，真没装成也会再亮
      useAppStore.setState({ mobileUpdateAvailable: null });
      message.success("已拉起安装器，按提示完成安装");
    } catch (e) {
      setDownloading(null);
      // 下载/安装任一环挂了都回退浏览器，别把用户堵在这
      Modal.confirm({
        title: "App 内更新失败",
        content: (
          <div className="text-sm">
            <div className="mb-2 text-slate-600">{String(e)}</div>
            <div className="text-xs text-slate-400">
              可以改用浏览器下载：下完在通知栏点一下就能装。
            </div>
          </div>
        ),
        okText: "用浏览器下载",
        cancelText: "取消",
        onOk: () =>
          openUrl(info.download_url).catch((err) =>
            message.error(`打开下载链接失败：${err}`),
          ),
      });
    } finally {
      unlistenRef.current?.();
      unlistenRef.current = null;
    }
  }

  /**
   * 检查更新：拉 update-mobile.json 比对版本，有新版走 {@link downloadAndInstall}。
   */
  async function handleCheckUpdate() {
    if (checkingUpdate || downloading) return;
    setCheckingUpdate(true);
    try {
      const info = await mobileUpdateApi.check();
      if (!info.has_update) {
        // 清掉启动检查留下的红点：用户可能已经装过新版了
        useAppStore.setState({ mobileUpdateAvailable: null });
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
              点"立即更新"会在 App 内下载，下完自动拉起安装器（首次需在系统里允许"安装未知应用"）。
            </div>
          </div>
        ),
        okText: "立即更新",
        cancelText: "以后再说",
        onOk: () => downloadAndInstall(info),
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
          label="模型服务"
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
            ) : pendingUpdate ? (
              // 启动静默检查已经发现新版了，直接把版本号摆出来，省一次点击
              <span className="text-xs font-medium text-[#ff4d4f]">
                v{pendingUpdate.latest_version} 可更新
              </span>
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

      {/*
        下载进度：故意做成不可关闭（无 X / 点遮罩不关）—— 下载是后端 tokio 任务，
        前端关掉对话框并不会真的中止它，给个"取消"只会让用户以为停了。
        真中断（杀进程 / 切后台被回收）时 .part 留在 cache 里，下次点更新自动续传。
      */}
      <Modal
        open={downloading !== null}
        title={`正在下载 v${downloading?.latest_version ?? ""}`}
        footer={null}
        closable={false}
        maskClosable={false}
        keyboard={false}
      >
        <Progress
          percent={progress.percent}
          status="active"
          // total 为 0 = 服务端没给 Content-Length，百分比无意义，只显示已下字节
          format={() =>
            progress.total > 0 ? `${progress.percent}%` : formatBytes(progress.downloaded)
          }
        />
        <div className="mt-2 text-xs text-slate-400">
          {progress.total > 0
            ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`
            : "下载中…"}
        </div>
        <div className="mt-3 text-xs text-slate-400">
          下载完成后会自动拉起系统安装器。请保持应用在前台。
        </div>
      </Modal>

      <div className="h-24" />
    </div>
  );
}

/** 字节数转人类可读（下载进度用，保留一位小数） */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
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

