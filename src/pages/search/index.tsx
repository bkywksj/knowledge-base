import { useState, useRef, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Input, Button, Typography, Empty, Spin, Segmented, theme as antdTheme } from "antd";
import {
  Search as SearchIcon,
  NotebookText,
  CheckSquare,
  AlertTriangle,
  Check,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { searchApi, taskApi } from "@/lib/api";
import { MicButton } from "@/components/MicButton";
import { useAppStore } from "@/store";
import { highlightText, highlightSnippet } from "@/lib/highlight";
import type { SearchResult, TaskSearchHit } from "@/types";

const { Text } = Typography;

/** 笔记结果单行高度估算（含 title + snippet + 日期三行 + 上下 padding） */
const ESTIMATED_ROW_HEIGHT = 92;
/** "全部" 模式下笔记最多展示这么多条，再多就让用户切到「笔记」Tab 看全 */
const ALL_MODE_NOTES_PREVIEW = 20;

type Scope = "all" | "notes" | "tasks";

export default function SearchPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { token } = antdTheme.useToken();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [taskResults, setTaskResults] = useState<TaskSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // URL ?type= 决定 Scope：缺省 "all"
  const scope = ((searchParams.get("type") ?? "all") as Scope);

  // 虚拟滚动只在「笔记」单 Tab 下启用（"全部" 时只展示前 20 条预览，无需虚拟化）
  const scrollParentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: scope === "notes" ? results.length : 0,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 6,
  });

  // URL ?q= 驱动搜索：外部（SearchPanel 点历史 / 首页搜索框直达）改变 URL 时
  // 同步输入框并触发重搜；用户在输入框 typing 走下方本地 debounce，不走这里
  const urlQ = (searchParams.get("q") ?? "").trim();
  useEffect(() => {
    if (!urlQ) return;
    setQuery(urlQ);
    doSearch(urlQ);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlQ]);

  /** 并发拉笔记 + 待办；任意一边失败不阻塞另一边 */
  async function doSearch(keyword: string) {
    setLoading(true);
    setSearched(true);
    const [notes, tasks] = await Promise.all([
      searchApi.search(keyword).catch((e) => {
        console.error("笔记搜索失败:", e);
        return [] as SearchResult[];
      }),
      taskApi.search(keyword, 50).catch((e) => {
        console.error("待办搜索失败:", e);
        return [] as TaskSearchHit[];
      }),
    ]);
    setResults(notes);
    setTaskResults(tasks);
    // 历史只在拿到任一结果时才记（避免空查询污染）
    if (notes.length + tasks.length > 0) {
      useAppStore.getState().pushRecentSearch(keyword);
    }
    setLoading(false);
  }

  function handleInputChange(value: string) {
    setQuery(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!value.trim()) {
      setResults([]);
      setTaskResults([]);
      setSearched(false);
      return;
    }
    timerRef.current = setTimeout(() => {
      doSearch(value.trim());
    }, 300);
  }

  /** 切换 Tab：写回 URL，保持 ?q= 不变以维持历史/分享链接 */
  function setScope(next: Scope) {
    const sp = new URLSearchParams(searchParams);
    if (next === "all") sp.delete("type");
    else sp.set("type", next);
    setSearchParams(sp, { replace: true });
  }

  const showNotes = scope === "all" || scope === "notes";
  const showTasks = scope === "all" || scope === "tasks";
  const totalHits = results.length + taskResults.length;
  // "全部" 模式下笔记只展示 preview，超出由"查看全部"链接引导切到笔记 Tab
  const notesToRender =
    scope === "all" ? results.slice(0, ALL_MODE_NOTES_PREVIEW) : results;

  return (
    <div className="max-w-4xl mx-auto">
      {/* 搜索框：与首页 / 笔记列表搜索同款（普通 Input + 独立搜索按钮） */}
      <div className="mb-4 flex items-stretch gap-1.5" style={{ width: "100%" }}>
        <Input
          size="large"
          placeholder="搜索笔记内容 / 待办标题…"
          prefix={<SearchIcon size={18} />}
          suffix={
            <MicButton
              size="small"
              stripTrailingPunctuation
              onTranscribed={(text) =>
                handleInputChange(query ? `${query} ${text}` : text)
              }
            />
          }
          value={query}
          onChange={(e) => handleInputChange(e.target.value)}
          onPressEnter={() => handleInputChange(query)}
          allowClear
          style={{ flex: 1, borderRadius: 8 }}
        />
        <Button
          size="large"
          type="primary"
          onClick={() => handleInputChange(query)}
        >
          搜索
        </Button>
      </div>

      {/* 范围切换：仅在已搜索时显示，免得空状态有个孤零零的切换器 */}
      {searched && (
        <div className="mb-4 flex items-center justify-between">
          <Segmented
            value={scope}
            onChange={(v) => setScope(v as Scope)}
            options={[
              { value: "all", label: `全部 ${totalHits}` },
              { value: "notes", label: `笔记 ${results.length}` },
              { value: "tasks", label: `待办 ${taskResults.length}` },
            ]}
          />
          {!loading && totalHits > 0 && (
            <Text type="secondary" className="text-xs">
              共 {totalHits} 条结果
            </Text>
          )}
        </div>
      )}

      {/* 结果区 */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Spin size="large" tip="搜索中..." />
        </div>
      ) : !searched ? (
        <div className="flex flex-col items-center py-12">
          <SearchIcon size={48} style={{ opacity: 0.15 }} />
          <Text type="secondary" className="mt-4" style={{ fontSize: 14 }}>
            输入关键词同时搜索笔记与待办
          </Text>
        </div>
      ) : totalHits === 0 ? (
        <Empty
          description={`未找到与 "${query}" 相关的内容`}
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      ) : (
        // 单一滚动容器；笔记 Tab 下用虚拟化，其它 Tab 直接渲染
        <div
          ref={scrollParentRef}
          style={{
            height: "calc(100vh - 220px)",
            overflowY: "auto",
            contain: "strict",
          }}
        >
          {/* 待办分组（"全部" 或 "待办" Tab 显示） */}
          {showTasks && taskResults.length > 0 && (
            <section className="mb-6">
              <SectionHeader
                icon={<CheckSquare size={14} />}
                label="待办"
                count={taskResults.length}
                token={token}
              />
              <div>
                {taskResults.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    token={token}
                    keyword={query}
                    onClick={() => navigate(`/tasks?taskId=${task.id}`)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* 笔记分组 */}
          {showNotes && results.length > 0 && (
            <section>
              <SectionHeader
                icon={<NotebookText size={14} />}
                label="笔记"
                count={results.length}
                token={token}
              />
              {scope === "notes" ? (
                // 笔记 Tab：虚拟滚动（千级结果不卡）
                <div
                  style={{
                    height: virtualizer.getTotalSize(),
                    width: "100%",
                    position: "relative",
                  }}
                >
                  {virtualizer.getVirtualItems().map((vItem) => {
                    const item = results[vItem.index];
                    return (
                      <div
                        key={item.id}
                        data-index={vItem.index}
                        ref={virtualizer.measureElement}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${vItem.start}px)`,
                        }}
                      >
                        <NoteRow
                          item={item}
                          token={token}
                          keyword={query}
                          onClick={() => navigate(`/notes/${item.id}`)}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                // 全部 Tab：只渲染预览前 N 条，多余的引导切 Tab
                <>
                  {notesToRender.map((item) => (
                    <NoteRow
                      key={item.id}
                      item={item}
                      token={token}
                      keyword={query}
                      onClick={() => navigate(`/notes/${item.id}`)}
                    />
                  ))}
                  {results.length > ALL_MODE_NOTES_PREVIEW && (
                    <div className="py-2 text-center">
                      <a
                        onClick={() => setScope("notes")}
                        style={{ fontSize: 12, color: token.colorPrimary }}
                      >
                        查看全部 {results.length} 条笔记 →
                      </a>
                    </div>
                  )}
                </>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/** 分组标题 */
function SectionHeader({
  icon,
  label,
  count,
  token,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  token: ReturnType<typeof antdTheme.useToken>["token"];
}) {
  return (
    <div
      className="flex items-center gap-2 mb-2"
      style={{
        fontSize: 12,
        fontWeight: 600,
        color: token.colorTextSecondary,
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}
    >
      <span style={{ color: token.colorPrimary }}>{icon}</span>
      <span>
        {label} · {count}
      </span>
    </div>
  );
}

/** 笔记结果行（与原虚拟滚动样式一致） */
function NoteRow({
  item,
  token,
  keyword,
  onClick,
}: {
  item: SearchResult;
  token: ReturnType<typeof antdTheme.useToken>["token"];
  keyword: string;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: "12px 0",
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        cursor: "pointer",
        display: "flex",
        gap: 12,
      }}
    >
      <NotebookText size={20} style={{ marginTop: 4, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text
          ellipsis
          style={{ display: "block", maxWidth: 500, fontWeight: 500 }}
        >
          {highlightText(item.title, keyword)}
        </Text>
        <div
          style={{
            fontSize: 13,
            marginTop: 4,
            marginBottom: 4,
            // 2 行截断让高亮大概率落在可见区域，避免单行被截走
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            wordBreak: "break-word",
            lineHeight: "1.5",
          }}
        >
          {highlightSnippet(item.snippet, keyword)}
        </div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {item.updated_at.slice(0, 10)}
        </Text>
      </div>
    </div>
  );
}

/** 待办结果行（与 CommandPalette 风格一致） */
function TaskRow({
  task,
  token,
  keyword,
  onClick,
}: {
  task: TaskSearchHit;
  token: ReturnType<typeof antdTheme.useToken>["token"];
  keyword: string;
  onClick: () => void;
}) {
  const done = task.status === 1;
  const urgent = task.priority === 0;
  const due = task.dueDate?.slice(0, 10) ?? null;
  return (
    <div
      onClick={onClick}
      style={{
        padding: "10px 0",
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        cursor: "pointer",
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
      }}
    >
      {done ? (
        <Check size={18} style={{ color: token.colorSuccess, marginTop: 2, flexShrink: 0 }} />
      ) : urgent ? (
        <AlertTriangle
          size={18}
          style={{ color: token.colorError, marginTop: 2, flexShrink: 0 }}
        />
      ) : (
        <CheckSquare
          size={18}
          style={{ color: token.colorTextSecondary, marginTop: 2, flexShrink: 0 }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text
          ellipsis
          style={{
            display: "block",
            maxWidth: 600,
            fontWeight: 500,
            textDecoration: done ? "line-through" : undefined,
            color: done ? token.colorTextTertiary : undefined,
          }}
        >
          {task.title ? highlightText(task.title, keyword) : "无标题"}
        </Text>
        {(due || task.snippet) && (
          <div
            style={{
              fontSize: 12,
              color: token.colorTextDescription,
              marginTop: 2,
            }}
          >
            {due && <span style={{ marginRight: 8 }}>📅 {due}</span>}
            {task.snippet && (
              <span
                style={{
                  display: "inline-block",
                  maxWidth: 500,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  verticalAlign: "bottom",
                }}
              >
                {task.snippet}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
