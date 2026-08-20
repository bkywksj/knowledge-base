import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, Popconfirm, message, theme as antdTheme } from "antd";
import { Search as SearchIcon, Clock, X, Trash2, Copy, MinusCircle } from "lucide-react";
import { useAppStore } from "@/store";
import { useContextMenu } from "@/hooks/useContextMenu";
import {
  ContextMenuOverlay,
  type ContextMenuEntry,
} from "@/components/ui/ContextMenuOverlay";

/**
 * SearchPanel —— Activity Bar 模式下"搜索"视图的主面板。
 *
 * 职责：
 *   · 顶部：视图标题 + "清空历史"按钮
 *   · 最近搜索列表：点击重用（navigate 到 /search?q=xxx）；
 *     每条支持单条删除（hover 显示 X）；空态引导用户先搜一下
 *
 * 按文件夹 / 标签 / 时间 / 类型筛选已实现（P1-2），入口在搜索结果页
 * （`/search` 右上角「筛选」按钮）—— 筛选是"看着结果收窄"的动作，
 * 放在结果旁边比放在这个历史面板里更顺手。
 *
 * 进阶（未实现，占位给未来迭代）：
 *   · 保存的查询（存一组筛选条件复用）
 */
export function SearchPanel() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const currentQ = searchParams.get("q") ?? "";
  const { token } = antdTheme.useToken();

  const recentSearches = useAppStore((s) => s.recentSearches);
  const removeRecentSearch = useAppStore((s) => s.removeRecentSearch);
  const clearRecentSearches = useAppStore((s) => s.clearRecentSearches);

  function goToQuery(q: string) {
    navigate(`/search?q=${encodeURIComponent(q)}`);
  }

  // ─── 右键菜单 ────────────────────────────────
  const ctx = useContextMenu<{ q: string }>();

  const menuItems: ContextMenuEntry[] = useMemo(() => {
    const p = ctx.state.payload;
    if (!p) return [];
    return [
      {
        key: "copy",
        label: "复制查询词",
        icon: <Copy size={13} />,
        onClick: () => {
          ctx.close();
          navigator.clipboard
            .writeText(p.q)
            .then(() => message.success("已复制"))
            .catch((e) => message.error(`复制失败：${e}`));
        },
      },
      {
        key: "remove",
        label: "从历史中移除",
        icon: <MinusCircle size={13} />,
        onClick: () => {
          ctx.close();
          removeRecentSearch(p.q);
        },
      },
      { type: "divider" },
      {
        key: "clear-all",
        label: "清空所有历史",
        icon: <Trash2 size={13} />,
        danger: true,
        onClick: () => {
          ctx.close();
          clearRecentSearches();
          message.success("已清空");
        },
      },
    ];
  }, [ctx, removeRecentSearch, clearRecentSearches]);

  return (
    <div
      className="flex flex-col h-full"
      style={{ overflow: "hidden" }}
      // 顶层兜底：本面板无 input，整个面板的 WebView 默认菜单都吞掉。
      // 历史条目子级 onContextMenu 已自管 preventDefault + ctx.open
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 视图标题 */}
      <div
        className="flex items-center gap-2 px-3 py-2.5 shrink-0"
        style={{ borderBottom: `1px solid ${token.colorBorderSecondary}` }}
      >
        <SearchIcon size={15} style={{ color: token.colorPrimary }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: token.colorText }}>
          搜索
        </span>
        <div style={{ flex: 1 }} />
        {recentSearches.length > 0 && (
          <Popconfirm
            title="清空所有搜索历史？"
            okText="清空"
            cancelText="取消"
            onConfirm={clearRecentSearches}
          >
            <Button
              type="text"
              size="small"
              icon={<Trash2 size={14} />}
              style={{ width: 24, height: 24, padding: 0 }}
              title="清空历史"
            />
          </Popconfirm>
        )}
      </div>

      {/* 历史分组标题 */}
      <div
        className="flex items-center gap-1 shrink-0"
        style={{
          color: token.colorTextSecondary,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          padding: "10px 16px 6px",
        }}
      >
        <Clock size={12} />
        最近搜索
      </div>

      {/* 历史列表 */}
      <div
        className="flex-1 overflow-auto"
        style={{ minHeight: 0, padding: "0 8px 8px" }}
      >
        {recentSearches.length === 0 ? (
          <div
            className="text-center py-6"
            style={{ color: token.colorTextQuaternary, fontSize: 12 }}
          >
            暂无搜索历史
            <br />
            <span style={{ fontSize: 11 }}>在右侧输入关键词搜索</span>
          </div>
        ) : (
          recentSearches.map((q) => {
            const active = q === currentQ;
            const ctxActive = ctx.state.payload?.q === q;
            return (
              <div
                key={q}
                onClick={() => goToQuery(q)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  ctx.open(e.nativeEvent, { q });
                }}
                className="cursor-pointer group"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 10px",
                  borderRadius: 6,
                  background: active
                    ? `${token.colorPrimary}14`
                    : "transparent",
                  color: active ? token.colorPrimary : token.colorText,
                  fontSize: 13,
                  outline: ctxActive ? `1px solid ${token.colorPrimary}` : "none",
                  outlineOffset: -1,
                  transition: "background .15s, outline .1s",
                }}
              >
                <SearchIcon
                  size={12}
                  style={{
                    color: active ? token.colorPrimary : token.colorTextTertiary,
                    flexShrink: 0,
                  }}
                />
                <span className="truncate" style={{ flex: 1 }}>
                  {q}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeRecentSearch(q);
                  }}
                  aria-label="删除此条历史"
                  className="opacity-0 group-hover:opacity-100"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 18,
                    height: 18,
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    color: token.colorTextTertiary,
                    borderRadius: 3,
                    transition: "opacity .15s, background .15s",
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })
        )}
      </div>

      <ContextMenuOverlay
        open={!!ctx.state.payload}
        x={ctx.state.x}
        y={ctx.state.y}
        items={menuItems}
        onClose={ctx.close}
      />
    </div>
  );
}
