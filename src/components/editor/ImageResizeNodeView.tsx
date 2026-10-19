/**
 * 图片 React NodeView —— 替换第三方 `tiptap-extension-resize-image` 的原生 NodeView。
 *
 * 为什么自绘（见 bug 修复背景）：
 *   第三方包的 NodeView 靠 DOM click + 往 `document` 绑全局监听来显示缩放手柄，且
 *   **不实现任何 ProseMirror NodeView 生命周期**（无 destroy/update/ignoreMutation/
 *   stopEvent）。在本项目「复用编辑器实例 + setContent 切换笔记」的架构下，每切一次
 *   笔记旧节点销毁但 document 监听残留，切回来新建节点又叠一个 → 监听泄漏 + 选中态
 *   在节点重建后失效（点击图片没反应，只剩 hover 双击放大）。
 *
 * 本实现的关键差异：
 *   1. 选中态由 ProseMirror 的 NodeSelection 驱动（props.selected），React 卸载即清理，
 *      切多少次笔记都不泄漏、不失效。
 *   2. 点击图片 → 手动 setNodeSelection（不依赖 atom 默认点击行为，避开 ReactNodeView
 *      stopEvent 把 click 吞掉导致选不中）。
 *   3. 4 角拖拽缩放 → 松手 updateAttributes({width}) 持久化（走 FigureExtension 的
 *      width → raw HTML 兜底序列化）。
 *   4. 对齐（左/中/右）写入 align attr 并持久化；1:1（原始像素）/ 适应页宽（清宽度）。
 *
 * 图片显示：仍渲染 <img src="kb-asset://...">，由 TiptapEditor 的全局 MutationObserver
 * 把 src 解析成可显示 URL（明文 asset.localhost / 加密 .enc → Blob URL）——零改动。
 * 双击放大（ImageLightbox 事件委托 dblclick on img）也继续工作。
 */
import { useCallback, useRef, useState } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Button, Tooltip, theme as antdTheme } from "antd";
import {
  AlignLeft,
  AlignCenter,
  AlignRight,
  Maximize2,
  Minimize2,
} from "lucide-react";

import { useEditorEditable } from "./useEditorEditable";
// 与 FigureImage.configure({ minWidth, maxWidth }) 保持一致
const MIN_WIDTH = 50;
const MAX_WIDTH = 1200;

type Corner = "tl" | "tr" | "bl" | "br";
const CORNERS: Corner[] = ["tl", "tr", "bl", "br"];

