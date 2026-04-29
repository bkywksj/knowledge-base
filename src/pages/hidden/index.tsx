import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Button,
  Modal,
  Pagination,
  Popconfirm,
  Space,
  Table,
  Typography,
  message,
  theme as antdTheme,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  Eye,
  EyeOff,
  Folder as FolderIcon,
  ExternalLink,
  Trash2,
} from "lucide-react";
import { folderApi, hiddenApi, noteApi, trashApi } from "@/lib/api";
import { EmptyState } from "@/components/ui/EmptyState";
import { relativeTime } from "@/lib/utils";
import type { Folder, Note, PageResult } from "@/types";
import { useContextMenu } from "@/hooks/useContextMenu";
import {
  ContextMenuOverlay,
  type ContextMenuEntry,
} from "@/components/ui/ContextMenuOverlay";

const { Title, Text } = Typography;

/** 把 URL 的 ?folder= 参数解析成 list API 的 opts */
function parseFolderParam(raw: string | null): {
  label: string;
  opts: Parameters<typeof hiddenApi.list>[0];
} {
  if (!raw) return { label: "全部隐藏笔记", opts: {} };
  if (raw === "uncategorized")
    return { label: "未分类", opts: { uncategorized: true } };
  const id = Number(raw);
  if (Number.isFinite(id) && id > 0) {
    return { label: "", opts: { folderId: id } }; // label 由调用方按 folderMap 反查
  }
  return { label: "全部隐藏笔记", opts: {} };
}

/**
 * 隐藏笔记页（T-003）
 *
 * 筛选状态走 URL ?folder= ：
 * - 不传 → 全部
 * - "uncategorized" → 仅未分类
 * - "<id>" → 仅该目录（不递归子目录）
 *
 * 侧边栏 HiddenPanel 写 URL，本页读 URL，两者通过 searchParams 同步。
 */
