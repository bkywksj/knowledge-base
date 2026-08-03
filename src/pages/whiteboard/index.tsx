import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Input,
  Button,
  Spin,
  Empty,
  Popconfirm,
  Typography,
  Dropdown,
  App as AntdApp,
  theme as antdTheme,
  type MenuProps,
} from "antd";
import { ArrowLeft, Trash2, Check, Loader2, Download, Copy } from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/store";
import { noteApi, whiteboardApi, systemApi } from "@/lib/api";
import type { Note } from "@/types";
// 仅类型导入：`import type` 会被编译期擦除，不会把 Excalidraw 拉进本页面的 chunk
import type { WhiteboardExportApi } from "@/components/whiteboard/WhiteboardCanvas";

const { Text } = Typography;

/**
 * 白板画布是重量级依赖（Excalidraw 及其一大票传递依赖），必须懒加载：
 * 只有真正打开白板的用户才会付出这份下载与解析成本。
 * 对应 vite.config.ts 里把它切成独立的 vendor-excalidraw chunk。
 */
const WhiteboardCanvas = lazy(
  () => import("@/components/whiteboard/WhiteboardCanvas"),
);

/** 顶栏右侧的保存状态。让用户对「画的东西存没存住」有确定感，而不是猜 */
type SaveState = "idle" | "saving" | "saved" | "error";

