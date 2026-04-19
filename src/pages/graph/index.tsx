import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Spin, Empty, theme as antdTheme, Segmented, Tooltip } from "antd";
import { Maximize2, Minimize2, RotateCcw } from "lucide-react";
import { Graph } from "@antv/g6";
import { linkApi } from "@/lib/api";
import type { GraphData } from "@/types";

export default function GraphPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const navigate = useNavigate();
  const { token } = antdTheme.useToken();

  const [loading, setLoading] = useState(true);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [layout, setLayout] = useState<string>("d3-force");

  useEffect(() => {
    loadGraphData();
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

    const nodes = graphData.nodes.map((n) => ({
      id: String(n.id),
      data: {
        label: n.title,
        isDaily: n.is_daily,
        isPinned: n.is_pinned,
        tagCount: n.tag_count,
        linkCount: n.link_count,
      },
    }));

    const edges = graphData.edges.map((e, i) => ({
      id: `edge-${i}`,
      source: String(e.source),
      target: String(e.target),
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
        style: {
          size: (d: any) => {
            const linkCount = d.data?.linkCount || 0;
            return Math.max(20, Math.min(52, 20 + linkCount * 6));
          },
          fill: (d: any) => {
            if (d.data?.isDaily) return token.colorWarning;
            if (d.data?.isPinned) return token.colorError;
            if ((d.data?.linkCount || 0) > 3) return token.colorPrimary;
            return token.colorPrimaryBg;
          },
          stroke: (d: any) => {
            if (d.data?.isDaily) return token.colorWarningBorder;
            if (d.data?.isPinned) return token.colorErrorBorder;
            return token.colorPrimaryBorder;
          },
          lineWidth: 2,
          labelText: (d: any) => {
            const label = d.data?.label || "";
            return label.length > 10 ? label.slice(0, 10) + "..." : label;
          },
          labelFontSize: 13,
          labelFontWeight: 500,
          labelFill: token.colorText,
          labelPlacement: "bottom",
          labelOffsetY: 6,
        },
      },
      edge: {
        style: {
          stroke: token.colorPrimary,
          strokeOpacity: 0.45,
          lineWidth: 1.5,
          endArrow: true,
          endArrowSize: 8,
          endArrowFill: token.colorPrimary,
        },
      },
      layout:
        layout === "d3-force"
          ? {
              // G6 v5 的 d3-force 走子对象 API（link / manyBody / collide / center）
              // 之前用的 linkDistance / nodeStrength 顶层简写是 v4 的，v5 会被忽略
              type: "d3-force",
              link: { distance: 220, strength: 0.4 },
              manyBody: { strength: -500 },
              collide: { radius: 60, strength: 0.9 },
              center: { strength: 0.05 },
            }
          : layout === "radial"
            ? { type: "radial", unitRadius: 140, preventOverlap: true, nodeSize: 50 }
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

    // 双击节点跳转到笔记
    graph.on("node:dblclick", (evt: any) => {
      const nodeId = evt.target?.id;
      if (nodeId) {
        navigate(`/notes/${nodeId}`);
      }
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
    <div className="flex flex-col h-full">
      {/* 顶部工具栏 */}
      <div
        className="flex items-center justify-between px-4 py-2 shrink-0"
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
          每日笔记
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full"
            style={{ background: token.colorError }}
          />
          置顶笔记
        </span>
        <span style={{ marginLeft: "auto" }}>双击节点打开笔记</span>
      </div>

      {/* 图谱画布 */}
      <div
        ref={containerRef}
        className="flex-1"
        style={{ minHeight: 0, background: token.colorBgLayout }}
      />
    </div>
  );
}
