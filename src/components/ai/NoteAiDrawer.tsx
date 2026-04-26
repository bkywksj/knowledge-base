import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Drawer, Button, Input, message, Tooltip, Empty, theme as antdTheme } from "antd";
import Markdown from "react-markdown";
import { Send, StopCircle, ExternalLink, Bot, RefreshCw, Quote, X } from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { aiChatApi } from "@/lib/api";
import type { AiConversation, AiMessage } from "@/types";

const { TextArea } = Input;

interface NoteAiDrawerProps {
  /** 当前笔记 id */
  noteId: number;
  /** 抽屉是否展开 */
  open: boolean;
  onClose: () => void;
  /**
   * 来自编辑器选段触发「问 AI 这段」时携带的选中文本。
   * 显示为输入框上方的引用 chip（可关闭），发送时自动拼到消息前作为上下文，
   * 不污染输入框，让用户专注写问题。
   */
  pendingSelection?: string;
}

/**
 * 编辑器右侧的迷你 AI 聊天抽屉（方案 A）。
 *
 * - 复用 backend 的 send_ai_message + ai:token/done/error 流式事件
 * - 每篇笔记懒建伴生对话（companion_conversation_id），保证笔记 ↔ 对话 1:1
 * - 切换笔记 / 关闭抽屉时取消未完成的流式请求，避免请求泄漏
 * - 顶部「在 AI 页打开」按钮 → 跳到完整 AI 页继续聊（带 activeConvId state）
 */
