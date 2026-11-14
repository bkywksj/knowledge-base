import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { theme as antdTheme } from "antd";
import {
  addChild,
  addSibling,
  cloneTree,
  indent,
  locate,
  moveAmongSiblings,
  outdent,
  parseMindMap,
  removeNode,
  serializeMindMap,
  setText,
  toggleTask,
  type EditResult,
  type MindNode,
} from "./tree";
import { DEFAULT_LAYOUT, layoutMindMap, type PlacedNode, type Size } from "./layout";
import { renderInline } from "./inline";

/**
 * 可编辑思维导图（自研，见 docs/tasks/mindmap-editor-tasks.md）。
 *
 * 结构：tree.ts 管数据和编辑操作，layout.ts 管坐标，这里只负责渲染和交互。
 * - 节点是普通 HTML 元素绝对定位（改文字用原生输入框，中文输入法无坑），连线是底下一层 SVG
 * - 每次渲染后量一遍节点尺寸，变了就重排（useLayoutEffect 在绘制前完成，不闪）
 * - 画布整体 CSS transform 做缩放平移
 * - 所有改动先改树 → 序列化成 Markdown → 防抖写回父组件（父组件负责保存）
 *
 * 只在父组件判定「纯大纲可编辑」时挂载；只读场景仍用 markmap 视图。
 */

export interface MindMapEditorHandle {
  zoomBy: (factor: number) => void;
  fit: () => void;
}

interface Props {
  markdown: string;
  /** 中心主题 = 笔记标题 */
  title: string;
  onChange: (markdown: string) => void;
  /** 改中心主题 = 改笔记标题；不传则中心主题不可改 */
  onTitleChange?: (title: string) => void;
  /** 分支配色（按一级分支轮换） */
  palette: string[];
}