export default function HiddenPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { token } = antdTheme.useToken();

  const [data, setData] = useState<PageResult<Note>>({
    items: [],
    total: 0,
    page: 1,
    page_size: 12,
  });
  const [loading, setLoading] = useState(false);
  const [pageSize, setPageSize] = useState(12);

  // 全文件夹 id→name 映射（用于"目录"列展示 + 当前筛选名）
  const [folderMap, setFolderMap] = useState<Map<number, string>>(new Map());

  const folderParam = searchParams.get("folder");
  const parsed = useMemo(() => parseFolderParam(folderParam), [folderParam]);

  /** 当前筛选的展示名 */
  const currentFilterLabel = useMemo(() => {
    if (parsed.label) return parsed.label;
    // 数字 id 走 folderMap 反查
    if (parsed.opts?.folderId != null) {
      return folderMap.get(parsed.opts.folderId) ?? `(已删除 #${parsed.opts.folderId})`;
    }
    return "全部隐藏笔记";
  }, [parsed, folderMap]);

  /** 拉列表 */
  const loadList = useCallback(
    async (page: number, size: number) => {
      setLoading(true);
      try {
        const result = await hiddenApi.list({
          page,
          pageSize: size,
          ...parsed.opts,
        });
        setData(result);
      } catch (e) {
        message.error(String(e));
      } finally {
        setLoading(false);
      }
    },
    [parsed.opts],
  );

  // 启动 + URL 变化时重拉到第 1 页
  useEffect(() => {
    void loadList(1, pageSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderParam]);

  // 启动加载文件夹映射
  useEffect(() => {
    folderApi
      .list()
      .then((list: Folder[]) => {
        const map = new Map<number, string>();
        function flatten(flist: Folder[]) {
          for (const f of flist) {
            map.set(f.id, f.name);
            if (f.children?.length) flatten(f.children);
          }
        }
        flatten(list);
        setFolderMap(map);
      })
      .catch((e) => console.warn("[hidden] 加载文件夹失败:", e));
  }, []);

  async function handleUnhide(id: number) {
    try {
      await noteApi.setHidden(id, false);
      message.success("已取消隐藏");
      setData((prev) => ({
        ...prev,
        items: prev.items.filter((n) => n.id !== id),
        total: Math.max(0, prev.total - 1),
      }));
      // 不主动刷新侧边栏：HiddenPanel 自己监听 URL 变化时会重拉 listFolderIds
      // 这里若想立即更新，可触发一个 store 信号；目前保持简单
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
        key: "open",
        label: "打开笔记",
        icon: <ExternalLink size={13} />,
        onClick: () => {
          ctx.close();
          navigate(`/notes/${p.id}`);
        },
      },
      {
        key: "unhide",
        label: "取消隐藏",
        icon: <Eye size={13} />,
        onClick: () => {
          ctx.close();
          void handleUnhide(p.id);
        },
      },
      { type: "divider" },
      {
        key: "delete",
        label: "移到回收站",
        icon: <Trash2 size={13} />,
        danger: true,
        onClick: () => {
          ctx.close();
          Modal.confirm({
            title: `把「${p.title || "(无标题)"}」移到回收站？`,
            content: "可以在回收站恢复。",
            okText: "移入回收站",
            okButtonProps: { danger: true },
            async onOk() {
              try {
                await trashApi.softDelete(p.id);
                message.success("已移到回收站");
                // 本地从列表移除（不重拉，避免分页跳动）
                setData((prev) => ({
                  ...prev,
                  items: prev.items.filter((n) => n.id !== p.id),
                  total: Math.max(0, prev.total - 1),
                }));
              } catch (e) {
                message.error(`删除失败：${e}`);
              }
            },
          });
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.state.payload, navigate]);

  const columns: ColumnsType<Note> = useMemo(
    () => [
      {
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
        render: (val: string, record: Note) => (
          <a
            onClick={(e) => {
              e.preventDefault();
              navigate(`/notes/${record.id}`);
            }}
            style={{ cursor: "pointer" }}
          >
            {val}
          </a>
        ),
      },
      {
        title: "目录",
        dataIndex: "folder_id",
        key: "folder",
        width: 130,
        ellipsis: true,
        render: (fid: number | null) => {
          if (fid === null || fid === undefined) {
            return (
              <Text type="secondary" style={{ fontSize: 12, fontStyle: "italic" }}>
                未分类
              </Text>
            );
          }
          const name = folderMap.get(fid) ?? `(已删除 #${fid})`;
          return (
            <span
              style={{
                fontSize: 12,
                color: token.colorTextSecondary,
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <FolderIcon size={12} style={{ opacity: 0.6 }} />
              {name}
            </span>
          );
        },
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
        title: "更新时间",
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
        width: 120,
        render: (_: unknown, record: Note) => (
          <Space size="small">
            <Popconfirm
              title="取消隐藏？"
              description="这条笔记会重新出现在主列表 / 搜索 / 图谱中"
              okText="取消隐藏"
              cancelText="保留隐藏"
              onConfirm={() => handleUnhide(record.id)}
            >
              <Button type="link" size="small" icon={<Eye size={14} />}>
                取消隐藏
              </Button>
            </Popconfirm>
          </Space>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.page, data.page_size, navigate, folderMap, token.colorTextTertiary, token.colorTextSecondary],
  );

  return (
    <div
      className="max-w-4xl mx-auto h-full flex flex-col min-h-0"
      onContextMenu={(e) => {
        // 顶层兜底：表格行/操作有自己的 onContextMenu 会先 preventDefault；
        // 其他位置（标题、空白）走顶层吞掉默认菜单。input 白名单保留浏览器原生菜单
        const t = e.target as HTMLElement;
        if (t.closest("input, textarea, [contenteditable='true']")) return;
        e.preventDefault();
      }}
    >
      <div className="flex items-center justify-between mb-2 flex-shrink-0">
        <Title level={3} style={{ margin: 0, lineHeight: "32px" }}>
          <span className="flex items-center gap-2">
            <EyeOff size={22} />
            隐藏笔记
            <Text type="secondary" style={{ fontSize: 13, fontWeight: "normal" }}>
              · {currentFilterLabel}
            </Text>
          </span>
        </Title>
      </div>

      <div className="flex-shrink-0" style={{ marginBottom: 12, lineHeight: 1.6 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          只显示被标记为「隐藏」的笔记 —— 主界面 / 搜索 / 反链 / 图谱 / AI
          问答都不会显示这些笔记。隐藏是弱保护，数据库里仍是明文；需要强保护请到笔记编辑器右上角点锁图标启用加密。
        </Text>
      </div>

      {data.total > 0 || loading ? (
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
                loadList(page, size);
              }}
              size="small"
            />
          </div>
        </div>
      ) : (
        <EmptyState
          description={
            folderParam
              ? `「${currentFilterLabel}」下没有隐藏笔记`
              : "还没有被隐藏的笔记"
          }
        />
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
