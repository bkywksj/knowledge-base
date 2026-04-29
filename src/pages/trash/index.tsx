import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Table,
  Button,
  Divider,
  Typography,
  Space,
  Pagination,
  Popconfirm,
  Modal,
  message,
  theme as antdTheme,
} from "antd";
import { Trash2, RotateCcw, AlertTriangle } from "lucide-react";
import type { ColumnsType } from "antd/es/table";
import { trashApi } from "@/lib/api";
import { useTabsStore } from "@/store/tabs";
import { EmptyState } from "@/components/ui/EmptyState";
import { relativeTime } from "@/lib/utils";
import type { Note, PageResult } from "@/types";
import { useContextMenu } from "@/hooks/useContextMenu";
import {
  ContextMenuOverlay,
  type ContextMenuEntry,
} from "@/components/ui/ContextMenuOverlay";

const { Title, Text } = Typography;

/**
 * 回收站
 *
 * 列表 + 分页样式与 /notes 列表视图保持一致：白底卡包表格 + 外置分页。
 */
export default function TrashPage() {
  const { token } = antdTheme.useToken();

  const [data, setData] = useState<PageResult<Note>>({
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
      icon: <AlertTriangle size={20} style={{ color: "#ff4d4f", marginRight: 8 }} />,
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

  const columns: ColumnsType<Note> = useMemo(
    () => [
      {
        // 与 /notes 一致：跨页连续序号
        title: "#",
        key: "index",
        width: 44,
        align: "right" as const,
        render: (_: unknown, __: Note, index: number) => (
          <span style={{ color: token.colorTextTertiary, fontSize: 12 }}>
            {(data.page - 1) * data.page_size + index + 1}
          </span>
        ),
      },
      {
        title: "标题",
        dataIndex: "title",
        key: "title",
        ellipsis: true,
      },
      {
        title: "字数",
        dataIndex: "word_count",
        key: "word_count",
        width: 70,
        render: (val: number) => (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {val}
          </Text>
        ),
      },
      {
        title: "删除时间",
        dataIndex: "updated_at",
        key: "updated_at",
        width: 110,
        render: (val: string) => (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {relativeTime(val)}
          </Text>
        ),
      },
      {
        title: "操作",
        key: "action",
        width: 200,
        render: (_: unknown, record: Note) => (
          <Space size="small">
            <Button
              type="link"
              size="small"
              icon={<RotateCcw size={14} />}
              onClick={() => handleRestore(record.id)}
            >
              恢复
            </Button>
            <Popconfirm
              title="确认永久删除？"
              description="此操作不可恢复"
              onConfirm={() => handlePermanentDelete(record.id)}
            >
              <Button type="link" danger size="small" icon={<Trash2 size={14} />}>
                永久删除
              </Button>
            </Popconfirm>
          </Space>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.page, data.page_size, token.colorTextTertiary],
  );

  return (
    <div
      className="max-w-4xl mx-auto h-full flex flex-col min-h-0"
      onContextMenu={(e) => {
        // 顶层兜底：表格行有自己的 onContextMenu 会先 preventDefault；
        // 其他位置统一吞 WebView 默认菜单。input 白名单留给搜索框等
        const t = e.target as HTMLElement;
        if (t.closest("input, textarea, [contenteditable='true']")) return;
        e.preventDefault();
      }}
    >
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between mb-2 flex-shrink-0">
        <Title level={3} style={{ margin: 0, lineHeight: "32px" }}>
          <span className="flex items-center gap-2">
            <Trash2 size={22} />
            回收站
          </span>
        </Title>
        {data.items.length > 0 && (
          <Button danger onClick={handleEmptyTrash}>
            清空回收站
          </Button>
        )}
      </div>

      <div className="flex-shrink-0" style={{ marginBottom: 12, lineHeight: 1.6 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          提示：回收站中的笔记将在 30 天后自动永久删除。
        </Text>
      </div>

      {/* 批量工具条：仅有选中时显示，与 /notes 风格一致 */}
      {selectedIds.length > 0 && (
        <div
          className="mb-2 flex items-center gap-2 flex-shrink-0"
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            background: token.colorPrimaryBg,
            color: token.colorPrimary,
            border: `1px solid ${token.colorPrimaryBorder}`,
          }}
        >
          <span style={{ fontSize: 13 }}>已选 {selectedIds.length} 条</span>
          <Divider orientation="vertical" />
          <Popconfirm
            title={`确认恢复 ${selectedIds.length} 条笔记？`}
            okText="恢复"
            onConfirm={handleRestoreBatch}
          >
            <Button size="small" type="primary" icon={<RotateCcw size={14} />}>
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
            <Button size="small" danger icon={<Trash2 size={14} />}>
              批量永久删除
            </Button>
          </Popconfirm>
          <Button size="small" onClick={() => setSelectedIds([])}>
            取消选择
          </Button>
        </div>
      )}

      {data.total > 0 || loading ? (
        // 与 /notes 一样：表格 + 分页条共享同一个白色卡片，短列表底下不再露背景
        <div
          className="flex-1 flex flex-col min-h-0"
          style={{
            background: token.colorBgContainer,
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          <div className="flex-1 min-h-0 overflow-auto">
            <Table
              columns={columns}
              dataSource={data.items}
              rowKey="id"
              loading={loading}
              size="small"
              pagination={false}
              sticky
              rowSelection={{
                selectedRowKeys: selectedIds,
                onChange: (keys) => setSelectedIds(keys.map((k) => Number(k))),
                columnWidth: 40,
              }}
              onRow={(record) => ({
                onContextMenu: (e) => {
                  e.preventDefault();
                  ctx.open(e.nativeEvent, {
                    id: record.id,
                    title: record.title,
                  });
                },
                // 用整行背景高亮替代 outline：antd Table 的 tr 之间有 1px
                // border-bottom，outline 会被遮挡显示不全；background 不受影响
                style:
                  ctx.state.payload?.id === record.id
                    ? { background: token.colorPrimaryBg }
                    : undefined,
              })}
            />
          </div>
          <div className="flex-shrink-0 flex justify-end items-center px-3 py-2">
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
        </div>
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
