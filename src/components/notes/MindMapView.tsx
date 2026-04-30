import { useEffect, useRef } from "react";
import { Drawer, Button, Space, Tooltip, App as AntdApp, theme as antdTheme } from "antd";
import { ZoomIn, ZoomOut, Maximize2, Download, X } from "lucide-react";
import { Transformer } from "markmap-lib";
import { Markmap } from "markmap-view";
import { save } from "@tauri-apps/plugin-dialog";
import { systemApi } from "@/lib/api";

interface Props {
  /** Drawer open 状态 */
  open: boolean;
  onClose: () => void;
  /** 笔记 markdown 原文（编辑时实时刷新视图） */
  markdown: string;
  /** 笔记标题（用作根节点 fallback / 导出文件名） */
  title: string;
}

/**
 * 思维导图视图（只读，右侧浮动 Drawer 模式）
 *
 * 设计要点（v2，从 Modal 改为 Drawer）：
 * - **mask={false}**：用户在右侧看导图的同时，左侧编辑器仍可写、滚动、保存
 * - **markdown 实时跟随**：父级 content 变化（每次 onChange）→ 重新 setData
 * - **fit 只做一次**：首次打开 fit 自适应；后续编辑不再 fit，避免每个键击都在缩放
 * - **手动 fit 按钮**：用户写完一段想"重新看全局"时点头部 ⤢
 */
const transformer = new Transformer();

export function MindMapView({ open, onClose, markdown, title }: Props) {
  const { token } = antdTheme.useToken();
  const { message } = AntdApp.useApp();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const mmRef = useRef<Markmap | null>(null);
  /** 标记首次渲染——只有首次创建时做 fit；后续 markdown 变化只 setData，
   * 避免敲键期间画布被反复"自适应"导致跳动 */
  const firstRenderRef = useRef(true);

  // Drawer 打开后初始化 / 更新；关闭时销毁
  useEffect(() => {
    if (!open) {
      if (mmRef.current) {
        mmRef.current.destroy();
        mmRef.current = null;
      }
      firstRenderRef.current = true;
      return;
    }

    // Drawer 是 portal 渲染，open 切到 true 后下一帧 svgRef 才挂上
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
        // 首次创建：create 时一并 fit 自适应
        mmRef.current = Markmap.create(svgRef.current, undefined, root);
        firstRenderRef.current = false;
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

  return (
    <Drawer
      open={open}
      onClose={onClose}
      placement="right"
      // 不挡编辑器：左侧仍可写笔记，右侧实时看到导图
      mask={false}
      // 关闭后销毁 svg 节点，下次打开重建（避免持有过期 markmap 实例）
      destroyOnHidden
      // antd 5：宽度走 styles.wrapper；50vw 自适应窗口，最大 1200px
      styles={{
        wrapper: { width: "50vw", maxWidth: 1200, minWidth: 480 },
        body: { padding: 0, background: token.colorBgContainer },
        header: { padding: "8px 12px" },
      }}
      // 自定义关闭按钮去掉，改在右侧工具栏画
      closable={false}
      title={
        <div className="flex items-center justify-between gap-2">
          <span
            className="truncate"
            style={{ fontSize: 13, fontWeight: 500 }}
            title={`思维导图 · ${title || "未命名"}`}
          >
            🧠 思维导图 · {title || "未命名"}
          </span>
          <Space size={2}>
            <Tooltip title="放大">
              <Button
                size="small"
                type="text"
                icon={<ZoomIn size={14} />}
                onClick={() => handleZoom(1.25)}
              />
            </Tooltip>
            <Tooltip title="缩小">
              <Button
                size="small"
                type="text"
                icon={<ZoomOut size={14} />}
                onClick={() => handleZoom(0.8)}
              />
            </Tooltip>
            <Tooltip title="自适应">
              <Button
                size="small"
                type="text"
                icon={<Maximize2 size={14} />}
                onClick={handleFit}
              />
            </Tooltip>
            <Tooltip title="导出 SVG">
              <Button
                size="small"
                type="text"
                icon={<Download size={14} />}
                onClick={() => void handleExportSvg()}
              />
            </Tooltip>
            <Tooltip title="关闭">
              <Button
                size="small"
                type="text"
                icon={<X size={14} />}
                onClick={onClose}
              />
            </Tooltip>
          </Space>
        </div>
      }
    >
      <svg
        ref={svgRef}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
        }}
      />
    </Drawer>
  );
}