interface Snapshot {
  root: MindNode;
  selectId: string;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 3;
/** 写回防抖：连续操作（快速按 Tab / 方向键挪位置）合并成一次保存 */
const EMIT_DELAY = 300;
const HISTORY_LIMIT = 100;

export const MindMapEditor = forwardRef<MindMapEditorHandle, Props>(function MindMapEditor(
  { markdown, title, onChange, onTitleChange, palette },
  ref,
) {
  const { token } = antdTheme.useToken();

  const [root, setRoot] = useState<MindNode>(() => parseMindMap(markdown, title).root);
  const [selectedId, setSelectedId] = useState<string>(() => root.id);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [sizes, setSizes] = useState<Map<string, Size>>(() => new Map());
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  /** 正在改文字的节点；isNew = 刚新建的节点，Esc 取消时连节点一起撤掉 */
  const [editing, setEditing] = useState<{ id: string; draft: string; isNew: boolean } | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const nodeEls = useRef(new Map<string, HTMLDivElement>());
  const undoStack = useRef<Snapshot[]>([]);
  const redoStack = useRef<Snapshot[]>([]);
  /** 最后一次写回的 Markdown：父组件把它原样传回来时不重新解析（否则 id 全换、选中和折叠丢失） */
  const lastEmitted = useRef<string>(markdown);
  const emitTimer = useRef<number | null>(null);
  const pendingEmit = useRef<string | null>(null);
  const fittedRef = useRef(false);
  const rootRef = useRef(root);
  rootRef.current = root;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  /**
   * 编辑态的同步副本：Enter 确认后输入框失焦还会再触发一次 onBlur → commit，
   * 闭包里的 editing 还是旧值会重复提交。确认 / 取消时先把这里清空，第二次进来直接返回。
   */
  const editingRef = useRef(editing);
  editingRef.current = editing;

  // ─── 写回 ───────────────────────────────────

  const flushEmit = useCallback(() => {
    if (emitTimer.current != null) {
      window.clearTimeout(emitTimer.current);
      emitTimer.current = null;
    }
    if (pendingEmit.current != null) {
      const md = pendingEmit.current;
      pendingEmit.current = null;
      onChange(md);
    }
  }, [onChange]);

  const scheduleEmit = useCallback(
    (next: MindNode) => {
      const md = serializeMindMap(next);
      lastEmitted.current = md;
      pendingEmit.current = md;
      if (emitTimer.current != null) window.clearTimeout(emitTimer.current);
      emitTimer.current = window.setTimeout(flushEmit, EMIT_DELAY);
    },
    [flushEmit],
  );

  // 卸载（关闭导图 / 切笔记）前把没写回的改动交出去
  const flushRef = useRef(flushEmit);
  flushRef.current = flushEmit;
  useEffect(() => () => flushRef.current(), []);

  // 外部改了正文（在编辑器里打字、同步拉下来）→ 重新解析；自己写回的回声跳过
  useEffect(() => {
    if (markdown === lastEmitted.current) return;
    lastEmitted.current = markdown;
    const next = parseMindMap(markdown, rootRef.current.text).root;
    undoStack.current = [];
    redoStack.current = [];
    setEditing(null);
    setRoot(next);
    setSelectedId(next.id);
  }, [markdown]);

  // 标题在别处改了 → 同步中心主题（正在改中心主题时不打断）
  useEffect(() => {
    setRoot((r) => (r.text === title ? r : { ...r, text: title }));
  }, [title]);

  /** 应用一次编辑：记撤销、换树、选中、写回 */
  const apply = useCallback(
    (next: MindNode, selectId: string) => {
      undoStack.current.push({ root: cloneTree(rootRef.current), selectId: selectedIdRef.current });
      if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
      redoStack.current = [];
      setRoot(next);
      setSelectedId(selectId);
      scheduleEmit(next);
    },
    [scheduleEmit],
  );

  function restore(from: Snapshot[], to: Snapshot[]) {
    const snap = from.pop();
    if (!snap) return;
    to.push({ root: cloneTree(rootRef.current), selectId: selectedIdRef.current });
    setRoot(snap.root);
    setSelectedId(locate(snap.root, snap.selectId) ? snap.selectId : snap.root.id);
    scheduleEmit(snap.root);
    if (snap.root.text !== rootRef.current.text) onTitleChange?.(snap.root.text);
  }

  // ─── 布局与测量 ─────────────────────────────

  const layout = useMemo(
    () => layoutMindMap(root, (id) => sizes.get(id), collapsed, DEFAULT_LAYOUT),
    [root, sizes, collapsed],
  );
  const placedById = useMemo(() => new Map(layout.nodes.map((p) => [p.id, p])), [layout]);

  // 绘制前量尺寸：有变化就更新 sizes 触发重排（同一帧内完成，用户看不到先错位再归位）
  useLayoutEffect(() => {
    let changed = false;
    const next = new Map(sizes);
    for (const [id, el] of nodeEls.current) {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const old = sizes.get(id);
      if (!old || old.w !== w || old.h !== h) {
        next.set(id, { w, h });
        changed = true;
      }
    }
    if (changed) setSizes(next);
  });

  const fit = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const { minX, minY, maxX, maxY } = layout.bounds;
    const pad = 40;
    const bw = maxX - minX + pad * 2;
    const bh = maxY - minY + pad * 2;
    const scale = Math.max(MIN_SCALE, Math.min(1, el.clientWidth / bw, el.clientHeight / bh));
    setView({
      scale,
      x: el.clientWidth / 2 - ((minX + maxX) / 2) * scale,
      y: el.clientHeight / 2 - ((minY + maxY) / 2) * scale,
    });
  }, [layout]);

