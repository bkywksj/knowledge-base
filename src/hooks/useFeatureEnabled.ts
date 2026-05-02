import { useAppStore, type ActiveView } from "@/store";

/**
 * 核心视图（永远启用，不受设置里"功能模块"开关影响）。
 * 与 ActivityBar.tsx 的 `core: true` 标记保持同步——这两处一起改。
 */
const CORE_VIEWS: ReadonlySet<ActiveView> = new Set([
  "home",
  "notes",
  "search",
  "trash",
  "about",
]);

/**
 * 单个视图是否启用——核心永远 true，可选项查 store.enabledViews。
 *
 * 用法（组件里短路渲染）：
 * ```tsx
 * const aiEnabled = useFeatureEnabled("ai");
 * if (!aiEnabled) return null;
 * ```
 */
export function useFeatureEnabled(view: ActiveView): boolean {
  return useAppStore((s) => CORE_VIEWS.has(view) || s.enabledViews.has(view));
}

/**
 * 多视图同时启用判断——任意一项关闭即返回 false。
 *
 * 用于"跨模块依赖"场景：如"AI 规划今日"按钮同时依赖 ai + tasks。
 *
 * 用法：
 * ```tsx
 * const planTodayAvailable = useAllFeaturesEnabled(["ai", "tasks"]);
 * if (!planTodayAvailable) return null;
 * ```
 */
export function useAllFeaturesEnabled(views: ActiveView[]): boolean {
  return useAppStore((s) =>
    views.every((v) => CORE_VIEWS.has(v) || s.enabledViews.has(v)),
  );
}
