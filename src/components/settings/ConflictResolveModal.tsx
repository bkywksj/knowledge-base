/**
 * T-S051 同步冲突解决面板
 *
 * V1 pull 遇到"本地/远端各改各的"时会把远端版本落到 sync_conflicts/ 目录、本地保持原样。
 * 这里把这些冲突列出来，每条用 本地 / 远端 双栏 diff 展示，
 * 用户选「用本地 / 用远端 / 保存合并结果」→ 写回笔记 + 删冲突文件。
 */
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import {
  Alert,
  App as AntdApp,
  Button,
  Empty,
  Input,
  List,
  Modal,
  Space,
  Spin,
  Tag,
} from "antd";
import type { DiffMethod } from "react-diff-viewer-continued";

// diff 视图只在真有冲突时才渲染；它被同步设置页静态引用，懒加载避免拖进主包
const ReactDiffViewer = lazy(() => import("react-diff-viewer-continued"));
// 枚举值直接写字面量：值导入 DiffMethod 会把整个库又拉回主包
const DIFF_WORDS = "diffWords" as DiffMethod;
import { useAppStore } from "@/store";
import { syncV1Api } from "@/lib/api";
import type { SyncConflictItem, SyncConflictResolution } from "@/types";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 解决了至少一条（或刷新后数量变化）时回调，外层据此刷新"冲突待处理"角标 */
  onChanged?: () => void;
}

