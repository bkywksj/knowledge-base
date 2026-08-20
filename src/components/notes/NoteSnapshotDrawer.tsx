import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Drawer,
  Empty,
  List,
  Popconfirm,
  Spin,
  Tag,
  Typography,
  App as AntdApp,
  theme as antdTheme,
} from "antd";
import { History, RotateCcw, Save } from "lucide-react";
import { noteApi } from "@/lib/api";
import type { NoteSnapshotMeta, SnapshotReason } from "@/types";

/**
 * 普通笔记的历史版本抽屉。
 *
 * 与白板那套（components/whiteboard/SnapshotDrawer）是两个组件：那边右侧要挂一整个
 * 只读画布，这边只需把正文原样摊开。共用的是后端同一张 note_snapshots 表。
 *
 * 正文按**纯文本**显示而不是渲染 Markdown：这里要回答的是"那一版到底写了什么"，
 * 渲染后反而看不出空行、列表符号这些常被误删的东西。
 */
const REASON_LABEL: Record<SnapshotReason, { text: string; color: string }> = {
  auto: { text: "自动", color: "default" },
  manual: { text: "手动存档", color: "blue" },
  before_restore: { text: "恢复前备份", color: "orange" },
};

/** 人话时间：今天只显示时刻，更早带上日期 */
function formatStamp(raw: string): string {
  // 后端存的是 `YYYY-MM-DD HH:MM:SS`（localtime），替换成 T 让 WebView 解析一致
  const d = new Date(raw.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return raw;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameDay ? `今天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface Props {
  open: boolean;
  onClose: () => void;
  noteId: number;
  /** 回滚成功后通知外层用新正文重载编辑器 —— 页面上那份已经是旧的了 */
  onRestored: (content: string) => void;
}

export default function NoteSnapshotDrawer({
  open,
  onClose,
  noteId,
  onRestored,
}: Props) {
  const { message } = AntdApp.useApp();
  const { token } = antdTheme.useToken();

  const [list, setList] = useState<NoteSnapshotMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<NoteSnapshotMeta | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await noteApi.listSnapshots(noteId);
      setList(rows);
      // 默认选中最新一份，省掉"打开→再点一下"
      setSelected((prev) => prev ?? rows[0] ?? null);
    } catch (e) {
      message.error(`读取历史版本失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [noteId, message]);

  // 每次打开都重拉：关着的这段时间里笔记还在保存，列表随时会变长
  useEffect(() => {
    if (!open) {
      setSelected(null);
      setPreview(null);
      return;
    }
    void load();
  }, [open, load]);

  useEffect(() => {
    if (!open || !selected) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    (async () => {
      try {
        const snap = await noteApi.getSnapshot(selected.id);
        if (!cancelled) setPreview(snap.content);
      } catch (e) {
        if (!cancelled) {
          setPreview(null);
          message.error(`加载这一版失败: ${e}`);
        }
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, selected, message]);

  const handleManualSave = useCallback(async () => {
    try {
      const saved = await noteApi.createSnapshot(noteId);
      message.success(
        saved ? "已存档当前版本" : "内容与上一份存档相同，无需重复存",
      );
      if (saved) await load();
    } catch (e) {
      message.error(`存档失败: ${e}`);
    }
  }, [noteId, message, load]);

  const handleRestore = useCallback(async () => {
    if (!selected) return;
    setRestoring(true);
    try {
      const note = await noteApi.restoreSnapshot(noteId, selected.id);
      message.success("已恢复到这一版（当前版本已自动存档，可再滚回来）");
      onRestored(note.content);
      onClose();
    } catch (e) {
      message.error(`恢复失败: ${e}`);
    } finally {
      setRestoring(false);
    }
  }, [noteId, selected, message, onRestored, onClose]);

  return (
    <Drawer
      title={
        <span className="flex items-center gap-2">
          <History size={16} />
          历史版本
        </span>
      }
      open={open}
      onClose={onClose}
      width="min(1040px, 92vw)"
      styles={{ body: { padding: 0, display: "flex", overflow: "hidden" } }}
      extra={
        <Button icon={<Save size={14} />} onClick={handleManualSave}>
          存档当前版本
        </Button>
      }
    >
      {/* 左：版本列表 */}
      <div
        className="shrink-0 overflow-auto"
        style={{
          width: 260,
          borderRight: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        {loading ? (
          <div className="flex justify-center py-8">
            <Spin />
          </div>
        ) : list.length === 0 ? (
          <Empty
            className="mt-10"
            description="还没有历史版本"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        ) : (
          <List
            size="small"
            dataSource={list}
            renderItem={(item) => {
              const active = selected?.id === item.id;
              const label = REASON_LABEL[item.reason] ?? REASON_LABEL.auto;
              return (
                <List.Item
                  onClick={() => setSelected(item)}
                  className="cursor-pointer"
                  style={{
                    paddingInline: 12,
                    background: active ? token.controlItemBgActive : undefined,
                  }}
                >
                  <div className="w-full">
                    <div className="flex items-center justify-between gap-2">
                      <span style={{ fontWeight: active ? 600 : 400 }}>
                        {formatStamp(item.created_at)}
                      </span>
                      <Tag color={label.color} style={{ marginInlineEnd: 0 }}>
                        {label.text}
                      </Tag>
                    </div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {formatBytes(item.byte_size)}
                    </Typography.Text>
                  </div>
                </List.Item>
              );
            }}
          />
        )}
      </div>

      {/* 右：正文预览 + 恢复 */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div
          className="flex items-center justify-between gap-2 px-3 py-2 shrink-0"
          style={{ borderBottom: `1px solid ${token.colorBorderSecondary}` }}
        >
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {selected
              ? `${formatStamp(selected.created_at)} 的正文（只读，恢复不会改动标题）`
              : "选择左侧的版本查看"}
          </Typography.Text>
          <Popconfirm
            title="恢复到这一版？"
            description="当前正文会先自动存档一份，恢复后还能再滚回来。"
            okText="恢复"
            cancelText="取消"
            onConfirm={handleRestore}
            disabled={!selected || restoring}
          >
            <Button
              type="primary"
              icon={<RotateCcw size={14} />}
              disabled={!selected}
              loading={restoring}
            >
              恢复此版本
            </Button>
          </Popconfirm>
        </div>

        <div className="flex-1 min-h-0 overflow-auto">
          {previewLoading ? (
            <div className="flex items-center justify-center h-full">
              <Spin tip="加载中..." />
            </div>
          ) : preview === null ? (
            <div className="flex items-center justify-center h-full">
              <Empty description="无预览" />
            </div>
          ) : (
            <pre
              className="m-0 px-4 py-3"
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontSize: 13,
                lineHeight: 1.7,
                fontFamily: token.fontFamilyCode,
                color: token.colorText,
              }}
            >
              {preview}
            </pre>
          )}
        </div>
      </div>
    </Drawer>
  );
}