export function NoteAiDrawer({
  noteId,
  open,
  onClose,
  pendingSelection,
}: NoteAiDrawerProps) {
  const { token } = antdTheme.useToken();
  const navigate = useNavigate();
  const [conv, setConv] = useState<AiConversation | null>(null);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [loading, setLoading] = useState(false);
  // 当前挂载的"选段引用"：发送下一条消息时会拼到消息开头作为上下文，发完清掉
  const [pendingContext, setPendingContext] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const unlistenRefs = useRef<UnlistenFn[]>([]);

  // 抽屉打开 + 切换 noteId 时拉伴生对话
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    aiChatApi
      .getOrCreateCompanionConversation(noteId)
      .then(async (c) => {
        if (cancelled) return;
        setConv(c);
        const msgs = await aiChatApi.listMessages(c.id).catch(() => []);
        if (!cancelled) setMessages(msgs);
      })
      .catch((e) => {
        if (!cancelled) message.error(`加载 AI 对话失败: ${e}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, noteId]);

  // 外部「问 AI 这段」触发：把选段挂到输入框上方的引用 chip 里，输入框留给用户写问题
  useEffect(() => {
    if (open && pendingSelection && pendingSelection.trim()) {
      setPendingContext(pendingSelection.trim());
    }
  }, [open, pendingSelection]);

  // 流式事件订阅：抽屉只要 open 就挂着 listener，关闭时清掉
  useEffect(() => {
    if (!open) return;
    let mounted = true;
    (async () => {
      const tokenUn = await listen<{ conversationId: number; token: string }>(
        "ai:token",
        (e) => {
          if (!mounted) return;
          if (conv && e.payload.conversationId === conv.id) {
            setStreamingText((prev) => prev + e.payload.token);
          }
        },
      );
      const doneUn = await listen<number>("ai:done", async (e) => {
        if (!mounted) return;
        if (conv && e.payload === conv.id) {
          // 流式结束：拉最新消息列表覆盖 streamingText
          const msgs = await aiChatApi.listMessages(conv.id).catch(() => []);
          if (mounted) {
            setMessages(msgs);
            setStreamingText("");
            setStreaming(false);
          }
        }
      });
      const errorUn = await listen<{ conversationId: number; error: string }>(
        "ai:error",
        (e) => {
          if (!mounted) return;
          if (conv && e.payload.conversationId === conv.id) {
            message.error(`AI 出错: ${e.payload.error}`);
            setStreamingText("");
            setStreaming(false);
          }
        },
      );
      if (!mounted) {
        tokenUn();
        doneUn();
        errorUn();
        return;
      }
      unlistenRefs.current.push(tokenUn, doneUn, errorUn);
    })();
    return () => {
      mounted = false;
      unlistenRefs.current.forEach((fn) => fn());
      unlistenRefs.current = [];
    };
  }, [open, conv?.id]);

  // 自动滚到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  const handleSend = useCallback(async () => {
    if (!conv || !input.trim() || streaming) return;
    const userQuestion = input.trim();
    // 有挂载的选段就拼到问题前面作为引用块，让 AI 能看到具体讨论对象
    const finalText = pendingContext
      ? `> ${pendingContext.replace(/\n/g, "\n> ")}\n\n${userQuestion}`
      : userQuestion;
    setInput("");
    setPendingContext(null);
    setStreaming(true);
    setStreamingText("");
    // 乐观先把 user 消息显示出来；done 事件会重新拉一次列表覆盖
    setMessages((prev) => [
      ...prev,
      {
        id: -Date.now(),
        conversation_id: conv.id,
        role: "user",
        content: finalText,
        references: null,
        skill_calls: null,
        created_at: new Date().toISOString(),
      },
    ]);
    try {
      // 抽屉默认不启 RAG / Skills（附加笔记已是当前笔记，足够上下文了）
      await aiChatApi.sendMessage(conv.id, finalText, false, false);
    } catch (e) {
      setStreaming(false);
      message.error(`发送失败: ${e}`);
    }
  }, [conv, input, streaming, pendingContext]);

  const handleCancel = useCallback(async () => {
    if (!conv) return;
    try {
      await aiChatApi.cancelGeneration(conv.id);
    } catch {
      // 忽略：UI 状态会被 ai:done / ai:error 重置
    }
  }, [conv]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <Drawer
      title={
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Bot size={16} />
            <span style={{ fontSize: 14 }}>{conv?.title ?? "AI 对话"}</span>
          </span>
          {conv && (
            <Tooltip title="跳到 AI 页查看完整对话">
              <Button
                size="small"
                type="text"
                icon={<ExternalLink size={14} />}
                onClick={() =>
                  navigate("/ai", { state: { activeConvId: conv.id } })
                }
              />
            </Tooltip>
          )}
        </div>
      }
      placement="right"
      open={open}
      onClose={onClose}
      width={440}
      mask={false}
      destroyOnHidden={false}
      styles={{
        body: {
          padding: 0,
          display: "flex",
          flexDirection: "column",
          background: token.colorBgLayout,
        },
        header: { padding: "8px 16px" },
      }}
    >
      {/* 消息列表 */}
      <div
        className="flex-1 overflow-auto px-3 py-3"
        style={{ minHeight: 0 }}
      >
        {loading && messages.length === 0 ? (
          <div
            className="flex items-center justify-center h-full text-sm"
            style={{ color: token.colorTextTertiary }}
          >
            <RefreshCw size={14} className="animate-spin mr-2" />
            加载中…
          </div>
        ) : messages.length === 0 && !streaming ? (
          <div className="flex items-center justify-center h-full">
            <Empty
              description={
                <span style={{ fontSize: 12 }}>
                  本笔记还没问过 AI，输入问题开始
                </span>
              }
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          </div>
        ) : (
          <>
            {messages.map((msg) => (
              <MiniBubble key={msg.id} msg={msg} token={token} />
            ))}
            {streaming && streamingText && (
              <div className="flex gap-2 mb-3">
                <div
                  className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-xs font-bold"
                  style={{
                    background: token.colorPrimaryBg,
                    color: token.colorPrimary,
                  }}
                >
                  AI
                </div>
                <div
                  className="px-2.5 py-1.5 rounded-lg text-sm ai-markdown"
                  style={{
                    background: token.colorBgContainer,
                    color: token.colorText,
                    maxWidth: "85%",
                  }}
                >
                  <Markdown>{streamingText}</Markdown>
                  <span
                    className="inline-block w-1.5 h-4 ml-0.5 animate-pulse"
                    style={{ background: token.colorPrimary }}
                  />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* 输入区 */}
      <div
        className="shrink-0 px-3 py-2"
        style={{
          borderTop: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
        }}
      >
        {/* 引用 chip：从编辑器选段触发时显示；点 × 撤销，发送后自动清空 */}
        {pendingContext && (
          <div
            className="mb-2 flex items-start gap-2 px-2 py-1.5 rounded"
            style={{
              background: token.colorPrimaryBg,
              border: `1px solid ${token.colorPrimaryBorder}`,
              fontSize: 12,
            }}
          >
            <Quote
              size={12}
              style={{ color: token.colorPrimary, marginTop: 2, flexShrink: 0 }}
            />
            <div
              className="flex-1 min-w-0"
              style={{
                color: token.colorText,
                lineHeight: 1.5,
                maxHeight: 60,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {pendingContext.length > 200
                ? pendingContext.slice(0, 200) + "…"
                : pendingContext}
            </div>
            <button
              type="button"
              onClick={() => setPendingContext(null)}
              style={{
                background: "transparent",
                border: "none",
                cursor: "pointer",
                padding: 0,
                color: token.colorTextSecondary,
                flexShrink: 0,
              }}
              title="撤销引用"
            >
              <X size={13} />
            </button>
          </div>
        )}
        <div className="flex gap-2 items-end">
          <TextArea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              pendingContext
                ? "针对上面这段，输入你的问题…"
                : "基于本笔记问 AI…(Enter 发送)"
            }
            autoSize={{ minRows: 1, maxRows: 4 }}
            disabled={streaming || !conv}
            className="flex-1"
          />
          {streaming ? (
            <Button danger icon={<StopCircle size={14} />} onClick={handleCancel}>
              停止
            </Button>
          ) : (
            <Button
              type="primary"
              icon={<Send size={14} />}
              onClick={handleSend}
              disabled={!input.trim() || !conv}
            />
          )}
        </div>
      </div>
    </Drawer>
  );
}

/**
 * 把 user 消息内容里开头连续的 `> ` 引用行 与 后续问题文本拆开。
 * 仅处理"消息开头紧跟一个引用块、再空行、再问题"这种由抽屉自动拼出的格式；
 * 其他形式（用户手动输入的引用、引用在中间等）保留原样不拆。
 *
 * 返回 { quote, body }；quote 为 null 时表示没有可折叠的前置引用。
 */
function splitQuoteAndBody(content: string): {
  quote: string | null;
  body: string;
} {
  const lines = content.split("\n");
  if (lines.length === 0 || !lines[0].startsWith("> ")) {
    return { quote: null, body: content };
  }
  // 收集开头连续的 `> ` 行
  let i = 0;
  const quoteLines: string[] = [];
  while (i < lines.length && lines[i].startsWith(">")) {
    quoteLines.push(lines[i].replace(/^>\s?/, ""));
    i++;
  }
  // 后面要有空行再有正文，否则不拆（保持原样让 markdown 渲染）
  if (i >= lines.length || lines[i].trim() !== "") {
    return { quote: null, body: content };
  }
  // 跳过空行，body 取剩余
  while (i < lines.length && lines[i].trim() === "") i++;
  const bodyText = lines.slice(i).join("\n").trim();
  if (!bodyText) {
    return { quote: null, body: content };
  }
  return { quote: quoteLines.join("\n").trim(), body: bodyText };
}

/** 迷你气泡：user 消息开头若挂着引用块，默认折叠为一行 chip，点击展开 */
function MiniBubble({
  msg,
  token,
}: {
  msg: AiMessage;
  token: { colorPrimaryBg: string; colorPrimary: string; colorBgContainer: string; colorText: string; colorTextTertiary: string };
}) {
  const isUser = msg.role === "user";
  const [expanded, setExpanded] = useState(false);
  const { quote, body } = isUser
    ? splitQuoteAndBody(msg.content)
    : { quote: null, body: msg.content };

  return (
    <div className={`flex gap-2 mb-3 ${isUser ? "flex-row-reverse" : ""}`}>
      <div
        className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-xs font-bold"
        style={{
          background: isUser ? token.colorPrimary : token.colorPrimaryBg,
          color: isUser ? "#fff" : token.colorPrimary,
        }}
      >
        {isUser ? "我" : "AI"}
      </div>
      <div
        className={isUser ? "px-2.5 py-1.5 rounded-lg text-sm" : "px-2.5 py-1.5 rounded-lg text-sm ai-markdown"}
        style={{
          background: isUser ? token.colorPrimary : token.colorBgContainer,
          color: isUser ? "#fff" : token.colorText,
          maxWidth: "85%",
          wordBreak: "break-word",
        }}
      >
        {/* 用户消息正文（在引用 chip 上方） */}
        {isUser ? body : <Markdown>{body}</Markdown>}

        {/* 折叠引用 chip：显示在问题下方，点击展开/收起 */}
        {isUser && quote && (
          <div
            onClick={() => setExpanded((v) => !v)}
            className="mt-1.5 px-2 py-1 rounded cursor-pointer text-xs flex items-start gap-1.5"
            style={{
              background: "rgba(255,255,255,0.18)",
              color: "rgba(255,255,255,0.92)",
              userSelect: "none",
            }}
            title={expanded ? "点击收起" : "点击展开完整引用"}
          >
            <Quote size={11} style={{ marginTop: 2, flexShrink: 0 }} />
            {expanded ? (
              <div
                className="flex-1"
                style={{
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  lineHeight: 1.5,
                }}
              >
                {quote}
              </div>
            ) : (
              <div
                className="flex-1"
                style={{
                  display: "-webkit-box",
                  WebkitLineClamp: 1,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                  wordBreak: "break-all",
                }}
              >
                {quote}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
