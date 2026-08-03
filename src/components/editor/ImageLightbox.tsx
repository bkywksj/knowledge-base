import { useEffect, useState, type RefObject } from "react";
import { Image } from "antd";

/**
 * 编辑器图片「双击放大」浮层。
 *
 * 背景：编辑器里的图片由 tiptap-extension-resize-image 渲染成原生 <img>（包括表格
 * 单元格内的图、figure 图注里的图），原生 <img> 没有任何「查看大图」能力，用户双击
 * 也只会选中节点，看不到大图。
 *
 * 方案：在编辑器容器上做事件委托，双击任意 <img> 即用 Ant Design 的 Image 预览
 * （自带缩放 / 旋转 / 拖拽）打开大图。好处：
 *   1. 不改动 resize-image 的 NodeView，零侵入，保留原拖拽缩放手柄。
 *   2. 事件委托天然覆盖表格 / 分栏 / figure 内的所有图片。
 *   3. 直接用 DOM 里的 currentSrc —— 明文图(asset://)与加密图(blob:)都能正确放大。
 */
export function ImageLightbox({
  containerRef,
}: {
  containerRef: RefObject<HTMLElement | null>;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onDblClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target || target.tagName !== "IMG") return;
      // 白板块的预览图不是「一张图」而是「一块可编辑画布的封面」——
      // 双击它的语义是进画布编辑，不是放大看图。这里放行给白板自己处理，
      // 否则用户双击白板只会弹出一个看图浮层，永远进不去编辑。
      if (target.closest("[data-kb-whiteboard]")) return;
      const img = target as HTMLImageElement;
      const url = img.currentSrc || img.src;
      if (!url) return;
      // 阻止双击默认的选词 / 节点选中，避免与放大冲突
      e.preventDefault();
      e.stopPropagation();
      setSrc(url);
    };

    el.addEventListener("dblclick", onDblClick);
    return () => el.removeEventListener("dblclick", onDblClick);
  }, [containerRef]);

  return (
    // 自身不显示，仅作为受控预览的载体；双击后由 visible 打开大图浮层
    <Image
      style={{ display: "none" }}
      src={src ?? ""}
      preview={{
        visible: !!src,
        onVisibleChange: (v) => {
          if (!v) setSrc(null);
        },
      }}
    />
  );
}
