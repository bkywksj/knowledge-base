import { useEffect, useRef } from "react";
import { Button, Space, Tooltip, App as AntdApp, theme as antdTheme } from "antd";
import { ZoomIn, ZoomOut, Maximize2, Download, X } from "lucide-react";
import { Transformer } from "markmap-lib";
import { Markmap } from "markmap-view";
import { save } from "@tauri-apps/plugin-dialog";
import { systemApi } from "@/lib/api";

interface Props {
  /** 是否显示——父级控制；隐藏时不挂载 svg、销毁 markmap 实例 */
  open: boolean;
  onClose: () => void;
  /** 笔记 markdown 原文（编辑时实时刷新视图） */
  markdown: string;
  /** 笔记标题（用作根节点 fallback / 导出文件名） */
  title: string;
}

/**
 * 思维导图视图（只读，编辑器右侧嵌入式分栏）
 *
 * 设计要点（v3，从 Drawer 改为编辑器内嵌 flex 子节点）：
 * - **真分屏**：编辑器和导图是 sibling，共享主区宽度，互不覆盖
 *   （v2 用 antd Drawer 是错的——Drawer 是 fixed 浮层不会推开 sibling）
 * - **maxWidth=300**：限制 markmap 节点宽度，长代码块自动折行不溢出
 * - **markdown 实时跟随**：父级 content 变化（每次 onChange）→ 重新 setData
 * - **fit 只做一次**：首次打开 fit 自适应；后续 markdown 变化只 setData
 * - **不渲染 chrome**：宽度 / 关闭由父级 splitter 控制；本组件只画工具栏 + svg
 */
const transformer = new Transformer();

export function MindMapView({ open, onClose, markdown, title }: Props) {
  const { token } = antdTheme.useToken();
  const { message } = AntdApp.useApp();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const mmRef = useRef<Markmap | null>(null);

  // open 切到 true 时初始化；切到 false 时销毁 markmap 实例（svg 由父级 unmount）
  useEffect(() => {
    if (!open) {
      if (mmRef.current) {
        mmRef.current.destroy();
        mmRef.current = null;
      }
      return;
    }

    const raf = requestAnimationFrame(() => {
      if (!svgRef.current) return;

      const md = markdown.trim()
        ? markdown
        : `# ${title || "未命名笔记"}\n`;
      const { root } = transformer.transform(md);

      if (mmRef.current) {
        // 后续更新：只 setData，不 fit（避免敲键时画布跳动）
        void mmRef.current.setData(root);
      } else {
        // 首次创建：限制节点最大宽度防止 foreignObject 溢出
        mmRef.current = Markmap.create(
          svgRef.current,
          { maxWidth: 300 },
          root,
        );
      }
    });

    return () => cancelAnimationFrame(raf);
  }, [open, markdown, title]);

  function handleZoom(factor: number) {
    void mmRef.current?.rescale(factor);
  }

  function handleFit() {
    void mmRef.current?.fit();
  }

  async function handleExportSvg() {
    const svg = svgRef.current;
    if (!svg) return;
    try {
      const targetPath = await save({
        title: "导出思维导图为 SVG",
        defaultPath: `${title || "mindmap"}.svg`,
        filters: [{ name: "SVG 矢量图", extensions: ["svg"] }],
      });
      if (!targetPath) return;
      const xml = new XMLSerializer().serializeToString(svg);
      const content = `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
      await systemApi.writeTextFile(targetPath, content);
      message.success("已导出 SVG");
    } catch (e) {
      message.error(`导出失败：${e}`);
    }
  }

  if (!open) return null;

  return (
    <div
      className="flex flex-col"
      style={{
        width: "100%",
        height: "100%",
        background: token.colorBgContainer,
        borderLeft: `1px solid ${token.colorBorderSecondary}`,
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      {/* 工具栏：标题 + 缩放/适应/导出/关闭 */}
      <div
        className="flex items-center justify-between gap-2"
        style={{
          padding: "6px 10px",
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          flexShrink: 0,
        }}
      >
        <span
          className="truncate"
          style={{ fontSize: 12, color: token.colorTextSecondary }}
          title={`思维导图 · ${title || "未命名"}`}
        >
          🧠 {title || "未命名"}
        </span>
        <Space size={2}>
          <Tooltip title="放大">
            <Button
              size="small"
              type="text"
              icon={<ZoomIn size={13} />}
              onClick={() => handleZoom(1.25)}
            />
          </Tooltip>
          <Tooltip title="缩小">
            <Button
              size="small"
              type="text"
              icon={<ZoomOut size={13} />}
              onClick={() => handleZoom(0.8)}
            />
          </Tooltip>
          <Tooltip title="自适应">
            <Button
              size="small"
              type="text"
              icon={<Maximize2 size={13} />}
              onClick={handleFit}
            />
          </Tooltip>
          <Tooltip title="导出 SVG">
            <Button
              size="small"
              type="text"
              icon={<Download size={13} />}
              onClick={() => void handleExportSvg()}
            />
          </Tooltip>
          <Tooltip title="关闭">
            <Button
              size="small"
              type="text"
              icon={<X size={13} />}
              onClick={onClose}
            />
          </Tooltip>
        </Space>
      </div>

      {/* SVG 容器：占满剩余空间 */}
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <svg
          ref={svgRef}
          style={{
            width: "100%",
            height: "100%",
            display: "block",
          }}
        />
      </div>
    </div>
  );
}
