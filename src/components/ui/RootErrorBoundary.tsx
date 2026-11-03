import { Component, type ReactNode } from "react";
import { error as logError } from "@tauri-apps/plugin-log";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 根错误边界 —— 刻意「零依赖 antd」，只用原生 HTML + inline style 渲染。
 *
 * Why: 既有 <ErrorBoundary> 位于 <ConfigProvider>/<AntdApp> 内部，一旦 antd 主题计算、
 *      ConfigProvider 自身或任意上层 Provider 在渲染期抛错，它在内层根本无法兜住 → 整页白屏。
 *      本组件包在最外层（ConfigProvider 之外），用不依赖任何 UI 库的纯 DOM 兜底页，保证
 *      「无论上层怎么崩，用户都能看到一个可读的错误页 + 重启入口」，而不是白屏 / 闪退。
 *
 * 同时把错误持久化到后端日志文件（tauri-plugin-log），方便「够不到用户机器」时远程取证。
 */
export class RootErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(err: Error, info: { componentStack?: string | null }) {
    // 落后端日志（失败也不能再抛，否则兜底自身崩溃）
    void logError(
      `[RootErrorBoundary] ${err.name}: ${err.message}\n${info?.componentStack ?? ""}`,
    ).catch(() => {});
    console.error("[RootErrorBoundary]", err, info?.componentStack);
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleCopy = () => {
    const { error } = this.state;
    const text = error
      ? `${error.name}: ${error.message}\n\n${error.stack ?? "(no stack)"}\nUA: ${navigator.userAgent}`
      : "未知错误";
    navigator.clipboard?.writeText(text).catch(() => {});
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "#1e1e1e",
          color: "#e6e6e6",
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
          zIndex: 999999,
          overflow: "auto",
        }}
      >
        <div style={{ maxWidth: 560, width: "100%" }}>
          <div style={{ fontSize: 40, lineHeight: 1, marginBottom: 12 }}>⚠️</div>
          <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>应用遇到问题</h1>
          <p style={{ margin: "0 0 16px", color: "#b0b0b0", fontSize: 13 }}>
            界面渲染出错。错误已记录到日志文件，你可以尝试重新加载；若反复出现，请复制错误信息发给开发者。
          </p>
          <pre
            style={{
              background: "#2a2a2a",
              border: "1px solid #3a3a3a",
              borderRadius: 6,
              padding: 12,
              fontSize: 12,
              lineHeight: 1.5,
              color: "#ff9c9c",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 200,
              overflow: "auto",
              margin: "0 0 16px",
            }}
          >
            {error.name}: {error.message}
          </pre>
          <div style={{ display: "flex", gap: 12 }}>
            <button
              type="button"
              onClick={this.handleReload}
              style={{
                padding: "8px 18px",
                fontSize: 14,
                border: "none",
                borderRadius: 6,
                background: "#7C63DC",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              重新加载
            </button>
            <button
              type="button"
              onClick={this.handleCopy}
              style={{
                padding: "8px 18px",
                fontSize: 14,
                border: "1px solid #4a4a4a",
                borderRadius: 6,
                background: "transparent",
                color: "#e6e6e6",
                cursor: "pointer",
              }}
            >
              复制错误信息
            </button>
          </div>
        </div>
      </div>
    );
  }
}
