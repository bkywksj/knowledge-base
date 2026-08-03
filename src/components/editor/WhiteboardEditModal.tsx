/**
 * 内嵌白板的编辑弹窗：笔记里点开白板块后，在这里画。
 *
 * 关闭时才落盘（而不是像整页白板那样防抖实时存）—— 这里是「打开-编辑-确认」的
 * 模态语义，用户按取消就该什么都没变。
 *
 * 保存做三件事：
 * 1. 场景 JSON + PNG 预览图一次写盘（后端配对命名，覆盖同一对文件）
 * 2. 量出预览图尺寸回传，让笔记里的块能提前占好高度、不抖
 * 3. 把两个 `kb-asset://` 路径交回 NodeView 写进节点属性
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Modal, Spin, App as AntdApp } from "antd";
import { whiteboardApi } from "@/lib/api";
import { toKbAsset } from "@/lib/assetUrl";
import { useAppStore } from "@/store";
import type { WhiteboardExportApi } from "@/components/whiteboard/WhiteboardCanvas";

// 与整页白板共用同一个画布组件，也共用它的 lazy chunk：
// 笔记里从不插白板的用户不会为 Excalidraw 付出任何下载成本
const WhiteboardCanvas = lazy(
  () => import("@/components/whiteboard/WhiteboardCanvas"),
);

export interface WhiteboardSaveResult {
  scenePath: string;
  previewPath: string;
  width: number | null;
  height: number | null;
}

interface Props {
  open: boolean;
  /** 白板资源按笔记归目录，所以必须知道自己属于哪篇笔记 */
  noteId: number;
  /** 已有场景的 `kb-asset://` 路径；null = 这是一块还没画过的新白板 */
  scenePath: string | null;
  onCancel: () => void;
  onSaved: (result: WhiteboardSaveResult) => void;
}

/** 从 PNG 的 base64 量出像素尺寸；失败返回 null（尺寸只是优化项，不该阻断保存） */
function measurePng(base64: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = `data:image/png;base64,${base64}`;
  });
}

export function WhiteboardEditModal({
  open,
  noteId,
  scenePath,
  onCancel,
  onSaved,
}: Props) {
  const { message } = AntdApp.useApp();
  const themeCategory = useAppStore((s) => s.themeCategory);
  const exportApiRef = useRef<WhiteboardExportApi | null>(null);

  const [loading, setLoading] = useState(true);
  const [initialScene, setInitialScene] = useState("");
  const [saving, setSaving] = useState(false);
  /**
   * Modal 入场动画结束、容器尺寸稳定之后才挂载画布。
   *
   * 🔴 **这是"打开白板一片空白"的真正原因**：Excalidraw 挂载时会量容器尺寸，
   * 若此刻 Modal 还在缩放动画里，它量到的是中间态的小尺寸 —— 于是按窄屏布局
   * 渲染（工具栏都变样了），`scrollToContent` 也按错误尺寸算，把内容推到视口外，
   * 看起来就是"内容没了"。双击时第二下点击又插在动画中间，必中。
   *
   * 顺带解决双击穿透：动画期间画布压根还没挂上，第二下点在 Spin 上，
   * 不会被 Excalidraw 当成画布双击。
   */
  const [canvasReady, setCanvasReady] = useState(false);

  // 打开时把已有场景读回来（图片由后端内联成 base64，Excalidraw 可直接吃）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        if (scenePath) {
          const rel = scenePath.replace(/^kb-asset:\/\//, "");
          const json = await whiteboardApi.loadEmbedded(rel);
          if (!cancelled) setInitialScene(json);
        } else {
          if (!cancelled) setInitialScene("");
        }
      } catch (e) {
        if (!cancelled) {
          // 读不出来就给空画布，但必须让用户知道 —— 否则他会以为白板被清空了，
          // 然后一保存把原文件真的覆盖掉
          message.error(`白板内容读取失败：${e}`);
          setInitialScene("");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, scenePath, message]);

  const handleSave = useCallback(async () => {
    const api = exportApiRef.current;
    // 直接问画布要最新场景，不等 800ms 防抖 —— 用户画完最后一笔就点保存是常态
    const scene = api?.getSceneJson();
    if (!api || !scene) {
      // 没画任何东西就点确定：当作取消，别写一个空文件进去
      onCancel();
      return;
    }
    setSaving(true);
    try {
      const previewBase64 = await api.exportImage("png");
      const saved = await whiteboardApi.saveEmbedded(
        noteId,
        scene,
        previewBase64,
        scenePath ? scenePath.replace(/^kb-asset:\/\//, "") : null,
      );
      const size = await measurePng(previewBase64);
      onSaved({
        scenePath: toKbAsset(saved.scene_path),
        previewPath: toKbAsset(saved.preview_path),
        width: size?.w ?? null,
        height: size?.h ?? null,
      });
    } catch (e) {
      message.error(`白板保存失败：${e}`);
    } finally {
      setSaving(false);
    }
  }, [noteId, scenePath, initialScene, onSaved, onCancel, message]);

  return (
    <Modal
      open={open}
      title="白板"
      onCancel={onCancel}
      onOk={handleSave}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      width="90vw"
      centered
      // 画布要尽可能大：白板在小窗口里没法用。
      // pointerEvents 直接写在 body 上而**不是**再套一层 div —— 试过套 div，
      // Excalidraw 挂载时量不到正确高度，画布直接空白（内容其实加载了）。
      // 它对 DOM 结构很敏感，别在它和有确定高度的容器之间加中间层。
      styles={{ body: { height: "78vh", padding: 0, overflow: "hidden" } }}
      // 动画彻底结束（尺寸稳定）才放行画布挂载，见 canvasReady 的说明
      afterOpenChange={(opened) => setCanvasReady(opened)}
      // 画到一半误点遮罩就全丢了，禁掉
      maskClosable={false}
      destroyOnHidden
    >
      {loading || !canvasReady ? (
        <div className="flex items-center justify-center h-full">
          <Spin tip="加载白板..." />
        </div>
      ) : (
        <Suspense
          fallback={
            <div className="flex items-center justify-center h-full">
              <Spin tip="正在加载画布..." />
            </div>
          }
        >
          <WhiteboardCanvas
            initialScene={initialScene}
            // 不传 onSave = 不自动落盘。弹窗是「确认才保存」的语义，
            // 保存时用 exportRef.getSceneJson() 主动取当前画布
            theme={themeCategory === "dark" ? "dark" : "light"}
            exportRef={exportApiRef}
            onError={() =>
              message.warning("白板内容损坏，已打开空白画布；直接关闭可保住原数据")
            }
          />
        </Suspense>
      )}
    </Modal>
  );
}