  // 首次量完尺寸后适应一次窗口。等两帧：字体晚到会让第一次量到的尺寸还要变一次，
  // 按旧尺寸适应会整体偏一截
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useEffect(() => {
    if (fittedRef.current || sizes.size === 0) return;
    fittedRef.current = true;
    containerRef.current?.focus();
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => fitRef.current());
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [sizes]);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const el = containerRef.current;
    if (!el) return;
    const px = cx ?? el.clientWidth / 2;
    const py = cy ?? el.clientHeight / 2;
    setView((v) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
      const k = scale / v.scale;
      return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  }, []);

  useImperativeHandle(ref, () => ({ zoomBy: (f) => zoomAt(f), fit }), [zoomAt, fit]);

  // 键盘移动选中后，选中节点跑出可视区就平移过去
  useEffect(() => {
    const el = containerRef.current;
    const p = placedById.get(selectedId);
    if (!el || !p || !fittedRef.current) return;
    const margin = 24;
    const left = p.x * view.scale + view.x;
    const top = p.y * view.scale + view.y;
    const right = left + p.w * view.scale;
    const bottom = top + p.h * view.scale;
    let dx = 0;
    let dy = 0;
    if (left < margin) dx = margin - left;
    else if (right > el.clientWidth - margin) dx = el.clientWidth - margin - right;
    if (top < margin) dy = margin - top;
    else if (bottom > el.clientHeight - margin) dy = el.clientHeight - margin - bottom;
    if (dx || dy) setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    // 只在选中变化时跟随，不在每次平移后再拉回
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, placedById]);

  // ─── 编辑 ───────────────────────────────────

  function startEdit(id: string, isNew = false) {
    const loc = locate(rootRef.current, id);
    if (!loc) return;
    if (!loc.parent && !onTitleChange) return;
    setSelectedId(id);
    setEditing({ id, draft: loc.node.text, isNew });
  }

  function commitEdit() {
    const cur = editingRef.current;
    if (!cur) return;
    editingRef.current = null;
    const { id, draft, isNew } = cur;
    setEditing(null);
    containerRef.current?.focus();
    const loc = locate(rootRef.current, id);
    if (!loc) return;
    const text = draft.trim();
    // 新建节点什么都没填 = 不要它（和 Esc 一样），免得留下空的「-」
    if (isNew && !text && loc.parent) {
      restore(undoStack.current, []);
      return;
    }
    if (!loc.parent) {
      // 中心主题 = 笔记标题，空标题不改
      if (text && text !== loc.node.text) {
        apply({ ...rootRef.current, text }, id);
        onTitleChange?.(text);
      }
      return;
    }
    if (text === loc.node.text) return;
    // 新建节点时 addChild 已经记过一次撤销，这里覆盖文字不再单独记，撤销一步就回到新建前
    if (isNew) {
      const next = setText(rootRef.current, id, text);
      setRoot(next);
      scheduleEmit(next);
    } else {
      apply(setText(rootRef.current, id, text), id);
    }
  }

  function cancelEdit() {
    const cur = editingRef.current;
    if (!cur) return;
    editingRef.current = null;
    const { id, isNew } = cur;
    setEditing(null);
    containerRef.current?.focus();
    // 刚新建就取消 = 不要这个节点：撤销新建那一步
    if (isNew && locate(rootRef.current, id)) restore(undoStack.current, []);
  }

  function run(result: EditResult | null, editNew = false) {
    if (!result) return;
    apply(result.root, result.selectId);
    if (editNew) setEditing({ id: result.selectId, draft: "", isNew: true });
  }

  function toggleCollapse(id: string) {
    const loc = locate(rootRef.current, id);
    if (!loc || !loc.node.children.length) return;
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** 展开某节点的所有祖先（新建 / 移动到折叠节点里时要让它看得见） */
  function revealAncestors(next: MindNode, id: string) {
    setCollapsed((s) => {
      if (!s.size) return s;
      const out = new Set(s);
      let cur = locate(next, id);
      while (cur && cur.parent) {
        out.delete(cur.parent.id);
        cur = locate(next, cur.parent.id);
      }
      return out;
    });
  }

  // ─── 键盘 ───────────────────────────────────

  /** 方向键导航：左右按节点所在侧决定是「往外（子节点）」还是「往里（父节点）」 */
  function navigate(key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight") {
    const loc = locate(root, selectedId);
    const placed = placedById.get(selectedId);
    if (!loc || !placed) return;
    if (key === "ArrowUp" || key === "ArrowDown") {
      if (!loc.parent) return;
      // 同侧可见同级里按纵坐标找上 / 下一个
      const sibs = loc.parent.children
        .map((c) => placedById.get(c.id))
        .filter((p): p is PlacedNode => !!p && p.side === placed.side)
        .sort((a, b) => a.y - b.y);
      const i = sibs.findIndex((p) => p.id === selectedId);
      const target = sibs[key === "ArrowUp" ? i - 1 : i + 1];
      if (target) setSelectedId(target.id);
      return;
    }
    const outward = (placed.side === "left" && key === "ArrowLeft") || (placed.side !== "left" && key === "ArrowRight");
    if (placed.side === "center") {
      const want = key === "ArrowRight" ? "right" : "left";
      const first = layout.nodes.find((p) => p.depth === 1 && p.side === want);
      if (first) setSelectedId(first.id);
      return;
    }
    if (outward) {
      if (!loc.node.children.length) return;
      if (collapsed.has(loc.node.id)) toggleCollapse(loc.node.id);
      // 选离当前节点纵向最近的子节点
      const kids = loc.node.children.map((c) => placedById.get(c.id)).filter((p): p is PlacedNode => !!p);
      const best = kids.sort((a, b) => Math.abs(a.y - placed.y) - Math.abs(b.y - placed.y))[0];
      setSelectedId(best ? best.id : loc.node.children[0].id);
    } else if (loc.parent) {
      setSelectedId(loc.parent.id);
    }
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (editing) return; // 输入框自己处理
    const mod = e.ctrlKey || e.metaKey;
    const placed = placedById.get(selectedId);
    const key = e.key;
    let handled = true;

    if (mod && !e.shiftKey && key.toLowerCase() === "z") restore(undoStack.current, redoStack.current);
    else if (mod && (key.toLowerCase() === "y" || (e.shiftKey && key.toLowerCase() === "z")))
      restore(redoStack.current, undoStack.current);
    else if (key === "Tab") {
      const r = addChild(root, selectedId);
      if (r) {
        setCollapsed((s) => {
          if (!s.has(selectedId)) return s;
          const n = new Set(s);
          n.delete(selectedId);
          return n;
        });
      }
      run(r, true);
    } else if (key === "Enter") run(addSibling(root, selectedId), true);
    else if (key === "Delete" || key === "Backspace") run(removeNode(root, selectedId));
    else if (key === "F2") startEdit(selectedId);
    else if (key === " ") toggleCollapse(selectedId);
    else if (e.altKey && (key === "ArrowUp" || key === "ArrowDown"))
      run(moveAmongSiblings(root, selectedId, key === "ArrowUp" ? -1 : 1));
    else if (e.altKey && (key === "ArrowLeft" || key === "ArrowRight")) {
      // 「往外」= 降级（变成上一个同级的子节点），左侧分支方向相反
      const outward = (placed?.side === "left") === (key === "ArrowLeft");
      const r = outward ? indent(root, selectedId) : outdent(root, selectedId);
      if (r) revealAncestors(r.root, r.selectId);
      run(r);
    } else if (key.startsWith("Arrow")) navigate(key as "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight");
    else handled = false;

    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // ─── 平移 / 缩放 ───────────────────────────

  const panRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    containerRef.current?.focus();
    if (e.button !== 0) return;
    // 只有点在空白处才平移；点在节点上由节点自己处理选中
    if ((e.target as HTMLElement).closest("[data-mm-node]")) return;
    if (editing) commitEdit();
    panRef.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const p = panRef.current;
    if (!p) return;
    setView((v) => ({ ...v, x: p.vx + e.clientX - p.x, y: p.vy + e.clientY - p.y }));
  }

  function onPointerUp() {
    panRef.current = null;
  }

  // wheel 要非 passive 才能 preventDefault（React 的 onWheel 是 passive）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // ─── 渲染 ───────────────────────────────────

  const colorOf = (branch: number) => (branch < 0 ? token.colorPrimary : palette[branch % palette.length]);

  const nodesById = useMemo(() => {
    const m = new Map<string, MindNode>();
    const walk = (n: MindNode) => {
      m.set(n.id, n);
      n.children.forEach(walk);
    };
    walk(root);
    return m;
  }, [root]);

  // 卸载了的节点从测量表里清掉，避免下次同 id（不会发生）或内存堆积
  useEffect(() => {
    for (const id of nodeEls.current.keys()) if (!placedById.has(id)) nodeEls.current.delete(id);
  }, [placedById]);

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="kb-mm-editor"
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        outline: "none",
        cursor: panRef.current ? "grabbing" : "default",
        background: token.colorBgContainer,
        userSelect: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          transformOrigin: "0 0",
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
        }}
      >
        <svg style={{ position: "absolute", left: 0, top: 0, width: 1, height: 1, overflow: "visible" }}>
          {layout.edges.map((e) => {
            const dx = (e.x2 - e.x1) / 2;
            const to = placedById.get(e.to);
            return (
              <path
                key={e.to}
                d={`M${e.x1},${e.y1} C${e.x1 + dx},${e.y1} ${e.x2 - dx},${e.y2} ${e.x2},${e.y2}`}
                fill="none"
                stroke={colorOf(e.branch)}
                strokeWidth={to && to.depth === 1 ? 2.5 : 1.5}
                strokeLinecap="round"
              />
            );
          })}
        </svg>

        {layout.nodes.map((p) => {
          const n = nodesById.get(p.id);
          if (!n) return null;
          const isRoot = p.depth === 0;
          const selected = p.id === selectedId;
          const color = colorOf(p.branch);
          const isEditing = editing?.id === p.id;
          const hasKids = n.children.length > 0;
          const isCollapsed = collapsed.has(p.id);
          const measured = sizes.has(p.id);
          return (
            <div
              key={p.id}
              data-mm-node
              ref={(el) => {
                if (el) nodeEls.current.set(p.id, el);
                else nodeEls.current.delete(p.id);
              }}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                if (editing && editing.id !== p.id) commitEdit();
                setSelectedId(p.id);
              }}
              onDoubleClick={() => startEdit(p.id)}
              style={{
                position: "absolute",
                left: p.x,
                top: p.y,
                // 没量到尺寸前不显示，避免按默认尺寸排出来的一帧错位
                visibility: measured || isEditing ? "visible" : "hidden",
                // 画布层宽度为 0：不写 max-content 的话，越靠右的节点可用宽度越小，会被挤成一字一行
                width: "max-content",
                maxWidth: isRoot ? 320 : 240,
                padding: isRoot ? "8px 18px" : p.depth === 1 ? "5px 12px" : "3px 8px",
                borderRadius: isRoot ? 10 : 6,
                fontSize: isRoot ? 17 : p.depth === 1 ? 14 : 13,
                fontWeight: isRoot ? 600 : p.depth === 1 ? 500 : 400,
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                color: isRoot ? token.colorTextLightSolid : token.colorText,
                background: isRoot ? token.colorPrimary : p.depth === 1 ? token.colorBgContainer : "transparent",
                border: p.depth === 1 ? `2px solid ${color}` : "2px solid transparent",
                boxShadow: selected ? `0 0 0 2px ${token.colorBgContainer}, 0 0 0 4px ${token.colorPrimary}` : undefined,
                cursor: "default",
              }}
            >
              {isEditing ? (
                <AutoWidthInput
                  value={editing.draft}
                  placeholder={isRoot ? "中心主题" : "输入内容"}
                  onChange={(v) => setEditing((s) => (s ? { ...s, draft: v } : s))}
                  onCommit={commitEdit}
                  onCancel={cancelEdit}
                />
              ) : (
                <>
                  {n.kind.type === "item" && n.kind.task !== null && (
                    <input
                      type="checkbox"
                      checked={n.kind.task}
                      onPointerDown={(e) => e.stopPropagation()}
                      onChange={() => apply(toggleTask(root, p.id), p.id)}
                      style={{ marginRight: 6, verticalAlign: "-2px" }}
                    />
                  )}
                  {n.text ? (
                    renderInline(n.text)
                  ) : (
                    <span style={{ color: isRoot ? undefined : token.colorTextQuaternary }}>{isRoot ? "未命名" : "（空）"}</span>
                  )}
                </>
              )}

              {hasKids && !isRoot && (isCollapsed || selected) && (
                <button
                  type="button"
                  title={isCollapsed ? `展开（${n.children.length}）` : "折叠"}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => toggleCollapse(p.id)}
                  style={{
                    position: "absolute",
                    top: "50%",
                    [p.side === "left" ? "left" : "right"]: -22,
                    transform: "translateY(-50%)",
                    minWidth: 18,
                    height: 18,
                    padding: "0 4px",
                    borderRadius: 9,
                    border: `1px solid ${color}`,
                    background: token.colorBgContainer,
                    color,
                    fontSize: 11,
                    lineHeight: "16px",
                    cursor: "pointer",
                  }}
                >
                  {isCollapsed ? n.children.length : "−"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});

/**
 * 宽度跟着内容走的单行输入框：底下垫一个看不见的同内容 span 撑宽，输入框盖在上面。
 * Enter 确认 / Esc 取消；输入法组字中的 Enter 是选词，不当确认。
 */
function AutoWidthInput({
  value,
  placeholder,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  return (
    <span style={{ display: "inline-grid", minWidth: 40 }}>
      <span style={{ gridArea: "1 / 1", visibility: "hidden", whiteSpace: "pre" }}>{value || placeholder}</span>
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        style={{
          gridArea: "1 / 1",
          width: "100%",
          minWidth: 0,
          font: "inherit",
          color: "inherit",
          background: "transparent",
          border: "none",
          outline: "none",
          padding: 0,
        }}
      />
    </span>
  );
}
