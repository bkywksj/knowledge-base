import { useState, useEffect, useMemo, useCallback, useRef, startTransition, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Table,
  Button,
  Input,
  Space,
  Typography,
  message,
  Modal,
  Popconfirm,
  Tooltip,
  Card,
  Row,
  Col,
  Segmented,
  Tag,
  Timeline,
  Popover,
  Tree,
  Divider,
  Pagination,
  Dropdown,
  theme as antdTheme,
} from "antd";
import {
  Search,
  Trash2,
  Archive,
  Edit3,
  Share,
  LayoutList,
  LayoutGrid,
  Clock,
  Pin,
  Calendar,
  Folder as FolderIcon,
  CornerUpLeft,
  Filter as FilterIcon,
  Bot,
  ChevronDown,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ColumnsType } from "antd/es/table";
import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { noteApi, exportApi, folderApi, tagApi } from "@/lib/api";
import { useTabsStore } from "@/store/tabs";
import { useAppStore } from "@/store";
import { stripHtml, relativeTime } from "@/lib/utils";
import { EmptyState } from "@/components/ui/EmptyState";
import { NewNoteButton } from "@/components/NewNoteButton";
import { createBlankAndOpen } from "@/lib/noteCreator";
import { startAiChatWithNotes } from "@/lib/aiAttach";
// AntD 已有 Tag 组件同名，这里给类型起个别名避免冲突
import type { Note, PageResult, Folder, Tag as NoteTag } from "@/types";

const { Title, Text, Paragraph } = Typography;

type ViewMode = "list" | "card" | "timeline";

/** 将笔记按日期分组 */
function groupByDate(notes: Note[]): Map<string, Note[]> {
  const map = new Map<string, Note[]>();
  for (const note of notes) {
    const date = note.updated_at.slice(0, 10);
    if (!map.has(date)) map.set(date, []);
    map.get(date)!.push(note);
  }
  return map;
}

/** 格式化日期标签 */
function formatDateLabel(dateStr: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (dateStr === today) return "今天";
  if (dateStr === yesterday) return "昨天";
  return dateStr;
}

/** 笔记标签装饰（React.memo 避免重渲染） */
const NoteDecorators = ({ note, warningColor }: { note: Note; warningColor: string }) => (
  <span className="inline-flex items-center gap-1 ml-1">
    {note.is_pinned && <Pin size={11} style={{ color: warningColor }} />}
    {note.is_daily && (
      <Tag color="blue" style={{ fontSize: 10, lineHeight: "14px", padding: "0 3px", margin: 0 }}>
        日记
      </Tag>
    )}
  </span>
);

/** 把 Folder[] 映射为 antd Tree 的节点结构（key = folder id） */
type FolderTreeNode = {
  key: number;
  title: ReactNode;
  children?: FolderTreeNode[];
};
function foldersToAntTree(folders: Folder[]): FolderTreeNode[] {
  return folders.map((f) => ({
    key: f.id,
    title: (
      <span className="inline-flex items-center gap-1.5" style={{ fontSize: 13 }}>
        <FolderIcon size={13} style={{ opacity: 0.6 }} />
        {f.name}
      </span>
    ),
    children: f.children?.length ? foldersToAntTree(f.children) : undefined,
  }));
}
function collectAllFolderKeys(nodes: FolderTreeNode[]): number[] {
  const out: number[] = [];
  for (const n of nodes) {
    out.push(n.key);
    if (n.children?.length) out.push(...collectAllFolderKeys(n.children));
  }
  return out;
}

/** 批量移动按钮：Popover 里用 Tree 选目标文件夹（含"移到根目录"快捷项）
 *  onMove 由父组件提供：负责调后端 + 清 selection + 刷新列表 */
