import { createContext, useContext, type ReactNode } from "react";
import { useUpdateChecker } from "@/hooks/useUpdateChecker";

type UpdaterValue = ReturnType<typeof useUpdateChecker>;

const UpdaterContext = createContext<UpdaterValue | null>(null);

interface ProviderProps {
  children: ReactNode;
  /** 是否启用自动检查 + 后台预下载（只在主窗口开启，避免子窗口重复下载）。 */
  enabled?: boolean;
}

/**
 * 全局更新状态单例。
 *
 * 把 useUpdateChecker 的状态机提升到 App 顶层，让顶栏徽章、关于页「检查更新」、
 * 托盘菜单共享同一份「后台预下载」状态——只下载一次，处处状态同步。
 */
export function UpdaterProvider({ children, enabled = true }: ProviderProps) {
  const updater = useUpdateChecker({ enabled });
  return <UpdaterContext.Provider value={updater}>{children}</UpdaterContext.Provider>;
}

/**
 * 消费全局更新状态。
 * 若不在 Provider 内（理论上不会发生），返回 null，调用方需自行判空。
 */
export function useUpdater(): UpdaterValue | null {
  return useContext(UpdaterContext);
}
