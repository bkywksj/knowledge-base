import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { theme as antdTheme } from "antd";
import { EyeOff, ListTree } from "lucide-react";
import { getHeadingNumberMap } from "./HeadingNumber";
import { pickActiveIndex, type OutlineProbe } from "@/lib/outlineScrollSpy";
import { useAppStore } from "@/store";

/**
 * EditorOutline —— 笔记编辑页右侧大纲面板。
 *
 * 数据来源：订阅 Tiptap editor 的 `transaction` 事件，全量遍历 doc 收集所有
 * heading 节点。300ms debounce 后重算一次条目（普通笔记 < 1ms 完成）。
 *
 * 跳转：用 ProseMirror node `pos` 而非文本匹配，同名标题不会跳错。
 *   `editor.chain().focus().setTextSelection(pos+1).scrollIntoView().run()`
 *
 * 当前位置高亮（scrollspy）：判定线取 sticky 工具栏下沿（工具栏 flex-wrap 会随窗宽
 * 换行，高度不是常量，用 ResizeObserver 实测），取"最后一个已越过判定线"的标题。
 *   历史坑：旧实现用 IntersectionObserver + "相交项里 top 最小的"，而 rootMargin
 *   顶部为 0 —— 躲在工具栏底下（肉眼已看不见）的上一个标题 top 更小，会抢走高亮。
 *   于是正文里两个标题挨得近（间距 < 工具栏高度）时，点击这一条后高亮立刻被判回
 *   上一条，表现就是"这一条点不动"。
 *
 * 自动隐藏：headings.length < 2 整面板隐藏（短笔记不打扰）。可见性切换由父
 * 组件控制（store.outlineVisible），本组件只看自身有没有数据。
 */

interface OutlineItem {
  pos: number;
  level: number;
  text: string;
  /**
   * 正文里显示的自动编号（"1.2.3" / "（一）"）；null = 该标题没有编号。
   * 与正文共用 HeadingNumber 插件算出的同一份数据，不会出现"正文有编号大纲没有"。
   */
  label: string | null;
  /** 用于 IntersectionObserver 配对：editor.view.nodeDOM(pos) 拿到的 HTMLElement */
  el: HTMLElement | null;
}

interface Props {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor: any | null;
  /** 滚动容器（即 .editor-body）。IntersectionObserver 的 root */
  scrollRoot?: HTMLElement | null;
  /** 点击右上角小眼睛 → 隐藏大纲（hover 时才出现，避免常态视觉噪声） */
  onHide?: () => void;
}

/** 跳转落点 / scrollspy 判定线在工具栏下沿再留的呼吸距离（两处必须同源，否则判定与落点错位） */
const TOP_BREATH = 8;
/** 点击跳转后锁住 scrollspy 的时长：覆盖 behavior:"smooth" 的动画（一般 300~500ms） */
const JUMP_LOCK_MS = 700;

/** 实测 sticky 工具栏高度（flex-wrap 换行后不是常量），拿不到就按 0 算 */
function measureToolbar(root: HTMLElement | null): number {
  if (!root) return 0;
  const toolbar = root.querySelector(".tiptap-toolbar") as HTMLElement | null;
  return toolbar ? toolbar.offsetHeight : 0;
}

