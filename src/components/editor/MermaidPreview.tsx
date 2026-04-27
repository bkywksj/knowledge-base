/**
 * Mermaid 渲染组件 —— 把 mermaid 源码渲染成 SVG。
 *
 * - mermaid 包体积大（~600KB gzip），首次需要时才动态 import，并把 promise
 *   缓存到模块作用域，避免重复加载
 * - 主题跟随 themeCategory：暗色主题用 mermaid 内置 "dark"，其他用 "default"
 * - render 异常时显示错误而非崩溃 NodeView，源码仍可读
 * - securityLevel: "strict" 阻断标签里的 <script>，符合 Tauri WebView 安全模式
 */
import { useEffect, useState } from "react";
import { useAppStore } from "@/store";

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, code: string) => Promise<{ svg: string }>;
};

let mermaidPromise: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => m.default as MermaidApi);
  }
  return mermaidPromise;
}

let renderCounter = 0;

export function MermaidPreview({
  code,
  onClick,
}: {
  code: string;
  onClick?: () => void;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const themeCategory = useAppStore((s) => s.themeCategory);

  useEffect(() => {
    let cancelled = false;
    if (!code.trim()) {
      setSvg(null);
      setError(null);
      return;
    }
    (async () => {
      try {
        const mermaid = await loadMermaid();
        // 每次渲染前重设主题：用户切主题后下次渲染就能跟上
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: themeCategory === "dark" ? "dark" : "default",
          fontFamily: "inherit",
        });
        renderCounter += 1;
        const id = `mermaid-${Date.now()}-${renderCounter}`;
        const result = await mermaid.render(id, code);
        if (!cancelled) {
          setSvg(result.svg);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setSvg(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, themeCategory]);

  if (error) {
    return (
      <div
        className="mermaid-preview mermaid-preview-error"
        onClick={onClick}
        style={{
          padding: "12px 16px",
          border: "1px solid #ff7875",
          borderRadius: 6,
          background: "rgba(255,77,79,0.05)",
          cursor: onClick ? "pointer" : "default",
        }}
      >
        <div style={{ fontWeight: 600, color: "#cf1322", marginBottom: 4 }}>
          Mermaid 渲染失败（点击编辑源码）
        </div>
        <pre
          style={{
            fontSize: 12,
            opacity: 0.75,
            margin: 0,
            whiteSpace: "pre-wrap",
            fontFamily: "ui-monospace, monospace",
          }}
        >
          {error}
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div
        className="mermaid-preview mermaid-preview-loading"
        onClick={onClick}
        style={{
          padding: "20px",
          textAlign: "center",
          opacity: 0.6,
          fontSize: 12,
          cursor: onClick ? "pointer" : "default",
        }}
      >
        加载中…
      </div>
    );
  }

  return (
    <div
      className="mermaid-preview"
      onClick={onClick}
      // 渲染产物来自 mermaid 库（securityLevel: strict 已过滤 <script>），
      // 这里直接吐 SVG；mermaid 内部用了 dompurify
      dangerouslySetInnerHTML={{ __html: svg }}
      style={{
        padding: "12px 16px",
        textAlign: "center",
        cursor: onClick ? "pointer" : "default",
        overflow: "auto",
      }}
    />
  );
}
