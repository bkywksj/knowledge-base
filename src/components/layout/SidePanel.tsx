import { lazy, Suspense } from "react";
import { Skeleton, theme as antdTheme } from "antd";
import { useAppStore } from "@/store";
import type { ActiveView } from "@/store";

/**
 * SidePanel —— Activity Bar 模式下 ActivityBar 右侧的主面板。
 *
 * 根据 activeView 分发到具体 panel 子组件。
 * 拥有面板的视图见 VIEWS_WITH_PANEL；其他视图（home/graph/ai/prompts/
 * about/trash）点图标直接展开主区,AppLayout 会把 SidePanel 宽度置 0。
 *
 * 性能优化：每个 Panel 都是 React.lazy 按需加载，避免首屏一次性付清所有
 * antd Tree/Modal/Dropdown 等重型子组件的解析开销。第一次切到某个 view
 * 时 Suspense 会先显示 fallback 骨架屏，chunk 加载完后再 mount 真实组件。
 */

// 各 panel 都是 named export，需要在 .then 里转成 default export 给 lazy 用
const NotesPanel = lazy(() =>
  import("./panels/NotesPanel").then((m) => ({ default: m.NotesPanel })),
);
const TagsPanel = lazy(() =>
  import("./panels/TagsPanel").then((m) => ({ default: m.TagsPanel })),
);
const DailyPanel = lazy(() =>
  import("./panels/DailyPanel").then((m) => ({ default: m.DailyPanel })),
);
const SearchPanel = lazy(() =>
  import("./panels/SearchPanel").then((m) => ({ default: m.SearchPanel })),
);
const TasksPanel = lazy(() =>
  import("./panels/TasksPanel").then((m) => ({ default: m.TasksPanel })),
);
const HiddenPanel = lazy(() =>
  import("./panels/HiddenPanel").then((m) => ({ default: m.HiddenPanel })),
);

/** 哪些视图拥有独立 SidePanel 内容 */
const VIEWS_WITH_PANEL = new Set<ActiveView>([
  "notes",
  "tags",
  "tasks",
  "search",
  "daily",
  "hidden",
]);

export function viewHasPanel(view: ActiveView): boolean {
  return VIEWS_WITH_PANEL.has(view);
}

/** Panel 加载中的占位骨架屏 —— 视觉与各 panel 顶部布局对齐 */
function PanelFallback() {
  const { token } = antdTheme.useToken();
  return (
    <div className="flex flex-col h-full" style={{ overflow: "hidden" }}>
      <div
        style={{
          padding: "10px 12px",
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Skeleton.Input active size="small" style={{ width: 80, height: 16 }} />
      </div>
      <div style={{ padding: "10px 12px", flex: 1 }}>
        <Skeleton
          active
          paragraph={{ rows: 5, width: ["80%", "60%", "70%", "50%", "65%"] }}
          title={false}
        />
      </div>
    </div>
  );
}

export function SidePanel() {
  const activeView = useAppStore((s) => s.activeView);

  let node: React.ReactNode = null;
  switch (activeView) {
    case "notes":
      node = <NotesPanel />;
      break;
    case "tags":
      node = <TagsPanel />;
      break;
    case "daily":
      node = <DailyPanel />;
      break;
    case "search":
      node = <SearchPanel />;
      break;
    case "tasks":
      node = <TasksPanel />;
      break;
    case "hidden":
      node = <HiddenPanel />;
      break;
    default:
      // 无面板视图（home/graph/ai/prompts/about/trash）
      // AppLayout 会基于 viewHasPanel() 把 SidePanel 宽度置 0
      return null;
  }

  return <Suspense fallback={<PanelFallback />}>{node}</Suspense>;
}
