/**
 * Dataview 块的 React NodeView。
 *
 * - 渲染头部（标题 + 编辑/刷新按钮）+ 数据行（紧凑列表）
 * - 行点击：note 跳 `/notes/<id>`，task 触发全局事件让 tasks 页打开详情
 *   （编辑器里点 task 不便直接跳路由 — 用户多半就在某笔记里看 dataview，
 *    打开 task 详情比离开笔记跳走更顺手）
 * - 编辑：点齿轮弹 DataviewBlockModal，修改 config 后 updateAttributes
 *
 * NodeView 配置成 atom，整个区域不接受光标进入；点击/拖拽行为靠
 * `data-drag-handle` + NodeViewWrapper 默认。
 */
import { useCallback, useEffect, useState } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import {
  App as AntdApp,
  Button,
  Empty,
  Spin,
  Tooltip,
  theme as antdTheme,
} from "antd";
import {
  RefreshCw,
  Settings,
  NotebookText,
  CheckSquare,
  Tag as TagIcon,
  Folder as FolderIcon,
  Clock,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { dataviewApi } from "@/lib/api";
import type { DataviewConfig, DataviewKind, DataviewRow } from "@/types";
import { relativeTime } from "@/lib/utils";
import { DataviewBlockModal } from "./DataviewBlockModal";

import { useEditorEditable } from "./useEditorEditable";
const KIND_LABEL: Record<DataviewKind, string> = {
  "recent-notes": "最近修改的笔记",
  "notes-by-tag": "按标签筛选笔记",
  "notes-by-folder": "文件夹下的笔记",
  "pending-tasks": "未完成任务",
  "tasks-by-project": "项目下的任务",
};

const KIND_ICON: Record<DataviewKind, React.ReactNode> = {
  "recent-notes": <Clock size={13} />,
  "notes-by-tag": <TagIcon size={13} />,
  "notes-by-folder": <FolderIcon size={13} />,
  "pending-tasks": <CheckSquare size={13} />,
  "tasks-by-project": <CheckSquare size={13} />,
};

/** 按 config 调用对应 API */
async function runDataview(config: DataviewConfig): Promise<DataviewRow[]> {
  const limit = config.limit;
  switch (config.kind) {
    case "recent-notes":
      return dataviewApi.recentNotes(limit);
    case "notes-by-tag":
      if (!config.tag) return [];
      return dataviewApi.notesByTag(config.tag, limit);
    case "notes-by-folder":
      if (config.folderId == null) return [];
      return dataviewApi.notesByFolder(config.folderId, limit);
    case "pending-tasks":
      return dataviewApi.pendingTasks(limit);
    case "tasks-by-project":
      if (config.projectId == null) return [];
      return dataviewApi.tasksByProject(config.projectId, limit);
    default:
      return [];
  }
}

export function DataviewNodeView({
  node,
  updateAttributes,
  editor,
}: NodeViewProps) {
  const { token } = antdTheme.useToken();
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const config = (node.attrs.config as DataviewConfig) ?? {
    kind: "recent-notes" as DataviewKind,
    limit: 10,
  };
  const [rows, setRows] = useState<DataviewRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await runDataview(config);
      setRows(data);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(config)]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const isEditable = useEditorEditable(editor);
  const heading = config.title?.trim() || KIND_LABEL[config.kind] || "数据视图";

  function handleRowClick(row: DataviewRow) {
    if (row.linkKind === "note") {
      navigate(`/notes/${row.linkId}`);
    } else if (row.linkKind === "task") {
      // 任务详情通过全局事件唤起（tasks 页 / 编辑器都能监听）
      // v0.1 简化：直接跳 /tasks，把 id 放 URL 参数让 tasks 页自打开详情
      // 编辑器场景：避免离开当前笔记，仅 message 提示
      message.info(`任务 #${row.linkId}：${row.title}`);
    }
  }

  return (
    <NodeViewWrapper
      className="tiptap-dataview"
      data-drag-handle
      style={{
        margin: "12px 0",
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: 6,
        background: token.colorBgContainer,
        overflow: "hidden",
      }}
      // contenteditable=false：内容是动态查询结果，不让 PM 接管文本编辑
      contentEditable={false}
    >
      {/* 头部：标题 + 操作 */}
      <div
        className="flex items-center gap-2"
        style={{
          padding: "6px 10px",
          background: token.colorFillQuaternary,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          fontSize: 12,
          fontWeight: 500,
          color: token.colorTextSecondary,
        }}
      >
        <span style={{ color: token.colorPrimary }}>
          {KIND_ICON[config.kind]}
        </span>
        <span>{heading}</span>
        <span
          style={{
            fontSize: 11,
            color: token.colorTextTertiary,
            marginLeft: 2,
          }}
        >
          · {rows.length} 条
        </span>
        <div style={{ flex: 1 }} />
        <Tooltip title="刷新">
          <Button
            size="small"
            type="text"
            icon={<RefreshCw size={12} />}
            onClick={() => void reload()}
            loading={loading}
          />
        </Tooltip>
        {isEditable && (
          <Tooltip title="编辑视图">
            <Button
              size="small"
              type="text"
              icon={<Settings size={12} />}
              onClick={() => setModalOpen(true)}
            />
          </Tooltip>
        )}
      </div>

      {/* 数据行 */}
      <div style={{ padding: "4px 0", maxHeight: 360, overflowY: "auto" }}>
        {loading && rows.length === 0 ? (
          <div className="flex justify-center items-center" style={{ padding: 20 }}>
            <Spin size="small" />
          </div>
        ) : err ? (
          <div
            style={{
              padding: 12,
              fontSize: 12,
              color: token.colorError,
            }}
          >
            查询失败：{err}
          </div>
        ) : rows.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span style={{ fontSize: 12, color: token.colorTextTertiary }}>
                没有匹配的数据
              </span>
            }
            style={{ margin: "12px 0" }}
          />
        ) : (
          rows.map((row) => (
            <div
              key={`${row.linkKind}-${row.linkId}`}
              onClick={() => handleRowClick(row)}
              className="cursor-pointer"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "5px 12px",
                fontSize: 13,
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background =
                  token.colorFillQuaternary;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = "";
              }}
            >
              <span
                style={{
                  color: token.colorTextTertiary,
                  flexShrink: 0,
                }}
              >
                {row.linkKind === "note" ? (
                  <NotebookText size={12} />
                ) : (
                  <CheckSquare size={12} />
                )}
              </span>
              <span
                className="truncate"
                style={{ flex: 1, minWidth: 0 }}
                title={row.title}
              >
                {row.title}
              </span>
              {row.subtitle && (
                <span
                  style={{
                    fontSize: 11,
                    color: token.colorTextTertiary,
                    flexShrink: 0,
                  }}
                >
                  {row.subtitle}
                </span>
              )}
              <span
                style={{
                  fontSize: 11,
                  color: token.colorTextQuaternary,
                  flexShrink: 0,
                  minWidth: 60,
                  textAlign: "right",
                }}
              >
                {relativeTime(row.updatedAt)}
              </span>
            </div>
          ))
        )}
      </div>

      <DataviewBlockModal
        open={modalOpen}
        initial={config}
        onClose={() => setModalOpen(false)}
        onSave={(next) => {
          updateAttributes({ config: next });
          setModalOpen(false);
        }}
      />
    </NodeViewWrapper>
  );
}
