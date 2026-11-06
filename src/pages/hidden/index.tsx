import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Button,
  Input,
  Modal,
  Pagination,
  Popconfirm,
  Spin,
  message,
} from "antd";
import {
  Eye,
  EyeOff,
  Folder as FolderIcon,
  ExternalLink,
  Search,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { folderApi, hiddenApi, noteApi, trashApi } from "@/lib/api";
import { EmptyState } from "@/components/ui/EmptyState";
import { relativeTime } from "@/lib/utils";
import { useAppStore } from "@/store";
import { LIST_PAGE_SIZE_OPTIONS } from "@/lib/listDensity";
import type { Folder, Note, PageResult } from "@/types";
import { useContextMenu } from "@/hooks/useContextMenu";
import {
  ContextMenuOverlay,
  type ContextMenuEntry,
} from "@/components/ui/ContextMenuOverlay";


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

  const [data, setData] = useState<PageResult<Note>>({
    items: [],
    total: 0,
    page: 1,
    page_size: useAppStore.getState().listPageSize,
  });
  const [loading, setLoading] = useState(false);
  // 和笔记页、回收站共用每页条数（见 lib/listDensity）
  const pageSize = useAppStore((s) => s.listPageSize);
  const setPageSize = useAppStore((s) => s.setListPageSize);

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

  /** 移到回收站（先确认）：右键菜单和行上的悬停按钮共用 */
  function confirmTrash(id: number, title: string) {
    Modal.confirm({
      title: `把「${title || "(无标题)"}」移到回收站？`,
      content: "可以在回收站恢复。",
      okText: "移入回收站",
      okButtonProps: { danger: true },
      async onOk() {
        try {
          await trashApi.softDelete(id);
          message.success("已移到回收站");
          // 本地从列表移除（不重拉，避免分页跳动）
          setData((prev) => ({
            ...prev,
            items: prev.items.filter((n) => n.id !== id),
            total: Math.max(0, prev.total - 1),
          }));
        } catch (e) {
          message.error(`删除失败：${e}`);
        }
      },
    });
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
          confirmTrash(p.id, p.title);
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.state.payload, navigate]);

  /** 只在当前页里按标题过滤：隐藏笔记列表接口不带关键词，这里不为它改后端 */
  const [keyword, setKeyword] = useState("");
  const shown = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return kw ? data.items.filter((n) => (n.title || "").toLowerCase().includes(kw)) : data.items;
  }, [data.items, keyword]);

  return (
    <div
      className="kb-hidden-page"
      onContextMenu={(e) => {
        // 顶层兜底：列表行有自己的 onContextMenu 会先 preventDefault；
        // 其他位置（标题、空白）走顶层吞掉默认菜单。input 白名单保留浏览器原生菜单
        const t = e.target as HTMLElement;
        if (t.closest("input, textarea, [contenteditable='true']")) return;
        e.preventDefault();
      }}
    >
      {/* 顶栏（原型 .bar）：隐藏笔记 · 当前筛选 · 说明 ｜ 搜索 */}
      <div className="kb-page-bar">
        <h1>隐藏笔记</h1>
        <span className="kb-page-sub">
          {currentFilterLabel} · 共 {data.total} 篇 · 不出现在笔记列表、搜索和图谱里
        </span>
        <span className="flex-1" />
        <Input
          className="kb-bar-search"
          allowClear
          prefix={<Search size={14} />}
          placeholder="在本页搜索隐藏笔记"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>

      <div className="kb-hidden-note">
        <ShieldAlert size={13} />
        隐藏是弱保护：主界面 / 搜索 / 反链 / 图谱 / AI 问答都不显示，但数据库里仍是明文；需要强保护请到笔记编辑器右上角点锁图标启用加密。
      </div>

      {data.total > 0 || loading ? (
        <section className="kb-cards-panel kb-hidden-list">
          {loading && data.items.length === 0 ? (
            <div className="flex justify-center py-10">
              <Spin />
            </div>
          ) : shown.length === 0 ? (
            <EmptyState description="本页没有匹配的隐藏笔记" />
          ) : (
            shown.map((n) => {
              const folderName =
                n.folder_id == null ? "未分类" : folderMap.get(n.folder_id) ?? `(已删除 #${n.folder_id})`;
              return (
                <div
                  key={n.id}
                  className={
                    "kb-hidden-row" + (ctx.state.payload?.id === n.id ? " is-ctx" : "")
                  }
                  onClick={() => navigate(`/notes/${n.id}`)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    ctx.open(e.nativeEvent, { id: n.id, title: n.title });
                  }}
                >
                  <span className="kb-sr-ico">
                    <EyeOff size={15} />
                  </span>
                  <div className="kb-sr-main">
                    <div className="kb-sr-title">{n.title || "(无标题)"}</div>
                    <div className="kb-sr-snippet is-one">
                      <FolderIcon size={11} style={{ display: "inline-block", verticalAlign: -1, marginRight: 3 }} />
                      {folderName} · {n.word_count} 字
                    </div>
                  </div>
                  <span className="kb-sr-time" title={n.updated_at.slice(0, 16)}>
                    {relativeTime(n.updated_at)}
                  </span>
                  {/* 悬停操作（原来只有「取消隐藏」，另两个藏在右键菜单里） */}
                  <div className="kb-hidden-acts" onClick={(e) => e.stopPropagation()}>
                    <Button
                      type="text"
                      size="small"
                      icon={<ExternalLink size={13} />}
                      onClick={() => navigate(`/notes/${n.id}`)}
                    >
                      打开笔记
                    </Button>
                    <Popconfirm
                      title="取消隐藏？"
                      description="这条笔记会重新出现在主列表 / 搜索 / 图谱中"
                      okText="取消隐藏"
                      cancelText="保留隐藏"
                      onConfirm={() => handleUnhide(n.id)}
                    >
                      <Button type="text" size="small" icon={<Eye size={13} />}>
                        取消隐藏
                      </Button>
                    </Popconfirm>
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<Trash2 size={13} />}
                      onClick={() => confirmTrash(n.id, n.title)}
                    >
                      移到回收站
                    </Button>
                  </div>
                </div>
              );
            })
          )}
          <div className="kb-hidden-pager">
            <Pagination
              current={data.page}
              pageSize={data.page_size}
              total={data.total}
              showTotal={(total) => `共 ${total} 篇`}
              showSizeChanger
              pageSizeOptions={LIST_PAGE_SIZE_OPTIONS.map(String)}
              onChange={(page, size) => {
                if (size !== pageSize) setPageSize(size);
                setKeyword("");
                loadList(page, size);
              }}
              size="small"
            />
          </div>
        </section>
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
