import { useEffect, useState, useRef, useCallback } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { updaterApi } from "@/lib/api";

interface Options {
  /** 应用启动多久后第一次检查（毫秒）。默认 5000。 */
  initialDelay?: number;
  /** 后续轮询间隔（毫秒）。默认 30 分钟。 */
  interval?: number;
}

/**
 * 应用级自动检查更新。
 *
 * 启动后 initialDelay 后静默查一次；之后每 interval 再查一次。
 * 发现新版本后暴露 update 对象给 UI 使用，用户主动打开 Modal 触发下载。
 */
export function useUpdateChecker(options: Options = {}) {
  const { initialDelay = 5000, interval = 30 * 60 * 1000 } = options;
  const [update, setUpdate] = useState<Update | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const dismissedVersionRef = useRef<string | null>(null);

  const check = useCallback(async () => {
    try {
      const result = await updaterApi.checkUpdate();
      if (result && dismissedVersionRef.current !== result.version) {
        setUpdate(result);
      }
    } catch {
      // 静默失败：没网络 / 端点不通不影响应用运行
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(check, initialDelay);
    const id = setInterval(check, interval);
    return () => {
      clearTimeout(t);
      clearInterval(id);
    };
  }, [check, initialDelay, interval]);

  const openModal = useCallback(() => {
    if (update) setModalOpen(true);
  }, [update]);

  const closeModal = useCallback(() => {
    setModalOpen(false);
    // 本次会话里用户主动关掉 Modal 视为"暂不提醒这个版本"
    if (update) dismissedVersionRef.current = update.version;
  }, [update]);

  return { update, modalOpen, openModal, closeModal };
}
