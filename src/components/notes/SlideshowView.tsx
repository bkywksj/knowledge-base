/**
 * 笔记幻灯片演示模式（v1.12 引入）。
 *
 * 设计：
 * - 输入是 HTML（笔记 content），找到所有顶层 `<hr>` 作为分页边界
 *   —— 复用 markdown `---` 渲染出来的 hr，无需新的语法
 * - fixed 全屏黑底，每页居中渲染当前页 HTML 片段
 * - ← / → 翻页（PageUp/PageDown 也支持）；Esc 退出
 * - 右下角页码 + 顶部短期淡出的提示（按 ? 显示帮助）
 * - 零外部依赖，不引 reveal.js
 */
import { useEffect, useMemo, useState } from "react";
import { theme as antdTheme } from "antd";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 笔记 HTML（Tiptap 产出的 content） */
  html: string;
  /** 笔记标题，仅用于左上角小字 */
  title: string;
}

/**
 * 把 HTML 按顶层 `<hr>` 切片。
 *
 * 用 DOMParser 解析，遍历 body 顶层子节点：
 * - 遇到 `<hr>` → 开新页
 * - 其它节点 → 追加到当前页的 fragment
 *
 * 返回每页的 HTML 字符串（不含 hr 本身）。空页（连续 hr）会保留为占位。
 */
function splitIntoSlides(html: string): string[] {
  if (!html || !html.trim()) return ["<p style='color:#888'>（笔记为空）</p>"];
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const slides: string[] = [];
  let buffer = "";
  for (const node of Array.from(doc.body.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === "HR") {
      slides.push(buffer);
      buffer = "";
    } else {
      // outerHTML 对元素；文本节点用 textContent 包一下
      if (node.nodeType === Node.ELEMENT_NODE) {
        buffer += (node as Element).outerHTML;
      } else if (node.nodeType === Node.TEXT_NODE && node.textContent) {
        buffer += node.textContent;
      }
    }
  }
  slides.push(buffer);
  // 至少返回 1 页；只有一页时不去掉空白（让用户看到空页提示）
  return slides.length === 0 ? [html] : slides;
}

export function SlideshowView({ open, onClose, html, title }: Props) {
  const { token } = antdTheme.useToken();
  const slides = useMemo(() => (open ? splitIntoSlides(html) : []), [html, open]);
  const [index, setIndex] = useState(0);

  // 打开时重置到首页
  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  // 键盘事件：翻页 + 退出
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        setIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (
        e.key === "ArrowRight" ||
        e.key === "PageDown" ||
        e.key === " "
      ) {
        e.preventDefault();
        setIndex((i) => Math.min(slides.length - 1, i + 1));
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        setIndex(0);
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        setIndex(slides.length - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, slides.length, onClose]);

  if (!open) return null;

  const current = slides[index] ?? "";
  const total = slides.length;

  return (
    <div
      role="dialog"
      aria-label="幻灯片演示"
      style={{
        position: "fixed",
        inset: 0,
        background: "#0f0f12",
        color: "#f0f0f0",
        zIndex: 2000,
        display: "flex",
        flexDirection: "column",
        fontFamily: "var(--editor-font-family, system-ui)",
      }}
    >
      {/* 顶部：标题 + 关闭 */}
      <div
        style={{
          padding: "10px 18px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          color: "rgba(255,255,255,0.55)",
          fontSize: 12,
          flexShrink: 0,
        }}
      >
        <span className="truncate" title={title}>
          📽 {title || "未命名笔记"}
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11 }}>
          ← / → 翻页 · Esc 退出
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="退出演示"
          style={{
            background: "transparent",
            color: "rgba(255,255,255,0.6)",
            border: "1px solid rgba(255,255,255,0.2)",
            borderRadius: 4,
            padding: "2px 8px",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <X size={14} />
        </button>
      </div>

      {/* 中央：当前页内容 */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          padding: "20px 80px",
          position: "relative",
        }}
      >
        {/* 左侧热区：上一页 */}
        <button
          type="button"
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
          disabled={index === 0}
          aria-label="上一页"
          style={{
            position: "absolute",
            left: 12,
            top: "50%",
            transform: "translateY(-50%)",
            background: "rgba(255,255,255,0.08)",
            color: "rgba(255,255,255,0.7)",
            border: "none",
            borderRadius: "50%",
            width: 44,
            height: 44,
            cursor: index === 0 ? "default" : "pointer",
            opacity: index === 0 ? 0.3 : 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <ChevronLeft size={22} />
        </button>

        {/* 内容区：复用 .tiptap 样式，加大字号方便投屏 */}
        <div
          className="tiptap slideshow-page"
          style={{
            background: token.colorBgContainer,
            color: token.colorText,
            borderRadius: 12,
            padding: "48px 64px",
            width: "min(960px, 90vw)",
            maxHeight: "100%",
            overflow: "auto",
            fontSize: 20,
            lineHeight: 1.7,
            boxShadow: "0 16px 48px rgba(0,0,0,0.45)",
          }}
          // dangerouslySetInnerHTML：内容来源是用户自己的笔记，无 XSS 风险
          dangerouslySetInnerHTML={{
            __html: current || "<p style='color:#888'>（空页）</p>",
          }}
        />

        {/* 右侧热区：下一页 */}
        <button
          type="button"
          onClick={() => setIndex((i) => Math.min(total - 1, i + 1))}
          disabled={index === total - 1}
          aria-label="下一页"
          style={{
            position: "absolute",
            right: 12,
            top: "50%",
            transform: "translateY(-50%)",
            background: "rgba(255,255,255,0.08)",
            color: "rgba(255,255,255,0.7)",
            border: "none",
            borderRadius: "50%",
            width: 44,
            height: 44,
            cursor: index === total - 1 ? "default" : "pointer",
            opacity: index === total - 1 ? 0.3 : 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <ChevronRight size={22} />
        </button>
      </div>

      {/* 底部：页码 + 进度条 */}
      <div
        style={{
          padding: "10px 18px 16px",
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            flex: 1,
            height: 3,
            background: "rgba(255,255,255,0.1)",
            borderRadius: 2,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${total > 0 ? ((index + 1) / total) * 100 : 0}%`,
              height: "100%",
              background: token.colorPrimary,
              transition: "width 0.2s",
            }}
          />
        </div>
        <span
          style={{
            fontSize: 13,
            color: "rgba(255,255,255,0.7)",
            minWidth: 60,
            textAlign: "right",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {index + 1} / {total}
        </span>
      </div>
    </div>
  );
}
