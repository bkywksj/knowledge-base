/**
 * 孤儿素材清理面板（替代旧的"孤儿图片清理"）
 *
 * - 一次扫描覆盖 5 类素材：images / videos / attachments / pdfs / sources
 * - Tabs 分组展示，徽章显示每类孤儿数
 * - 单类一键清理 + 全部一键清理
 * - 图片类预览缩略图，其他类只显示路径列表
 *
 * 修复了旧版的两个 BUG：
 * 1. trash 笔记 content 已纳入引用集 → 撤回不会丢图片
 * 2. 加密笔记 content 是密文，对应 note 目录整体跳过判定
 */
import { useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Modal,
  Popconfirm,
  Tabs,
  Typography,
  message,
} from "antd";
import { SyncOutlined } from "@ant-design/icons";
import { Trash2, ExternalLink } from "lucide-react";

import { orphanAssetApi } from "@/lib/api";
import type {
  OrphanAssetScan,
  OrphanGroup,
  OrphanItem,
  OrphanKind,
} from "@/types";

const { Text } = Typography;

const TAB_DEFS: { key: OrphanKind; label: string; description: string }[] = [
  { key: "image", label: "图片", description: "笔记里删掉但磁盘还在的图片" },
  { key: "video", label: "视频", description: "已不被任何笔记引用的视频" },
  { key: "attachment", label: "附件", description: "已不被任何笔记引用的附件" },
  { key: "pdf", label: "PDF", description: "已 purge 的笔记残留的 PDF" },
  { key: "source", label: "源文件", description: "已不被引用的 Word / 源文件" },
];

const KIND_TO_GROUP: Record<OrphanKind, keyof OrphanAssetScan> = {
  image: "images",
  video: "videos",
  attachment: "attachments",
  pdf: "pdfs",
  source: "sources",
};

