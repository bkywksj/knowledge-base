import { useState, useEffect, useRef, useCallback } from "react";
import type { Editor } from "@tiptap/react";
import { Button, Tooltip, theme as antdTheme } from "antd";
import {
  Sparkles,
  ArrowRight,
  FileText,
  RefreshCw,
  Languages,
  Expand,
  Shrink,
  X,
  Check,
  Loader2,
  StopCircle,
} from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { aiWriteApi } from "@/lib/api";

interface AiWriteMenuProps {
  editor: Editor;
}

interface AiAction {
  key: string;
  icon: React.ReactNode;
  label: string;
}

const AI_ACTIONS: AiAction[] = [
  { key: "continue", icon: <ArrowRight size={13} />, label: "续写" },
  { key: "summarize", icon: <FileText size={13} />, label: "总结" },
  { key: "rewrite", icon: <RefreshCw size={13} />, label: "改写" },
  { key: "expand", icon: <Expand size={13} />, label: "扩展" },
  { key: "shorten", icon: <Shrink size={13} />, label: "精简" },
  { key: "translate_en", icon: <Languages size={13} />, label: "译英" },
  { key: "translate_zh", icon: <Languages size={13} />, label: "译中" },
];

export function AiWriteMenu({ editor }: AiWriteMenuProps) {
  const { token } = antdTheme.useToken();
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [streaming, setStreaming] = useState(false);
  const [result, setResult] = useState("");
  const [selectedText, setSelectedText] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const unlistenRefs = useRef<UnlistenFn[]>([]);

  // 监听编辑器选区变化，显示/隐藏菜单
  useEffect(() => {
    function handleSelectionUpdate() {
      const { from, to } = editor.state.selection;
      if (from === to) {
        // 无选区 & 不在流式中 → 隐藏
        if (!streaming) {
          setVisible(false);
          setResult("");
        }
        return;
      }

      // 有选区 → 显示菜单
      const text = editor.state.doc.textBetween(from, to, " ");
      if (text.trim().length < 2) return;

      setSelectedText(text);

      // 计算菜单位置（基于选区末尾的 DOM 坐标）
      const view = editor.view;
      const coords = view.coordsAtPos(to);
      const editorRect = view.dom.closest(".tiptap-wrapper")?.getBoundingClientRect();
      if (editorRect) {
        setPosition({
          top: coords.bottom - editorRect.top + 6,
          left: coords.left - editorRect.left,
        });
      }

      if (!streaming) {
        setResult("");
        setVisible(true);
      }
    }

    editor.on("selectionUpdate", handleSelectionUpdate);
    return () => {
      editor.off("selectionUpdate", handleSelectionUpdate);
    };
  }, [editor, streaming]);

  // 点击外部关闭
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        !streaming
      ) {
        setVisible(false);
        setResult("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [streaming]);

  const cleanup = useCallback(async () => {
    for (const fn of unlistenRefs.current) {
      fn();
    }
    unlistenRefs.current = [];
  }, []);

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  async function handleAction(action: string) {
    if (streaming) return;

    setStreaming(true);
    setResult("");
    await cleanup();

    // 获取选区周围的上下文
    const { from, to } = editor.state.selection;
    const fullText = editor.state.doc.textBetween(0, editor.state.doc.content.size, " ");
    const contextBefore = fullText.slice(Math.max(0, from - 300), from);
    const contextAfter = fullText.slice(to, Math.min(fullText.length, to + 300));
    const context = contextBefore + contextAfter;

    const tokenUnlisten = await listen<string>("ai-write:token", (event) => {
      setResult((prev) => prev + event.payload);
    });
    const doneUnlisten = await listen("ai-write:done", async () => {
      setStreaming(false);
      await cleanup();
    });
    const errorUnlisten = await listen<string>("ai-write:error", async (event) => {
      setStreaming(false);
      setResult(`错误: ${event.payload}`);
      await cleanup();
    });

    unlistenRefs.current = [tokenUnlisten, doneUnlisten, errorUnlisten];

    try {
      await aiWriteApi.assist(action, selectedText, context);
    } catch (e) {
      setStreaming(false);
      setResult(`错误: ${e}`);
      await cleanup();
    }
  }

  async function handleCancel() {
    try {
      await aiWriteApi.cancel();
    } catch {
      // ignore
    }
    setStreaming(false);
    await cleanup();
  }

  function handleAccept() {
    if (!result) return;
    const { from, to } = editor.state.selection;

    // 根据不同操作，插入方式不同
    // 续写：在选区末尾追加；其他：替换选中内容
    editor.chain().focus().deleteRange({ from, to }).insertContentAt(from, result).run();
    setVisible(false);
    setResult("");
  }

  function handleDiscard() {
    setResult("");
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div
      ref={menuRef}
      className="absolute z-50"
      style={{
        top: position.top,
        left: Math.max(0, position.left - 100),
      }}
    >
      {/* AI 操作按钮行 */}
      {!result && !streaming && (
        <div
          className="flex items-center gap-0.5 px-1.5 py-1 rounded-lg shadow-lg"
          style={{
            background: token.colorBgElevated,
            border: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <Sparkles
            size={13}
            style={{ color: token.colorPrimary, marginRight: 4 }}
          />
          {AI_ACTIONS.map((action) => (
            <Tooltip key={action.key} title={action.label} mouseEnterDelay={0.3}>
              <button
                className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-black/5 transition-colors whitespace-nowrap"
                style={{ color: token.colorText }}
                onClick={() => handleAction(action.key)}
              >
                {action.icon}
                {action.label}
              </button>
            </Tooltip>
          ))}
        </div>
      )}

      {/* 流式结果 / 已完成结果 */}
      {(streaming || result) && (
        <div
          className="rounded-lg shadow-lg overflow-hidden"
          style={{
            background: token.colorBgElevated,
            border: `1px solid ${token.colorBorderSecondary}`,
            maxWidth: 480,
            minWidth: 280,
          }}
        >
          {/* 结果标题栏 */}
          <div
            className="flex items-center justify-between px-3 py-1.5 text-xs"
            style={{
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
              color: token.colorTextSecondary,
            }}
          >
            <span className="flex items-center gap-1.5">
              <Sparkles size={12} style={{ color: token.colorPrimary }} />
              AI 写作辅助
              {streaming && (
                <Loader2
                  size={12}
                  className="animate-spin"
                  style={{ color: token.colorPrimary }}
                />
              )}
            </span>
            {streaming && (
              <Button
                type="text"
                size="small"
                danger
                icon={<StopCircle size={12} />}
                onClick={handleCancel}
                style={{ height: 20, padding: "0 4px", fontSize: 11 }}
              >
                停止
              </Button>
            )}
          </div>

          {/* 结果内容 */}
          <div
            className="px-3 py-2 text-sm whitespace-pre-wrap max-h-60 overflow-auto"
            style={{ color: token.colorText }}
          >
            {result}
            {streaming && !result && (
              <span style={{ color: token.colorTextQuaternary }}>
                生成中...
              </span>
            )}
            {streaming && result && (
              <span
                className="inline-block w-1.5 h-3.5 ml-0.5 animate-pulse"
                style={{ background: token.colorPrimary }}
              />
            )}
          </div>

          {/* 操作按钮 */}
          {!streaming && result && (
            <div
              className="flex items-center justify-end gap-2 px-3 py-1.5"
              style={{
                borderTop: `1px solid ${token.colorBorderSecondary}`,
              }}
            >
              <Button
                size="small"
                icon={<X size={12} />}
                onClick={handleDiscard}
              >
                丢弃
              </Button>
              <Button
                type="primary"
                size="small"
                icon={<Check size={12} />}
                onClick={handleAccept}
              >
                替换
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
