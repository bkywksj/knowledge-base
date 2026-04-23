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
  Wand2,
} from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { aiWriteApi, promptApi } from "@/lib/api";
import type { PromptOutputMode, PromptTemplate } from "@/types";

interface AiWriteMenuProps {
  editor: Editor;
}

// Lucide 图标名 → React 元素工厂，保持和管理页"图标名"字段一致
const ICON_MAP: Record<string, (size: number) => React.ReactNode> = {
  ArrowRight: (s) => <ArrowRight size={s} />,
  FileText: (s) => <FileText size={s} />,
  RefreshCw: (s) => <RefreshCw size={s} />,
  Languages: (s) => <Languages size={s} />,
  Expand: (s) => <Expand size={s} />,
  Shrink: (s) => <Shrink size={s} />,
  Sparkles: (s) => <Sparkles size={s} />,
  Wand2: (s) => <Wand2 size={s} />,
};

function renderIcon(name: string | null, size: number): React.ReactNode {
  if (name && ICON_MAP[name]) return ICON_MAP[name](size);
  return <Wand2 size={size} />; // 用户自定义没填图标时的默认占位
}

export function AiWriteMenu({ editor }: AiWriteMenuProps) {
  const { token } = antdTheme.useToken();
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [streaming, setStreaming] = useState(false);
  const [result, setResult] = useState("");
  const [selectedText, setSelectedText] = useState("");
  // 正在执行的 Prompt（用于决定结果插入模式 / 菜单标题）
  const [activePrompt, setActivePrompt] = useState<PromptTemplate | null>(null);
  // DB 里的提示词列表，AI 菜单从这里渲染；为空时显示"去添加提示词"占位
  const [prompts, setPrompts] = useState<PromptTemplate[]>([]);
  const [promptsLoaded, setPromptsLoaded] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const unlistenRefs = useRef<UnlistenFn[]>([]);

  // 首次挂载时拉一次提示词；管理页增删后由用户重新选中触发刷新（下面 selectionUpdate 里刷）。
  // 不做全局事件订阅：管理页和编辑器通常不同时打开，多拉一次成本可以忽略。
  useEffect(() => {
    void reloadPrompts();
  }, []);

  async function reloadPrompts() {
    try {
      const list = await promptApi.list(true);
      setPrompts(list);
    } catch (e) {
      console.error("加载提示词失败:", e);
    } finally {
      setPromptsLoaded(true);
    }
  }

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
        setActivePrompt(null);
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

  async function handlePrompt(prompt: PromptTemplate) {
    if (streaming) return;

    setStreaming(true);
    setResult("");
    setActivePrompt(prompt);
    await cleanup();

    // 获取选区周围的上下文（与旧版本一致：各取 300 字符）
    const { from, to } = editor.state.selection;
    const fullText = editor.state.doc.textBetween(
      0,
      editor.state.doc.content.size,
      " ",
    );
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
      await aiWriteApi.assist(`prompt:${prompt.id}`, selectedText, context);
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

  /**
   * 应用结果：按 Prompt 的 output_mode 选择插入策略
   * - append：在选区末尾追加（续写）
   * - popup：只展示不插入；用户确实想插入会手动选"替换"/"追加"
   * - replace（默认）：删选区再插入
   */
  function applyResult(mode: PromptOutputMode) {
    if (!result) return;
    const { from, to } = editor.state.selection;
    if (mode === "append") {
      editor.chain().focus().insertContentAt(to, result).run();
    } else {
      // replace：popup 也会走到这里（用户手动点"替换"），一视同仁
      editor
        .chain()
        .focus()
        .deleteRange({ from, to })
        .insertContentAt(from, result)
        .run();
    }
    setVisible(false);
    setResult("");
    setActivePrompt(null);
  }

  function handleDiscard() {
    setResult("");
    setVisible(false);
    setActivePrompt(null);
  }

  if (!visible) return null;

  const defaultMode: PromptOutputMode = activePrompt?.outputMode ?? "replace";

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
            maxWidth: 560,
            flexWrap: "wrap",
          }}
        >
          <Sparkles
            size={13}
            style={{ color: token.colorPrimary, marginRight: 4 }}
          />
          {prompts.length === 0 && promptsLoaded && (
            <span
              style={{
                color: token.colorTextTertiary,
                fontSize: 12,
                padding: "2px 6px",
              }}
            >
              无可用提示词，去"提示词"页添加
            </span>
          )}
          {prompts.map((p) => (
            <Tooltip
              key={p.id}
              title={p.description || p.title}
              mouseEnterDelay={0.3}
            >
              <button
                className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-black/5 transition-colors whitespace-nowrap"
                style={{ color: token.colorText }}
                onClick={() => handlePrompt(p)}
              >
                {renderIcon(p.icon, 13)}
                {p.title}
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
              {activePrompt ? activePrompt.title : "AI 写作辅助"}
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
              {/* 追加按钮：续写场景（append）默认主按钮；其他场景降级为次按钮 */}
              <Button
                type={defaultMode === "append" ? "primary" : "default"}
                size="small"
                onClick={() => applyResult("append")}
              >
                追加
              </Button>
              <Button
                type={defaultMode === "append" ? "default" : "primary"}
                size="small"
                icon={<Check size={12} />}
                onClick={() => applyResult("replace")}
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
