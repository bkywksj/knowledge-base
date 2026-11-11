import { cloneElement, isValidElement, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { message, Modal, Progress } from "antd";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import {
  BookOpenText,
  Boxes,
  Cloud,
  CloudCheck,
  CloudOff,
  FileArchive,
  FolderInput,
  Info,
  KeyRound,
  LockKeyhole,
  Palette,
  Plug,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import {
  systemApi,
  cardApi,
  trashApi,
  aiModelApi,
  promptApi,
  mobileUpdateApi,
  syncV1Api,
} from "@/lib/api";
import {
  MOBILE_UPDATE_PROGRESS_EVENT,
  type DashboardStats,
  type MobileDownloadProgress,
  type MobileUpdateInfo,
  type SyncBackend,
} from "@/types";
import { useAppStore, type ActiveView } from "@/store";
import { relativeTime } from "@/lib/utils";
import { themes, type ThemeMeta } from "@/theme/tokens";
import { MOBILE_TAB_REGISTRY, type MobileTabKey } from "@/lib/mobileTabRegistry";
import { BOTTOM_ITEMS, MAIN_GROUPS, type ActivityItem } from "@/components/layout/ActivityBar";
import { useLongPress } from "@/hooks/useLongPress";
import { MGroup, MRow, MSectionHeader } from "@/components/mobile/primitives";
import { MSheet, PickRow } from "@/components/mobile/MSheet";
import { ActionSheet, type ActionSheetItem } from "@/components/mobile/ActionSheet";

/**
 * 移动端「我的」页（v4 原型 12 屏）
 *
 * 5 Tab 之一，路由 /settings 在 isMobile=true 时渲染本组件。
 *
 * - 头部：「我的知识库」+ 笔记 / 字数 / 双链 / 标签 / 今日更新
 * - 同步卡：第一个启用的同步后端 + 上次同步时间；「立即同步」跳同步页并自动跑（流程只在同步页维护一份）
 * - 全部功能：= PC 活动栏除首页 / 关于外的全部入口，顺序与显示规则（core / 功能模块开关）直接读 ActivityBar 的列表；
 *   已在底部 Tab 的带点，长按选择放到底部哪个位置
 * - 设置分组：外观与主题（手机上可切 9 套主题）/ 模型服务 / 功能模块与底部 Tab / 隐私 / 数据 / 关于与更新
 */

/** 不进「全部功能」的视图：首页有自己的 Tab；关于在设置分组里 */
const EXCLUDED_VIEWS: ActiveView[] = ["home", "about"];
/** 格子上的名字：大多用活动栏短名；「隐藏」单独两个字意思不清，用全名 */
const CELL_LABEL: Partial<Record<ActiveView, string>> = { hidden: "隐藏笔记" };

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
  const [backends, setBackends] = useState<SyncBackend[] | null>(null);
  const [version, setVersion] = useState<string>("");
  const [themeOpen, setThemeOpen] = useState(false);
  const [tabFor, setTabFor] = useState<ActivityItem | null>(null);

  const enabledViews = useAppStore((s) => s.enabledViews);
  const tabKeys = useAppStore((s) => s.mobileTabKeys);
  const urgentTodoCount = useAppStore((s) => s.urgentTodoCount);
  const themeCategory = useAppStore((s) => s.themeCategory);
  const lightTheme = useAppStore((s) => s.lightTheme);
  const darkTheme = useAppStore((s) => s.darkTheme);
  const currentTheme = themes.find((t) => t.key === (themeCategory === "light" ? lightTheme : darkTheme));

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
            <div className="text-sm text-[var(--m-ink2)]">
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
            <div className="mb-2 text-[var(--m-ink2)]">{String(e)}</div>
            <div className="text-xs text-[var(--m-ink3)]">
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
            <div className="mb-2 text-[var(--m-ink3)]">
              当前 v{info.current_version} → 最新 v{info.latest_version}
            </div>
            {info.notes && (
              <div className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[var(--m-well)] p-2 text-xs text-[var(--m-ink)]">
                {info.notes}
              </div>
            )}
            <div className="mt-2 text-xs text-[var(--m-ink3)]">
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
    syncV1Api
      .listBackends()
      .then((b) => alive && setBackends(b))
      .catch(() => alive && setBackends([]));
    // 「关于」行原来写死 v1.7.1，改读真实版本
    getVersion()
      .then((v) => alive && setVersion(v))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  /** 全部功能：活动栏顺序 + 同一套显示规则 */
  const features = useMemo(
    () =>
      [...MAIN_GROUPS.flat(), ...BOTTOM_ITEMS].filter(
        (it) => !EXCLUDED_VIEWS.includes(it.view) && (it.core || enabledViews.has(it.view)),
      ),
    [enabledViews],
  );

  const badgeOf = (view: ActiveView): number => {
    if (view === "cards") return counts.dueCards;
    if (view === "tasks") return urgentTodoCount;
    return 0;
  };
  const captionOf = (view: ActiveView): string | undefined => {
    if (view === "graph" && stats) return `${stats.total_notes} 节点`;
    if (view === "prompts") return `${counts.promptCount} 条`;
    if (view === "trash" && counts.trashCount > 0) return `${counts.trashCount} 项`;
    return undefined;
  };

  const backend = backends?.find((b) => b.enabled) ?? backends?.[0] ?? null;
  const lastSync = backend ? [backend.lastPullTs, backend.lastPushTs].filter(Boolean).sort().pop() ?? null : null;

  /** 长按格子：选放到底部哪个位置（4 个位置；已在的就是换位） */
  const tabItems: ActionSheetItem[] = tabFor
    ? (() => {
        const key = tabFor.view as MobileTabKey;
        return tabKeys.map((k, slot) => {
          const here = k === key;
          return {
            key: `slot-${slot}`,
            label: here ? `第 ${slot + 1} 个位置（当前）` : `放到第 ${slot + 1} 个位置`,
            extra: here ? undefined : `替换「${MOBILE_TAB_REGISTRY[k]?.label ?? k}」`,
            onClick: () => {
              if (here) return;
              useAppStore.getState().setMobileTabKey(slot, key);
              message.success(`已放到底部第 ${slot + 1} 个位置`);
            },
          };
        });
      })()
    : [];

  function onFeatureLongPress(it: ActivityItem) {
    if (!(it.view in MOBILE_TAB_REGISTRY)) {
      message.info(`「${it.label}」暂不能放到底部 Tab`);
      return;
    }
    setTabFor(it);
  }

  function pickTheme(t: ThemeMeta) {
    // 与 PC ThemePicker 同一写法：先记下该类别用哪套，再切类别；store 订阅负责持久化
    const st = useAppStore.getState();
    if (t.category === "light") st.setLightTheme(t.key);
    else st.setDarkTheme(t.key);
    st.setThemeCategory(t.category);
  }

  const iconStyle = { color: "var(--m-ink2)" };

  return (
    <div className="mx-auto w-full max-w-[860px] pb-24">
      {/* 头部（原型 12）：渐变图标块 + 20px 标题 + 统计 */}
      <div className="m-gutter flex items-center gap-3.5 pt-3">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[12px]" style={{ background: "var(--m-grad)", color: "var(--m-on-accent)" }}>
          <BookOpenText size={24} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[20px] font-bold" style={{ color: "var(--m-ink)" }}>
            我的知识库
          </div>
          <div className="m-t-meta m-num">
            {stats ? `${stats.total_notes} 篇笔记 · ${stats.total_words.toLocaleString()} 字 · ${stats.total_links} 条双链 · ${stats.total_tags} 个标签` : "　"}
          </div>
          {stats && stats.today_updated > 0 && <div className="m-t-cap">今天更新了 {stats.today_updated} 篇</div>}
        </div>
      </div>

      {/* 同步行（原型 12）：状态图标块 + 两行文字 + 右侧文字按钮 */}
      <div className="m-gutter mt-5">
        <MGroup className="flex min-h-[60px] items-center gap-3 pr-1 pl-3">
          <button type="button" className="flex min-h-[44px] min-w-0 flex-1 items-center gap-3 text-left" onClick={() => navigate("/sync")}>
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px]"
              style={backend ? { background: "var(--m-ok-soft)", color: "var(--m-ok)" } : { background: "var(--m-well)", color: "var(--m-ink3)" }}
            >
              {backend ? <CloudCheck size={18} /> : <CloudOff size={18} />}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-semibold" style={{ color: "var(--m-ink)" }}>
                {backends === null ? "同步" : backend ? `${lastSync ? "已同步" : "未同步过"} ${backend.name}` : "还没配置同步"}
              </span>
              <span className="m-t-cap block truncate" style={backend?.lastError ? { color: "var(--m-bad)" } : undefined}>
                {backend
                  ? backend.lastError
                    ? `上次同步出错：${backend.lastError}`
                    : lastSync
                      ? `${relativeTime(lastSync)}同步`
                      : "点立即同步做第一次同步"
                  : "WebDAV / S3，和桌面端互通"}
              </span>
            </span>
          </button>
          {backend ? (
            <button
              type="button"
              className="flex h-11 shrink-0 items-center px-3 text-[14px] font-bold"
              style={{ color: "var(--m-accent-ink)" }}
              onClick={() => navigate("/sync", { state: { syncNow: backend.id } })}
            >
              立即同步
            </button>
          ) : (
            <button type="button" className="flex h-11 shrink-0 items-center px-3 text-[14px] font-bold" style={{ color: "var(--m-accent-ink)" }} onClick={() => navigate("/sync")}>
              去设置
            </button>
          )}
        </MGroup>
      </div>

      {/* 全部功能 */}
      <div className="m-gutter mt-6">
        <MSectionHeader className="mb-2" title="全部功能" action={<span className="m-t-cap">长按可放到底部 Tab</span>} />
        <MGroup className="grid grid-cols-4 py-2">
          {features.map((it) => (
            <FeatureCell
              key={it.view}
              item={it}
              label={CELL_LABEL[it.view] ?? it.short ?? it.label}
              inTab={tabKeys.includes(it.view as MobileTabKey)}
              badge={badgeOf(it.view)}
              caption={captionOf(it.view)}
              onClick={() => navigate(it.route)}
              onLongPress={() => onFeatureLongPress(it)}
            />
          ))}
        </MGroup>
        <div className="m-t-cap mt-1.5 flex items-center gap-1.5">
          <span className="m-dot" style={{ background: "var(--m-accent)", width: 7, height: 7 }} /> 已在底部 Tab
        </div>
      </div>

      {/* 设置 */}
      <div className="m-gutter mt-6">
        <MSectionHeader className="mb-2" title="设置" />
        <MGroup>
          <MRow icon={<Palette size={20} style={iconStyle} />} chevron right={currentTheme?.label} onClick={() => setThemeOpen(true)}>
            外观与主题
          </MRow>
          <MRow icon={<Sparkles size={20} style={iconStyle} />} chevron right={`${counts.modelCount} 个`} onClick={() => navigate("/ai")}>
            模型服务
          </MRow>
          <MRow icon={<Boxes size={20} style={iconStyle} />} chevron onClick={() => navigate("/feature-toggle")}>
            功能模块与底部 Tab
          </MRow>
        </MGroup>

        <div className="m-t-cap mt-4 mb-1.5 px-1">隐私</div>
        <MGroup>
          <MRow icon={<LockKeyhole size={20} style={iconStyle} />} chevron onClick={() => navigate("/hidden")}>
            隐藏笔记 PIN
          </MRow>
          <DesktopOnlyRow icon={<KeyRound size={20} style={iconStyle} />} label="笔记加密 Vault" info="笔记加密在桌面端设置；手机端可只读已加密笔记" />
        </MGroup>

        <div className="m-t-cap mt-4 mb-1.5 px-1">数据</div>
        <MGroup>
          <MRow icon={<Cloud size={20} style={iconStyle} />} chevron right={backend?.name} onClick={() => navigate("/sync")}>
            云端同步
          </MRow>
          <MRow icon={<FolderInput size={20} style={iconStyle} />} chevron right=".md / .txt" onClick={() => navigate("/quick-create")}>
            导入笔记
          </MRow>
          <DesktopOnlyRow icon={<FileArchive size={20} style={iconStyle} />} label="导出 / 备份" info="导出与整库备份在桌面端操作" />
          <DesktopOnlyRow icon={<Plug size={20} style={iconStyle} />} label="MCP 服务器" info="MCP 走子进程 sidecar，移动端沙盒禁止 spawn" />
        </MGroup>

        <div className="m-t-cap mt-4 mb-1.5 px-1">关于与更新</div>
        <MGroup>
          <MRow
            icon={<RefreshCw size={20} style={iconStyle} />}
            right={
              checkingUpdate ? (
                "检查中…"
              ) : pendingUpdate ? (
                // 启动静默检查已经发现新版了，直接把版本号摆出来，省一次点击
                <span style={{ color: "var(--m-bad)", fontWeight: 600 }}>v{pendingUpdate.latest_version} 可更新</span>
              ) : undefined
            }
            onClick={() => void handleCheckUpdate()}
          >
            检查更新
          </MRow>
          <MRow icon={<Info size={20} style={iconStyle} />} chevron right={version ? `v${version}` : undefined} onClick={() => navigate("/about")}>
            关于
          </MRow>
        </MGroup>
      </div>

      {/* 外观与主题：手机端的颜色全部从主题变量推导，9 套都可用 */}
      <MSheet open={themeOpen} title="外观与主题" caption="选哪套就切到哪套；浅色 / 深色各记住自己上次用的那套" onClose={() => setThemeOpen(false)}>
        {(["light", "dark"] as const).map((cat) => (
          <div key={cat} className={cat === "dark" ? "mt-3" : undefined}>
            <div className="m-t-cap mb-1.5 px-1">{cat === "light" ? "浅色" : "深色"}</div>
            <div className="m-group">
              {themes
                .filter((t) => t.category === cat)
                .map((t) => (
                  <PickRow
                    key={t.key}
                    label={
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{t.label}</span>
                        <span className="m-t-cap truncate font-normal">{t.description}</span>
                      </span>
                    }
                    icon={<ThemeSwatch colors={t.colors} />}
                    active={t.key === currentTheme?.key}
                    onClick={() => pickTheme(t)}
                  />
                ))}
            </div>
          </div>
        ))}
      </MSheet>

      <ActionSheet
        open={!!tabFor}
        title={tabFor ? `「${CELL_LABEL[tabFor.view] ?? tabFor.label}」放到底部 Tab` : ""}
        subtitle="底部有 4 个位置可换，「我的」固定在最右"
        items={tabItems}
        onClose={() => setTabFor(null)}
      />

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
        <div className="mt-2 text-xs text-[var(--m-ink3)]">
          {progress.total > 0
            ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`
            : "下载中…"}
        </div>
        <div className="mt-3 text-xs text-[var(--m-ink3)]">
          下载完成后会自动拉起系统安装器。请保持应用在前台。
        </div>
      </Modal>

    </div>
  );
}

/** 字节数转人类可读（下载进度用，保留一位小数） */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 全部功能的一格：活动栏同款图标 + 名字；已在底部 Tab 带点；数量角标 / 小字说明 */
function FeatureCell({
  item,
  label,
  inTab,
  badge,
  caption,
  onClick,
  onLongPress,
}: {
  item: ActivityItem;
  label: string;
  inTab: boolean;
  badge: number;
  caption?: string;
  onClick: () => void;
  onLongPress: () => void;
}) {
  const lp = useLongPress(onLongPress, { onClick });
  const icon = isValidElement(item.icon) ? cloneElement(item.icon as ReactElement<{ size?: number }>, { size: 22 }) : item.icon;
  return (
    <div
      {...lp}
      role="button"
      tabIndex={0}
      aria-label={item.label}
      className="flex min-h-[70px] cursor-pointer select-none flex-col items-center justify-center gap-2 py-3 text-[12px] active:opacity-70"
      style={{ WebkitTouchCallout: "none", color: "var(--m-ink2)" }}
    >
      <span className="relative flex">
        {icon}
        {badge > 0 && (
          <span className="m-badge m-num" aria-label={`${badge} 项待处理`}>
            {badge > 99 ? "99+" : badge}
          </span>
        )}
        {inTab && badge === 0 && <span className="absolute -top-1.5 -right-2.5 h-[7px] w-[7px] rounded-full" style={{ background: "var(--m-accent)" }} aria-label="已在底部 Tab" />}
      </span>
      <span className="leading-[18px]">{label}</span>
      {/* 4 列下格子窄，原来第二行的说明（「N 条」等）收进读屏文字 */}
      {caption && <span className="sr-only">{caption}</span>}
    </div>
  );
}

/** 桌面端才能用的设置：右侧写「桌面端」、不带箭头，点了说明原因 */
function DesktopOnlyRow({ icon, label, info }: { icon: ReactNode; label: string; info: string }) {
  return (
    <MRow icon={icon} right="桌面端" onClick={() => message.info(info)}>
      {label}
    </MRow>
  );
}

/** 主题小色卡：底色 + 主色 + 点缀色 */
function ThemeSwatch({ colors }: { colors: [string, string, string, string] }) {
  const [bg, primary, accent] = colors;
  return (
    <span className="relative inline-block h-6 w-6 overflow-hidden rounded-[var(--m-r-s)]" style={{ background: bg, boxShadow: "inset 0 0 0 1px var(--m-hair)" }}>
      <span className="absolute right-0 bottom-0 left-0 h-2" style={{ background: primary }} />
      <span className="absolute top-1 right-1 h-2 w-2 rounded-full" style={{ background: accent }} />
    </span>
  );
}
