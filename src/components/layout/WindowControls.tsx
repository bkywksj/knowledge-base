import { useEffect, useState, useCallback, useRef } from "react";
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
import { Minus, Square, Copy, X } from "lucide-react";

function getAppWindow(): Window | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);
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

  // v4 标题栏：三个按钮各 46px 宽、撑满标题栏高度，悬停浅底；关闭悬停红底白字。
  // 样式在 global.css 的 .kb-winbtn（hover 用 CSS 而不是 state，省掉每次移入移出的重渲染）
  return (
    <div className="kb-winbtn">
      <button type="button" onClick={handleMinimize} title="最小化">
        <Minus size={15} strokeWidth={1.4} />
      </button>
      <button type="button" onClick={handleToggleMaximize} title={isMaximized ? "还原" : "最大化"}>
        {isMaximized ? <Copy size={13} strokeWidth={1.4} /> : <Square size={13} strokeWidth={1.4} />}
      </button>
      <button type="button" className="close" onClick={handleClose} title="关闭">
        <X size={15} strokeWidth={1.4} />
      </button>
    </div>
  );
}
