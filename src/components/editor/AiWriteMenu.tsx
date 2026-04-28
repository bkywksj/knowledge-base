import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import type { Editor } from "@tiptap/react";
import { Button, Input, Popover, Tooltip, message, theme as antdTheme } from "antd";
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
  PenLine,
  Copy,
} from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { aiWriteApi, promptApi } from "@/lib/api";
import type { PromptOutputMode, PromptTemplate } from "@/types";

interface AiWriteMenuProps {
  editor: Editor;
  /**
   * 选中文本时浮起按钮行的「leading 按钮」回调（即「问 AI 这段」）。
   * 不传时不渲染该按钮；按钮跟着同一个浮动菜单出现，不会和右侧续写/总结/改写
   * 等工具按钮重叠。点击时携带选中纯文本作为参数；调用方负责打开抽屉 / 预填问题。
   */
  onAskAi?: (selectedText: string) => void;
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

export function AiWriteMenu({ editor, onAskAi }: AiWriteMenuProps) {
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
  // 自定义提示词弹窗
  const [customOpen, setCustomOpen] = useState(false);
  const [customInstruction, setCustomInstruction] = useState("");
  // AI 给这段选区提的"建议指令"：每次打开 Popover 都重新拉一次
  // null = 还未发起 / 已关闭；"" = 加载中；非空 = 已就绪；undefined = 失败/不可用
  const [suggestion, setSuggestion] = useState<string | undefined | null>(null);
  const suggestSeqRef = useRef(0); // 选区/Popover 切换时丢弃过期请求
  const menuRef = useRef<HTMLDivElement>(null);
  const unlistenRefs = useRef<UnlistenFn[]>([]);
  // 最近一次 mouseup 的坐标（拖选完毕时记下来，让 AI 菜单贴在鼠标附近而不是
  // 跑到选区末尾——长选区末尾常常在视口外）
  const mouseUpPosRef = useRef<{ x: number; y: number; ts: number } | null>(
    null,
  );

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
    const dom = editor.view.dom as HTMLElement;
    const onMouseUp = (e: MouseEvent) => {
      mouseUpPosRef.current = {
        x: e.clientX,
        y: e.clientY,
        ts: Date.now(),
      };
    };
    dom.addEventListener("mouseup", onMouseUp);

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

      // 计算菜单位置：
      //   1) 鼠标拖选 → 紧贴 mouseup 位置（最贴近用户视线）
      //   2) 键盘选（Ctrl+A、Shift+方向）或 mouseup 已过期 → 兜底用选区末尾坐标
      const view = editor.view;
      const wrapper = view.dom.closest(".tiptap-wrapper") as HTMLElement | null;
      if (!wrapper) return;
      const wrapperRect = wrapper.getBoundingClientRect();
      const mp = mouseUpPosRef.current;
      const useMouse = mp && Date.now() - mp.ts < 400;
      let top: number;
      let left: number;
      if (useMouse && mp) {
        top = mp.y - wrapperRect.top + 8;
        left = mp.x - wrapperRect.left + 8;
      } else {
        // 键盘选兜底：起点在视口里用起点；起点不行用终点；
        // 全选/跨视口的极端情况两端都不在视口 → 锚点放在视口中央
        const fromCoords = view.coordsAtPos(from);
        const toCoords = view.coordsAtPos(to);
        const vh = window.innerHeight;
        const inViewport = (y: number) => y >= 0 && y <= vh - 60;
        let anchorTop: number;
        let anchorLeft: number;
        if (inViewport(fromCoords.top)) {
          anchorTop = fromCoords.bottom;
          anchorLeft = fromCoords.left;
        } else if (inViewport(toCoords.top)) {
          anchorTop = toCoords.bottom;
          anchorLeft = toCoords.left;
        } else {
          anchorTop = vh / 2;
          anchorLeft = wrapperRect.left + 80;
        }
        top = anchorTop - wrapperRect.top + 6;
        left = anchorLeft - wrapperRect.left;
      }
      // 初次定位：先按 wrapper 宽度兜底 clamp（菜单实际宽度待渲染后由 useLayoutEffect 二次修正）
      const wrapperH = wrapper.clientHeight;
      left = Math.max(0, left);
      top = Math.max(0, Math.min(wrapperH - 60, top));
      setPosition({ top, left });

      if (!streaming) {
        setResult("");
        setActivePrompt(null);
        setVisible(true);
      }
    }

