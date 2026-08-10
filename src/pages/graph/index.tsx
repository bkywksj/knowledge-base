import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Spin, Empty, theme as antdTheme, Segmented, Tooltip } from "antd";
import {
  Maximize2,
  Minimize2,
  RotateCcw,
  ExternalLink,
  Crosshair,
} from "lucide-react";
import { Graph } from "@antv/g6";
import { linkApi } from "@/lib/api";
import type { GraphData } from "@/types";
import { useContextMenu } from "@/hooks/useContextMenu";
import {
  ContextMenuOverlay,
  type ContextMenuEntry,
} from "@/components/ui/ContextMenuOverlay";

export default function GraphPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const navigate = useNavigate();
  const { token } = antdTheme.useToken();

  const [loading, setLoading] = useState(true);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [layout, setLayout] = useState<string>("d3-force");

  // ─── 节点右键菜单 ────────────────────────────
  // gid = G6 节点 id（带 n/f 前缀）；realId = 数据库真实 id；nodeType 决定菜单项
  const ctx = useContextMenu<{
    gid: string;
    realId: number;
    nodeType: "note" | "folder";
    title: string;
  }>();

  const menuItems: ContextMenuEntry[] = useMemo(() => {
    const p = ctx.state.payload;
    if (!p) return [];
    const items: ContextMenuEntry[] = [];
    // 文件夹节点没有对应笔记，不显示"打开笔记"
    if (p.nodeType === "note") {
      items.push({
        key: "open",
        label: "打开笔记",
        icon: <ExternalLink size={13} />,
        onClick: () => {
          ctx.close();
          navigate(`/notes/${p.realId}`);
        },
      });
    }
    items.push({
      key: "focus",
      label: "居中此节点",
      icon: <Crosshair size={13} />,
      onClick: () => {
        ctx.close();
        // G6 v5：把指定节点移到视图中心
        try {
          graphRef.current?.focusElement(p.gid);
        } catch {
          // focusElement 可能在某些版本叫 focus；失败时退到 fitCenter
          graphRef.current?.fitCenter();
        }
      },
    });
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.state.payload, navigate]);

  useEffect(() => {
    loadGraphData();
  }, []);

  // 给 G6 画布容器原生挂 contextmenu capture-phase listener，吞 WebView 默认菜单。
  // G6 v5 的 canvas 内部会拦截 contextmenu 不冒泡到 React 外层 div，所以
  // 顶层 <div onContextMenu> 收不到画布空白处的右键事件。capture phase 的
  // 原生 listener 比 G6 内部 bubble-phase 监听器先触发，主动 preventDefault
  // 让 WebView 默认菜单不弹；节点的 graph.on("node:contextmenu") 仍然能跑
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: MouseEvent) => e.preventDefault();
    el.addEventListener("contextmenu", handler, true);
    return () => el.removeEventListener("contextmenu", handler, true);
  }, []);

  async function loadGraphData() {
    setLoading(true);
    try {
      const data = await linkApi.getGraphData();
      setGraphData(data);
    } catch (e) {
      console.error("加载图谱数据失败:", e);
    } finally {
      setLoading(false);
    }
  }

  // 渲染图谱
  useEffect(() => {
    if (!containerRef.current || !graphData || graphData.nodes.length === 0) {
      return;
    }

    // 销毁旧实例
    if (graphRef.current) {
      graphRef.current.destroy();
      graphRef.current = null;
    }

    // note 节点 id 加 `n` 前缀、folder 加 `f` 前缀——两表自增 id 可能相同，必须区分
    const nodes = graphData.nodes.map((n) => ({
      id: (n.node_type === "folder" ? "f" : "n") + n.id,
      data: {
        label: n.title,
        nodeType: n.node_type,
        realId: n.id,
        isDaily: n.is_daily,
        isPinned: n.is_pinned,
        tagCount: n.tag_count,
        linkCount: n.link_count,
        folderColor: n.color,
      },
    }));

    // 按 edge_type 给两端拼对应前缀：
    //   link  n→n      folder_child  f→f      folder_note  f→n
    const edges = graphData.edges.map((e, i) => ({
      id: `edge-${i}`,
      source: (e.edge_type === "link" ? "n" : "f") + e.source,
      target: (e.edge_type === "folder_child" ? "f" : "n") + e.target,
      data: { edgeType: e.edge_type },
    }));

    const graph = new Graph({
      container: containerRef.current,
      // 用对象写法：内容溢出才缩放（when: "overflow"），装得下就保持原尺寸；
      // 两者兼顾——首屏能看到全部节点，字也不会被无谓缩小
      autoFit: {
        type: "view",
        options: { when: "overflow", direction: "both" },
        animation: { duration: 300, easing: "ease-out" },
      },
      data: { nodes, edges },
      node: {
        // 文件夹用方形（rect）、笔记用圆形（circle）——形状先于颜色区分两类节点
        type: (d: any) => (d.data?.nodeType === "folder" ? "rect" : "circle"),
        style: {
          size: (d: any) => {
            // 文件夹固定尺寸；笔记按链接数放大
            if (d.data?.nodeType === "folder") return 30;
            const linkCount = d.data?.linkCount || 0;
            return Math.max(20, Math.min(52, 20 + linkCount * 6));
          },
          fill: (d: any) => {
            // 文件夹优先用自定义颜色，否则中性填充
            if (d.data?.nodeType === "folder")
              return d.data?.folderColor || token.colorFillSecondary;
            if (d.data?.isDaily) return token.colorWarning;
            if (d.data?.isPinned) return token.colorError;
            if ((d.data?.linkCount || 0) > 3) return token.colorPrimary;
            return token.colorPrimaryBg;
          },
          stroke: (d: any) => {
            if (d.data?.nodeType === "folder")
              return d.data?.folderColor || token.colorBorder;
            if (d.data?.isDaily) return token.colorWarningBorder;
            if (d.data?.isPinned) return token.colorErrorBorder;
            return token.colorPrimaryBorder;
          },
          // 文件夹方块加圆角；圆形节点 radius 无副作用
          radius: (d: any) => (d.data?.nodeType === "folder" ? 6 : 0),
          lineWidth: 2,
          labelText: (d: any) => {
            const raw = d.data?.label || "";
            const label = d.data?.nodeType === "folder" ? `📁 ${raw}` : raw;
            return label.length > 12 ? label.slice(0, 12) + "..." : label;
          },
          labelFontSize: 13,
          labelFontWeight: (d: any) =>
            d.data?.nodeType === "folder" ? 600 : 500,
          labelFill: token.colorText,
          labelPlacement: "bottom",
          labelOffsetY: 6,
        },
      },
      edge: {
        style: {
          // wiki 双链：实线带箭头、主题色；层级边：浅色虚线无箭头
          stroke: (d: any) =>
            d.data?.edgeType === "link"
              ? token.colorPrimary
              : token.colorTextQuaternary,
          strokeOpacity: (d: any) => (d.data?.edgeType === "link" ? 0.45 : 0.7),
          lineWidth: (d: any) => (d.data?.edgeType === "link" ? 1.5 : 1),
          lineDash: (d: any) =>
            d.data?.edgeType === "link" ? undefined : [4, 4],
          endArrow: (d: any) => d.data?.edgeType === "link",
          endArrowSize: 8,
          endArrowFill: token.colorPrimary,
        },
      },
      layout:
        layout === "d3-force"
          ? {
              // G6 v5 的 d3-force 走子对象 API（link / manyBody / collide / center）
              // 小图（<20 节点）用紧凑参数：节点不会散到画布外，autoFit 也就
              // 不需要缩放，字得以保持原尺寸
              type: "d3-force",
              link: { distance: 110, strength: 0.5 },
              manyBody: { strength: -180 },
              collide: { radius: 48, strength: 0.9 },
              center: { strength: 0.08 },
            }
          : layout === "radial"
            ? { type: "radial", unitRadius: 110, preventOverlap: true, nodeSize: 50 }
            : { type: layout },
      behaviors: [
        "drag-canvas",
        "zoom-canvas",
        "drag-element",
        {
          type: "click-select",
          multiple: false,
        },
      ],
    });

    graph.render();

    // 双击节点跳转到笔记（文件夹节点无对应笔记，双击忽略）
    graph.on("node:dblclick", (evt: any) => {
      const gid = String(evt.target?.id ?? "");
      const node = graphData.nodes.find(
        (n) => (n.node_type === "folder" ? "f" : "n") + n.id === gid,
      );
      if (node && node.node_type === "note") {
        navigate(`/notes/${node.id}`);
      }
    });

    // 节点右键弹自定义菜单
    graph.on("node:contextmenu", (evt: any) => {
      // 阻止 WebView 默认右键菜单（不同 G6 版本字段名可能不同，逐个试）
      const native: MouseEvent | undefined =
        evt?.nativeEvent ?? evt?.originalEvent ?? evt?.event;
      native?.preventDefault?.();
      const gid = String(evt?.target?.id ?? "");
      if (!gid) return;
      const node = graphData.nodes.find(
        (n) => (n.node_type === "folder" ? "f" : "n") + n.id === gid,
      );
      if (!node) return;
      const x = native?.clientX ?? evt?.client?.x ?? 0;
      const y = native?.clientY ?? evt?.client?.y ?? 0;
      ctx.open(
        { clientX: x, clientY: y },
        {
          gid,
          realId: node.id,
          nodeType: node.node_type,
          title: node.title,
        },
      );
    });

    graphRef.current = graph;

    return () => {
      if (graphRef.current) {
        graphRef.current.destroy();
        graphRef.current = null;
      }
    };
  }, [graphData, layout, token]);

  function handleFitView() {
    graphRef.current?.fitView();
  }

  function handleFitCenter() {
    graphRef.current?.fitCenter();
  }

  function handleRefresh() {
    loadGraphData();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spin size="large" tip="加载知识图谱..." />
      </div>
    );
  }

  if (!graphData || graphData.nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <Empty description="暂无图谱数据，请先创建笔记并添加链接" />
      </div>
    );
  }

  return (
    <div
      className="flex flex-col h-full"
      // 顶层兜底：节点右键由 G6 监听并自管 preventDefault；其他位置（画布空白 /
      // 工具栏 / 图例）右键不弹 WebView 默认菜单。本页无 input
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 顶部工具栏 */}
      <div
        className="flex items-center justify-between px-4 py-2 shrink-0 kb-surface"
        style={{
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
        }}
      >
        <div className="flex items-center gap-3">
          <span
            className="font-semibold text-base"
            style={{ color: token.colorText }}
          >
            知识图谱
          </span>
          <span
            className="text-xs"
            style={{ color: token.colorTextSecondary }}
          >
            {graphData.nodes.length} 个节点 / {graphData.edges.length} 条连线
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Segmented
            size="small"
            value={layout}
            options={[
              { label: "力导向", value: "d3-force" },
              { label: "环形", value: "circular" },
              { label: "径向", value: "radial" },
              { label: "网格", value: "grid" },
            ]}
            onChange={(v) => setLayout(v as string)}
          />

          <div className="flex items-center gap-1 ml-2">
            <Tooltip title="适应画布">
              <button
                className="p-1.5 rounded hover:bg-black/5 transition-colors"
                onClick={handleFitView}
              >
                <Maximize2 size={14} />
              </button>
            </Tooltip>
            <Tooltip title="居中">
              <button
                className="p-1.5 rounded hover:bg-black/5 transition-colors"
                onClick={handleFitCenter}
              >
                <Minimize2 size={14} />
              </button>
            </Tooltip>
            <Tooltip title="刷新数据">
              <button
                className="p-1.5 rounded hover:bg-black/5 transition-colors"
                onClick={handleRefresh}
              >
                <RotateCcw size={14} />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* 图例 */}
      <div
        className="flex items-center gap-4 px-4 py-1.5 text-xs shrink-0"
        style={{
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          color: token.colorTextSecondary,
        }}
      >
        <span className="flex items-center gap-1">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full"
            style={{ background: token.colorPrimaryBg }}
          />
          普通笔记
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full"
            style={{ background: token.colorPrimary }}
          />
          热门笔记
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full"
            style={{ background: token.colorWarning }}
          />
          日记
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full"
            style={{ background: token.colorError }}
          />
          置顶笔记
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block w-2.5 h-2.5 rounded-sm"
            style={{
              background: token.colorFillSecondary,
              border: `1px solid ${token.colorBorder}`,
            }}
          />
          文件夹
        </span>
        <span style={{ marginLeft: "auto" }}>
          双击笔记打开 · 虚线为文件夹归属
        </span>
      </div>

      {/* 图谱画布 */}
      <div
        ref={containerRef}
        className="flex-1"
        style={{ minHeight: 0, background: token.colorBgLayout }}
      />

      <ContextMenuOverlay
        open={!!ctx.state.payload}
        x={ctx.state.x}
        y={ctx.state.y}
        items={menuItems}
        onClose={ctx.close}
      />
    </div>
  );
}
