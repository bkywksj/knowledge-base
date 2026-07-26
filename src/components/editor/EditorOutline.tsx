import { useEffect, useMemo, useRef, useState } from "react";
import { theme as antdTheme } from "antd";
import { EyeOff, ListTree } from "lucide-react";
import { getHeadingNumberMap } from "./HeadingNumber";
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
 * 当前位置高亮：IntersectionObserver 监视每个 h1~h6 DOM，取"上次离开顶部"的
 * 那个高亮。比 onScroll + throttle 性能更好（浏览器原生 scrollspy）。
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

export function EditorOutline({ editor, scrollRoot, onHide }: Props) {
  const { token } = antdTheme.useToken();
  const guideLine = useAppStore((s) => s.editorGuideLine);
  const [items, setItems] = useState<OutlineItem[]>([]);
  const [activePos, setActivePos] = useState<number | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // IntersectionObserver: 当前可视的最靠上的标题 → 高亮
  useEffect(() => {
    if (items.length === 0) return;
    const root = scrollRoot ?? null;
    // 一组 entry 的视野状态记录在 Map 里；每次回调重算"当前激活项"
    const visibility = new Map<HTMLElement, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          visibility.set(e.target as HTMLElement, e.isIntersecting);
        }
        // 找出最靠前的"在视野内"标题；都不在视野时，找最后一个已滚出顶部的
        let activeEl: HTMLElement | null = null;
        let activeTop = Number.POSITIVE_INFINITY;
        for (const it of items) {
          if (!it.el) continue;
          if (visibility.get(it.el)) {
            const top = it.el.getBoundingClientRect().top;
            if (top < activeTop) {
              activeEl = it.el;
              activeTop = top;
            }
          }
        }
        if (!activeEl) {
          // 没在视野内：最后一个 boundingTop < rootTop 的（已经滚出顶部的最后一个）
          const rootTop = root ? root.getBoundingClientRect().top : 0;
          for (const it of items) {
            if (!it.el) continue;
            const top = it.el.getBoundingClientRect().top;
            if (top < rootTop + 8) {
              activeEl = it.el;
            }
          }
        }
        if (activeEl) {
          const found = items.find((it) => it.el === activeEl);
          setActivePos(found?.pos ?? null);
        }
      },
      {
        root,
        // 顶部 0、底部往上收 60% 的窗口：让"刚滑入屏幕"的标题立即点亮
        rootMargin: "0px 0px -60% 0px",
        threshold: [0, 1],
      },
    );
    for (const it of items) {
      if (it.el) observer.observe(it.el);
    }
    return () => observer.disconnect();
  }, [items, scrollRoot]);

  function handleJump(item: OutlineItem) {
    // 用显式 scrollTo 计算目标位置，不依赖 scrollIntoView 的"已可见就不滚"语义；
    // 同时要求 .editor-content-area 末尾有足够 padding-bottom（40vh）让最后
    // 几个标题也能被滚到顶部，否则 scrollTop 会被 clamp 到 max，看似"点了没反应"。
    if (item.el && scrollRoot) {
      // sticky 的 tiptap 工具栏会覆盖 editor-body 顶部一截；动态查询它的高度，
      // 把目标位置往下让，避免最后一个标题滚到顶后被工具栏盖住。
      const toolbar = scrollRoot.querySelector(".tiptap-toolbar") as HTMLElement | null;
      const toolbarH = toolbar ? toolbar.offsetHeight : 0;
      const containerRect = scrollRoot.getBoundingClientRect();
      const elRect = item.el.getBoundingClientRect();
      // 元素相对滚动容器顶部的距离 + 当前滚动 - 工具栏高 - 8px 呼吸
      const target =
        scrollRoot.scrollTop + (elRect.top - containerRect.top) - toolbarH - 8;
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