export function EditorOutline({ editor, scrollRoot, onHide }: Props) {
  const { token } = antdTheme.useToken();
  const guideLine = useAppStore((s) => s.editorGuideLine);
  const [items, setItems] = useState<OutlineItem[]>([]);
  const [activePos, setActivePos] = useState<number | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** sticky 工具栏实测高度；scrollspy 判定线 = 容器顶 + 它 + TOP_BREATH */
  const [toolbarH, setToolbarH] = useState(0);
  /** 跳转动画期间置 true：此间 scrollspy 让位于点击结果，避免高亮被判回上一条 */
  const jumpLockedRef = useRef(false);
  const jumpLockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 当前已写入 .editor-content-area 的尾部留白，用于下次计算时扣除，防止累积膨胀 */
  const tailSpaceRef = useRef(0);

  /** 点击跳转起手：锁住 scrollspy，锁解除时不回算，高亮保持点击结果直到用户自己滚动 */
  const lockScrollSpy = useCallback(() => {
    jumpLockedRef.current = true;
    if (jumpLockTimerRef.current) clearTimeout(jumpLockTimerRef.current);
    jumpLockTimerRef.current = setTimeout(() => {
      jumpLockedRef.current = false;
      jumpLockTimerRef.current = null;
    }, JUMP_LOCK_MS);
  }, []);

  useEffect(
    () => () => {
      if (jumpLockTimerRef.current) clearTimeout(jumpLockTimerRef.current);
    },
    [],
  );

  // 收集 doc 里所有 heading
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const collect = useMemo(() => (ed: any): OutlineItem[] => {
    const list: OutlineItem[] = [];
    // 正文编号表（HeadingNumber 插件算好的）；编号关闭时是空表，大纲自然也不显示编号
    const byPos = getHeadingNumberMap(ed.state);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ed.state.doc.descendants((node: any, pos: number) => {
      if (node.type.name === "heading") {
        list.push({
          pos,
          level: node.attrs.level ?? 1,
          text: node.textContent || "(无标题)",
          label: byPos.get(pos) ?? null,
          el: null, // 后面在 useEffect 里补
        });
        return false; // 不下钻 heading 内部
      }
      return true;
    });
    return list;
  }, []);

  // 订阅 editor 变化
  useEffect(() => {
    if (!editor) {
      setItems([]);
      return;
    }

    const recompute = () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        const next = collect(editor);
        // 配对 DOM 节点
        for (const it of next) {
          try {
            const dom = editor.view.nodeDOM(it.pos) as HTMLElement | null;
            it.el = dom ?? null;
          } catch {
            it.el = null;
          }
        }
        setItems(next);
      }, 300);
    };

    // 初始 + 后续 transaction 都触发
    recompute();
    editor.on("transaction", recompute);

    return () => {
      editor.off("transaction", recompute);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [editor, collect]);

  // 工具栏高度实测：flex-wrap 使它随窗宽换行，高度会变；不跟着变的话判定线偏移，
  // 又会退回"点了不高亮"。editor 就绪后工具栏才挂载，故一并作为依赖重查。
  useEffect(() => {
    if (!scrollRoot) {
      setToolbarH(0);
      return;
    }
    const toolbar = scrollRoot.querySelector(".tiptap-toolbar") as HTMLElement | null;
    if (!toolbar) {
      setToolbarH(0);
      return;
    }
    const sync = () => setToolbarH(toolbar.offsetHeight);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(toolbar);
    return () => ro.disconnect();
  }, [scrollRoot, editor]);

  // scrollspy：取"最后一个已越过判定线（工具栏下沿）"的标题 → 高亮。
  // 用 scroll + rAF 节流全量重算，而不是 IntersectionObserver：判定线随工具栏高度浮动，
  // IO 的 rootMargin 是创建时固定的静态值，且"是否相交"表达不了"谁在判定线之上"。
  useEffect(() => {
    if (items.length === 0 || !scrollRoot) return;
    const root = scrollRoot;

    const recalc = () => {
      if (jumpLockedRef.current) return; // 跳转动画期间以点击结果为准
      const rootTop = root.getBoundingClientRect().top;
      const probes: OutlineProbe[] = items.map((it) => {
        if (!it.el) return { top: null };
        const rect = it.el.getBoundingClientRect();
        // 折叠隐藏 / 已脱离文档的节点 rect 全 0，当成缺席（否则 top=0 会假装"已越过判定线"）
        if (rect.height === 0 && rect.top === 0) return { top: null };
        return { top: rect.top };
      });
      // 内容不足一屏（没有滚动条）时不算"滚到底"，否则会一直死盯最后一条
      const scrollable = root.scrollHeight > root.clientHeight + 4;
      const idx = pickActiveIndex(probes, {
        lineY: rootTop + toolbarH + TOP_BREATH + 4,
        bottomY: rootTop + root.clientHeight,
        atBottom:
          scrollable && root.scrollTop + root.clientHeight >= root.scrollHeight - 2,
      });
      setActivePos(idx >= 0 ? items[idx].pos : null);
    };

    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        recalc();
      });
    };

    recalc();
    root.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      root.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [items, scrollRoot, toolbarH]);

  // 尾部留白：最后一个标题之后的正文若不足一屏，scrollTop 会被 clamp 到 max，
  // 这条标题永远滚不到判定线 —— 点了"纹丝不动"。按缺口精确补齐（不够才补、补多少算多少），
  // 比静态 padding-bottom: 40vh 克制：正文够长时一点不补，不牺牲视觉紧凑。
  useEffect(() => {
    const root = scrollRoot;
    if (!root) return;
    const area = root.querySelector(".editor-content-area") as HTMLElement | null;
    if (!area) return;

    const apply = (px: number) => {
      const next = Math.round(px);
      if (Math.abs(next - tailSpaceRef.current) < 1) return;
      tailSpaceRef.current = next;
      area.style.setProperty("--outline-tail-space", `${next}px`);
    };

    const recalcTail = () => {
      let last: OutlineItem | null = null;
      for (const it of items) if (it.el) last = it;
      if (!last || !last.el) {
        apply(0);
        return;
      }
      // 扣掉已生效的留白，才是"真实内容尾巴"，否则每轮把自己算进去会无限膨胀
      const tail =
        area.getBoundingClientRect().bottom -
        last.el.getBoundingClientRect().top -
        tailSpaceRef.current;
      apply(Math.max(0, root.clientHeight - (toolbarH + TOP_BREATH) - tail));
    };

    recalcTail();
    // 窗口/分栏改变容器高度 → 缺口大小跟着变
    const ro = new ResizeObserver(recalcTail);
    ro.observe(root);
    return () => ro.disconnect();
  }, [items, scrollRoot, toolbarH]);

  // 卸载 / 换容器时收回留白，避免关掉大纲后正文底部白挂一屏
  useEffect(() => {
    const root = scrollRoot;
    return () => {
      const area = root?.querySelector(".editor-content-area") as HTMLElement | null;
      area?.style.removeProperty("--outline-tail-space");
      tailSpaceRef.current = 0;
    };
  }, [scrollRoot]);

  function handleJump(item: OutlineItem) {
    // 点击即高亮，不等 scrollspy 回算：目标标题停在工具栏下沿时，上一个标题可能还躲在
    // 工具栏底下，回算会把高亮判回上一条 —— 表现就是"这一条点不动"。锁住动画这一段。
    setActivePos(item.pos);
    lockScrollSpy();

    // 用显式 scrollTo 计算目标位置，不依赖 scrollIntoView 的"已可见就不滚"语义；
    // 末尾标题滚不到顶的问题由上面的尾部留白（--outline-tail-space）补齐。
    if (item.el && scrollRoot) {
      // sticky 的 tiptap 工具栏会覆盖 editor-body 顶部一截；现查一次实际高度（与
      // scrollspy 判定线同源），把目标位置往下让，避免标题滚到顶后被工具栏盖住。
      const containerRect = scrollRoot.getBoundingClientRect();
      const elRect = item.el.getBoundingClientRect();
      // 元素相对滚动容器顶部的距离 + 当前滚动 - 工具栏高 - 呼吸距离
      const target =
        scrollRoot.scrollTop +
        (elRect.top - containerRect.top) -
        measureToolbar(scrollRoot) -
        TOP_BREATH;
      scrollRoot.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
      return;
    }
    // 兜底：scrollRoot 缺失（极少见）退回 DOM scrollIntoView
    if (item.el) {
      item.el.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    // 二级兜底：DOM 配对失败 → PM 链式命令
    if (editor) {
      editor
        .chain()
        .focus()
        .setTextSelection(item.pos + 1)
        .scrollIntoView()
        .run();
    }
  }

  // 标题数 < 2：内容不足以做大纲，整体隐身
  if (items.length < 2) {
    return (
      <div
        className="editor-outline editor-outline--empty"
        style={{ color: token.colorTextQuaternary }}
      >
        <div className="editor-outline__header">
          <ListTree size={13} />
          <span>大纲</span>
          {onHide && (
            <button
              type="button"
              className="editor-outline__hide-btn"
              onClick={onHide}
              title="隐藏大纲"
              aria-label="隐藏大纲"
              style={{ marginLeft: "auto", color: token.colorTextQuaternary }}
            >
              <EyeOff size={13} />
            </button>
          )}
        </div>
        <div className="editor-outline__hint">
          标题不足，添加 H1~H6 即可看到大纲
        </div>
      </div>
    );
  }

  return (
    <div className="editor-outline">
      <div
        className="editor-outline__header"
        style={{ color: token.colorTextSecondary }}
      >
        <ListTree size={13} />
        <span>大纲</span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 11,
            color: token.colorTextQuaternary,
          }}
        >
          {items.length}
        </span>
        {onHide && (
          <button
            type="button"
            className="editor-outline__hide-btn"
            onClick={onHide}
            title="隐藏大纲"
            aria-label="隐藏大纲"
            style={{ color: token.colorTextQuaternary }}
          >
            <EyeOff size={13} />
          </button>
        )}
      </div>
      <ul className="editor-outline__list">
        {items.map((it) => {
          const isActive = activePos === it.pos;
          return (
            <li
              key={it.pos}
              className="editor-outline__item"
              data-active={isActive || undefined}
              style={{
                paddingLeft: 8,
                // 缩进改用 marginLeft，把左边框让出来当层级引线：同级条目连续排列时
                // 这些 1px 边框会连成一条竖线（Obsidian 同款）。关引线时用透明边框占位，
                // 保证开/关状态下条目左边界不跳动。
                marginLeft: Math.max(0, it.level - 1) * 12,
                borderLeft:
                  it.level > 1
                    ? `1px solid ${guideLine ? token.colorBorderSecondary : "transparent"}`
                    : undefined,
                color: isActive ? token.colorPrimary : token.colorTextSecondary,
                fontWeight: isActive ? 600 : 400,
                background: isActive ? `${token.colorPrimary}14` : "transparent",
              }}
              onClick={() => handleJump(it)}
              title={it.label ? `${it.label} ${it.text}` : it.text}
            >
              {it.label && <span className="editor-outline__num">{it.label}</span>}
              {it.text || "(无标题)"}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