export default function WhiteboardPage() {
  const { id: idParam } = useParams<{ id: string }>();
  const noteId = Number(idParam);
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const { token } = antdTheme.useToken();
  const themeCategory = useAppStore((s) => s.themeCategory);

  const [note, setNote] = useState<Note | null>(null);
  // 画布场景单独取（getScene 会把图片从附件内联回 base64），不能直接用 note.content
  const [scene, setScene] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  // 「已保存」的对勾显示 2 秒后自动淡回 idle，避免长期占着视觉焦点
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 画布挂载后由 WhiteboardCanvas 填入导出能力（见该组件的 exportRef 说明）
  const exportApiRef = useRef<WhiteboardExportApi | null>(null);

  useEffect(() => {
    if (!Number.isFinite(noteId) || noteId <= 0) {
      setError("无效的白板 ID");
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const n = await noteApi.get(noteId);
        if (cancelled) return;
        if (n.note_type !== "whiteboard") {
          // 走错路由：这条其实是普通笔记，直接转到 Markdown 编辑器而不是报错，
          // 免得用户对着一个"打不开"的白板发愣
          navigate(`/notes/${noteId}`, { replace: true });
          return;
        }
        const sceneJson = await whiteboardApi.getScene(noteId);
        if (cancelled) return;
        setNote(n);
        setTitle(n.title);
        setScene(sceneJson);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [noteId, navigate]);

  // 卸载时清掉「已保存」提示的定时器，避免在已卸载组件上 setState
  useEffect(
    () => () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    },
    [],
  );

  /** 画布内容变更（已在子组件里防抖过）→ 落库 */
  const handleSaveScene = useCallback(
    async (sceneJson: string) => {
      setSaveState("saving");
      try {
        await whiteboardApi.saveScene(noteId, sceneJson);
        setSaveState("saved");
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => setSaveState("idle"), 2000);
      } catch (e) {
        setSaveState("error");
        message.error(`白板保存失败: ${e}`);
      }
    },
    [noteId, message],
  );

  /** 标题失焦时保存。白板的正文由画布单独维护，这里必须把原 content 原样回填，
   *  否则 update_note 会用空串把整块画布覆盖掉。 */
  const handleTitleBlur = useCallback(async () => {
    const next = title.trim();
    if (!note || !next || next === note.title) {
      setTitle(note?.title ?? "");
      return;
    }
    try {
      const updated = await noteApi.update(noteId, {
        title: next,
        content: note.content,
        folder_id: note.folder_id,
      });
      setNote(updated);
      setTitle(updated.title);
    } catch (e) {
      message.error(`重命名失败: ${e}`);
      setTitle(note.title);
    }
  }, [title, note, noteId, message]);

  /** 导出画布为图片文件。走原生 save 对话框 + 已有的 writeBinaryFile 落盘 */
  const handleExport = useCallback(
    async (format: "png" | "svg") => {
      const api = exportApiRef.current;
      if (!api) {
        message.warning("画布还没加载完，请稍候");
        return;
      }
      try {
        // 先弹对话框再渲染：用户取消的话就不用白白渲染一张大图
        const path = await saveDialog({
          defaultPath: `${(note?.title || "白板").replace(/[\\/:*?"<>|]/g, "_")}.${format}`,
          filters: [
            {
              name: format === "png" ? "PNG 图片" : "SVG 矢量图",
              extensions: [format],
            },
          ],
        });
        if (!path) return;
        const base64 = await api.exportImage(format);
        await systemApi.writeBinaryFile(path, base64);
        message.success(`已导出 ${format.toUpperCase()}`);
      } catch (e) {
        message.error(`导出失败: ${e}`);
      }
    },
    [note, message],
  );

  /** 复制画布为 PNG 到剪贴板，方便直接粘进笔记 */
  const handleCopyImage = useCallback(async () => {
    const api = exportApiRef.current;
    if (!api) {
      message.warning("画布还没加载完，请稍候");
      return;
    }
    try {
      await api.copyImageToClipboard();
      message.success("已复制为图片，可直接粘贴到笔记里");
    } catch (e) {
      message.error(`复制失败: ${e}`);
    }
  }, [message]);

  const exportMenu: MenuProps["items"] = [
    {
      key: "png",
      label: "导出 PNG…",
      icon: <Download size={14} />,
      onClick: () => void handleExport("png"),
    },
    {
      key: "svg",
      label: "导出 SVG…",
      icon: <Download size={14} />,
      onClick: () => void handleExport("svg"),
    },
    { type: "divider" },
    {
      key: "clipboard",
      label: "复制为图片",
      icon: <Copy size={14} />,
      onClick: () => void handleCopyImage(),
    },
  ];

  const handleDelete = useCallback(async () => {
    try {
      await noteApi.delete(noteId);
      message.success("已移入回收站");
      navigate("/notes");
    } catch (e) {
      message.error(`删除失败: ${e}`);
    }
  }, [noteId, navigate, message]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spin tip="加载白板..." />
      </div>
    );
  }

  if (error || !note) {
    return (
      <div className="flex items-center justify-center h-full">
        <Empty description={error ?? "白板不存在"} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* 顶栏：返回 / 标题 / 保存状态 / 删除 */}
      <div
        className="flex items-center gap-2 px-3 py-2 shrink-0"
        style={{
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
        }}
      >
        <Button
          type="text"
          icon={<ArrowLeft size={16} />}
          onClick={() => navigate(-1)}
          title="返回"
        />
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={handleTitleBlur}
          onPressEnter={(e) => e.currentTarget.blur()}
          variant="borderless"
          placeholder="未命名白板"
          className="font-medium"
          style={{ maxWidth: 420 }}
        />

        <div className="flex-1" />

        <SaveIndicator state={saveState} color={token.colorTextSecondary} />

        <Dropdown menu={{ items: exportMenu }} trigger={["click"]} placement="bottomRight">
          <Button type="text" icon={<Download size={16} />} title="导出 / 复制为图片" />
        </Dropdown>

        <Popconfirm
          title="移入回收站？"
          description="白板会进回收站，可以再恢复。"
          onConfirm={handleDelete}
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
        >
          <Button type="text" danger icon={<Trash2 size={16} />} title="删除白板" />
        </Popconfirm>
      </div>

      {/* 画布。Excalidraw 需要一个确定高度的容器，这里用 flex-1 + min-h-0 撑满剩余空间 */}
      <div className="flex-1 min-h-0">
        <Suspense
          fallback={
            <div className="flex items-center justify-center h-full">
              <Spin tip="正在加载白板画布..." />
            </div>
          }
        >
          <WhiteboardCanvas
            initialScene={scene ?? ""}
            onSave={handleSaveScene}
            theme={themeCategory === "dark" ? "dark" : "light"}
            // 画布里的 [[双链]] 角标 → 走应用内路由。目标若也是白板，
            // /notes/:id 会自行重定向到 /whiteboard/:id（见 notes/editor.tsx）
            onOpenNote={(id) => navigate(`/notes/${id}`)}
            exportRef={exportApiRef}
            onError={() =>
              message.warning("白板内容损坏，已打开空白画布；请勿保存以免覆盖原数据")
            }
          />
        </Suspense>
      </div>
    </div>
  );
}

/** 顶栏右侧的保存状态指示 */
function SaveIndicator({ state, color }: { state: SaveState; color: string }) {
  if (state === "idle") return null;
  if (state === "saving") {
    return (
      <Text style={{ color, fontSize: 12 }}>
        <Loader2 size={12} className="inline animate-spin mr-1" />
        保存中
      </Text>
    );
  }
  if (state === "saved") {
    return (
      <Text style={{ color, fontSize: 12 }}>
        <Check size={12} className="inline mr-1" />
        已保存
      </Text>
    );
  }
  return (
    <Text type="danger" style={{ fontSize: 12 }}>
      保存失败
    </Text>
  );
}