/** 把 width attr（可能是数字 / 数字字符串 / null / "")规整成数字或 null */
function parseWidth(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function ImageResizeNodeView(props: NodeViewProps) {
  const { node, updateAttributes, selected, editor, getPos } = props;
  const src = (node.attrs.src as string | null) ?? "";
  const alt = (node.attrs.alt as string | null) ?? "";
  const align = (node.attrs.align as "left" | "center" | "right" | null) ?? null;
  const width = parseWidth(node.attrs.width);

  const isEditable = useEditorEditable(editor);
  const { token } = antdTheme.useToken();

  const imgRef = useRef<HTMLImageElement>(null);
  // 拖拽过程中的实时宽度（仅本地视觉，松手才写回 attrs，避免每像素一个 transaction）
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const effectiveWidth = dragWidth ?? width;

  /** 点击图片 → 显式建立 NodeSelection，使 selected=true 弹出手柄/工具条 */
  const selectSelf = useCallback(() => {
    if (typeof getPos !== "function") return;
    const pos = getPos();
    if (typeof pos === "number") {
      editor.commands.setNodeSelection(pos);
    }
  }, [editor, getPos]);

  /** 4 角拖拽缩放：左侧两角反向（往左拖变大需取反） */
  const startResize = useCallback(
    (e: React.MouseEvent, corner: Corner) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = imgRef.current?.offsetWidth ?? width ?? MIN_WIDTH;
      const invert = corner === "tl" || corner === "bl";
      let pending = startW;

      const onMove = (ev: MouseEvent) => {
        const delta = invert ? -(ev.clientX - startX) : ev.clientX - startX;
        pending = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startW + delta));
        setDragWidth(pending);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        // 松手写回 attrs 持久化；清掉本地 dragWidth 让渲染回到受控 attrs
        updateAttributes({ width: String(Math.round(pending)), height: null });
        setDragWidth(null);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [updateAttributes, width],
  );

  function setAlign(a: "left" | "center" | "right") {
    updateAttributes({ align: align === a ? null : a });
  }
  /** 1:1 原始比例：宽度设为图片自然像素宽（受 MAX_WIDTH 上限钳制） */
  function actualSize() {
    const nat = imgRef.current?.naturalWidth ?? 0;
    if (nat > 0) {
      updateAttributes({
        width: String(Math.min(nat, MAX_WIDTH)),
        height: null,
      });
    }
  }
  /** 适应页宽：清掉显式宽度，回到 CSS max-width:100% 的默认自适应 */
  function fitWidth() {
    updateAttributes({ width: null, height: null });
  }

  // 阻止工具条/手柄上的 mousedown 把焦点/选区从图片节点夺走（否则点一下就取消选中）
  const stopMouseDown = (e: React.MouseEvent) => e.stopPropagation();

  const justify =
    align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start";

  return (
    <NodeViewWrapper
      className="kb-image-block"
      data-align={align ?? undefined}
      style={{ display: "flex", justifyContent: justify }}
    >
      <div
        className="kb-image-frame"
        style={{
          position: "relative",
          display: "inline-block",
          lineHeight: 0,
          maxWidth: "100%",
          width: effectiveWidth ? `${effectiveWidth}px` : undefined,
          outline: selected ? `2px solid ${token.colorPrimary}` : undefined,
          outlineOffset: 2,
          borderRadius: 6,
        }}
      >
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          draggable={false}
          className="kb-image-img"
          onClick={isEditable ? selectSelf : undefined}
          style={{
            display: "block",
            width: effectiveWidth ? "100%" : undefined,
            maxWidth: "100%",
            height: "auto",
            borderRadius: 6,
          }}
        />

        {isEditable && selected && (
          <>
            {/* 浮动工具条：对齐 + 1:1 + 适应页宽 */}
            <div
              className="kb-image-toolbar"
              contentEditable={false}
              onMouseDown={stopMouseDown}
              style={{
                position: "absolute",
                top: -42,
                left: "50%",
                transform: "translateX(-50%)",
                display: "flex",
                alignItems: "center",
                gap: 2,
                padding: "2px 6px",
                background: token.colorBgElevated,
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: 8,
                boxShadow: token.boxShadowSecondary,
                zIndex: 20,
                whiteSpace: "nowrap",
              }}
            >
              <Tooltip title="左对齐">
                <Button
                  size="small"
                  type={align === "left" ? "primary" : "text"}
                  icon={<AlignLeft size={14} />}
                  onClick={() => setAlign("left")}
                />
              </Tooltip>
              <Tooltip title="居中">
                <Button
                  size="small"
                  type={align === "center" ? "primary" : "text"}
                  icon={<AlignCenter size={14} />}
                  onClick={() => setAlign("center")}
                />
              </Tooltip>
              <Tooltip title="右对齐">
                <Button
                  size="small"
                  type={align === "right" ? "primary" : "text"}
                  icon={<AlignRight size={14} />}
                  onClick={() => setAlign("right")}
                />
              </Tooltip>
              <span
                style={{
                  width: 1,
                  height: 16,
                  background: token.colorBorderSecondary,
                  margin: "0 4px",
                }}
              />
              <Tooltip title="原始比例 (1:1)">
                <Button
                  size="small"
                  type="text"
                  icon={<Maximize2 size={14} />}
                  onClick={actualSize}
                />
              </Tooltip>
              <Tooltip title="适应页宽">
                <Button
                  size="small"
                  type="text"
                  icon={<Minimize2 size={14} />}
                  onClick={fitWidth}
                />
              </Tooltip>
            </div>

            {/* 4 角缩放手柄 */}
            {CORNERS.map((c) => (
              <div
                key={c}
                className={`kb-image-handle kb-image-handle-${c}`}
                onMouseDown={(e) => startResize(e, c)}
                style={{
                  position: "absolute",
                  width: 10,
                  height: 10,
                  background: token.colorBgContainer,
                  border: `1.5px solid ${token.colorPrimary}`,
                  borderRadius: "50%",
                  zIndex: 21,
                  top: c === "tl" || c === "tr" ? -5 : undefined,
                  bottom: c === "bl" || c === "br" ? -5 : undefined,
                  left: c === "tl" || c === "bl" ? -5 : undefined,
                  right: c === "tr" || c === "br" ? -5 : undefined,
                  cursor:
                    c === "tl" || c === "br" ? "nwse-resize" : "nesw-resize",
                }}
              />
            ))}
          </>
        )}
      </div>
    </NodeViewWrapper>
  );
}
