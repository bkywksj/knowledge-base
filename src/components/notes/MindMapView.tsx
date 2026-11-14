import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Space, Tooltip, App as AntdApp, theme as antdTheme } from "antd";
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Minimize2,
  Download,
  ExternalLink,
  X,
  PencilLine,
  Keyboard,
  Columns2,
  ArrowRightToLine,
} from "lucide-react";
import { Transformer } from "markmap-lib";
import { Markmap, deriveOptions } from "markmap-view";
import { save } from "@tauri-apps/plugin-dialog";
import { toPng } from "html-to-image";
import { noteApi, systemApi } from "@/lib/api";
import { MindMapEditor, type MindMapEditorHandle } from "@/components/mindmap/MindMapEditor";
import { parseMindMap } from "@/components/mindmap/tree";

interface Props {
  /** 是否显示——父级控制；隐藏时不挂载 svg、销毁 markmap 实例 */
  open: boolean;
  onClose: () => void;
  /** 笔记 markdown 原文（编辑时实时刷新视图） */
  markdown: string;
  /** 笔记标题（用作根节点 fallback / 导出文件名） */
  title: string;
  /** 笔记 id；传入即显示"在新窗口打开"按钮。popout 模式 / 新建未保存笔记请传 null/undefined */
  noteId?: number | null;
  /**
   * 渲染形态：
   * - `embed`（默认）：编辑器右侧分栏，工具栏含"关闭"+"在新窗口打开"+"全屏"
   * - `standalone`：弹窗内独占整个窗口，不显示"关闭"和"新窗口打开"
   */
  variant?: "embed" | "standalone";
  /**
   * 传了才允许在导图里编辑：改动以 Markdown 交回（父组件负责写进编辑器 + 保存）。
   * popout 窗口不传，保持只读。
   */
  onMarkdownChange?: (markdown: string) => void;
  /** 改中心主题 = 改笔记标题 */
  onTitleChange?: (title: string) => void;
  /** 打开时直接进入编辑模式（「新建思维导图」用） */
  defaultEditing?: boolean;
  /** 父页面暂时不允许编辑的原因（阅读 / 源码模式）；有值时编辑按钮置灰并提示 */
  editBlockedReason?: string;
}

const SHORTCUT_HELP =
  "Tab 加子节点 · Enter 加同级 · Delete 删除 · F2/双击 改文字 · 方向键 移动选中 · " +
  "Alt+↑↓ 调顺序 · Alt+←→ 调层级 · 空格 折叠 · Ctrl+Z/Y 撤销重做 · " +
  "拖动节点 调位置（放上沿/下沿=插到前/后，放中间=变成子节点）· 右键 更多操作 · 滚轮缩放 · 拖空白处平移";

/** 编辑模式的布局偏好（左右分布 / 全部向右），跨笔记记住 */
const LAYOUT_KEY = "kb.mindmap.layoutMode";

/**
 * 思维导图视图：默认只读 markmap 渲染；纯大纲笔记可切到编辑模式（自研 MindMapEditor）
 *
 * 设计要点：
 * - **真分屏**（embed 模式）：编辑器和导图是 sibling，共享主区宽度，互不覆盖
 * - **maxWidth=300**：限制 markmap 节点宽度，长代码块自动折行不溢出
 * - **markdown 实时跟随**：父级 content 变化（每次 onChange）→ 重新 setData
 * - **fit 只做一次**：首次打开 fit 自适应；后续 markdown 变化只 setData
 * - **全屏模式**：fixed 覆盖整个视口，ESC 退出；popout 窗口内的 standalone 不显示该按钮
 *   （因为 popout 本身就是独立窗口）
 */
const transformer = new Transformer();

