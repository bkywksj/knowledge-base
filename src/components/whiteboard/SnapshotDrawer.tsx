import { lazy, Suspense, useCallback, useEffect, useState } from "react";
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
import { whiteboardApi } from "@/lib/api";
import { useAppStore } from "@/store";
import type { NoteSnapshotMeta, SnapshotReason } from "@/types";

/**
 * 历史版本抽屉。
 *
 * 为什么白板尤其需要它：画布是防抖**自动**保存的 —— 误删一大片图形什么都不用做，
 * 改动就已经进库；撤销栈只活在内存里，关掉应用就没了。抽屉左侧列版本、
 * 右侧只读预览，确认是那一版再恢复，避免"闭着眼睛回滚"。
 *
 * 预览画布与主画布是两个独立的 Excalidraw 实例，同样走 lazy —— 抽屉不打开就不加载。
 */
const WhiteboardCanvas = lazy(
  () => import("@/components/whiteboard/WhiteboardCanvas"),
);

const REASON_LABEL: Record<SnapshotReason, { text: string; color: string }> = {
  auto: { text: "自动", color: "default" },
  manual: { text: "手动存档", color: "blue" },
  before_restore: { text: "恢复前备份", color: "orange" },
};

/** 人话时间：今天只显示时刻，更早带上日期。用户找的是"我下午改坏之前那一版" */
function formatStamp(raw: string): string {
  // 后端存的是 `YYYY-MM-DD HH:MM:SS`（localtime，不带时区）。
  // Safari/WebView 对带空格的格式解析不一致，替换成 T 更稳妥。
  const d = new Date(raw.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return raw;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return `今天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
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
  /** 回滚成功后通知外层重新加载画布 —— 页面上那份场景已经是旧的了 */
  onRestored: () => void;
}

export default function SnapshotDrawer({
  open,
  onClose,
  noteId,
  onRestored,
}: Props) {
  const { message } = AntdApp.useApp();
  const { token } = antdTheme.useToken();
  const themeCategory = useAppStore((s) => s.themeCategory);

  const [list, setList] = useState<NoteSnapshotMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<NoteSnapshotMeta | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await whiteboardApi.listSnapshots(noteId);
      setList(rows);
      // 默认选中最新一份，省掉用户"打开→再点一下"的多余动作
      setSelected((prev) => prev ?? rows[0] ?? null);
    } catch (e) {
      message.error(`读取历史版本失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [noteId, message]);

  // 每次打开都重新拉：抽屉关着的这段时间里画布还在自动保存，列表随时会变长
  useEffect(() => {
    if (!open) {
      setSelected(null);
      setPreview(null);
      return;
    }
    void load();
  }, [open, load]);

  // 选中项变了 → 拉那一版的画布内容
  useEffect(() => {
    if (!open || !selected) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    (async () => {
      try {
        const scene = await whiteboardApi.getSnapshotScene(selected.id);
        if (!cancelled) setPreview(scene);
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
      const saved = await whiteboardApi.createSnapshot(noteId);
      message.success(saved ? "已存档当前版本" : "内容与上一份存档相同，无需重复存");
      if (saved) await load();
    } catch (e) {
      message.error(`存档失败: ${e}`);
    }
  }, [noteId, message, load]);

  const handleRestore = useCallback(async () => {
    if (!selected) return;
    setRestoring(true);
    try {
      await whiteboardApi.restoreSnapshot(noteId, selected.id);
      message.success("已恢复到这一版（当前版本已自动存档，可再滚回来）");
      onRestored();
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

      {/* 右：只读预览 + 恢复 */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div
          className="flex items-center justify-between gap-2 px-3 py-2 shrink-0"
          style={{ borderBottom: `1px solid ${token.colorBorderSecondary}` }}
        >
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {selected
              ? `预览 ${formatStamp(selected.created_at)} 的画布（只读）`
              : "选择左侧的版本查看"}
          </Typography.Text>
          <Popconfirm
            title="恢复到这一版？"
            description="当前画布会先自动存档一份，恢复后还能再滚回来。"
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

        <div className="flex-1 min-h-0">
          {previewLoading || preview === null ? (
            <div className="flex items-center justify-center h-full">
              {previewLoading ? <Spin tip="加载中..." /> : <Empty description="无预览" />}
            </div>
          ) : (
            <Suspense
              fallback={
                <div className="flex items-center justify-center h-full">
                  <Spin />
                </div>
              }
            >
              {/* key 绑快照 id：Excalidraw 的 initialData 是非受控的，
                  不换 key 切换版本时画布不会更新 */}
              <WhiteboardCanvas
                key={selected?.id}
                initialScene={preview}
                theme={themeCategory === "dark" ? "dark" : "light"}
                readOnly
              />
            </Suspense>
          )}
        </div>
      </div>
    </Drawer>
  );
}
