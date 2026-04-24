import { theme as antdTheme } from "antd";
import { useAppStore } from "@/store";
import type { ActiveView } from "@/store";
import { NotesPanel } from "./panels/NotesPanel";
import { TagsPanel } from "./panels/TagsPanel";
import { DailyPanel } from "./panels/DailyPanel";

/**
 * SidePanel —— Activity Bar 模式下 ActivityBar 右侧的主面板。
 *
 * 根据 activeView 分发到具体 panel 子组件：
 *   · notes → NotesPanel（文件夹树 + 新建 + 导入）
 *   · tags / tasks / search → 预留位（后续迭代填内容）
 *   · 其他视图（home/daily/graph/ai/prompts/about/trash）→ 无面板
 *
 * 是否有面板通过 viewHasPanel() 导出，AppLayout 用它决定布局宽度。
 */

/** 哪些视图拥有独立 SidePanel 内容（其他视图点图标直接展开主区） */
const VIEWS_WITH_PANEL = new Set<ActiveView>([
  "notes",
  "tags",
  "tasks",
  "search",
  "daily",
]);

export function viewHasPanel(view: ActiveView): boolean {
  return VIEWS_WITH_PANEL.has(view);
}

function ComingSoonPanel({ title }: { title: string }) {
  const { token } = antdTheme.useToken();
  return (
    <div
      className="flex flex-col items-center justify-center h-full px-6 text-center"
      style={{ color: token.colorTextTertiary, fontSize: 12 }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: token.colorText }}>
        {title}
      </div>
      <div>本视图的面板正在重构中</div>
      <div style={{ marginTop: 4 }}>主区已展示完整内容</div>
    </div>
  );
}

export function SidePanel() {
  const activeView = useAppStore((s) => s.activeView);

  switch (activeView) {
    case "notes":
      return <NotesPanel />;
    case "tags":
      return <TagsPanel />;
    case "daily":
      return <DailyPanel />;
    case "tasks":
      return <ComingSoonPanel title="待办" />;
    case "search":
      return <ComingSoonPanel title="搜索" />;
    default:
      // 无面板视图（home/daily/graph/ai/prompts/about/trash）
      // AppLayout 会基于 viewHasPanel() 把 SidePanel 宽度置 0
      return null;
  }
}
