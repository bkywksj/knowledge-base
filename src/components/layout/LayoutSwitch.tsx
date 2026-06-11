import { useIsMobile } from "@/hooks/useIsMobile";
import { AppLayout } from "./AppLayout";
import { MobileLayout } from "./MobileLayout";

/**
 * 根据平台/视口动态选 Layout：
 * - Tauri Mobile（Android/iOS）→ MobileLayout
 * - Tauri 桌面壳（Windows/macOS/Linux）→ AppLayout（永远桌面布局，忽略窗口宽度）
 * - 普通浏览器开发态 → 按 < 768px 视口兜底（方便模拟手机）
 *
 * 注意：仅在路由根节点（Router.tsx 的 element 处）使用一次。
 * 子页面组件不应该再判断 isMobile 来切 Layout，那会导致 mount/unmount 混乱。
 */
export function LayoutSwitch() {
  const isMobile = useIsMobile();
  return isMobile ? <MobileLayout /> : <AppLayout />;
}
