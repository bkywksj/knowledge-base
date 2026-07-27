import { lazy, Suspense, useEffect } from "react";
import { Segmented, Skeleton, theme as antdTheme } from "antd";
import { FolderTree, Tags as TagsIcon } from "lucide-react";
import { useAppStore } from "@/store";

const NotesPanel = lazy(() =>
  import("./NotesPanel").then((m) => ({ default: m.NotesPanel })),
);
const TagsPanel = lazy(() =>
  import("./TagsPanel").then((m) => ({ default: m.TagsPanel })),
);

/**
 * NotesTagsPanel —— 笔记面板的「文件夹 / 标签」双视图外壳。
 *
 * 用户反馈：标签和笔记本来就是同一批内容的两种组织方式，却要在 Activity Bar
 * 上来回切两个图标；希望在笔记面板顶部用标签页切换，右侧列表区不变。
 *
 * **刻意不合并两个面板的内部实现**：NotesPanel(2686 行) 和 TagsPanel(817 行)
 * 各自带着虚拟滚动、右键菜单、拖拽、inline 重命名，且结构同构（标题栏 → 搜索 → 树）。
 * 与其抽公共树组件重写（回归风险高、收益仅是少几百行），不如加这层薄壳按需渲染 ——
 * 两个面板一行不动，交互零变化。
 *
 * 两个子面板都是 lazy 的：只切到哪个才加载哪个，首屏不为没看的那个买单。
 */
export function NotesTagsPanel() {
  const { token } = antdTheme.useToken();
  const tab = useAppStore((s) => s.notesPanelTab);
  const setTab = useAppStore((s) => s.setNotesPanelTab);
  const activeView = useAppStore((s) => s.activeView);

  // Activity Bar 的「标签」/「笔记」图标仍然各自可用：点进来直接停在对应页签。
  // 只在 activeView 变化时对齐一次，之后用户在面板里手动切页签不会被拽回去。
  useEffect(() => {
    if (activeView === "tags") setTab("tags");
    else if (activeView === "notes") setTab("folders");
  }, [activeView, setTab]);

  return (
    <div className="flex flex-col h-full" style={{ overflow: "hidden" }}>
      <div
        className="shrink-0 px-2 pt-2 pb-1.5"
        style={{ borderBottom: `1px solid ${token.colorBorderSecondary}` }}
      >
        <Segmented
          block
          size="small"
          value={tab}
          onChange={(v) => setTab(v as "folders" | "tags")}
          options={[
            {
              value: "folders",
              label: (
                <span className="inline-flex items-center gap-1">
                  <FolderTree size={13} />
                  文件夹
                </span>
              ),
            },
            {
              value: "tags",
              label: (
                <span className="inline-flex items-center gap-1">
                  <TagsIcon size={13} />
                  标签
                </span>
              ),
            },
          ]}
        />
      </div>

      <div className="flex-1 min-h-0">
        <Suspense
          fallback={
            <div style={{ padding: "10px 12px" }}>
              <Skeleton active paragraph={{ rows: 5 }} title={false} />
            </div>
          }
        >
          {tab === "tags" ? <TagsPanel /> : <NotesPanel />}
        </Suspense>
      </div>
    </div>
  );
}
