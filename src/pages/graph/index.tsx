import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Spin, Empty, theme as antdTheme, Segmented, Button, Input, AutoComplete } from "antd";
import {
  Maximize2,
  RotateCcw,
  ExternalLink,
  Crosshair,
  Search,
} from "lucide-react";
import { Graph } from "@antv/g6";
import { linkApi } from "@/lib/api";
import type { GraphData } from "@/types";
import { useContextMenu } from "@/hooks/useContextMenu";
import {
  ContextMenuOverlay,
  type ContextMenuEntry,
} from "@/components/ui/ContextMenuOverlay";

/** 节点种类（决定颜色 / 大小 / 标签权重），与图例一一对应 */
type NodeKind = "normal" | "hot" | "daily" | "pinned" | "folder";
/** 链接数超过它算「热门笔记」 */
const HOT_LINKS = 3;
const LEGEND: { key: NodeKind; label: string }[] = [
  { key: "normal", label: "普通笔记" },
  { key: "hot", label: "热门笔记" },
  { key: "daily", label: "日记" },
  { key: "pinned", label: "置顶笔记" },
  { key: "folder", label: "文件夹" },
];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function kindOf(d: any): NodeKind {
  if (d?.nodeType === "folder") return "folder";
  if (d?.isPinned) return "pinned";
  if (d?.isDaily) return "daily";
  if ((d?.linkCount || 0) > HOT_LINKS) return "hot";
  return "normal";
}