export function ConflictResolveModal({ open, onClose, onChanged }: Props) {
  const { message } = AntdApp.useApp();
  const dark = useAppStore((s) => s.themeCategory) === "dark";

  const [loading, setLoading] = useState(false);
  const [conflicts, setConflicts] = useState<SyncConflictItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [merged, setMerged] = useState("");
  const [resolving, setResolving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await syncV1Api.listConflicts();
      setConflicts(list);
      setSelectedIdx(0);
      setMerged(list[0]?.localContent ?? "");
    } catch (e) {
      message.error(`加载冲突列表失败：${e}`);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  function selectIdx(i: number) {
    setSelectedIdx(i);
    setMerged(conflicts[i]?.localContent ?? "");
  }

  const current = conflicts[selectedIdx];

  async function resolve(resolution: SyncConflictResolution) {
    if (!current) return;
    setResolving(true);
    try {
      await syncV1Api.resolveConflict(
        current.conflictFilePath,
        resolution,
        resolution === "merged" ? merged : undefined,
      );
      message.success("已处理该冲突");
      onChanged?.();
      const next = conflicts.filter((_, i) => i !== selectedIdx);
      setConflicts(next);
      const ni = next.length === 0 ? 0 : Math.min(selectedIdx, next.length - 1);
      setSelectedIdx(ni);
      setMerged(next[ni]?.localContent ?? "");
    } catch (e) {
      message.error(`处理失败：${e}`);
    } finally {
      setResolving(false);
    }
  }

  return (
    <Modal
      title="同步冲突待处理"
      open={open}
      onCancel={onClose}
      width="80vw"
      style={{ top: 24, maxWidth: 1100 }}
      footer={<Button onClick={onClose}>关闭</Button>}
    >
      {loading ? (
        <div style={{ textAlign: "center", padding: 40 }}>
          <Spin />
        </div>
      ) : conflicts.length === 0 ? (
        <Empty description="没有待处理的冲突" />
      ) : (
        <div style={{ display: "flex", gap: 16, minHeight: 420 }}>
          <div
            style={{
              width: 230,
              flexShrink: 0,
              paddingRight: 12,
              borderRight: "1px solid var(--ant-color-border-secondary, #eee)",
              overflowY: "auto",
              maxHeight: "65vh",
            }}
          >
            <List
              size="small"
              dataSource={conflicts}
              renderItem={(c, i) => (
                <List.Item
                  onClick={() => selectIdx(i)}
                  style={{
                    cursor: "pointer",
                    borderRadius: 6,
                    padding: "6px 8px",
                    background:
                      i === selectedIdx
                        ? "var(--ant-color-fill-tertiary, #f5f5f5)"
                        : undefined,
                  }}
                >
                  <div style={{ width: "100%", minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={c.title || c.stableId}
                    >
                      {c.encrypted ? "🔒 " : ""}
                      {c.title || c.stableId}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--ant-color-text-tertiary, #999)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c.backendName}
                      {c.detectedAt ? ` · ${c.detectedAt}` : ""}
                    </div>
                  </div>
                </List.Item>
              )}
            />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {current && (
              <ConflictDetail
                key={current.conflictFilePath}
                item={current}
                merged={merged}
                onMergedChange={setMerged}
                dark={dark}
                resolving={resolving}
                onResolve={resolve}
              />
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function ConflictDetail({
  item,
  merged,
  onMergedChange,
  dark,
  resolving,
  onResolve,
}: {
  item: SyncConflictItem;
  merged: string;
  onMergedChange: (v: string) => void;
  dark: boolean;
  resolving: boolean;
  onResolve: (r: SyncConflictResolution) => void;
}) {
  if (item.encrypted) {
    return (
      <div>
        <Alert
          type="warning"
          showIcon
          message="加密笔记冲突"
          description="加密笔记的冲突内容是密文，无法在此对比 / 合并。请在笔记编辑器中解锁后手动处理；此处仅能「忽略」（删除冲突标记文件，下次推送时本地版本会上传覆盖远端）。"
          style={{ marginBottom: 12 }}
        />
        <Button danger loading={resolving} onClick={() => onResolve("keep_local")}>
          忽略此冲突（保留本地）
        </Button>
      </div>
    );
  }

  if (item.noteMissingLocally) {
    return (
      <div>
        <Alert
          type="info"
          showIcon
          message="本地已无此笔记"
          description="你本地已删除这条笔记，但收到了来自远端的修改版本。可以「用远端版本」把它重建回来，或「忽略」丢弃远端版本。"
          style={{ marginBottom: 12 }}
        />
        <div
          style={{
            maxHeight: "40vh",
            overflow: "auto",
            border: "1px solid var(--ant-color-border-secondary, #eee)",
            borderRadius: 6,
            padding: 12,
            whiteSpace: "pre-wrap",
            fontSize: 13,
            lineHeight: 1.6,
          }}
        >
          {item.remoteContent || "（远端版本正文为空）"}
        </div>
        <Space style={{ marginTop: 12 }}>
          <Button type="primary" loading={resolving} onClick={() => onResolve("use_remote")}>
            用远端版本（重建笔记）
          </Button>
          <Button danger loading={resolving} onClick={() => onResolve("keep_local")}>
            忽略（丢弃远端版本）
          </Button>
        </Space>
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          fontSize: 12,
          color: "var(--ant-color-text-secondary, #888)",
          marginBottom: 8,
        }}
      >
        <Tag>{item.backendName}</Tag>
        左 = 本地版本，右 = 远端版本
        {item.detectedAt ? `（检测于 ${item.detectedAt}）` : ""}
      </div>
      <div
        style={{
          maxHeight: "34vh",
          overflow: "auto",
          border: "1px solid var(--ant-color-border-secondary, #eee)",
          borderRadius: 6,
        }}
      >
        <Suspense fallback={<Spin style={{ display: "block", padding: 24 }} />}>
          <ReactDiffViewer
            oldValue={item.localContent}
            newValue={item.remoteContent}
            splitView
            useDarkTheme={dark}
            compareMethod={DIFF_WORDS}
            leftTitle="本地版本"
            rightTitle="远端版本"
          />
        </Suspense>
      </div>
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
          合并结果（可编辑，初始为本地版本；保存后会写回这条笔记）
        </div>
        <Input.TextArea
          value={merged}
          onChange={(e) => onMergedChange(e.target.value)}
          autoSize={{ minRows: 6, maxRows: 16 }}
        />
      </div>
      <Space style={{ marginTop: 12 }}>
        <Button loading={resolving} onClick={() => onResolve("keep_local")}>
          用本地版本
        </Button>
        <Button loading={resolving} onClick={() => onResolve("use_remote")}>
          用远端版本
        </Button>
        <Button type="primary" loading={resolving} onClick={() => onResolve("merged")}>
          保存合并结果
        </Button>
      </Space>
      <div
        style={{
          fontSize: 11,
          color: "var(--ant-color-text-tertiary, #999)",
          marginTop: 6,
        }}
      >
        处理后会写回本地笔记并刷新「最近更新」时间，下次推送时这条会同步到远端、覆盖冲突版本。
      </div>
    </div>
  );
}
