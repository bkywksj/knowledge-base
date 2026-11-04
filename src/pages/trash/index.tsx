import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Button,
  Checkbox,
  Pagination,
  Popconfirm,
  Modal,
  Spin,
  message,
} from "antd";
import { Trash2, RotateCcw, AlertTriangle, CheckSquare, FileText, Info } from "lucide-react";
import { folderApi, trashApi } from "@/lib/api";
import { useTabsStore } from "@/store/tabs";
import { EmptyState } from "@/components/ui/EmptyState";
import { relativeTime } from "@/lib/utils";
import type { Folder, PageResult, TrashNote } from "@/types";
import { useContextMenu } from "@/hooks/useContextMenu";
import {
  ContextMenuOverlay,
  type ContextMenuEntry,
} from "@/components/ui/ContextMenuOverlay";

/**
 * 回收站
 *
 * 列表 + 分页样式与 /notes 列表视图保持一致：白底卡包表格 + 外置分页。
 */
function DesktopTrashPage() {
  const [data, setData] = useState<PageResult<TrashNote>>({
    items: [],
    total: 0,
    page: 1,
    page_size: 12,
  });
  const [loading, setLoading] = useState(false);
  const [pageSize, setPageSize] = useState(12);
  /** 选中的笔记 id（仅当前页生效；翻页/批量操作后清空） */
  const [selectedIds, setSelectedIds] = useState<number[]>([]);

  const loadTrash = useCallback(async (page: number, size: number) => {
    setLoading(true);
    try {
      const result = await trashApi.list(page, size);
      setData(result);
      setSelectedIds([]); // 数据刷新后清空选择，避免跨页"幽灵选中"
    } catch (e) {
      message.error(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTrash(1, pageSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 文件夹 id → 名：列表行「原位置」用 */
  const [folderMap, setFolderMap] = useState<Map<number, string>>(new Map());
  useEffect(() => {
    folderApi
      .list()
      .then((list: Folder[]) => {
        const map = new Map<number, string>();
        const walk = (fl: Folder[]) => {
          for (const f of fl) {
            map.set(f.id, f.name);
            if (f.children?.length) walk(f.children);
          }
        };
        walk(list);
        setFolderMap(map);
      })
      .catch(() => {});
  }, []);

  async function handleRestore(id: number) {
    try {
      const toOriginal = await trashApi.restore(id);
      if (toOriginal) {
        message.success("已恢复到原文件夹");
      } else {
        message.warning("已恢复，但原文件夹已不存在，已放到根目录");
      }
      loadTrash(data.page, pageSize);
    } catch (e) {
      message.error(String(e));
    }
  }

  async function handlePermanentDelete(id: number) {
    try {
      await trashApi.permanentDelete(id);
      useTabsStore.getState().closeTab(id);
      message.success("已永久删除");
      loadTrash(data.page, pageSize);
    } catch (e) {
      message.error(String(e));
    }
  }

  // ─── 右键菜单 ────────────────────────────────
  const ctx = useContextMenu<{ id: number; title: string }>();

  const menuItems: ContextMenuEntry[] = useMemo(() => {
    const p = ctx.state.payload;
    if (!p) return [];
    return [
      {
        key: "restore",
        label: "恢复笔记",
        icon: <RotateCcw size={13} />,
        onClick: () => {
          ctx.close();
          void handleRestore(p.id);
        },
      },
      { type: "divider" },
      {
        key: "permanent-delete",
        label: "永久删除",
        icon: <Trash2 size={13} />,
        danger: true,
        onClick: () => {
          ctx.close();
          Modal.confirm({
            title: `永久删除「${p.title || "(无标题)"}」？`,
            content: "此操作不可恢复。",
            okText: "永久删除",
            okButtonProps: { danger: true },
            async onOk() {
              await handlePermanentDelete(p.id);
            },
          });
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.state.payload]);

  async function handleRestoreBatch() {
    if (selectedIds.length === 0) return;
    try {
      const { restored, toRoot } = await trashApi.restoreBatch(selectedIds);
      if (toRoot > 0) {
        message.success(
          `已恢复 ${restored} 条，其中 ${toRoot} 条原文件夹已不存在，落到根目录`,
        );
      } else {
        message.success(`已恢复 ${restored} 条到原文件夹`);
      }
      loadTrash(data.page, pageSize);
    } catch (e) {
      message.error(String(e));
    }
  }

  async function handlePermanentDeleteBatch() {
    if (selectedIds.length === 0) return;
    try {
      // 关闭对应 tab，避免编辑器残留指向已删笔记
      useTabsStore.getState().closeTabsByIds(selectedIds);
      const n = await trashApi.permanentDeleteBatch(selectedIds);
      message.success(`已永久删除 ${n} 条`);
      loadTrash(data.page, pageSize);
    } catch (e) {
      message.error(String(e));
    }
  }

  function handleEmptyTrash() {
    // 当前页面已加载的回收站 id，先收着用于清 tab
    const visibleIds = data.items.map((n) => n.id);
    Modal.confirm({
      title: "清空回收站",
      icon: <AlertTriangle size={20} style={{ color: "var(--ant-color-error)", marginRight: 8 }} />,
      content: "此操作将永久删除回收站中的所有笔记，且不可恢复。确定继续？",
      okText: "确认清空",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        try {
          const count = await trashApi.empty();
          // 兜底关 tab：当前页可见的 id 一定关掉；超过分页范围的"幽灵 tab"
          // 用户点击时编辑器会跳回 /notes，体验上不会崩
          if (visibleIds.length > 0) {
            useTabsStore.getState().closeTabsByIds(visibleIds);
          }
          message.success(`已清空 ${count} 篇笔记`);
          loadTrash(1, pageSize);
        } catch (e) {
          message.error(String(e));
        }
      },
    });
  }

  const allChecked = data.items.length > 0 && selectedIds.length === data.items.length;
  function toggleOne(id: number) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  return (
    <div
      className="kb-hidden-page"
      onContextMenu={(e) => {
        // 顶层兜底：列表行有自己的 onContextMenu 会先 preventDefault；
        // 其他位置统一吞 WebView 默认菜单。input 白名单留给搜索框等
        const t = e.target as HTMLElement;
        if (t.closest("input, textarea, [contenteditable='true']")) return;
        e.preventDefault();
      }}
    >
      {/* 顶栏（原型 .bar）：回收站 · N 篇 ｜ 清空回收站 */}
      <div className="kb-page-bar">
        <h1>回收站</h1>
        <span className="kb-trash-count">{data.total} 篇</span>
        <span className="flex-1" />
        {data.items.length > 0 && (
          <Button className="kb-danger-soft kb-bar-btn-p" icon={<Trash2 size={14} />} onClick={handleEmptyTrash}>
            清空回收站
          </Button>
        )}
      </div>

      <div className="kb-trash-tip">
        <Info size={14} />
        {/* 应用没有按时间自动清理回收站（原文案写「30 天后自动永久删除」与实际不符） */}
        提示：回收站里的笔记会一直保留，不会自动删除；可以随时恢复，或手动永久删除。
      </div>

      {/* 批量工具条：仅有选中时显示（原型 .selbar） */}
      {selectedIds.length > 0 && (
        <div className="kb-trash-selbar">
          <CheckSquare size={14} />
          <b>已选 {selectedIds.length} 篇</b>
          <span className="flex-1" />
          <Popconfirm
            title={`确认恢复 ${selectedIds.length} 条笔记？`}
            okText="恢复"
            onConfirm={handleRestoreBatch}
          >
            <Button size="small" className="kb-selbar-btn" icon={<RotateCcw size={13} />}>
              批量恢复
            </Button>
          </Popconfirm>
          <Popconfirm
            title={`确认永久删除 ${selectedIds.length} 条笔记？`}
            description="此操作不可恢复"
            okText="永久删除"
            okButtonProps={{ danger: true }}
            onConfirm={handlePermanentDeleteBatch}
          >
            <Button size="small" className="kb-danger-soft" icon={<Trash2 size={13} />}>
              批量永久删除
            </Button>
          </Popconfirm>
          <Button size="small" type="text" onClick={() => setSelectedIds([])}>
            取消选择
          </Button>
        </div>
      )}

      {data.total > 0 || loading ? (
        <section className="kb-cards-panel kb-hidden-list">
          {loading && data.items.length === 0 ? (
            <div className="flex justify-center py-10">
              <Spin />
            </div>
          ) : (
            <>
              {/* 本页全选 */}
              <label className="kb-trash-all">
                <Checkbox
                  checked={allChecked}
                  indeterminate={selectedIds.length > 0 && !allChecked}
                  onChange={(e) => setSelectedIds(e.target.checked ? data.items.map((n) => n.id) : [])}
                />
                全选本页
              </label>
              {data.items.map((n) => {
                const checked = selectedIds.includes(n.id);
                const folderName =
                  n.folder_id == null ? "未分类" : folderMap.get(n.folder_id) ?? "已删除的文件夹";
                return (
                  <div
                    key={n.id}
                    className={
                      "kb-hidden-row" +
                      (checked ? " is-picked" : "") +
                      (ctx.state.payload?.id === n.id ? " is-ctx" : "")
                    }
                    onClick={() => toggleOne(n.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      ctx.open(e.nativeEvent, { id: n.id, title: n.title });
                    }}
                  >
                    <span onClick={(e) => e.stopPropagation()}>
                      <Checkbox checked={checked} onChange={() => toggleOne(n.id)} />
                    </span>
                    <span className="kb-sr-ico is-err">
                      <FileText size={15} />
                    </span>
                    <div className="kb-sr-main">
                      <div className="kb-sr-title">{n.title || "(无标题)"}</div>
                      <div className="kb-sr-snippet is-one">
                        原位置：{folderName} · {n.word_count} 字
                      </div>
                    </div>
                    {/* 显示删除时间；老数据没有删除时间时退回「修改于」 */}
                    <span
                      className="kb-trash-time"
                      title={
                        (n.deleted_at ? `删除于 ${n.deleted_at.slice(0, 16)} · ` : "") +
                        `修改于 ${n.updated_at.slice(0, 16)}`
                      }
                    >
                      {n.deleted_at
                        ? `删除于 ${relativeTime(n.deleted_at)}`
                        : `修改于 ${relativeTime(n.updated_at)}`}
                    </span>
                    {/* 悬停操作（原操作列） */}
                    <div className="kb-hidden-acts" onClick={(e) => e.stopPropagation()}>
                      <Button
                        type="text"
                        size="small"
                        // 原型 .btn-s：浅紫底主色字
                        className="kb-act-soft"
                        icon={<RotateCcw size={13} />}
                        onClick={() => handleRestore(n.id)}
                      >
                        恢复
                      </Button>
                      <Popconfirm
                        title="确认永久删除？"
                        description="此操作不可恢复"
                        onConfirm={() => handlePermanentDelete(n.id)}
                      >
                        {/* 原型 .btn-d：浅红底红字 */}
                        <Button type="text" size="small" danger className="kb-act-danger" icon={<Trash2 size={13} />}>
                          永久删除
                        </Button>
                      </Popconfirm>
                    </div>
                  </div>
                );
              })}
            </>
          )}
          <div className="kb-hidden-pager">
            <Pagination
              current={data.page}
              pageSize={data.page_size}
              total={data.total}
              showTotal={(total) => `共 ${total} 篇`}
              showSizeChanger
              pageSizeOptions={["12", "20", "50", "100", "200"]}
              onChange={(page, size) => {
                if (size !== pageSize) setPageSize(size);
                loadTrash(page, size);
              }}
              size="small"
            />
          </div>
        </section>
      ) : (
        <EmptyState description="回收站为空" />
      )}

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

import { useIsMobile } from "@/hooks/useIsMobile";
import { MobileTrash } from "./MobileTrash";

export default function TrashPage() {
  const isMobile = useIsMobile();
  return isMobile ? <MobileTrash /> : <DesktopTrashPage />;
}