    editor.on("selectionUpdate", handleSelectionUpdate);
    return () => {
      editor.off("selectionUpdate", handleSelectionUpdate);
      dom.removeEventListener("mouseup", onMouseUp);
    };
  }, [editor, streaming]);

  // 渲染后用菜单**实际宽度**修正 left：保证整条按钮行单行显示，不被右边界挤换行
  // useLayoutEffect 在浏览器 paint 前同步执行，避免用户看到先错位再修正的闪烁
  useLayoutEffect(() => {
    if (!visible || !menuRef.current) return;
    const wrapper = (editor.view.dom as HTMLElement).closest(
      ".tiptap-wrapper",
    ) as HTMLElement | null;
    if (!wrapper) return;
    const wrapperW = wrapper.clientWidth;
    const menuW = menuRef.current.offsetWidth;
    const maxLeft = Math.max(0, wrapperW - menuW - 8);
    if (position.left > maxLeft) {
      setPosition((p) => ({ ...p, left: maxLeft }));
    }
  }, [visible, position.left, editor]);

  // 点击外部关闭（流式中 / 自定义弹窗打开时不响应，避免误关）
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (streaming || customOpen) return;
      const target = e.target as HTMLElement | null;
      // antd Popover/Dropdown/message 走 Portal 渲染在 body 下，命中这些容器时不关菜单
      if (
        target &&
        target.closest(
          ".ant-popover, .ant-popover-inner, .ant-popover-content, .ant-dropdown, .ant-message",
        )
      ) {
        return;
      }
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setVisible(false);
        setResult("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [streaming, customOpen]);

  // Popover 打开时根据选区 + 上下文拉一条 AI 建议指令；关闭时清空
  // 失败（未配置模型 / 离线 / 限流等）静默：suggestion=undefined → UI 不渲染建议区
  useEffect(() => {
    if (!customOpen) {
      setSuggestion(null);
      return;
    }
    if (!selectedText.trim()) return;
    const seq = ++suggestSeqRef.current;
    setSuggestion(""); // 加载态

    const { from, to } = editor.state.selection;
    const fullText = editor.state.doc.textBetween(
      0,
      editor.state.doc.content.size,
      " ",
    );
    const ctxBefore = fullText.slice(Math.max(0, from - 200), from);
    const ctxAfter = fullText.slice(to, Math.min(fullText.length, to + 200));
    const ctx = ctxBefore + ctxAfter;

    aiWriteApi
      .suggestPrompt(selectedText, ctx)
      .then((s) => {
        if (suggestSeqRef.current !== seq) return; // 已切换
        setSuggestion(s && s.trim() ? s.trim() : undefined);
      })
      .catch(() => {
        if (suggestSeqRef.current !== seq) return;
        setSuggestion(undefined);
      });
  }, [customOpen, selectedText, editor]);

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

  /**
   * 通用：发起一次 AI 写作辅助流式请求。
   * `action` 直接交给后端：`prompt:{id}` / `custom:{指令}` / 内置 builtin_code。
   * `display` 用作结果标题栏显示（自定义路径不在 DB，没有 PromptTemplate 可用）。
   */
  async function runAssist(
    action: string,
    display: PromptTemplate,
  ): Promise<void> {
    if (streaming) return;

    setStreaming(true);
    setResult("");
    setActivePrompt(display);
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
      await aiWriteApi.assist(action, selectedText, context);
    } catch (e) {
      setStreaming(false);
      setResult(`错误: ${e}`);
      await cleanup();
    }
  }

  function handlePrompt(prompt: PromptTemplate) {
    void runAssist(`prompt:${prompt.id}`, prompt);
  }

  async function handleCustomSubmit() {
    const instruction = customInstruction.trim();
    if (!instruction) {
      message.warning("请输入提示词");
      return;
    }
    // 伪 PromptTemplate：仅供结果标题栏显示和 applyResult 默认 mode 用
    const ephemeral: PromptTemplate = {
      id: -1,
      title: "自定义",
      description: instruction,
      prompt: instruction,
      outputMode: "replace",
      icon: "PenLine",
      isBuiltin: false,
      builtinCode: null,
      sortOrder: 0,
      enabled: true,
      createdAt: "",
      updatedAt: "",
    };
    setCustomOpen(false);
    setCustomInstruction("");
    await runAssist(`custom:${instruction}`, ephemeral);
  }

  async function handleCopy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result);
      message.success("已复制");
    } catch {
      message.error("复制失败");
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
        left: position.left,
      }}
    >
      {/* AI 操作按钮行 — 强制单行（nowrap），右边界由 useLayoutEffect 反向 clamp left
          保证菜单永远完整显示在 wrapper 内，鼠标在哪都不会换行 */}
      {!result && !streaming && (
        <div
          className="flex items-center gap-1 px-1.5 py-1 rounded-lg shadow-lg"
          style={{
            background: token.colorBgElevated,
            border: `1px solid ${token.colorBorderSecondary}`,
            flexWrap: "nowrap",
            whiteSpace: "nowrap",
          }}
        >
          {/* leading：问 AI 这段（蓝色 CTA，与右侧轻量工具按钮做视觉区分） */}
          {onAskAi && (
            <>
              <button
                className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium whitespace-nowrap"
                style={{
                  background: token.colorPrimary,
                  color: "#fff",
                  border: "none",
                  cursor: "pointer",
                }}
                onMouseDown={(e) => {
                  // mousedown 先于 blur，避免点击瞬间菜单消失
                  e.preventDefault();
                  onAskAi(selectedText);
                }}
              >
                🤖 问AI
              </button>
              {/* 主 CTA 和工具按钮之间的细分隔线，比图标更克制 */}
              <span
                style={{
                  width: 1,
                  height: 18,
                  background: token.colorBorderSecondary,
                  margin: "0 4px",
                }}
              />
            </>
          )}
          {/* 没有 onAskAi 时（独立用 AiWriteMenu 的场景）保留原来的 ✨ 前缀 */}
          {!onAskAi && (
            <Sparkles
              size={13}
              style={{ color: token.colorPrimary, marginRight: 4 }}
            />
          )}
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
          {/* 自定义提示词：贴在按钮下方的小 Popover 输入即兴指令，不写入 DB */}
          <Popover
            open={customOpen}
            onOpenChange={(o) => {
              setCustomOpen(o);
              if (!o) setCustomInstruction("");
            }}
            trigger="click"
            placement="bottomLeft"
            destroyTooltipOnHide
            content={
              <div style={{ width: 320 }}>
                <Input.TextArea
                  autoFocus
                  value={customInstruction}
                  onChange={(e) => setCustomInstruction(e.target.value)}
                  placeholder="例如：翻译为日文，并解释每个词的含义"
                  autoSize={{ minRows: 2, maxRows: 6 }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void handleCustomSubmit();
                    }
                  }}
                />
                {/* AI 建议气泡：suggestion="" 加载中；非空 = 可点击采纳；undefined = 静默隐藏 */}
                {suggestion === "" && (
                  <div
                    className="flex items-center gap-1.5 mt-2 text-xs"
                    style={{ color: token.colorTextTertiary }}
                  >
                    <Loader2 size={11} className="animate-spin" />
                    AI 正在为这段文本想建议…
                  </div>
                )}
                {typeof suggestion === "string" && suggestion.length > 0 && (
                  <Tooltip title="点击填入输入框" mouseEnterDelay={0.3}>
                    <button
                      type="button"
                      className="flex items-start gap-1.5 mt-2 px-2 py-1.5 rounded text-xs text-left w-full transition-colors"
                      style={{
                        background: token.colorFillQuaternary,
                        border: `1px dashed ${token.colorBorderSecondary}`,
                        color: token.colorText,
                        cursor: "pointer",
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.background =
                          token.colorPrimaryBg;
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.background =
                          token.colorFillQuaternary;
                      }}
                      onClick={() => setCustomInstruction(suggestion)}
                    >
                      <Sparkles
                        size={12}
                        style={{
                          color: token.colorPrimary,
                          marginTop: 2,
                          flexShrink: 0,
                        }}
                      />
                      <span className="flex-1">{suggestion}</span>
                    </button>
                  </Tooltip>
                )}
                <div className="flex items-center justify-between mt-2">
                  <span
                    className="text-xs"
                    style={{ color: token.colorTextTertiary }}
                  >
                    Enter 发送 / Shift+Enter 换行
                  </span>
                  <Button
                    type="primary"
                    size="small"
                    onClick={handleCustomSubmit}
                  >
                    发送
                  </Button>
                </div>
              </div>
            }
          >
            <Tooltip title="输入自定义指令" mouseEnterDelay={0.3}>
              <button
                className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-black/5 transition-colors whitespace-nowrap"
                style={{
                  color: customOpen ? token.colorPrimary : token.colorText,
                }}
                onMouseDown={(e) => e.preventDefault()}
              >
                <PenLine size={13} />
                自定义
              </button>
            </Tooltip>
          </Popover>
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
              <Tooltip title="复制到剪贴板">
                <Button
                  size="small"
                  icon={<Copy size={12} />}
                  onClick={handleCopy}
                >
                  复制
                </Button>
              </Tooltip>
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
