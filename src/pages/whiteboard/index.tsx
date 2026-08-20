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
  Modal,
  List,
  App as AntdApp,
  theme as antdTheme,
  type MenuProps,
} from "antd";
import {
  ArrowLeft,
  Trash2,
  Check,
  Loader2,
  Download,
  Copy,
  History,
  FileJson,
  Upload,
  Presentation,
  Minimize2,
  StickyNote,
} from "lucide-react";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/store";
import { noteApi, whiteboardApi, systemApi, searchApi } from "@/lib/api";
import type { Note, SearchResult } from "@/types";
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

/** 历史版本抽屉同样懒加载：它内部还会再挂一个只读画布，不点开就不该付出这份成本 */
const SnapshotDrawer = lazy(
  () => import("@/components/whiteboard/SnapshotDrawer"),
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
  const [historyOpen, setHistoryOpen] = useState(false);
  /** 演示模式：画布全屏 + 只读，顶栏收起 */
  const [presenting, setPresenting] = useState(false);
  /** 全屏的目标元素（只让画布容器全屏，不是整个窗口） */
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  /** 画布挂载后填入「插入笔记卡片」的函数 */
  const insertCardRef = useRef<((noteId: number) => Promise<void>) | null>(null);
  /** 选笔记弹窗 */
  const [cardPickerOpen, setCardPickerOpen] = useState(false);
  const [cardQuery, setCardQuery] = useState("");
  const [cardResults, setCardResults] = useState<SearchResult[]>([]);
  const [cardSearching, setCardSearching] = useState(false);
  /**
   * 画布实例的重建计数。
   *
   * Excalidraw 的 initialData 是非受控的，从外部换掉场景（回滚历史版本）
   * 只能靠换 key 重建整个画布 —— 光 setScene 改不动已经挂起来的那块画布。
   */
  const [canvasEpoch, setCanvasEpoch] = useState(0);

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

  /**
   * 画布被外部改写后（回滚历史版本 / 导入文件）重新装载。
   *
   * `discardPendingSave` 必须在换 key 之前调：旧画布实例卸载时会兜底保存一次，
   * 不打断的话新内容会被旧画布原样覆盖回去 —— 用户看到的就是"恢复没生效"。
   */
  const handleRestored = useCallback(async () => {
    exportApiRef.current?.discardPendingSave();
    try {
      const sceneJson = await whiteboardApi.getScene(noteId);
      setScene(sceneJson);
      setCanvasEpoch((v) => v + 1);
    } catch (e) {
      message.error(`重新加载画布失败: ${e}`);
    }
  }, [noteId, message]);

  /**
   * 导出为 `.excalidraw` 场景文件。
   *
   * 和导出图片的区别：这份是**可再编辑**的，能丢进 excalidraw.com 或别人的白板工具接着画 ——
   * 知识库最忌讳数据出不去，图片导出只解决"给人看"，解决不了"带走"。
   *
   * 内容直接用画布当前场景：打开时后端已把图片内联成 base64，所以导出的文件自带图，
   * 换台机器打开不会裂。
   */
  const handleExportScene = useCallback(async () => {
    const api = exportApiRef.current;
    if (!api) {
      message.warning("画布还没加载完，请稍候");
      return;
    }
    try {
      const path = await saveDialog({
        defaultPath: `${(note?.title || "白板").replace(/[\\/:*?"<>|]/g, "_")}.excalidraw`,
        filters: [{ name: "Excalidraw 场景", extensions: ["excalidraw"] }],
      });
      if (!path) return;
      await systemApi.writeTextFile(path, api.getSceneJson());
      message.success("已导出 .excalidraw 文件");
    } catch (e) {
      message.error(`导出失败: ${e}`);
    }
  }, [note, message]);

  /**
   * 导入 `.excalidraw` 文件，**覆盖**当前画布。
   *
   * 覆盖前强制存一份手动存档（不受自动快照的时间窗节流影响）——
   * 导入是个一步就能把半天工作盖掉的操作，必须留退路。
   */
  const handleImportScene = useCallback(async () => {
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [
          { name: "Excalidraw 场景", extensions: ["excalidraw", "json"] },
        ],
      });
      const path = typeof picked === "string" ? picked : null;
      if (!path) return;

      const text = await systemApi.readTextFile(path);
      // 先给当前画布留底，再覆盖。存档失败不拦截导入（多半是内容为空），只提示
      try {
        await whiteboardApi.createSnapshot(noteId);
      } catch (e) {
        console.warn("[whiteboard] 导入前存档失败:", e);
      }
      // 合法性交给后端 parse_scene 把关：不是 Excalidraw 场景会直接报错，不会写进库
      await whiteboardApi.saveScene(noteId, text);
      await handleRestored();
      message.success("已导入（原画布已存进历史版本，可回滚）");
    } catch (e) {
      message.error(`导入失败: ${e}`);
    }
  }, [noteId, message, handleRestored]);

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
    { type: "divider" },
    {
      key: "scene",
      // 与上面导出图片的区别值得在菜单里说清楚：这份能再编辑，图片也带着走
      label: "导出 .excalidraw（可再编辑）…",
      icon: <FileJson size={14} />,
      onClick: () => void handleExportScene(),
    },
    {
      key: "import",
      label: "导入 .excalidraw…",
      icon: <Upload size={14} />,
      onClick: () => void handleImportScene(),
    },
  ];

  /** 选笔记弹窗里的搜索。空关键词不搜 —— 全库列表对"找某条笔记"没帮助 */
  const searchForCard = useCallback(async (q: string) => {
    setCardQuery(q);
    if (!q.trim()) {
      setCardResults([]);
      return;
    }
    setCardSearching(true);
    try {
      setCardResults(await searchApi.search(q, 20));
    } catch {
      setCardResults([]);
    } finally {
      setCardSearching(false);
    }
  }, []);

  /** 把选中的笔记作为卡片插进画布中心 */
  const insertCard = useCallback(
    async (targetId: number) => {
      if (!insertCardRef.current) {
        message.warning("画布还没加载完，请稍候");
        return;
      }
      try {
        await insertCardRef.current(targetId);
        setCardPickerOpen(false);
        message.success("已插入笔记卡片（笔记内容变化时卡片会自动更新）");
      } catch (e) {
        message.error(`插入失败: ${e}`);
      }
    },
    [message],
  );

  /**
   * 进入演示模式：画布全屏 + 只读。
   *
   * 用元素级 `requestFullscreen` 而不是 Tauri 的窗口全屏 API：
   * 前者只让画布容器铺满屏幕（侧边栏、顶栏自然被盖住），且不需要额外声明 Capabilities。
   *
   * 全屏被浏览器策略拒绝时不当成失败：退化成"隐藏顶栏 + 只读"，
   * 讲解白板这件事照样能做，比直接报错好。
   */
  const enterPresent = useCallback(async () => {
    try {
      await canvasWrapRef.current?.requestFullscreen();
    } catch {
      // 忽略：下面照样进演示态
    }
    setPresenting(true);
  }, []);

  const exitPresent = useCallback(async () => {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        // 忽略：状态位照样清掉，不然会卡在演示态出不来
      }
    }
    setPresenting(false);
  }, []);

  // 用户按 Esc 退出全屏时同步状态位 —— 否则顶栏一直藏着，看着像卡死了
  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement) setPresenting(false);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

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
      {/* 顶栏：返回 / 标题 / 保存状态 / 删除。演示时整条收起，把屏幕让给画布 */}
      <div
        className="flex items-center gap-2 px-3 py-2 shrink-0 kb-surface"
        style={{
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
          display: presenting ? "none" : undefined,
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

        <Button
          type="text"
          icon={<StickyNote size={16} />}
          onClick={() => setCardPickerOpen(true)}
          title="插入笔记卡片（把笔记内容摊在画布上，笔记改了卡片跟着变）"
        />

        <Button
          type="text"
          icon={<Presentation size={16} />}
          onClick={() => void enterPresent()}
          title="演示模式（全屏 + 只读，按 Esc 退出）"
        />

        <Button
          type="text"
          icon={<History size={16} />}
          onClick={() => setHistoryOpen(true)}
          title="历史版本（画布自动保存，误删可回滚）"
        />

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

      {/* 画布。Excalidraw 需要一个确定高度的容器，这里用 flex-1 + min-h-0 撑满剩余空间。
          这个 div 同时是演示模式的全屏目标，所以要自带背景色 —— 全屏元素默认背景是黑的 */}
      <div
        ref={canvasWrapRef}
        className="flex-1 min-h-0 relative"
        style={{ background: token.colorBgContainer }}
      >
        <Suspense
          fallback={
            <div className="flex items-center justify-center h-full">
              <Spin tip="正在加载白板画布..." />
            </div>
          }
        >
          <WhiteboardCanvas
            key={canvasEpoch}
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
            readOnly={presenting}
            insertCardRef={insertCardRef}
          />
        </Suspense>

        {/* 演示态的退出口。必须放在全屏元素**内部**，否则全屏时点不到；
            全屏被拒的退化路径也靠它退出（那种情况下 Esc 没有全屏可退） */}
        {presenting && (
          <Button
            icon={<Minimize2 size={16} />}
            onClick={() => void exitPresent()}
            // 层级写死在内联样式里：Excalidraw 自己的 UI 层（--zIndex-layerUI 一系）
            // 会盖住普通的 z-10，实测按钮会整个消失
            style={{ position: "absolute", right: 12, top: 12, zIndex: 1002 }}
            title="退出演示（Esc）"
          >
            退出演示
          </Button>
        )}
      </div>

      {/* 选笔记 → 插入卡片 */}
      <Modal
        open={cardPickerOpen}
        onCancel={() => setCardPickerOpen(false)}
        footer={null}
        title="插入笔记卡片"
        destroyOnClose
      >
        <Text type="secondary" style={{ fontSize: 12 }}>
          卡片显示笔记的标题与开头部分，笔记内容变化时卡片会自动更新。
        </Text>
        <Input.Search
          autoFocus
          allowClear
          placeholder="搜索笔记标题或内容…"
          className="mt-3"
          loading={cardSearching}
          onChange={(e) => void searchForCard(e.target.value)}
        />
        <List
          className="mt-2"
          size="small"
          style={{ maxHeight: 320, overflow: "auto" }}
          dataSource={cardResults}
          locale={{
            emptyText: cardQuery.trim() ? "没有匹配的笔记" : "输入关键词开始搜索",
          }}
          renderItem={(item) => (
            <List.Item
              className="cursor-pointer"
              onClick={() => void insertCard(item.id)}
            >
              <List.Item.Meta
                title={item.title || "未命名"}
                description={
                  <span
                    style={{ fontSize: 12 }}
                    // snippet 由后端生成，含 <mark> 高亮标记
                    dangerouslySetInnerHTML={{ __html: item.snippet }}
                  />
                }
              />
            </List.Item>
          )}
        />
      </Modal>

      {/* 抽屉整体懒加载，且只有开过一次才挂载 —— 从没点过「历史版本」的用户不用为它买单 */}
      {historyOpen && (
        <Suspense fallback={null}>
          <SnapshotDrawer
            open={historyOpen}
            onClose={() => setHistoryOpen(false)}
            noteId={noteId}
            onRestored={handleRestored}
          />
        </Suspense>
      )}
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