export function MindMapView({
  open,
  onClose,
  markdown,
  title,
  noteId,
  variant = "embed",
  onMarkdownChange,
  onTitleChange,
  defaultEditing = false,
  editBlockedReason,
}: Props) {
  const { token } = antdTheme.useToken();
  const { message } = AntdApp.useApp();
  const editorRef = useRef<MindMapEditorHandle | null>(null);
  const [layoutMode, setLayoutMode] = useState<"both" | "right">(() =>
    localStorage.getItem(LAYOUT_KEY) === "right" ? "right" : "both",
  );
  function toggleLayout() {
    const next = layoutMode === "both" ? "right" : "both";
    setLayoutMode(next);
    localStorage.setItem(LAYOUT_KEY, next);
  }
  /** 只有纯大纲笔记能编辑（段落 / 表格等写回会丢），否则编辑按钮置灰并说明原因 */
  const editability = useMemo(() => {
    const r = parseMindMap(markdown, title);
    return { editable: r.editable, reason: r.reason };
  }, [markdown, title]);
  const canEdit = !!onMarkdownChange;
  const [editing, setEditing] = useState(defaultEditing && canEdit);
  const editMode = editing && canEdit && editability.editable && !editBlockedReason;
  /** 编辑按钮置灰的原因：页面模式优先（切一下就能编辑），其次是内容不是纯大纲 */
  const editDisabledReason = editBlockedReason ?? (editability.editable ? undefined : editability.reason);

  // 编辑中途在正文里加了段落等内容 → 退回只读并说明，不让导图把它们写丢
  useEffect(() => {
    if (editing && !editability.editable) {
      setEditing(false);
      message.info("正文里有了不是大纲的内容，导图已切回只读");
    }
  }, [editing, editability.editable, message]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const mmRef = useRef<Markmap | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  /**
   * 分支配色：markmap 默认是 d3 的蓝橙绿调色板，暖炭下发灰、淡紫下跳色。
   * 换成主题的主色 / 信息 / 成功 / 警告四色，按分支轮换（deriveOptions 生成 markmap 原生的分支着色函数）
   */
  const branchPalette = [token.colorPrimary, token.colorInfo, token.colorSuccess, token.colorWarning];
  const paletteKey = branchPalette.join(",");
  /** 全屏模式（standalone 永远视作非全屏；它本来就独占窗口） */
  const [isFullscreen, setIsFullscreen] = useState(false);

  // open 切到 true 时初始化；切到 false 或进入编辑模式时销毁 markmap 实例（svg 随之卸载）
  useEffect(() => {
    if (!open || editMode) {
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
          { maxWidth: 300, ...deriveOptions({ color: branchPalette }) },
          root,
        );
      }
    });

    return () => cancelAnimationFrame(raf);
  }, [open, markdown, title, editMode]);

  // 切主题后重新着色（只重绘，不 fit，保留用户当前的缩放 / 平移）
  useEffect(() => {
    const mm = mmRef.current;
    if (!mm) return;
    mm.setOptions(deriveOptions({ color: paletteKey.split(",") }));
    void mm.renderData();
  }, [paletteKey]);

  // 全屏切换时容器尺寸变了——延一帧 fit 重新撑满，避免内容偏在角落。
  // 不能以 mmRef 判空提前返回：编辑模式下 markmap 实例已销毁，那样导图编辑器永远不会重新适应（实测全屏后偏到一边）
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      void mmRef.current?.fit();
      editorRef.current?.fit();
    });
    return () => cancelAnimationFrame(raf);
  }, [isFullscreen, open]);

  // 全屏模式下监听 ESC 退出（standalone 不接管，让 OS 关闭快捷键 / 用户主动关窗）
  useEffect(() => {
    if (variant === "standalone" || !isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setIsFullscreen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isFullscreen, variant]);

  function handleZoom(factor: number) {
    if (editMode) editorRef.current?.zoomBy(factor);
    else void mmRef.current?.rescale(factor);
  }

  function handleFit() {
    if (editMode) editorRef.current?.fit();
    else void mmRef.current?.fit();
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

  /**
   * 导出 PNG：用 html-to-image 把 svg DOM 节点光栅化。
   *
   * 注意：直接给 toPng 传 svgRef 不行——html-to-image 对裸 SVG 元素的处理有 bug，
   * 容易吃掉 foreignObject 里的 HTML（markmap 节点正是 foreignObject）。
   * 解法：传它的父 div 容器（含 SVG），让 html-to-image 走 DOM-to-canvas 路径。
   */
  async function handleExportPng() {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    try {
      const targetPath = await save({
        title: "导出思维导图为 PNG",
        defaultPath: `${title || "mindmap"}.png`,
        filters: [{ name: "PNG 图像", extensions: ["png"] }],
      });
      if (!targetPath) return;
      // 编辑模式导出整张图（与当前缩放 / 平移无关）；只读视图沿用截容器
      // 2x 像素密度，在 4K/Retina 上看着锐利
      const dataUrl =
        editMode && editorRef.current
          ? await editorRef.current.exportPng(token.colorBgContainer)
          : await toPng(wrapper, {
              pixelRatio: 2,
              backgroundColor: token.colorBgContainer,
              cacheBust: true,
            });
      // 去掉 "data:image/png;base64," 前缀，只留 base64
      const base64 = dataUrl.split(",")[1] ?? "";
      if (!base64) throw new Error("toPng 返回空数据");
      await systemApi.writeBinaryFile(targetPath, base64);
      message.success("已导出 PNG");
    } catch (e) {
      message.error(`导出失败：${e}`);
    }
  }

  async function handleOpenInWindow() {
    if (noteId == null) {
      message.warning("请先保存笔记后再打开新窗口");
      return;
    }
    try {
      await noteApi.openMindMapInNewWindow(noteId);
    } catch (e) {
      message.error(`打开窗口失败：${e}`);
    }
  }

  if (!open) return null;

  // standalone 永不切全屏；embed 模式根据 isFullscreen 决定外层样式
  const effectiveFullscreen = variant === "embed" && isFullscreen;
  const showCloseBtn = variant === "embed" && !effectiveFullscreen;
  const showPopoutBtn =
    variant === "embed" && noteId != null && !effectiveFullscreen;

  return (
    <div
      className="flex flex-col"
      style={{
        width: "100%",
        height: "100%",
        background: token.colorBgContainer,
        // standalone 没有左侧分栏边框（自己占满窗口）
        borderLeft:
          variant === "embed" && !effectiveFullscreen
            ? `1px solid ${token.colorBorderSecondary}`
            : undefined,
        minWidth: 0,
        overflow: "hidden",
        // 全屏：fixed 覆盖整个视口，z-index 高于 antd Modal/Drawer（1000 起）和 popover
        ...(effectiveFullscreen
          ? ({
              position: "fixed",
              inset: 0,
              zIndex: 1100,
            } as const)
          : {}),
      }}
    >
      {/* 工具栏：标题 + 缩放/适应/导出/全屏/弹窗/关闭 */}
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
          {canEdit && (
            <Tooltip
              title={
                editMode
                  ? "退出编辑（回到只读视图）"
                  : editDisabledReason ?? "在导图里直接编辑（改动写回笔记正文）"
              }
            >
              <Button
                size="small"
                type={editMode ? "primary" : "text"}
                icon={<PencilLine size={13} />}
                disabled={!editMode && !!editDisabledReason}
                onClick={() => setEditing((v) => !v)}
              >
                <span style={{ fontSize: 12 }}>{editMode ? "编辑中" : "编辑"}</span>
              </Button>
            </Tooltip>
          )}
          {editMode && (
            <Tooltip title={layoutMode === "both" ? "布局：左右分布（点击改为全部向右）" : "布局：全部向右（点击改为左右分布）"}>
              <Button
                size="small"
                type="text"
                icon={layoutMode === "both" ? <Columns2 size={13} /> : <ArrowRightToLine size={13} />}
                onClick={toggleLayout}
              />
            </Tooltip>
          )}
          {editMode && (
            <Tooltip title={SHORTCUT_HELP} placement="bottomRight">
              <Button size="small" type="text" icon={<Keyboard size={13} />} />
            </Tooltip>
          )}
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
          {!editMode && (
            <Tooltip title="导出 SVG（矢量）">
              <Button
                size="small"
                type="text"
                icon={<Download size={13} />}
                onClick={() => void handleExportSvg()}
              />
            </Tooltip>
          )}
          <Tooltip title="导出 PNG（位图）">
            <Button
              size="small"
              type="text"
              onClick={() => void handleExportPng()}
            >
              <span style={{ fontSize: 10, fontWeight: 600 }}>PNG</span>
            </Button>
          </Tooltip>
          {variant === "embed" && (
            <Tooltip title={effectiveFullscreen ? "退出全屏（Esc）" : "全屏"}>
              <Button
                size="small"
                type="text"
                icon={
                  effectiveFullscreen ? (
                    <Minimize2 size={13} />
                  ) : (
                    <Maximize2 size={13} />
                  )
                }
                onClick={() => setIsFullscreen((v) => !v)}
              />
            </Tooltip>
          )}
          {showPopoutBtn && (
            <Tooltip title="在新窗口打开（双屏对照）">
              <Button
                size="small"
                type="text"
                icon={<ExternalLink size={13} />}
                onClick={() => void handleOpenInWindow()}
              />
            </Tooltip>
          )}
          {showCloseBtn && (
            <Tooltip title="关闭">
              <Button
                size="small"
                type="text"
                icon={<X size={13} />}
                onClick={onClose}
              />
            </Tooltip>
          )}
        </Space>
      </div>

      {/* SVG 容器：占满剩余空间。ref 在 wrapper 上，PNG 导出需要它 */}
      <div
        ref={wrapperRef}
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          background: token.colorBgContainer,
        }}
      >
        {editMode && onMarkdownChange ? (
          <MindMapEditor
            // 切笔记时整个重建：防抖中没写回的改动在卸载时交给上一篇，不会串到下一篇
            key={noteId ?? "draft"}
            ref={editorRef}
            markdown={markdown}
            title={title}
            onChange={onMarkdownChange}
            onTitleChange={onTitleChange}
            palette={branchPalette}
            layoutMode={layoutMode}
          />
        ) : (
        <svg
          ref={svgRef}
          style={
            {
              width: "100%",
              height: "100%",
              display: "block",
              // markmap 的节点文字 / 链接 / 代码 / 折叠圆点底色走这些 CSS 变量，默认是写死的深灰，
              // 暖炭下深灰字压在深色底上看不清
              "--markmap-text-color": token.colorText,
              "--markmap-a-color": token.colorPrimary,
              "--markmap-a-hover-color": token.colorPrimaryHover,
              "--markmap-code-bg": token.colorFillTertiary,
              "--markmap-code-color": token.colorText,
              "--markmap-circle-open-bg": token.colorBgContainer,
              "--markmap-highlight-bg": token.colorPrimaryBg,
              "--markmap-table-border": token.colorBorderSecondary,
            } as React.CSSProperties
          }
        />
        )}
      </div>
    </div>
  );
}