function fmtMB(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function reasonLabel(reason: string): string {
  if (reason === "notePurged") return "笔记已被永久删除";
  return "未被引用";
}

function pickFileName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

export default function OrphanAssetsPanel() {
  const [scan, setScan] = useState<OrphanAssetScan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [activeTab, setActiveTab] = useState<OrphanKind>("image");
  const [previewItem, setPreviewItem] = useState<OrphanItem | null>(null);

  const totalCount = useMemo(() => {
    if (!scan) return 0;
    return (
      scan.images.count +
      scan.videos.count +
      scan.attachments.count +
      scan.pdfs.count +
      scan.sources.count
    );
  }, [scan]);

  const totalBytes = useMemo(() => {
    if (!scan) return 0;
    return (
      scan.images.totalBytes +
      scan.videos.totalBytes +
      scan.attachments.totalBytes +
      scan.pdfs.totalBytes +
      scan.sources.totalBytes
    );
  }, [scan]);

  async function handleScan() {
    setScanning(true);
    try {
      const result = await orphanAssetApi.scanAll();
      setScan(result);
    } catch (e) {
      message.error(`扫描失败: ${e}`);
    } finally {
      setScanning(false);
    }
  }

  async function handleClean(items: OrphanItem[]) {
    if (items.length === 0) return;
    setCleaning(true);
    try {
      const result = await orphanAssetApi.clean(items);
      const freed = fmtMB(result.freedBytes);
      if (result.failed.length > 0) {
        message.warning(
          `清理完成：删除 ${result.deleted} 项，失败 ${result.failed.length} 项，释放 ${freed}`,
        );
      } else {
        message.success(`清理完成：删除 ${result.deleted} 项，释放 ${freed}`);
      }
      await handleScan();
    } catch (e) {
      message.error(`清理失败: ${e}`);
    } finally {
      setCleaning(false);
    }
  }

  function getGroup(kind: OrphanKind): OrphanGroup {
    return scan ? scan[KIND_TO_GROUP[kind]] : { count: 0, totalBytes: 0, items: [], truncated: false };
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <Button
          icon={<SyncOutlined />}
          onClick={handleScan}
          loading={scanning}
          type="primary"
        >
          扫描全部孤儿素材
        </Button>
        <Text type="secondary" className="text-xs">
          覆盖图片 / 视频 / 附件 / PDF / 源文件 5 类，按类别分组展示
        </Text>
      </div>

      {scan && totalCount === 0 && (
        <Alert type="success" showIcon message="磁盘干净，没有孤儿素材" />
      )}

      {scan && totalCount > 0 && (
        <>
          <Alert
            type="warning"
            showIcon
            message={
              <span>
                共 <b>{totalCount}</b> 项孤儿素材，占用{" "}
                <b>{fmtMB(totalBytes)}</b>
              </span>
            }
            action={
              <Popconfirm
                title="清理全部 5 类孤儿素材？"
                description={`将删除 ${totalCount} 项文件 / 目录，不可撤销。`}
                okText="全部删除"
                okType="danger"
                cancelText="取消"
                onConfirm={() => {
                  const all: OrphanItem[] = [];
                  for (const def of TAB_DEFS) {
                    all.push(...getGroup(def.key).items);
                  }
                  return handleClean(all);
                }}
              >
                <Button danger size="small" loading={cleaning}>
                  一键清理全部
                </Button>
              </Popconfirm>
            }
          />

          <Tabs
            activeKey={activeTab}
            onChange={(k) => setActiveTab(k as OrphanKind)}
            items={TAB_DEFS.map((def) => {
              const group = getGroup(def.key);
              return {
                key: def.key,
                label: (
                  <Badge count={group.count} offset={[6, -2]} size="small">
                    <span>{def.label}</span>
                  </Badge>
                ),
                children: (
                  <OrphanTabContent
                    kind={def.key}
                    description={def.description}
                    group={group}
                    cleaning={cleaning}
                    onClean={() => handleClean(group.items)}
                    onPreview={(it) => setPreviewItem(it)}
                  />
                ),
              };
            })}
          />
        </>
      )}

      <Modal
        title="预览"
        open={!!previewItem}
        onCancel={() => setPreviewItem(null)}
        footer={null}
        width={680}
      >
        {/* 仅图片/视频走 Modal 全屏预览；其他类型在 PathList 里直接 openPath 走系统应用 */}
        {previewItem && previewItem.kind === "image" && (
          <img
            src={convertFileSrc(previewItem.path)}
            alt={previewItem.path}
            style={{ maxWidth: "100%", display: "block", margin: "0 auto" }}
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        )}
        {previewItem && previewItem.kind === "video" && (
          <video
            src={convertFileSrc(previewItem.path)}
            controls
            preload="metadata"
            style={{ maxWidth: "100%", display: "block", margin: "0 auto" }}
          />
        )}
        {previewItem && (
          <div className="text-xs text-gray-500 mt-3 break-all">
            {previewItem.path}
          </div>
        )}
      </Modal>
    </div>
  );
}

interface TabContentProps {
  kind: OrphanKind;
  description: string;
  group: OrphanGroup;
  cleaning: boolean;
  onClean: () => void;
  onPreview: (item: OrphanItem) => void;
}

function OrphanTabContent({
  kind,
  description,
  group,
  cleaning,
  onClean,
  onPreview,
}: TabContentProps) {
  if (group.count === 0) {
    return <Empty description="此类别下无孤儿" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <Text type="secondary" className="text-xs">{description}</Text>
          <div className="mt-1">
            <span className="text-sm">
              <b>{group.count}</b> 项 · {fmtMB(group.totalBytes)}
              {group.truncated && (
                <Text type="secondary" className="text-xs ml-2">
                  （列表已截断至前 500 项，可多次清理）
                </Text>
              )}
            </span>
          </div>
        </div>
        <Popconfirm
          title={`清理本组 ${group.items.length} 项？`}
          okText="删除"
          okType="danger"
          cancelText="取消"
          onConfirm={onClean}
        >
          <Button danger size="small" icon={<Trash2 size={14} />} loading={cleaning}>
            清理本组
          </Button>
        </Popconfirm>
      </div>

      {kind === "image" || kind === "video" ? (
        <MediaGrid kind={kind} items={group.items} onPreview={onPreview} />
      ) : (
        <PathList items={group.items} onPreview={onPreview} />
      )}
    </div>
  );
}

function MediaGrid({
  kind,
  items,
  onPreview,
}: {
  kind: OrphanKind;
  items: OrphanItem[];
  onPreview: (it: OrphanItem) => void;
}) {
  // 视频缩略图比图片宽一些，给"首帧/控件"留位置
  const minColumn = kind === "video" ? 200 : 140;
  const tileHeight = kind === "video" ? 130 : 100;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(auto-fill, minmax(${minColumn}px, 1fr))`,
        gap: 12,
        maxHeight: "60vh",
        overflow: "auto",
      }}
    >
      {items.map((it) => (
        <div
          key={it.path}
          className="border rounded overflow-hidden cursor-pointer"
          style={{ borderColor: "#e5e7eb", background: "#fafafa" }}
          onClick={() => onPreview(it)}
        >
          <div
            style={{
              height: tileHeight,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "#000",
            }}
          >
            {kind === "image" ? (
              <img
                src={convertFileSrc(it.path)}
                alt={it.path}
                style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
            ) : (
              // 视频缩略图：preload="metadata" 只下载首帧 + 时长，不会拉整个视频；
              // muted 让浏览器允许 play 不需要用户交互；点击卡片走 onPreview 全屏看
              <video
                src={convertFileSrc(it.path)}
                preload="metadata"
                muted
                playsInline
                controls
                style={{ maxWidth: "100%", maxHeight: "100%" }}
                onClick={(e) => e.stopPropagation()}
              />
            )}
          </div>
          <div className="text-xs px-2 py-1 truncate" style={{ color: "#666" }} title={it.path}>
            {pickFileName(it.path)}
          </div>
          <div className="text-[10px] px-2 pb-1" style={{ color: "#999" }}>
            {fmtMB(it.size)} · {reasonLabel(it.reason)}
          </div>
        </div>
      ))}
    </div>
  );
}

function PathList({
  items,
}: {
  items: OrphanItem[];
  onPreview: (it: OrphanItem) => void;
}) {
  /** 点击 → 用系统默认应用打开（PDF 启 Acrobat / Word 启 Office 等） */
  async function handleOpen(path: string) {
    try {
      await openPath(path);
    } catch (e) {
      message.error(`无法打开: ${e}`);
    }
  }

  return (
    <div
      style={{
        maxHeight: "60vh",
        overflow: "auto",
        border: "1px solid #f0f0f0",
        borderRadius: 6,
      }}
    >
      {items.map((it) => (
        <div
          key={it.path}
          className="px-3 py-2 border-b last:border-b-0 cursor-pointer hover:bg-gray-50 flex items-center gap-3"
          style={{ borderColor: "#f0f0f0" }}
          onClick={() => handleOpen(it.path)}
          title="点击用系统默认应用打开"
        >
          <div className="flex-1 min-w-0">
            <div className="text-sm truncate">{pickFileName(it.path)}</div>
            <div className="text-xs text-gray-500 truncate">{it.path}</div>
            <div className="text-xs text-gray-400 mt-0.5">
              {fmtMB(it.size)}
              {it.noteId != null && <span className="ml-2">笔记 ID: {it.noteId}</span>}
              <span className="ml-2">{reasonLabel(it.reason)}</span>
            </div>
          </div>
          <ExternalLink size={14} className="text-gray-400 shrink-0" />
        </div>
      ))}
    </div>
  );
}