function BatchMoveButton({
  folders,
  open,
  onOpenChange,
  onMove,
}: {
  folders: Folder[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onMove: (folderId: number | null) => void | Promise<void>;
}) {
  const treeData = useMemo(() => foldersToAntTree(folders), [folders]);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  useEffect(() => {
    if (open) setExpandedKeys(collectAllFolderKeys(treeData));
  }, [open, treeData]);

  return (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={onOpenChange}
      placement="bottomLeft"
      destroyOnHidden
      content={
        <div style={{ width: 260 }}>
          <div
            style={{
              maxHeight: 280,
              overflowY: "auto",
              margin: "0 -4px",
              padding: "0 4px",
            }}
          >
            {treeData.length === 0 ? (
              <div
                style={{
                  textAlign: "center",
                  padding: "16px 8px",
                  fontSize: 12,
                  opacity: 0.6,
                }}
              >
                还没有文件夹
              </div>
            ) : (
              <Tree
                blockNode
                treeData={treeData}
                expandedKeys={expandedKeys}
                onExpand={(keys) => setExpandedKeys(keys)}
                onSelect={(keys) => {
                  if (keys.length > 0) {
                    void onMove(keys[0] as number);
                  }
                }}
              />
            )}
          </div>
          <Divider style={{ margin: "8px 0" }} />
          <Button
            size="small"
            type="text"
            block
            icon={<CornerUpLeft size={13} />}
            onClick={() => void onMove(null)}
            style={{ textAlign: "left", justifyContent: "flex-start" }}
          >
            移到根目录
          </Button>
        </div>
      }
    >
      <Button size="small" type="primary">
        移动到…
      </Button>
    </Popover>
  );
}

/** 批量打标签按钮：Popover 里多选标签，确认后追加到所有选中笔记（不清除原有）
 *  onDone 由父组件注入：调 API + 清 selection + 刷新 */
function BatchTagButton({
  noteIds,
  onDone,
}: {
  noteIds: number[];
  onDone: (tagIds: number[]) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [allTags, setAllTags] = useState<NoteTag[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const [filter, setFilter] = useState("");

  // 每次打开时拉一次最新标签，并重置选择
  useEffect(() => {
    if (!open) return;
    setPicked([]);
    setFilter("");
    tagApi
      .list()
      .then(setAllTags)
      .catch((e) => message.error(`加载标签失败: ${e}`));
  }, [open]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return allTags;
    return allTags.filter((t) => t.name.toLowerCase().includes(q));
  }, [allTags, filter]);

  function toggle(id: number) {
    setPicked((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function confirm() {
    if (picked.length === 0) {
      message.info("请选择要添加的标签");
      return;
    }
    await onDone(picked);
    setOpen(false);
  }

  return (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      placement="bottomLeft"
      destroyOnHidden
      content={
        <div style={{ width: 260 }}>
          <Input
            size="small"
            placeholder="筛选标签..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            allowClear
            style={{ marginBottom: 6 }}
          />
          <div
            style={{
              maxHeight: 220,
              overflowY: "auto",
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              padding: "2px 0",
            }}
          >
            {filtered.length === 0 ? (
              <div
                style={{
                  textAlign: "center",
                  padding: "12px 8px",
                  fontSize: 12,
                  opacity: 0.6,
                  width: "100%",
                }}
              >
                {allTags.length === 0 ? "还没有标签" : "无匹配"}
              </div>
            ) : (
              filtered.map((tag) => {
                const active = picked.includes(tag.id);
                return (
                  <Tag
                    key={tag.id}
                    color={active ? tag.color || "blue" : undefined}
                    onClick={() => toggle(tag.id)}
                    style={{
                      cursor: "pointer",
                      padding: "2px 10px",
                      fontSize: 13,
                      fontWeight: active ? 600 : undefined,
                      opacity: active ? 1 : 0.75,
                    }}
                  >
                    {tag.name}
                  </Tag>
                );
              })
            )}
          </div>
          <Divider style={{ margin: "8px 0" }} />
          <div className="flex justify-between items-center">
            <span style={{ fontSize: 11, opacity: 0.6 }}>
              已选 {picked.length} 个 · 将应用到 {noteIds.length} 篇
            </span>
            <Space size={4}>
              <Button size="small" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button
                size="small"
                type="primary"
                disabled={picked.length === 0}
                onClick={confirm}
              >
                添加
              </Button>
            </Space>
          </div>
        </div>
      }
    >
      <Button size="small">打标签…</Button>
    </Popover>
  );
}

/** 笔记列表"目录"列的单元格：
 *  - 展示当前文件夹名或"—"（无目录）
 *  - 点击 → Popover 里 Tree 选择新文件夹 → 调 moveToFolder → 刷新列表
 *  - 保留"筛选此文件夹"快捷入口（原表格里的跳转语义） */
function FolderChangeCell({
  noteId,
  currentFolderId,
  folders,
  folderMap,
  onChanged,
  onFilterClick,
}: {
  noteId: number;
  currentFolderId: number | null;
  folders: Folder[];
  folderMap: Map<number, string>;
  onChanged: () => void;
  onFilterClick: (folderId: number) => void;
}) {
  const { token } = antdTheme.useToken();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const treeData = useMemo(() => foldersToAntTree(folders), [folders]);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  useEffect(() => {
    if (open) setExpandedKeys(collectAllFolderKeys(treeData));
  }, [open, treeData]);

  async function applyMove(folderId: number | null) {
    if (folderId === currentFolderId) {
      setOpen(false);
      return;
    }
    setSaving(true);
    try {
      await noteApi.moveToFolder(noteId, folderId);
      useAppStore.getState().bumpFoldersRefresh();
      onChanged();
      setOpen(false);
    } catch (e) {
      message.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  const currentName =
    currentFolderId != null ? folderMap.get(currentFolderId) ?? null : null;

  const popoverContent = (
    <div style={{ width: 240 }}>
      <div
        style={{
          fontSize: 11,
          color: token.colorTextTertiary,
          padding: "2px 4px 6px",
          letterSpacing: 0.3,
        }}
      >
        移动到
      </div>
      <div style={{ maxHeight: 260, overflowY: "auto", margin: "0 -4px", padding: "0 4px" }}>
        {treeData.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "12px 8px",
              color: token.colorTextTertiary,
              fontSize: 12,
            }}
          >
            还没有文件夹
          </div>
        ) : (
          <Tree
            blockNode
            treeData={treeData}
            selectedKeys={currentFolderId != null ? [currentFolderId] : []}
            expandedKeys={expandedKeys}
            onExpand={(keys) => setExpandedKeys(keys)}
            onSelect={(keys) => {
              if (keys.length > 0) applyMove(keys[0] as number);
            }}
            disabled={saving}
          />
        )}
      </div>
      <Divider style={{ margin: "8px 0" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <Button
          size="small"
          type="text"
          block
          disabled={currentFolderId == null || saving}
          icon={<CornerUpLeft size={13} />}
          onClick={() => applyMove(null)}
          style={{ textAlign: "left", justifyContent: "flex-start" }}
        >
          移到根目录
        </Button>
        {currentFolderId != null && (
          <Button
            size="small"
            type="text"
            block
            icon={<FilterIcon size={13} />}
            onClick={() => {
              onFilterClick(currentFolderId);
              setOpen(false);
            }}
            style={{ textAlign: "left", justifyContent: "flex-start" }}
          >
            筛选此文件夹下的笔记
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      placement="bottomLeft"
      destroyOnHidden
      content={popoverContent}
    >
      {currentName ? (
        <a style={{ fontSize: 12 }} onClick={(e) => e.preventDefault()}>
          {currentName}
        </a>
      ) : (
        <span
          style={{ fontSize: 12, color: token.colorTextTertiary, cursor: "pointer" }}
        >
          —
        </span>
      )}
    </Popover>
  );
}

export default function NoteListPage() {
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
  const [keyword, setKeyword] = useState(searchParams.get("keyword") || "");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  /** 列表视图每页条数，受分页组件 sizeChanger 控制；初始 12 */
  const [listPageSize, setListPageSize] = useState(12);
  /** 列表视图下选中的笔记 id，切换到其他视图/翻页自动清空 */
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  /** 批量移动 Popover 的开关 */
  const [batchMoveOpen, setBatchMoveOpen] = useState(false);

  const folderId = searchParams.get("folder");

  // 文件夹 id → name 映射（用于显示目录列）
  const [folderMap, setFolderMap] = useState<Map<number, string>>(new Map());
  // 原始文件夹树，供"目录"列的 Popover 选择器用
  const [folders, setFolders] = useState<Folder[]>([]);

  // 依赖全局 foldersRefreshTick：Sidebar 新建/改名/删文件夹后自动重建 id→name 映射
  const foldersRefreshTick = useAppStore((s) => s.foldersRefreshTick);
  useEffect(() => {
    folderApi.list().then((list) => {
      setFolders(list);
      const map = new Map<number, string>();
      function flatten(flist: Folder[]) {
        for (const f of flist) {
          map.set(f.id, f.name);
          if (f.children?.length) flatten(f.children);
        }
      }
      flatten(list);
      setFolderMap(map);
    });
  }, [foldersRefreshTick]);

  useEffect(() => {
    loadNotes(1);
  }, [folderId]);

  // 监听全局"刷新"触发器：任何创建/导入流程完成后都会 bump，触发列表重拉
  const notesRefreshTick = useAppStore((s) => s.notesRefreshTick);
  useEffect(() => {
    if (notesRefreshTick > 0) loadNotes(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notesRefreshTick]);

  useEffect(() => {
    const kw = searchParams.get("keyword");
    if (kw) {
      setKeyword(kw);
      loadNotes(1, kw);
    }
  }, [searchParams]);

  const loadNotes = useCallback(
    async (page: number, kw?: string, pageSizeOverride?: number) => {
      setLoading(true);
      try {
        const isUncategorized = folderId === "uncategorized";
        const result = await noteApi.list({
          page,
          page_size:
            viewMode === "timeline"
              ? 50
              : (pageSizeOverride ?? listPageSize),
          keyword: (kw ?? keyword) || undefined,
          // folder=uncategorized 是常驻"未分类"虚拟文件夹（folder_id IS NULL）
          folder_id: isUncategorized
            ? undefined
            : folderId
              ? Number(folderId)
              : undefined,
          uncategorized: isUncategorized || undefined,
        });
        setData(result);
      } catch (e) {
        message.error(String(e));
      } finally {
        setLoading(false);
      }
    },
    [viewMode, keyword, folderId, listPageSize],
  );

  const handleDelete = useCallback(
    async (id: number) => {
      try {
        await noteApi.delete(id);
        useTabsStore.getState().closeTab(id);
        message.success("删除成功");
        useAppStore.getState().bumpNotesRefresh();
        loadNotes(data.page);
      } catch (e) {
        message.error(String(e));
      }
    },
    [data.page, loadNotes],
  );

  const handleExport = useCallback(async (record: Note) => {
    const parentDir = await openDialog({
      directory: true,
      title: "选择导出目录",
    });
    if (!parentDir) return;
    try {
      const result = await exportApi.exportSingle(record.id, parentDir as string);
      Modal.success({
        title: "导出成功",
        content: (
          <div>
            <p style={{ marginBottom: 4 }}>
              {result.assets_copied > 0
                ? `已导出 .md 与 ${result.assets_copied} 个资产文件，目录：`
                : "已导出 .md，目录："}
            </p>
            <p style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
              {result.root_dir}
            </p>
          </div>
        ),
        okText: "打开所在文件夹",
        onOk: () => revealItemInDir(result.root_dir).catch(() => {}),
        closable: true,
      });
    } catch (e) {
      message.error(`导出失败: ${e}`);
    }
  }, []);

  /** 批量导出：循环调单条 export，每篇笔记会在父目录下生成 `{标题}/` 子目录 */
  const handleExportBatch = useCallback(async (ids: number[]) => {
    if (ids.length === 0) return;
    const parentDir = await openDialog({
      directory: true,
      title: `选择导出目录（共 ${ids.length} 篇）`,
    });
    if (!parentDir) return;
    const hide = message.loading(`正在导出 ${ids.length} 篇…`, 0);
    let success = 0;
    let totalAssets = 0;
    const failed: number[] = [];
    for (const id of ids) {
      try {
        const result = await exportApi.exportSingle(id, parentDir as string);
        success += 1;
        totalAssets += result.assets_copied;
      } catch (e) {
        failed.push(id);
        console.warn(`[export] 笔记 ${id} 导出失败:`, e);
      }
    }
    hide();
    Modal.success({
      title: failed.length === 0 ? "导出完成" : "导出完成（部分失败）",
      content: (
        <div>
          <p style={{ marginBottom: 4 }}>
            成功 {success} 篇{failed.length > 0 ? `，失败 ${failed.length} 篇` : ""}；
            共复制资产 {totalAssets} 个。父目录：
          </p>
          <p style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
            {parentDir}
          </p>
        </div>
      ),
      okText: "打开所在文件夹",
      onOk: () => revealItemInDir(parentDir as string).catch(() => {}),
      closable: true,
    });
  }, []);

  /** 单条 Word 导出（save dialog 选最终 .docx 路径） */
  const handleExportWordSingle = useCallback(async (record: Note) => {
    const safeName = record.title.replace(/[/\\:*?"<>|]/g, "_").trim() || "未命名";
    const filePath = await save({
      defaultPath: `${safeName}.docx`,
      filters: [{ name: "Word", extensions: ["docx"] }],
    });
    if (!filePath) return;
    try {
      const result = await exportApi.exportSingleToWord(record.id, filePath);
      Modal.success({
        title: "导出 Word 成功",
        content: (
          <div>
            <p style={{ marginBottom: 4 }}>
              {`嵌入图片 ${result.imagesEmbedded} 张` +
                (result.imagesMissing > 0
                  ? `（${result.imagesMissing} 张缺失，已用占位符替代）`
                  : "")}
              ，文件：
            </p>
            <p style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
              {result.filePath}
            </p>
          </div>
        ),
        okText: "打开所在文件夹",
        onOk: () => revealItemInDir(result.filePath).catch(() => {}),
        closable: true,
      });
    } catch (e) {
      message.error(`导出 Word 失败: ${e}`);
    }
  }, []);

  /** 单条 HTML 导出（save dialog 选最终 .html 路径） */
  const handleExportHtmlSingle = useCallback(async (record: Note) => {
    const safeName = record.title.replace(/[/\\:*?"<>|]/g, "_").trim() || "未命名";
    const filePath = await save({
      defaultPath: `${safeName}.html`,
      filters: [{ name: "HTML", extensions: ["html", "htm"] }],
    });
    if (!filePath) return;
    try {
      const result = await exportApi.exportSingleToHtml(record.id, filePath);
      Modal.success({
        title: "导出 HTML 成功",
        content: (
          <div>
            <p style={{ marginBottom: 4 }}>
              {`内嵌图片 ${result.imagesInlined} 张` +
                (result.imagesMissing > 0
                  ? `（${result.imagesMissing} 张缺失）`
                  : "")}
              ，文件：
            </p>
            <p style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
              {result.filePath}
            </p>
          </div>
        ),
        okText: "打开所在文件夹",
        onOk: () => revealItemInDir(result.filePath).catch(() => {}),
        closable: true,
      });
    } catch (e) {
      message.error(`导出 HTML 失败: ${e}`);
    }
  }, []);

  /** 批量 Word/HTML 导出：选一次目录，循环按 `{title}.{ext}` 命名；同名自动加序号 _2、_3 */
  const handleExportBatchSingleFile = useCallback(
    async (ids: number[], ext: "docx" | "html") => {
      if (ids.length === 0) return;
      const parentDir = await openDialog({
        directory: true,
        title: `选择导出目录（共 ${ids.length} 篇 → .${ext}）`,
      });
      if (!parentDir) return;

      const sep = (parentDir as string).includes("\\") ? "\\" : "/";
      // 同次批量内的命名去重：记录已用名（去 ext 后小写比较，模拟 Windows 不分大小写文件名冲突）
      const usedKeys = new Set<string>();
      const allocatePath = (rawTitle: string): string => {
        const base = rawTitle.replace(/[/\\:*?"<>|]/g, "_").trim() || "未命名";
        let candidate = base;
        let n = 2;
        while (usedKeys.has(candidate.toLowerCase())) {
          candidate = `${base}_${n}`;
          n += 1;
        }
        usedKeys.add(candidate.toLowerCase());
        return `${parentDir}${sep}${candidate}.${ext}`;
      };

      const hide = message.loading(`正在导出 ${ids.length} 篇 .${ext}…`, 0);
      let success = 0;
      let images = 0;
      const failed: number[] = [];
      for (const id of ids) {
        const note = data.items.find((n) => n.id === id);
        const targetPath = allocatePath(note?.title ?? `note-${id}`);
        try {
          if (ext === "docx") {
            const r = await exportApi.exportSingleToWord(id, targetPath);
            images += r.imagesEmbedded;
          } else {
            const r = await exportApi.exportSingleToHtml(id, targetPath);
            images += r.imagesInlined;
          }
          success += 1;
        } catch (e) {
          failed.push(id);
          console.warn(`[export] 笔记 ${id} 导出 ${ext} 失败:`, e);
        }
      }
      hide();
      Modal.success({
        title: failed.length === 0 ? `导出 .${ext} 完成` : `导出 .${ext} 完成（部分失败）`,
        content: (
          <div>
            <p style={{ marginBottom: 4 }}>
              成功 {success} 篇{failed.length > 0 ? `，失败 ${failed.length} 篇` : ""}；
              {ext === "docx" ? "嵌入" : "内嵌"} {images} 张图片。目录：
            </p>
            <p style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
              {parentDir}
            </p>
          </div>
        ),
        okText: "打开所在文件夹",
        onOk: () => revealItemInDir(parentDir as string).catch(() => {}),
        closable: true,
      });
    },
    [data.items],
  );

  const handleTrashAll = useCallback(() => {
    Modal.confirm({
      title: "全部移到回收站",
      content: `将全部 ${data.total} 篇笔记移到回收站，可在回收站中恢复或彻底删除。`,
      okText: "确认移入回收站",
      cancelText: "取消",
      onOk: async () => {
        try {
          const count = await noteApi.trashAll();
          useTabsStore.getState().closeAllTabs();
          message.success(`已将 ${count} 篇笔记移到回收站`);
          useAppStore.getState().bumpNotesRefresh();
          loadNotes(1);
        } catch (e) {
          message.error(String(e));
        }
      },
    });
  }, [data.total, loadNotes]);


  const handleSearch = useCallback(() => {
    loadNotes(1, keyword);
  }, [loadNotes, keyword]);

  const handleViewChange = useCallback(
    (v: string) => {
      // startTransition 标记为非紧急，让 Segmented 滑块动画先跑完
      startTransition(() => {
        setViewMode(v as ViewMode);
        // 切到非列表视图时清空批量选择（只有 list 有 checkbox）
        if (v !== "list") setSelectedIds([]);
        if (v === "timeline") {
          loadNotes(1);
        }
      });
    },
    [loadNotes],
  );

  const columns: ColumnsType<Note> = useMemo(
    () => [
      {
        // 绝对序号：跨页连续（(page-1)*pageSize + 行内索引 + 1），翻页不重置
        title: "#",
        key: "index",
        width: 36,
        align: "right" as const,
        onCell: () => ({ style: { paddingLeft: 4, paddingRight: 4 } }),
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
        // 标题文字（尤其是被 ellipsis 截断时）会贴到下一列，给单元格右侧留点呼吸空间
        onCell: () => ({ style: { paddingRight: 24 } }),
        render: (title: string, record: Note) => {
          // 子文件夹笔记标记：当前选中是某文件夹，且这条笔记 folder_id 不等于该选中
          // → 笔记其实在子孙文件夹下；前面加 ↳ 小箭头作为轻量视觉提示
          const numericFolderId =
            folderId && folderId !== "uncategorized" ? Number(folderId) : null;
          const isFromDescendant =
            numericFolderId !== null && record.folder_id !== numericFolderId;
          return (
            <span className="flex items-center">
              {isFromDescendant && (
                <Tooltip
                  title={`来自子文件夹：${record.folder_id ? folderMap.get(record.folder_id) ?? "?" : "未分类"}`}
                >
                  <span
                    style={{
                      color: token.colorTextTertiary,
                      marginRight: 4,
                      fontSize: 12,
                    }}
                  >
                    ↳
                  </span>
                </Tooltip>
              )}
              <a onClick={() => navigate(`/notes/${record.id}`)}>{title}</a>
              <NoteDecorators note={record} warningColor={token.colorWarning} />
            </span>
          );
        },
      },
      {
        title: "目录",
        dataIndex: "folder_id",
        key: "folder",
        width: 120,
        ellipsis: true,
        render: (fid: number | null, record: Note) => (
          <FolderChangeCell
            noteId={record.id}
            currentFolderId={fid}
            folders={folders}
            folderMap={folderMap}
            onChanged={() => loadNotes(data.page)}
            onFilterClick={(id) => navigate(`/notes?folder=${id}`)}
          />
        ),
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
            <Tooltip title="编辑">
              <Button
                type="link"
                size="small"
                icon={<Edit3 size={14} />}
                onClick={() => navigate(`/notes/${record.id}`)}
              />
            </Tooltip>
            <Dropdown
              trigger={["click"]}
              menu={{
                items: [
                  {
                    key: "md",
                    label: "导出为 Markdown",
                    onClick: () => void handleExport(record),
                  },
                  {
                    key: "docx",
                    label: "导出为 Word (.docx)",
                    onClick: () => void handleExportWordSingle(record),
                  },
                  {
                    key: "html",
                    label: "导出为 HTML (单文件)",
                    onClick: () => void handleExportHtmlSingle(record),
                  },
                ],
              }}
            >
              <Tooltip title="导出">
                <Button type="link" size="small" icon={<Share size={14} />} />
              </Tooltip>
            </Dropdown>
            <Popconfirm title="确认删除此笔记？" onConfirm={() => handleDelete(record.id)}>
              <Tooltip title="删除">
                <Button type="link" danger size="small" icon={<Trash2 size={14} />} />
              </Tooltip>
            </Popconfirm>
          </Space>
        ),
      },
    ],
    [navigate, token.colorWarning, token.colorTextTertiary, handleDelete, handleExport, handleExportWordSingle, handleExportHtmlSingle, folderMap, folders, loadNotes, data.page, data.page_size],
  );

  // 时间线分组（缓存）
  const dateGroups = useMemo(() => groupByDate(data.items), [data.items]);

  // 笔记纯文本预览（缓存：仅当 data.items 变化才重算 stripHtml，避免每次 render 都跑）
  const notePreviews = useMemo(() => {
    const map = new Map<number, string>();
    for (const n of data.items) {
      map.set(n.id, n.content ? stripHtml(n.content) : "");
    }
    return map;
  }, [data.items]);

  // ─── 虚拟滚动（卡片视图） ────────────────────
  // 将笔记按 3 列分行
  const cardRows = useMemo(() => {
    const rows: Note[][] = [];
    for (let i = 0; i < data.items.length; i += 3) {
      rows.push(data.items.slice(i, i + 3));
    }
    return rows;
  }, [data.items]);

  const cardContainerRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: cardRows.length,
    getScrollElement: () => cardContainerRef.current,
    estimateSize: () => 182, // 170 card + 12 gap
    overscan: 3,
  });

  return (
    <div className="max-w-4xl mx-auto h-full flex flex-col min-h-0">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between mb-2 flex-shrink-0">
        <Title level={3} style={{ margin: 0, lineHeight: "32px" }}>
          笔记
        </Title>
        <Space align="center">
          <Segmented
            value={viewMode}
            onChange={handleViewChange}
            options={[
              { value: "list", icon: <LayoutList size={14} />, title: "列表" },
              { value: "card", icon: <LayoutGrid size={14} />, title: "卡片" },
              { value: "timeline", icon: <Clock size={14} />, title: "时间线" },
            ]}
            size="small"
          />
          {data.total > 0 && (
            <Button icon={<Archive size={14} />} onClick={handleTrashAll}>
              全部移到回收站
            </Button>
          )}
          <NewNoteButton folderId={folderId ? Number(folderId) : null} />
        </Space>
      </div>

      {/* 搜索栏 */}
      <Space.Compact className="mb-2 flex-shrink-0" style={{ width: "100%" }}>
        <Input
          placeholder="搜索笔记标题..."
          prefix={<Search size={14} />}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onPressEnter={handleSearch}
          allowClear
        />
        <Button type="primary" onClick={handleSearch}>
          搜索
        </Button>
      </Space.Compact>

      {/* 批量工具条：仅列表视图 + 有选中时显示 */}
      {viewMode === "list" && selectedIds.length > 0 && (
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
          <BatchMoveButton
            folders={folders}
            open={batchMoveOpen}
            onOpenChange={setBatchMoveOpen}
            onMove={async (folderId) => {
              try {
                const n = await noteApi.moveBatch(selectedIds, folderId);
                message.success(`已移动 ${n} 条到目标文件夹`);
                setSelectedIds([]);
                setBatchMoveOpen(false);
                await loadNotes(data.page);
                useAppStore.getState().bumpFoldersRefresh();
              } catch (e) {
                message.error(`移动失败: ${e}`);
              }
            }}
          />
          <BatchTagButton
            noteIds={selectedIds}
            onDone={async (tagIds) => {
              try {
                const n = await noteApi.addTagsBatch(selectedIds, tagIds);
                message.success(`已添加 ${n} 条关联`);
                setSelectedIds([]);
                await loadNotes(data.page);
                useAppStore.getState().bumpTagsRefresh();
              } catch (e) {
                message.error(`打标签失败: ${e}`);
              }
            }}
          />
          <Popconfirm
            title={`确认将 ${selectedIds.length} 篇笔记移到回收站？`}
            okText="移到回收站"
            okButtonProps={{ danger: true }}
            onConfirm={async () => {
              try {
                const n = await noteApi.trashBatch(selectedIds);
                message.success(`已移到回收站 ${n} 条`);
                setSelectedIds([]);
                useAppStore.getState().bumpNotesRefresh();
                await loadNotes(data.page);
              } catch (e) {
                message.error(`删除失败: ${e}`);
              }
            }}
          >
            <Button size="small" danger icon={<Trash2 size={14} />}>
              删除
            </Button>
          </Popconfirm>
          <Space.Compact size="small">
            <Tooltip title="批量导出为 Markdown">
              <Button
                size="small"
                icon={<Share size={14} />}
                onClick={() => handleExportBatch(selectedIds)}
              >
                批量导出
              </Button>
            </Tooltip>
            <Dropdown
              trigger={["click"]}
              menu={{
                items: [
                  {
                    key: "md",
                    label: "批量导出为 Markdown",
                    onClick: () => void handleExportBatch(selectedIds),
                  },
                  {
                    key: "docx",
                    label: "批量导出为 Word (.docx)",
                    onClick: () => void handleExportBatchSingleFile(selectedIds, "docx"),
                  },
                  {
                    key: "html",
                    label: "批量导出为 HTML (单文件)",
                    onClick: () => void handleExportBatchSingleFile(selectedIds, "html"),
                  },
                ],
              }}
            >
              <Button size="small" icon={<ChevronDown size={12} />} title="更多导出格式" />
            </Dropdown>
          </Space.Compact>
          <Button
            size="small"
            icon={<Bot size={14} />}
            onClick={async () => {
              // 找第一篇笔记的标题给新对话用作默认名
              const firstId = selectedIds[0];
              const firstTitle = data.items.find((n) => n.id === firstId)?.title;
              try {
                await startAiChatWithNotes(selectedIds, firstTitle, navigate);
              } catch (e) {
                message.error(`发起 AI 会话失败: ${e}`);
              }
            }}
          >
            发到 AI
          </Button>
          <Button size="small" onClick={() => setSelectedIds([])}>
            取消选择
          </Button>
        </div>
      )}

      {/* 列表视图：表格 + 分页条共享同一个白色卡片，短列表底下不再露出页面背景 */}
      {viewMode === "list" && (
        <div
          className="flex-1 flex flex-col min-h-0 notes-list-flat"
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
            />
          </div>
          <div
            className="flex-shrink-0 flex justify-end items-center px-3 py-2"
          >
            <Pagination
              current={data.page}
              pageSize={data.page_size}
              total={data.total}
              showTotal={(total) => `共 ${total} 篇`}
              showSizeChanger
              pageSizeOptions={["12", "20", "50", "100", "200"]}
              onChange={(page, size) => {
                setSelectedIds([]);
                if (size !== listPageSize) {
                  // 改了每页条数 → 同步 state；loadNotes 用 override 立即生效，
                  // 不依赖 useCallback 重建后才生效（否则会闪一次旧 size）
                  setListPageSize(size);
                  loadNotes(page, undefined, size);
                } else {
                  loadNotes(page);
                }
              }}
              size="small"
            />
          </div>
        </div>
      )}

      {/* 卡片视图（虚拟滚动） */}
      {viewMode === "card" && (
        <>
          {loading ? (
            <Row gutter={[12, 12]}>
              {[1, 2, 3].map((i) => (
                <Col key={i} span={8}>
                  <Card loading style={{ height: 170 }} />
                </Col>
              ))}
            </Row>
          ) : data.items.length > 0 ? (
            <>
              <div
                ref={cardContainerRef}
                style={{
                  height: Math.min(cardRows.length * 182, 600),
                  overflow: "auto",
                }}
              >
                <div
                  style={{
                    height: `${rowVirtualizer.getTotalSize()}px`,
                    width: "100%",
                    position: "relative",
                  }}
                >
                  {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const row = cardRows[virtualRow.index];
                    return (
                      <div
                        key={virtualRow.key}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          height: `${virtualRow.size}px`,
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        <Row gutter={[12, 12]}>
                          {row.map((note) => (
                            <Col key={note.id} xs={24} sm={12} md={8}>
                              <Card
                                hoverable
                                size="small"
                                onClick={() => navigate(`/notes/${note.id}`)}
                                style={{
                                  height: 170,
                                  display: "flex",
                                  flexDirection: "column",
                                  borderLeft: note.is_pinned
                                    ? `3px solid ${token.colorWarning}`
                                    : undefined,
                                }}
                                styles={{
                                  body: {
                                    flex: 1,
                                    overflow: "hidden",
                                    display: "flex",
                                    flexDirection: "column",
                                    padding: "10px 12px",
                                  },
                                }}
                              >
                                <div className="flex items-center gap-1 mb-1">
                                  <Title
                                    level={5}
                                    ellipsis
                                    style={{ marginBottom: 0, fontSize: 13, flex: 1 }}
                                  >
                                    {note.title}
                                  </Title>
                                  <NoteDecorators note={note} warningColor={token.colorWarning} />
                                </div>
                                <Paragraph
                                  type="secondary"
                                  ellipsis={{ rows: 3 }}
                                  style={{ fontSize: 11, flex: 1, marginBottom: 6 }}
                                >
                                  {notePreviews.get(note.id) || "暂无内容"}
                                </Paragraph>
                                <div className="flex items-center justify-between">
                                  <Text type="secondary" style={{ fontSize: 10 }}>
                                    {relativeTime(note.updated_at)}
                                    {note.word_count > 0 && ` · ${note.word_count} 字`}
                                  </Text>
                                  <Space size={0}>
                                    <Dropdown
                                      trigger={["click"]}
                                      menu={{
                                        items: [
                                          {
                                            key: "md",
                                            label: "导出为 Markdown",
                                            onClick: () => void handleExport(note),
                                          },
                                          {
                                            key: "docx",
                                            label: "导出为 Word (.docx)",
                                            onClick: () => void handleExportWordSingle(note),
                                          },
                                          {
                                            key: "html",
                                            label: "导出为 HTML (单文件)",
                                            onClick: () => void handleExportHtmlSingle(note),
                                          },
                                        ],
                                      }}
                                    >
                                      <Tooltip title="导出">
                                        <Button
                                          type="text"
                                          size="small"
                                          icon={<Share size={11} />}
                                          onClick={(e) => e.stopPropagation()}
                                          style={{ height: 20, width: 20, padding: 0 }}
                                        />
                                      </Tooltip>
                                    </Dropdown>
                                    <Popconfirm
                                      title="确认删除？"
                                      onConfirm={(e) => {
                                        e?.stopPropagation();
                                        handleDelete(note.id);
                                      }}
                                    >
                                      <Tooltip title="删除">
                                        <Button
                                          type="text"
                                          danger
                                          size="small"
                                          icon={<Trash2 size={11} />}
                                          onClick={(e) => e.stopPropagation()}
                                          style={{ height: 20, width: 20, padding: 0 }}
                                        />
                                      </Tooltip>
                                    </Popconfirm>
                                  </Space>
                                </div>
                              </Card>
                            </Col>
                          ))}
                        </Row>
                      </div>
                    );
                  })}
                </div>
              </div>

              {data.total > data.page_size && (
                <div className="flex justify-center mt-4">
                  <Button disabled={data.page <= 1} onClick={() => loadNotes(data.page - 1)}>
                    上一页
                  </Button>
                  <Text className="mx-4" style={{ lineHeight: "32px" }}>
                    {data.page} / {Math.ceil(data.total / data.page_size)}
                  </Text>
                  <Button
                    disabled={data.page >= Math.ceil(data.total / data.page_size)}
                    onClick={() => loadNotes(data.page + 1)}
                  >
                    下一页
                  </Button>
                </div>
              )}
            </>
          ) : (
            <EmptyState
              description="暂无笔记"
              actionText="创建第一篇笔记"
              onAction={() =>
                createBlankAndOpen(
                  folderId ? Number(folderId) : null,
                  navigate,
                  { useDefaults: !folderId },
                )
              }
            />
          )}
        </>
      )}

      {/* 时间线视图 */}
      {viewMode === "timeline" && (
        <>
          {loading ? (
            <Card loading style={{ height: 200 }} />
          ) : data.items.length > 0 ? (
            <div className="pl-2">
              {Array.from(dateGroups.entries()).map(([date, notes]) => (
                <div key={date} className="mb-5">
                  <div
                    className="flex items-center gap-2 mb-2 pb-1"
                    style={{
                      borderBottom: `1px solid ${token.colorBorderSecondary}`,
                    }}
                  >
                    <Calendar size={13} style={{ color: token.colorPrimary }} />
                    <Text strong style={{ fontSize: 13, color: token.colorPrimary }}>
                      {formatDateLabel(date)}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {notes.length} 篇
                    </Text>
                  </div>
                  <Timeline
                    items={notes.map((note) => ({
                      color: note.is_pinned ? "gold" : note.is_daily ? "blue" : "gray",
                      children: (
                        <div
                          className="cursor-pointer group -mt-0.5"
                          onClick={() => navigate(`/notes/${note.id}`)}
                        >
                          <div className="flex items-center gap-1.5">
                            <Text
                              style={{ fontSize: 13 }}
                              className="group-hover:text-blue-500 transition-colors"
                            >
                              {note.title}
                            </Text>
                            <NoteDecorators note={note} warningColor={token.colorWarning} />
                            <Text
                              type="secondary"
                              style={{ fontSize: 10, marginLeft: "auto" }}
                            >
                              {note.updated_at.slice(11, 16)}
                            </Text>
                          </div>
                          {note.content && (
                            <Paragraph
                              type="secondary"
                              ellipsis={{ rows: 1 }}
                              style={{
                                fontSize: 11,
                                marginBottom: 0,
                                marginTop: 2,
                              }}
                            >
                              {(notePreviews.get(note.id) ?? "").slice(0, 100)}
                            </Paragraph>
                          )}
                        </div>
                      ),
                    }))}
                  />
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              description="暂无笔记"
              actionText="创建第一篇笔记"
              onAction={() =>
                createBlankAndOpen(
                  folderId ? Number(folderId) : null,
                  navigate,
                  { useDefaults: !folderId },
                )
              }
            />
          )}
        </>
      )}

      {/* "新建笔记"入口已统一到 NewNoteButton 分段按钮 */}
    </div>
  );
}
