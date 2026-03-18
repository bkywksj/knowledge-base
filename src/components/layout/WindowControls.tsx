import { useEffect, useState, useCallback, useRef } from "react";
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
import { Minus, Square, Copy, X } from "lucide-react";
import { theme as antdTheme } from "antd";

function getAppWindow(): Window | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const { token } = antdTheme.useToken();
  const windowRef = useRef<Window | null>(getAppWindow());

  useEffect(() => {
    const win = windowRef.current;
    if (!win) return;

    win.isMaximized().then(setIsMaximized);

    const unlisten = win.onResized(async () => {
      const maximized = await win.isMaximized();
      setIsMaximized(maximized);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const handleMinimize = useCallback(() => {
    windowRef.current?.minimize();
  }, []);

  const handleToggleMaximize = useCallback(() => {
    windowRef.current?.toggleMaximize();
  }, []);

  const handleClose = useCallback(() => {
    windowRef.current?.close();
  }, []);

  function getButtonStyle(id: string): React.CSSProperties {
    const isHovered = hovered === id;
    const isClose = id === "close";

    if (isHovered && isClose) {
      return { backgroundColor: "#e81123", color: "#fff" };
    }
    if (isHovered) {
      return { backgroundColor: token.colorFillSecondary };
    }
    return {};
  }

  const baseStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 36,
    height: 30,
    border: "none",
    borderRadius: 6,
    background: "transparent",
    color: token.colorTextSecondary,
    cursor: "pointer",
    transition: "all 0.15s ease",
    outline: "none",
    padding: 0,
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        height: 48,
        paddingRight: 8,
        paddingLeft: 4,
      }}
    >
      <button
        style={{ ...baseStyle, ...getButtonStyle("min") }}
        onMouseEnter={() => setHovered("min")}
        onMouseLeave={() => setHovered(null)}
        onClick={handleMinimize}
        title="最小化"
      >
        <Minus size={15} strokeWidth={1.5} />
      </button>
      <button
        style={{ ...baseStyle, ...getButtonStyle("max") }}
        onMouseEnter={() => setHovered("max")}
        onMouseLeave={() => setHovered(null)}
        onClick={handleToggleMaximize}
        title={isMaximized ? "还原" : "最大化"}
      >
        {isMaximized ? (
          <Copy size={12} strokeWidth={1.5} />
        ) : (
          <Square size={12} strokeWidth={1.5} />
        )}
      </button>
      <button
        style={{
          ...baseStyle,
          ...getButtonStyle("close"),
        }}
        onMouseEnter={() => setHovered("close")}
        onMouseLeave={() => setHovered(null)}
        onClick={handleClose}
        title="关闭"
      >
        <X size={15} strokeWidth={1.5} />
      </button>
    </div>
  );
}
