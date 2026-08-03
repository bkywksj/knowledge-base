/**
 * 内嵌白板块的 React NodeView。
 *
 * 三种状态：
 * - **空块**（还没画过）：显示"点击创建白板"占位，点一下就进画布
 * - **有预览图**：显示图片；hover 时右上角浮出「编辑」按钮
 * - **加载中/出错**：给出可读提示，绝不静默变空白 —— 白板内容可能是用户画了很久的东西
 *
 * 画布本身在 `WhiteboardEditModal` 里（懒加载 Excalidraw），本组件只管展示与触发。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { App as AntdApp, Button, theme as antdTheme } from "antd";
import { PenTool, Pencil } from "lucide-react";
import { useAppStore } from "@/store";
import { imageApi } from "@/lib/api";
import { isEncryptedAsset, parseKbAsset, resolveAssetSrc } from "@/lib/assetUrl";
import { WhiteboardEditModal } from "./WhiteboardEditModal";

export function WhiteboardBlockNodeView({
  node,
  updateAttributes,
  deleteNode,
  editor,
  extension,
}: NodeViewProps) {
  const { token } = antdTheme.useToken();
  const { message } = AntdApp.useApp();
  const dataDir = useAppStore((s) => s.instanceInfo?.dataDir ?? null);
  const [editing, setEditing] = useState(false);

  const scene = (node.attrs.scene as string | null) ?? null;
  const preview = (node.attrs.preview as string | null) ?? null;
  const width = (node.attrs.width as number | null) ?? null;
  const height = (node.attrs.height as number | null) ?? null;

  /**
   * kb-asset:// → 可直接喂 `<img>` 的 URL。
   *
   * 加密笔记里的白板预览图落盘时也是加密的（`.enc`），asset 协议直接读会是一坨密文，
   * 必须走 `imageApi.getBlob` 解密后转 Blob URL —— 与编辑器里加密图片、
   * AI 溯源缩略图同一套路子。Blob URL 在依赖变化/卸载时记得 revoke，否则内存泄漏。
   */
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  /**
   * 预览图版本号。改完白板保存后 +1。
   *
   * 🔴 **不能省**：白板改完存的是**同一个文件**（配对覆盖，见后端 save_embedded_scene），
   * 所以 `preview` 路径压根不变 —— `<img src>` 一样，浏览器直接吃缓存，
   * 用户改了半天回到笔记看到的还是旧图，会以为没保存成功。
   * 版本号既进 effect 依赖（加密图重新 getBlob），又拼进明文 URL（绕过 HTTP 缓存）。
   */
  const [previewVersion, setPreviewVersion] = useState(() => Date.now());
  useEffect(() => {
    if (!preview) {
      setPreviewSrc(null);
      return;
    }
    const rel = parseKbAsset(preview);
    if (!rel || !isEncryptedAsset(rel)) {
      const base = resolveAssetSrc(preview, dataDir);
      // 初值就是挂载时的时间戳，所以**每次打开笔记都会重新取图**。
      // 不能只在保存后才加参数：白板改完路径不变，浏览器那份旧图能一直缓存到
      // 下次重启，用户会看到一张过时的预览。同一次挂载内 re-render 时间戳不变，
      // 缓存该复用的地方仍然复用。
      setPreviewSrc(`${base}${base.includes("?") ? "&" : "?"}_v=${previewVersion}`);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    imageApi
      .getBlob(rel)
      .then((bytes) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart]));
        setPreviewSrc(objectUrl);
      })
      .catch(() => {
        // vault 未解锁 / 文件缺失：显示成"未画过"的占位，至少块还在、能点开重画
        if (!cancelled) setPreviewSrc(null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // previewVersion 进依赖：加密图靠它重新 getBlob 拿到新内容
  }, [preview, dataDir, previewVersion]);

  /**
   * 新插入的空白板**直接进画布**，不让用户对着一个占位框再点一次。
   *
   * 用户的心智是「我要画个图」，插入动作本身就该把画布支起来 —— 中间那一步
   * 「点击创建白板」纯属多余。占位 UI 仍然保留：弹窗关掉之后（画了一半反悔、
   * 或异常情况下留下的空块）总得有个能再点开的落点。
   *
   * ref 挡重复：React StrictMode 下 effect 会跑两遍，不挡会弹两次。
   */
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (scene || autoOpenedRef.current) return;
    if (!editor.isEditable) return;
    if (!extension.options.getNoteId?.()) return; // 笔记还没 id，留占位块并在点击时提示
    autoOpenedRef.current = true;
    setEditing(true);
  }, [scene, editor.isEditable, extension.options]);

  const openEditor = useCallback(() => {
    if (!editor.isEditable) return; // 只读模式（预览 / 导出）不给编辑
    const noteId = extension.options.getNoteId?.();
    if (!noteId) {
      message.warning("笔记还没保存，无法创建白板");
      return;
    }
    setEditing(true);
  }, [editor.isEditable, extension.options, message]);

  return (
    <NodeViewWrapper className="tiptap-whiteboard my-3" data-drag-handle>
      <div
        className="relative group rounded-lg overflow-hidden"
        style={{
          border: `1px solid ${token.colorBorderSecondary}`,
          // 有图时边框收缩到图片大小，别拉出一条横贯正文的空框；
          // 占位态保持全宽，那样"点击创建白板"才有个像样的落点
          width: previewSrc ? "fit-content" : undefined,
          maxWidth: "100%",
        }}
      >
        {previewSrc ? (
          <img
            src={previewSrc}
            alt="白板"
            // 用存下来的原始尺寸占位，避免图片加载完成前块高度为 0、
            // 加载完又把下方正文顶下去（每次打开笔记都抖一下）
            width={width ?? undefined}
            height={height ?? undefined}
            // 尺寸策略（三种画法都得看得下去）：
            // - 小图按原尺寸。Excalidraw 导出的 PNG 是按内容裁剪的，画个小矩形
            //   就得到 320×220，拉满容器只会放大成一张糊图
            // - 宽图受 max-width 限制，缩回容器宽度
            // - **高图受 max-height 限制** —— 竖着画的流程图能导出上千像素高，
            //   不设上限会把笔记撑成一条看不到头的长廊，想看细节点开编辑即可
            // width/height 属性仍然写着：浏览器据此算宽高比预留空间，
            // 图片加载完不会把下方正文顶一下
            className="block"
            style={{
              maxWidth: "100%",
              maxHeight: 520,
              width: "auto",
              height: "auto",
              background: token.colorBgContainer,
              // 覆盖 `.tiptap img { cursor: zoom-in }`：白板不是"点开看大图"，
              // 光标必须指向它真正的行为——点开编辑
              cursor: "pointer",
            }}
            // 单击即进画布。白板看着像图，但用户点它是想改它；
            // 让人先单击选中、再找编辑按钮，等于把功能藏起来。
            // stopPropagation 挡住 ProseMirror 的节点选中，免得弹窗背后还闪一个蓝框。
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openEditor();
            }}
            onDoubleClick={(e) => {
              // 双击已被 onClick 抢先处理，这里只负责别让事件继续冒泡到
              // 灯箱/编辑器（灯箱那侧也加了白板豁免，双保险）
              e.preventDefault();
              e.stopPropagation();
            }}
          />
        ) : (
          <button
            type="button"
            onClick={openEditor}
            className="w-full flex flex-col items-center justify-center gap-2 py-10 cursor-pointer"
            style={{
              background: token.colorFillQuaternary,
              color: token.colorTextSecondary,
            }}
          >
            <PenTool size={22} />
            <span style={{ fontSize: 13 }}>点击创建白板</span>
          </button>
        )}

        {/* 编辑入口。
            刻意**常显**而不是只在 hover 时浮出：白板是"看起来像图、其实能改"的东西，
            全靠 hover 才发现的入口等于没有 —— 触屏没有 hover，用户也未必会去试。
            用低透明度收着，hover 时补满，既不喧宾夺主又始终够得着。 */}
        {previewSrc && editor.isEditable && (
          <div className="absolute top-2 right-2 opacity-60 group-hover:opacity-100 transition-opacity">
            <Button
              size="small"
              icon={<Pencil size={13} />}
              onClick={openEditor}
              title="编辑白板（也可双击画布）"
            >
              编辑
            </Button>
          </div>
        )}
      </div>

      {editing && (
        <WhiteboardEditModal
          open
          noteId={extension.options.getNoteId?.() as number}
          scenePath={scene}
          onCancel={() => {
            setEditing(false);
            // 空白板取消 = 用户压根没想插这个块，笔记里不该留下任何痕迹。
            // 已有内容的白板取消只是「不改了」，块要留着。
            if (!scene) deleteNode();
          }}
          onSaved={(next) => {
            // 一次性写回四个属性：内容变了、预览图也变了，分开写会让编辑器多一次
            // 无谓的历史记录，撤销时还得按两下
            updateAttributes({
              scene: next.scenePath,
              preview: next.previewPath,
              width: next.width,
              height: next.height,
            });
            // 路径没变但文件内容变了，必须主动让预览图重新取一次
            setPreviewVersion((v) => v + 1);
            setEditing(false);
          }}
        />
      )}
    </NodeViewWrapper>
  );
}