export default function GraphPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const navigate = useNavigate();
  const { token } = antdTheme.useToken();

  const [loading, setLoading] = useState(true);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [layout, setLayout] = useState<string>("d3-force");
  /** 当前选中的节点（G6 id，带 n/f 前缀）→ 右上角节点卡片 */
  const [selectedGid, setSelectedGid] = useState<string | null>(null);
  const [locateText, setLocateText] = useState("");

  /**
   * 原型配色（v4 .legend 实测）：普通 #B9A9F1、日记 #8DAEEA、置顶 #E6BC6E、文件夹 #7CC1A4 —— 中等明度的柔和色，
   * 淡紫 / 暖炭两套底色上都看得清，所以不随主题切换。
   * 热门在原型里是主按钮渐变，画布上画不了渐变 → 用主色实心 + 光晕代替（图例仍画渐变）。
   */
  const palette: Record<NodeKind, string> = useMemo(
    () => ({
      normal: "#B9A9F1",
      hot: token.colorPrimary,
      daily: "#8DAEEA",
      pinned: "#E6BC6E",
      folder: "#7CC1A4",
    }),
    [token],
  );

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
        // v4 原型：全部圆形，靠颜色区分（文件夹绿、日记蓝、置顶琥珀、热门深紫带光晕）
        type: "circle",
        style: {
          size: (d: any) => {
            const k = kindOf(d.data);
            if (k === "folder") return 26;
            // 笔记按链接数放大
            const linkCount = d.data?.linkCount || 0;
            return Math.max(12, Math.min(44, 12 + linkCount * 5));
          },
          fill: (d: any) => {
            const k = kindOf(d.data);
            // 文件夹自定义颜色仍然优先
            if (k === "folder") return d.data?.folderColor || palette.folder;
            return palette[k];
          },
          // 普通笔记原来靠半透明主色变浅，现在本身就是浅紫，不再叠透明度
          fillOpacity: 1,
          lineWidth: 0,
          // 热门笔记一圈柔光（原型里的「热门」）
          halo: (d: any) => kindOf(d.data) === "hot",
          haloFill: palette.hot,
          haloStroke: palette.hot,
          haloLineWidth: 16,
          haloStrokeOpacity: 0.16,
          labelText: (d: any) => {
            const raw = d.data?.label || "";
            return raw.length > 12 ? raw.slice(0, 12) + "..." : raw;
          },
          // 标签不隐藏，只分轻重：文件夹 / 热门 / 置顶 / 日记 醒目，普通笔记小号浅色，减轻拥挤
          labelFontSize: (d: any) => (kindOf(d.data) === "normal" ? 11 : 13),
          labelFontWeight: (d: any) => (kindOf(d.data) === "normal" ? 400 : 600),
          labelFill: (d: any) =>
            kindOf(d.data) === "normal" ? token.colorTextTertiary : token.colorText,
          labelPlacement: "bottom",
          labelOffsetY: 4,
        },
        // 选中态：主色描边 + 柔光（G6 默认是粗黑圈，和主题不搭）
        state: {
          selected: {
            stroke: token.colorPrimary,
            lineWidth: 3,
            halo: true,
            haloStroke: token.colorPrimary,
            haloLineWidth: 14,
            haloStrokeOpacity: 0.22,
            labelFontWeight: 700,
            labelFill: token.colorText,
          },
        },
      },
      edge: {
        style: {
          // wiki 双链：实线带箭头、主题色；层级边：浅色虚线无箭头
          // wiki 双链：主色实线 + 小箭头（箭头表示链接方向，保留）；文件夹归属：绿色虚线（原型）
          stroke: (d: any) =>
            d.data?.edgeType === "link" ? token.colorPrimary : palette.folder,
          strokeOpacity: (d: any) => (d.data?.edgeType === "link" ? 0.35 : 0.75),
          lineWidth: (d: any) => (d.data?.edgeType === "link" ? 1.2 : 1.2),
          lineDash: (d: any) =>
            d.data?.edgeType === "link" ? undefined : [5, 4],
          endArrow: (d: any) => d.data?.edgeType === "link",
          endArrowSize: 6,
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
      } else if (node) {
        // 文件夹节点：双击打开该文件夹的笔记列表（原来忽略）
        navigate(`/notes?folder=${node.id}`);
      }
    });

    // 单击节点 → 右上角节点卡片；点画布空白 → 收起
    graph.on("node:click", (evt: any) => {
      const gid = String(evt.target?.id ?? "");
      if (gid) setSelectedGid(gid);
    });
    graph.on("canvas:click", () => setSelectedGid(null));

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

    // 画布跟着容器尺寸走：G6 只在创建时量一次容器（首帧可能还没撑开 → 只画了上半截），
    // autoResize 又只听窗口 resize，拖侧栏 / 首帧布局变化都漏掉，这里直接盯容器
    const host = containerRef.current;
    const ro = new ResizeObserver(() => {
      const g = graphRef.current;
      if (!g || !host) return;
      const { clientWidth: w, clientHeight: h } = host;
      if (w > 0 && h > 0) g.resize(w, h);
    });
    ro.observe(host);
    // 换布局 / 刷新会重建画布，旧的选中态已不存在，卡片一起收起
    setSelectedGid(null);

    return () => {
      ro.disconnect();
      if (graphRef.current) {
        graphRef.current.destroy();
        graphRef.current = null;
      }
    };
  }, [graphData, layout, token, palette]);

  /** 定位：放大到看得清（缩得太小时回到 100%）+ 平移到节点 + 设为选中 + 打开卡片 */
  async function locate(gid: string) {
    const graph = graphRef.current;
    if (!graph) return;
    try {
      // 先清掉其它节点的选中态，再选中目标
      for (const n of graph.getElementDataByState("node", "selected")) {
        graph.setElementState(String(n.id), []);
      }
      graph.setElementState(gid, "selected");
      // 「适应画布」后整张图可能缩得只剩小点，光平移找不到节点在哪
      if (graph.getZoom() < 1) await graph.zoomTo(1, false);
      await graph.focusElement(gid);
    } catch {
      graph.fitCenter();
    }
    setSelectedGid(gid);
  }

  /** 「定位节点」下拉：按标题模糊匹配，最多 20 条 */
  const locateOptions = useMemo(() => {
    const kw = locateText.trim().toLowerCase();
    if (!graphData || !kw) return [];
    return graphData.nodes
      .filter((n) => n.title.toLowerCase().includes(kw))
      .slice(0, 20)
      .map((n) => ({
        value: (n.node_type === "folder" ? "f" : "n") + n.id,
        label: (n.node_type === "folder" ? "📁 " : "") + n.title,
      }));
  }, [graphData, locateText]);

  /** 节点卡片内容：标题 · 所在文件夹路径（从图里的归属边推）· 链接数 · 类型 */
  const selectedInfo = useMemo(() => {
    if (!graphData || !selectedGid) return null;
    const isFolder = selectedGid.startsWith("f");
    const realId = Number(selectedGid.slice(1));
    const node = graphData.nodes.find(
      (n) => n.id === realId && n.node_type === (isFolder ? "folder" : "note"),
    );
    if (!node) return null;
    const folderName = new Map(
      graphData.nodes.filter((n) => n.node_type === "folder").map((n) => [n.id, n.title]),
    );
    // 父文件夹：folder_child 边 source=父 target=子；笔记所在文件夹：folder_note 边 source=文件夹 target=笔记
    const parentOfFolder = new Map<number, number>();
    const folderOfNote = new Map<number, number>();
    for (const e of graphData.edges) {
      if (e.edge_type === "folder_child") parentOfFolder.set(e.target, e.source);
      else if (e.edge_type === "folder_note") folderOfNote.set(e.target, e.source);
    }
    const chain: string[] = [];
    let cur = isFolder ? parentOfFolder.get(realId) : folderOfNote.get(realId);
    const seen = new Set<number>();
    while (cur != null && !seen.has(cur)) {
      seen.add(cur);
      chain.unshift(folderName.get(cur) ?? "");
      cur = parentOfFolder.get(cur);
    }
    const parts: string[] = [chain.length ? chain.join(" / ") : isFolder ? "顶层文件夹" : "未分类"];
    if (isFolder) {
      const count = graphData.edges.filter(
        (e) => e.edge_type === "folder_note" && e.source === realId,
      ).length;
      parts.push(`${count} 篇笔记`);
    } else {
      parts.push(`${node.link_count} 条链接`);
      const k = kindOf({
        nodeType: "note",
        isPinned: node.is_pinned,
        isDaily: node.is_daily,
        linkCount: node.link_count,
      });
      parts.push(LEGEND.find((l) => l.key === k)?.label ?? "");
    }
    return {
      gid: selectedGid,
      realId,
      nodeType: node.node_type,
      title: node.title,
      meta: parts.filter(Boolean).join(" · "),
    };
  }, [graphData, selectedGid]);

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
    // v4：撑满纸张（同编辑页 / 白板），顶栏一行 + 画布；图例、节点卡片浮在画布上
    <div
      className="editor-page"
      // 顶层兜底：节点右键由 G6 监听并自管 preventDefault；其他位置（画布空白 /
      // 工具栏 / 图例）右键不弹 WebView 默认菜单
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 顶栏（原型 .bar）：知识图谱 · 布局 · 说明 ｜ 定位节点 · 适应画布 · 居中 · 刷新数据 */}
      <div className="editor-topbar kb-ebar kb-graph-bar">
        <div className="kb-ebar-left">
          <span className="kb-graph-title">知识图谱</span>
          <Segmented
            size="small"
            // 原型 .seg：30 高、圆角 8、选中白底描边（与编辑器模式切换同款）
            className="kb-mode-seg"
            value={layout}
            options={[
              { label: "力导向", value: "d3-force" },
              { label: "环形", value: "circular" },
              { label: "径向", value: "radial" },
              { label: "网格", value: "grid" },
            ]}
            onChange={(v) => setLayout(v as string)}
          />
          <span className="kb-graph-hint">
            {graphData.nodes.length} 个节点 · {graphData.edges.length} 条连线 · 单击看详情 · 双击打开 · 虚线为文件夹归属
          </span>
        </div>
        <div className="kb-ebar-right">
          {/* 定位节点（新增）：按标题找节点 → 平移过去 + 选中 + 弹节点卡片 */}
          <AutoComplete
            className="kb-graph-locate"
            value={locateText}
            options={locateOptions}
            onSearch={setLocateText}
            onChange={setLocateText}
            onSelect={(gid: string) => {
              setLocateText("");
              void locate(gid);
            }}
          >
            <Input allowClear prefix={<Search size={14} />} placeholder="定位节点" />
          </AutoComplete>
          <Button className="kb-bar-btn" icon={<Maximize2 size={14} />} onClick={handleFitView}>
            适应画布
          </Button>
          <Button className="kb-bar-btn" icon={<Crosshair size={14} />} onClick={handleFitCenter}>
            居中
          </Button>
          <Button className="kb-bar-btn" icon={<RotateCcw size={14} />} onClick={handleRefresh}>
            刷新数据
          </Button>
        </div>
      </div>

      {/* 画布 + 浮层 */}
      <div className="kb-graph-stage">
        <div ref={containerRef} className="kb-graph-canvas" />

        {/* 图例（原型 .legend）：颜色与节点配色一一对应 */}
        <div className="kb-graph-legend">
          {LEGEND.map((l) => (
            <span key={l.label}>
              {/* 热门：原型图例是主按钮渐变 */}
              <i style={{ background: l.key === "hot" ? "var(--kb-grad, " + palette.hot + ")" : palette[l.key] }} />
              {l.label}
            </span>
          ))}
        </div>

        {/* 节点卡片（新增）：单击节点出现，点画布空白关闭 */}
        {selectedInfo && (
          <div className="kb-graph-card">
            <div className="kb-graph-card-title" title={selectedInfo.title}>
              {selectedInfo.title || "未命名"}
            </div>
            <div className="kb-graph-card-meta">{selectedInfo.meta}</div>
            <div className="kb-graph-card-actions">
              <Button
                type="primary"
                size="small"
                icon={<ExternalLink size={13} />}
                onClick={() =>
                  navigate(
                    selectedInfo.nodeType === "note"
                      ? `/notes/${selectedInfo.realId}`
                      : `/notes?folder=${selectedInfo.realId}`,
                  )
                }
              >
                {selectedInfo.nodeType === "note" ? "打开笔记" : "打开文件夹"}
              </Button>
              <Button
                className="kb-bar-btn is-sm"
                icon={<Crosshair size={13} />}
                onClick={() => void locate(selectedInfo.gid)}
              >
                居中此节点
              </Button>
            </div>
          </div>
        )}
      </div>

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
