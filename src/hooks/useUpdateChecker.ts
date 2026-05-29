import { useEffect, useState, useRef, useCallback } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { updaterApi } from "@/lib/api";

/**
 * 更新生命周期状态机。
 *
 * idle        无可用更新（或检查失败静默忽略）
 * checking    正在检查（仅手动检查时短暂经过）
 * available   发现新版本，尚未下载完成（自动后台下载会立即把它推向 downloading）
 * downloading 后台静默下载中（只下载、不安装）
 * ready       已下载完，字节在本地待命，点重启即可秒装
 * installing  正在安装并重启
 * error       下载/安装失败，可在 Modal 里重试或走镜像手动下载
 */
export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

interface Options {
  /** 应用启动多久后第一次检查（毫秒）。默认 5000。 */
  initialDelay?: number;
  /** 后续轮询间隔（毫秒）。默认 30 分钟。 */
  interval?: number;
  /**
   * 是否启用自动检查 + 后台下载。默认 true。
   * 多窗口场景下只让主窗口启用，避免每个子窗口都重复后台下载同一个更新包。
   */
  enabled?: boolean;
}

/**
 * 应用级自动检查 + 后台预下载更新。
 *
 * 设计目标：用户「点重启就秒装」，不用干等下载。
 * - 启动 initialDelay 后静默 check；之后每 interval 再 check 一次。
 * - 一旦发现新版本，**立即在后台静默 `download()`（只下不装）**，把更新包字节下到本地。
 * - 下载完进入 ready，UI（徽章/Modal）提示「重启以更新」。
 * - 用户点重启时走 `install()`（复用已下载好的字节，不二次下载）+ `relaunch()`。
 *
 * Update 对象用 ref 跨渲染保活：download() 下好的字节绑定在这个实例上，
 * install() 必须用同一个实例才能复用，绝不能重新 check() 拿新实例。
 */
export function useUpdateChecker(options: Options = {}) {
  const { initialDelay = 5000, interval = 30 * 60 * 1000, enabled = true } = options;

  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhaseState] = useState<UpdatePhase>("idle");
  const [progress, setProgress] = useState(0);
  const [downloadedSize, setDownloadedSize] = useState(0);
  const [totalSize, setTotalSize] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  // Update 实例保活：download() 的字节绑在它身上，install() 要用同一个。
  const updateRef = useRef<Update | null>(null);
  // phase 镜像到 ref，避免轮询闭包读到过期的 phase。
  const phaseRef = useRef<UpdatePhase>("idle");

  const setPhase = useCallback((p: UpdatePhase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);

  /** 后台下载更新包（只下载、不安装）。下载完进入 ready。 */
  const startDownload = useCallback(async () => {
    const u = updateRef.current;
    if (!u) return;
    // 正在下载 / 已下完 / 正在装，不重复触发。
    if (phaseRef.current === "downloading" || phaseRef.current === "installing") return;

    setPhase("downloading");
    setProgress(0);
    setDownloadedSize(0);
    setTotalSize(0);
    setError(null);

    try {
      let total = 0;
      let done = 0;
      await u.download((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          setTotalSize(total);
        } else if (event.event === "Progress") {
          done += event.data.chunkLength;
          setDownloadedSize(done);
          // contentLength 为权威总大小；累加值偶有虚高（tauri 进度事件特性），
          // 百分比 clamp 到 100，避免出现「138%」「已下载 > 总」的观感问题。
          if (total > 0) setProgress(Math.min(100, Math.round((done / total) * 100)));
        } else if (event.event === "Finished") {
          setProgress(100);
        }
      });
      setPhase("ready");
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  }, [setPhase]);

  /** 安装已下载好的更新并重启（秒装，复用 download() 的字节）。 */
  const installAndRelaunch = useCallback(async () => {
    const u = updateRef.current;
    if (!u || phaseRef.current !== "ready") return;
    setPhase("installing");
    setError(null);
    try {
      await u.install();
      await relaunch();
    } catch (e) {
      // 安装失败回退到 ready，允许用户重试或走镜像手动下载。
      setError(String(e));
      setPhase("ready");
    }
  }, [setPhase]);

  /** 内部统一的检查逻辑。manual=true 时无视轮询节流并自动弹 Modal。 */
  const runCheck = useCallback(
    async (manual: boolean): Promise<{ hasUpdate: boolean; error?: string }> => {
      // 已经在处理某个版本（下载中/已就绪/安装中）：手动点就直接把 Modal 打开看进度，
      // 自动轮询则直接跳过，别打断正在进行的下载。
      if (
        updateRef.current &&
        (phaseRef.current === "available" ||
          phaseRef.current === "downloading" ||
          phaseRef.current === "ready" ||
          phaseRef.current === "installing" ||
          phaseRef.current === "error")
      ) {
        if (manual) setModalOpen(true);
        return { hasUpdate: true };
      }

      try {
        if (manual) setPhase("checking");
        const result = await updaterApi.checkUpdate();
        if (result) {
          updateRef.current = result;
          setUpdate(result);
          setPhase("available");
          if (manual) setModalOpen(true);
          // 发现即后台下载，用户无需等待。
          void startDownload();
          return { hasUpdate: true };
        }
        setPhase("idle");
        return { hasUpdate: false };
      } catch (e) {
        // 自动检查静默失败（没网/端点不通不影响应用运行）；手动检查把错误回传给调用方。
        if (manual) setPhase("idle");
        return { hasUpdate: false, error: String(e) };
      }
    },
    [setPhase, startDownload]
  );

  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(() => void runCheck(false), initialDelay);
    const id = setInterval(() => void runCheck(false), interval);
    return () => {
      clearTimeout(t);
      clearInterval(id);
    };
  }, [enabled, runCheck, initialDelay, interval]);

  const openModal = useCallback(() => {
    if (updateRef.current) setModalOpen(true);
  }, []);

  const closeModal = useCallback(() => {
    // 仅隐藏弹窗：下载/就绪状态保留，徽章继续提示，用户随时可再点开重启。
    setModalOpen(false);
  }, []);

  /**
   * 用户手动触发检查（托盘菜单「检查更新…」）。
   * 有更新时弹出 Modal；已是最新或失败时由调用方给出反馈。
   */
  const checkManually = useCallback(
    () => runCheck(true),
    [runCheck]
  );

  return {
    update,
    phase,
    progress,
    downloadedSize,
    totalSize,
    error,
    modalOpen,
    openModal,
    closeModal,
    checkManually,
    startDownload,
    installAndRelaunch,
  };
}
