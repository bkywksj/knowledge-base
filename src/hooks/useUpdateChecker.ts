import { useEffect, useState, useRef, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { message } from "antd";
import { configApi, updaterApi, UPDATER_STATE_EVENT } from "@/lib/api";
import { flushSettingsToDisk } from "@/store";
import type { UpdaterPhase, UpdaterSnapshot } from "@/types";

/** app_config 键："0" = 关闭自动检查 + 后台下载；缺省 / 其它值 = 开启。 */
const AUTO_CHECK_KEY = "update.auto_check";
/** app_config 键：更新包下好后什么时候装。缺省 = prompt。 */
const INSTALL_TIMING_KEY = "update.install_timing";
/** app_config 键：弹窗里点了「下次启动时安装」的那个版本号（只对这一版生效，不改上面的设置） */
const INSTALL_ONCE_KEY = "update.install_next_launch_version";

/**
 * - prompt：下好后提示，用户点「立即重启」才装
 * - next_launch：下好后不打扰，下次启动应用时自动安装
 */
export type InstallTiming = "prompt" | "next_launch";

/** 兼容旧名：各组件按这个名字引用更新状态 */
export type UpdatePhase = UpdaterPhase;

/** 弹窗 / 徽章要显示的新版本信息 */
export interface UpdateInfo {
  version: string;
  body: string | null;
}

/**
 * 每次自动 tick 现读配置而不是缓存：设置页可能在子窗口里改，主窗口的定时器
 * 要能立刻感知；读失败（键不存在）按默认开启处理。
 */
async function readAutoCheck(): Promise<boolean> {
  try {
    return (await configApi.get(AUTO_CHECK_KEY)) !== "0";
  } catch {
    return true;
  }
}

async function readInstallTiming(): Promise<InstallTiming> {
  try {
    return (await configApi.get(INSTALL_TIMING_KEY)) === "next_launch" ? "next_launch" : "prompt";
  } catch {
    return "prompt";
  }
}

const EMPTY: UpdaterSnapshot = {
  phase: "idle",
  version: null,
  body: null,
  downloaded: 0,
  total: 0,
  speed: 0,
  source: null,
  notice: null,
  error: null,
  failures: [],
  restored: false,
};

interface Options {
  /** 应用启动多久后第一次检查（毫秒）。默认 5000。 */
  initialDelay?: number;
  /** 后续轮询间隔（毫秒）。默认 30 分钟。 */
  interval?: number;
  /**
   * 是否由本窗口负责自动检查。默认 true。多窗口时只让主窗口开；
   * 状态在 Rust 只有一份，其它窗口照样能看到进度。
   * 同时还要用户没在设置页关掉「自动更新」（app_config `update.auto_check`）。
   */
  enabled?: boolean;
}

/**
 * 应用级更新状态。检查、下载、验签、安装都在 Rust（services::updater_download），
 * 这里只订阅 `updater://state` 事件把状态镜像出来，再提供几个按钮动作。
 *
 * 设计目标：用户「点重启就秒装」，不用干等下载，也不被打扰。
 * - 启动 initialDelay 后静默检查，之后每 interval 再查一次；发现新版本立即后台下载；
 * - 下载断了自动续传、换源；下完立刻验签；下好的包跨重启保留；
 * - 只有用户手动检查才弹窗，自动检查只更新右上角徽章；
 * - 安装时机可选「提示我重启」或「下次启动时自动安装」。
 */
export function useUpdateChecker(options: Options = {}) {
  const { initialDelay = 5000, interval = 30 * 60 * 1000, enabled = true } = options;

  const [snap, setSnap] = useState<UpdaterSnapshot>(EMPTY);
  const [modalOpen, setModalOpen] = useState(false);
  const [autoCheck, setAutoCheck] = useState(true);
  const [installTiming, setInstallTimingState] = useState<InstallTiming>("prompt");
  const [installOnceVersion, setInstallOnceVersion] = useState<string | null>(null);
  // 「下次启动时安装」每次启动只尝试一次，装失败就停在已就绪，别反复拉起安装器
  const launchInstallTried = useRef(false);

  // 订阅 Rust 的状态广播；挂载时先取一次，窗口晚打开 / 组件重挂载也能对齐
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<UpdaterSnapshot>(UPDATER_STATE_EVENT, (e) => setSnap(e.payload)).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    // 移动端没有这些命令，失败按「无更新」处理
    updaterApi.state().then((s) => !disposed && setSnap(s)).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const installAndRelaunch = useCallback(async () => {
    try {
      // install 会拉起安装器，安装器为了替换 exe 必须先结束本进程 —— 此时还没落盘的
      // 设置改动就永久丢了（用户观感就是"更新之后设置被重置"）。先同步刷一次。
      // 刷盘失败不该挡住更新：settings 是次要数据，装不上新版本才是大事。
      await flushSettingsToDisk().catch(() => {});
      await updaterApi.install();
      // Windows 上走不到这里（安装器已结束本进程）；macOS / Linux 装完要自己重启
      await relaunch();
    } catch (e) {
      // 失败原因 Rust 已写进状态（回到 ready + error），弹窗里会显示
      console.warn("[updater] 安装失败", e);
    }
  }, []);

  // 已就绪且选了「下次启动时安装」（设置项，或弹窗里只对这一版点的）
  const installOnNextLaunch =
    snap.version !== null && (installTiming === "next_launch" || installOnceVersion === snap.version);

  // 下次启动时安装：本次启动恢复出上次下好的包，且用户选了这个时机，就直接装
  useEffect(() => {
    if (!enabled || launchInstallTried.current) return;
    if (snap.phase !== "ready" || !snap.restored || !installOnNextLaunch) return;
    launchInstallTried.current = true;
    message.loading({ content: `正在安装上次下载好的更新 v${snap.version}…`, duration: 0, key: "updater-launch-install" });
    void installAndRelaunch().finally(() => message.destroy("updater-launch-install"));
  }, [enabled, snap.phase, snap.restored, snap.version, installOnNextLaunch, installAndRelaunch]);

  /** 内部统一的检查逻辑。manual=true 时发现新版本自动弹 Modal。 */
  const runCheck = useCallback(
    async (manual: boolean): Promise<{ hasUpdate: boolean; error?: string }> => {
      try {
        // 手动检查也后台下载：用户点检查就是想更新。自动检查走到这里说明自动更新开着
        const s = await updaterApi.check(true);
        setSnap(s);
        const hasUpdate = s.version !== null;
        if (manual && hasUpdate) setModalOpen(true);
        return { hasUpdate };
      } catch (e) {
        // 自动检查静默失败（没网/端点不通不影响应用运行）；手动检查把错误回传给调用方。
        return { hasUpdate: false, error: String(e) };
      }
    },
    []
  );

  /** 自动检查入口：用户关了开关就整个跳过（不检查、不下载）。 */
  const autoTick = useCallback(async () => {
    if (!(await readAutoCheck())) return;
    await runCheck(false);
  }, [runCheck]);

  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(() => void autoTick(), initialDelay);
    const id = setInterval(() => void autoTick(), interval);
    return () => {
      clearTimeout(t);
      clearInterval(id);
    };
  }, [enabled, autoTick, initialDelay, interval]);

  useEffect(() => {
    void readAutoCheck().then(setAutoCheck);
    void readInstallTiming().then(setInstallTimingState);
    configApi.get(INSTALL_ONCE_KEY).then((v) => setInstallOnceVersion(v || null)).catch(() => {});
  }, []);

  /** 设置页开关：持久化后更新状态；从关到开时立刻检查一次，不用等下个周期。 */
  const setAutoCheckEnabled = useCallback(
    async (next: boolean) => {
      await configApi.set(AUTO_CHECK_KEY, next ? "1" : "0");
      setAutoCheck(next);
      if (next && enabled) void runCheck(false);
    },
    [enabled, runCheck]
  );

  /** 设置页「安装时机」 */
  const setInstallTiming = useCallback(async (next: InstallTiming) => {
    await configApi.set(INSTALL_TIMING_KEY, next);
    setInstallTimingState(next);
  }, []);

  /** 弹窗「下次启动时安装」：只对当前这个版本生效 */
  const installCurrentOnNextLaunch = useCallback(async () => {
    if (!snap.version) return;
    await configApi.set(INSTALL_ONCE_KEY, snap.version);
    setInstallOnceVersion(snap.version);
  }, [snap.version]);

  const openModal = useCallback(() => {
    setModalOpen(true);
  }, []);

  const closeModal = useCallback(() => {
    // 仅隐藏弹窗：下载/就绪状态保留，徽章继续提示，用户随时可再点开重启。
    setModalOpen(false);
  }, []);

  /**
   * 用户手动触发检查（托盘菜单「检查更新…」、右上角版本号、设置页、关于页）。
   * 有更新时弹出 Modal；已是最新或失败时由调用方给出反馈。
   */
  const checkManually = useCallback(() => runCheck(true), [runCheck]);

  // 按钮动作：失败原因由 Rust 写进状态，这里只兜住 reject
  const startDownload = useCallback(() => {
    updaterApi.start().then(setSnap).catch((e) => message.error(`开始下载失败：${e}`));
  }, []);
  const pauseDownload = useCallback(() => {
    updaterApi.pause().then(setSnap).catch(() => {});
  }, []);
  const cancelDownload = useCallback(() => {
    updaterApi.cancel().then(setSnap).catch(() => {});
  }, []);

  const update: UpdateInfo | null = snap.version ? { version: snap.version, body: snap.body } : null;
  const progress = snap.total > 0 ? Math.min(100, Math.floor((snap.downloaded / snap.total) * 100)) : 0;

  return {
    update,
    phase: snap.phase,
    progress,
    downloadedSize: snap.downloaded,
    totalSize: snap.total,
    speed: snap.speed,
    source: snap.source,
    notice: snap.notice,
    error: snap.error,
    failures: snap.failures,
    modalOpen,
    autoCheck,
    setAutoCheckEnabled,
    installTiming,
    setInstallTiming,
    installOnNextLaunch,
    installCurrentOnNextLaunch,
    openModal,
    closeModal,
    checkManually,
    startDownload,
    pauseDownload,
    cancelDownload,
    installAndRelaunch,
  };
}
