/**
 * 笔记幻灯片演示模式（v1.12 引入）。
 *
 * 设计：
 * - 输入是 **markdown 字符串**（TiptapEditor onChange 给出的就是 markdown）
 * - 按 markdown 的水平分割线行（`---` / `***` / `___` 独占一行）作为页边界
 * - fixed 全屏黑底，每页用项目共用的 `MarkdownContent`（react-markdown + GFM）渲染
 * - ← / → 翻页（PageUp/PageDown 也支持）；Esc 退出
 * - 右下角页码 + 顶部小字操作提示
 * - 零原生依赖，复用项目已有的 markdown 渲染管线
 *
 * 历史：v1（commit c1f4852）用 DOMParser 找 `<hr>`，但 prop 实际是 markdown
 * 而非 HTML（TiptapEditor 的 onChange 给的是 storage.markdown.getMarkdown()），
 * DOMParser 永远只切出 1 张幻灯片（截图证实 "1 / 1"）。本次修复改为按 markdown
 * 文本切片 + 用 MarkdownContent 渲染。
 */
import { useEffect, useMemo, useState } from "react";
import { theme as antdTheme } from "antd";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import rehypeRaw from "rehype-raw";
import { MarkdownContent } from "@/components/ai/MarkdownContent";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 笔记 markdown 内容（与 editor.tsx 里 `content` 同源） */
  html: string;
  /** 笔记标题，仅用于左上角小字 */
  title: string;
}

/**
 * 把 markdown 按"水平分割线行"切片。
 *
 * CommonMark 规定：一行只含 3+ 个 `-` / `*` / `_`（可有前后空白）→ 渲染为 `<hr>`。
 * 我们按这个规则切（也是用户在笔记里写 `---` 想要的分页效果）。
 *
 * 边界：
 * - 代码块内（` ``` `…` ``` ` 之间）的 `---` 不算分页符（CommonMark 也不当 hr）
 * - 空 markdown → 单页占位
 * - 连续两条分割线 → 中间空页保留（让用户看到自己的笔记结构）
 */
function splitIntoSlides(md: string): string[] {
  if (!md || !md.trim()) return ["*（笔记为空）*"];

  const HR_LINE = /^[ \t]{0,3}(?:-[ \t]*){3,}[ \t]*$|^[ \t]{0,3}(?:\*[ \t]*){3,}[ \t]*$|^[ \t]{0,3}(?:_[ \t]*){3,}[ \t]*$/;
  const CODE_FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;

  const lines = md.split(/\r?\n/);
  const slides: string[] = [];
  let buffer: string[] = [];
  let inFence = false;
  let fenceMark = "";

  for (const line of lines) {
    // 围栏代码块状态机：开/关括号都不计入页边界判定
    const fenceMatch = line.match(CODE_FENCE);
    if (fenceMatch) {
      const mark = fenceMatch[1];
      if (!inFence) {
        inFence = true;
        fenceMark = mark[0]; // ` 或 ~
      } else if (mark[0] === fenceMark) {
        inFence = false;
        fenceMark = "";
      }
      buffer.push(line);
      continue;
    }

    if (!inFence && HR_LINE.test(line)) {
      slides.push(buffer.join("\n"));
      buffer = [];
      continue;
    }
    buffer.push(line);
  }
  slides.push(buffer.join("\n"));

  // 至少返回 1 页
  return slides.length === 0 ? [md] : slides;
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

        {/* 内容区：复用 .tiptap + .ai-markdown 样式（与 AI 回复同款 markdown 渲染），
            加大字号方便投屏。MarkdownContent 内部走 react-markdown + remark-gfm，
            原生支持表格 / 删除线 / 任务列表 / wiki link 文本（如需 wiki 跳转可后续补）。

            rehypeRaw：笔记里调过列宽的表格会被 TableWithMarkdown 序列化成**原始 HTML**
            （<table class="tiptap-table">…，见 TiptapEditor.tsx），同理 SafeLink 也是 <a>。
            react-markdown 默认不解析内嵌 HTML，会把标签当纯文本逐字显示（演示模式 bug）。
            这里局部启用 rehype-raw 让内嵌 HTML 正常渲染。仅对用户自己的笔记开启，
            不动全局 MarkdownContent 默认行为（AI 回复仍不解析 HTML，避免 XSS 面）。 */}
        <div
          className="tiptap ai-markdown slideshow-page"
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
        >
          {current.trim() ? (
            <MarkdownContent rehypePlugins={[rehypeRaw]}>
              {current}
            </MarkdownContent>
          ) : (
            <p style={{ color: "#888" }}>（空页）</p>
          )}
        </div>

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
