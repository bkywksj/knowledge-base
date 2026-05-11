import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ChevronLeft,
  Sparkles,
  MoreVertical,
  Plus,
  Mic,
  Send,
  Square,
  Copy,
} from "lucide-react";
import { Drawer, message } from "antd";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { aiChatApi, aiModelApi } from "@/lib/api";
import type { AiConversation, AiMessage, AiModel } from "@/types";
import { MobileAiModelModal } from "@/components/ai/MobileAiModelModal";

/**
 * 移动端 AI 对话页（设计稿：07-ai-chat.html）
 *
 * 路由：/ai-chat/:id
 *
 * 流式响应：监听后端事件
 * - `ai:token` (string)   — 增量文字
 * - `ai:done`             — 流结束，刷消息列表
 * - `ai:error` (string)   — 错误
 *
 * 暂不实现：
 * - 工具调用 chip（ai:tool_call 事件）
 * - 引用笔记 chip（attached_note_ids）
 * - 重新生成 / 点赞 / 复制（占位按钮，下迭代）
 */

export function MobileAiChat() {
  const navigate = useNavigate();
  const { id: idParam } = useParams<{ id: string }>();
  const convId = Number(idParam);

  const [conv, setConv] = useState<AiConversation | null>(null);
  const [model, setModel] = useState<AiModel | null>(null);
  const [allModels, setAllModels] = useState<AiModel[]>([]);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [modelDrawer, setModelDrawer] = useState(false);
  const [addModelOpen, setAddModelOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // convId 的 ref 镜像 —— 给 mount-once 的 ai:* 事件 handler 用，避免路由参数变化后闭包陷阱
  const convIdRef = useRef(convId);
  useEffect(() => {
    convIdRef.current = convId;
  }, [convId]);

  // 自动滚到底
  function scrollToBottom() {
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  const loadAll = useCallback(async () => {
    if (!convId || Number.isNaN(convId)) return;
    try {
      const [convs, models, msgs] = await Promise.all([
        aiChatApi.listConversations(),
        aiModelApi.list(),
        aiChatApi.listMessages(convId),
      ]);
      const c = convs.find((x) => x.id === convId) ?? null;
      setConv(c);
      setAllModels(models);
      setModel(models.find((m) => m.id === c?.model_id) ?? null);
      setMessages(msgs);
      scrollToBottom();
    } catch (e) {
      console.error("[MobileAiChat] load failed:", e);
    }
  }, [convId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // 流式响应监听（mount once）
  useEffect(() => {
    let unlistens: UnlistenFn[] = [];
    let cancelled = false;
    (async () => {
      // ai:token / ai:error payload 带 conversationId（后端改造）；按当前路由的会话过滤，
      // 避免别的会话（如桌面端）的流式 token 串到这里。
      const tokenU = await listen<{ conversationId: number; content: string }>(
        "ai:token",
        (e) => {
          if (e.payload.conversationId !== convIdRef.current) return;
          setStreamingText((prev) => {
            const next = prev + e.payload.content;
            scrollToBottom();
            return next;
          });
        },
      );
      const doneU = await listen<number>("ai:done", async (e) => {
        if (e.payload !== convIdRef.current) return;
        setStreaming(false);
        setStreamingText("");
        await loadAll();
      });
      const errU = await listen<{ conversationId: number; error: string }>(
        "ai:error",
        (e) => {
          if (e.payload.conversationId !== convIdRef.current) return;
          setStreaming(false);
          setStreamingText("");
          message.error(`AI 错误: ${e.payload.error}`);
        },
      );
      if (cancelled) {
        tokenU();
        doneU();
        errU();
      } else {
        unlistens = [tokenU, doneU, errU];
      }
    })();
    return () => {
      cancelled = true;
      unlistens.forEach((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function send() {
    const text = input.trim();
    if (!text || !convId || streaming) return;
    setInput("");
    setStreaming(true);
    setStreamingText("");
    // 乐观插入用户消息
    const optimistic: AiMessage = {
      id: -Date.now(),
      conversation_id: convId,
      role: "user",
      content: text,
      references: null,
      skill_calls: null,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    scrollToBottom();
    try {
      await aiChatApi.sendMessage(convId, text);
    } catch (e) {
      setStreaming(false);
      message.error(`发送失败: ${e}`);
    }
  }

  async function cancel() {
    if (!convId) return;
    try {
      await aiChatApi.cancelGeneration(convId);
    } catch (e) {
      console.error("cancel failed:", e);
    }
  }

  function openAddModel() {
    setModelDrawer(false);
    setAddModelOpen(true);
  }

  async function onModelAdded(created: AiModel) {
    // 自动把当前对话切到新模型
    if (convId) {
      try {
        await aiChatApi.updateConversationModel(convId, created.id);
      } catch (e) {
        console.error("auto switch failed:", e);
      }
    }
    await loadAll();
  }

  async function switchModel(m: AiModel) {
    if (!convId) return;
    if (m.id === conv?.model_id) {
      setModelDrawer(false);
      return;
    }
    try {
      await aiChatApi.updateConversationModel(convId, m.id);
      setModelDrawer(false);
      message.success(`已切换到 ${m.name}`);
      await loadAll();
    } catch (e) {
      message.error(`切换失败: ${e}`);
    }
  }

  function copyText(text: string) {
    navigator.clipboard
      ?.writeText(text)
      .then(() => message.success("已复制"))
      .catch(() => message.error("复制失败"));
  }

  if (Number.isNaN(convId)) {
    return (
      <div className="p-4 text-center text-sm text-slate-400">
        对话 ID 无效
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 flex flex-col bg-slate-50 z-50"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      {/* 顶栏 */}
      <header className="flex h-12 items-center justify-between border-b border-slate-200 bg-white px-2 shrink-0">
        <button
          onClick={() => navigate("/ai")}
          aria-label="返回"
          className="flex h-10 w-10 items-center justify-center"
        >
          <ChevronLeft size={24} className="text-slate-700" />
        </button>
        <button
          onClick={() => setModelDrawer(true)}
          className="flex flex-col items-center min-w-0 flex-1 px-2 active:opacity-60"
        >
          <span className="truncate text-sm font-semibold text-slate-900">
            {conv?.title || "对话"}
          </span>
          <span className="flex items-center gap-1 text-[10px] text-orange-600">
            {streaming && (
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-orange-500" />
            )}
            {model?.name ?? "未选模型"}
            {streaming ? " · 生成中" : " ▾"}
          </span>
        </button>
        <button
          aria-label="更多"
          className="flex h-10 w-10 items-center justify-center"
        >
          <MoreVertical size={20} className="text-slate-700" />
        </button>
      </header>

      {/* 消息列表 */}
      <main
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 py-3 space-y-3"
      >
        {messages.length === 0 && !streaming && (
          <div className="flex flex-col items-center gap-2 py-16 text-slate-400">
            <Sparkles size={32} className="text-orange-300" />
            <span className="text-sm">开始对话吧</span>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} onCopy={copyText} />
        ))}
        {streaming && streamingText && (
          <StreamingBubble text={streamingText} />
        )}
        {streaming && !streamingText && (
          <div className="flex gap-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-orange-100">
              <Sparkles size={16} className="text-[#FA8C16]" />
            </div>
            <div className="rounded-2xl rounded-tl-md bg-white px-4 py-3 shadow-sm">
              <Dots />
            </div>
          </div>
        )}
      </main>

      {/* 输入栏 */}
      <footer
        className="border-t border-slate-200 bg-white px-2 py-2"
        style={{ paddingBottom: "calc(8px + env(safe-area-inset-bottom, 0px))" }}
      >
        <div className="flex items-end gap-2">
          <button
            aria-label="附件"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 active:bg-slate-200"
          >
            <Plus size={20} className="text-slate-700" />
          </button>
          <div className="flex flex-1 items-center rounded-2xl bg-slate-100 px-3 py-2 min-h-[40px]">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder="发消息或 / 调用 Prompt"
              className="flex-1 bg-transparent text-sm outline-none"
            />
          </div>
          {streaming ? (
            <button
              onClick={cancel}
              aria-label="停止"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#FA8C16] text-white active:scale-95"
            >
              <Square size={16} fill="currentColor" />
            </button>
          ) : input.trim() ? (
            <button
              onClick={send}
              aria-label="发送"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#1677FF] text-white active:scale-95"
            >
              <Send size={18} />
            </button>
          ) : (
            <button
              aria-label="语音"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 active:bg-slate-200"
            >
              <Mic size={20} className="text-slate-700" />
            </button>
          )}
        </div>
      </footer>

      {/* 模型切换 Drawer */}
      <Drawer
        title="选择模型"
        placement="bottom"
        height={Math.min(80 * Math.max(allModels.length + 2, 4), 520)}
        open={modelDrawer}
        onClose={() => setModelDrawer(false)}
      >
        <div className="flex flex-col gap-2">
          {allModels.length === 0 && (
            <div className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
              手机端还没有配置 AI 模型
              <br />
              <span className="text-xs text-slate-400">
                （手机数据库与桌面独立，需要单独配置）
              </span>
            </div>
          )}
          {allModels.map((m) => {
            const active = m.id === conv?.model_id;
            return (
              <button
                key={m.id}
                onClick={() => switchModel(m)}
                className={`flex items-center justify-between rounded-xl px-4 py-3 text-left active:bg-slate-100 ${
                  active
                    ? "border border-orange-200 bg-orange-50"
                    : "border border-slate-100 bg-white"
                }`}
              >
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="truncate text-sm font-semibold text-slate-900">
                    {m.name}
                  </span>
                  <span className="truncate text-xs text-slate-500">
                    {m.provider} · {m.model_id}
                  </span>
                </div>
                {active && (
                  <span className="text-xs font-semibold text-orange-600 ml-2">
                    ✓ 当前
                  </span>
                )}
              </button>
            );
          })}
          <button
            onClick={openAddModel}
            className="mt-2 flex items-center justify-center gap-1 rounded-xl border border-dashed border-orange-300 bg-orange-50 px-4 py-3 text-sm font-semibold text-orange-700 active:bg-orange-100"
          >
            <Plus size={16} /> 新增 AI 模型（DeepSeek 等）
          </button>
        </div>
      </Drawer>

      {/* 新增模型 Modal（共享组件） */}
      <MobileAiModelModal
        open={addModelOpen}
        onClose={() => setAddModelOpen(false)}
        onSaved={onModelAdded}
        okText="保存并切换"
      />
    </div>
  );
}

function MessageBubble({
  msg,
  onCopy,
}: {
  msg: AiMessage;
  onCopy: (s: string) => void;
}) {
  const isUser = msg.role === "user";
  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[280px] rounded-2xl rounded-tr-md bg-[#1677FF] px-4 py-2.5 text-sm text-white whitespace-pre-wrap break-words">
          {msg.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-2">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-orange-100">
        <Sparkles size={16} className="text-[#FA8C16]" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="rounded-2xl rounded-tl-md bg-white px-4 py-3 text-sm text-slate-700 shadow-sm whitespace-pre-wrap break-words">
          {msg.content}
        </div>
        <div className="mt-1.5 flex items-center gap-3 px-1 text-[11px] text-slate-400">
          <button
            onClick={() => onCopy(msg.content)}
            className="flex items-center gap-0.5 active:text-slate-600"
          >
            <Copy size={12} /> 复制
          </button>
          <span className="ml-auto">
            {new Date(msg.created_at).toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
      </div>
    </div>
  );
}

function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="flex gap-2">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-orange-100">
        <Sparkles size={16} className="text-[#FA8C16]" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="rounded-2xl rounded-tl-md bg-white px-4 py-3 text-sm text-slate-700 shadow-sm whitespace-pre-wrap break-words">
          {text}
          <span className="ml-0.5 inline-block h-3.5 w-0.5 animate-pulse bg-[#FA8C16] align-middle" />
        </div>
      </div>
    </div>
  );
}

function Dots() {
  return (
    <span className="flex items-center gap-1">
      <span
        className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400"
        style={{ animationDelay: "0ms" }}
      />
      <span
        className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400"
        style={{ animationDelay: "150ms" }}
      />
      <span
        className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400"
        style={{ animationDelay: "300ms" }}
      />
    </span>
  );
}
