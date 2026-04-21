import { useState, useEffect, useRef, useCallback } from "react";
import Markdown from "react-markdown";
import {
  Button,
  Input,
  Empty,
  message,
  Modal,
  Select,
  Switch,
  Tooltip,
  Dropdown,
  theme as antdTheme,
} from "antd";
import {
  Send,
  Plus,
  Trash2,
  StopCircle,
  BookOpen,
  MessageSquare,
  MoreHorizontal,
  Edit3,
} from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { aiChatApi, aiModelApi } from "@/lib/api";
import type { AiConversation, AiMessage, AiModel } from "@/types";
import { relativeTime } from "@/lib/utils";

const { TextArea } = Input;

/**
 * 显示 AI 相关错误：
 * - 多行（含 \n）用 Modal.error，保留换行、可细读
 * - 单行用短 toast
 */
function showAiError(err: unknown) {
  const raw = String(err ?? "未知错误");
  if (raw.includes("\n")) {
    Modal.error({
      title: "AI 请求失败",
      content: (
        <pre
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontFamily: "inherit",
            margin: 0,
            maxHeight: 360,
            overflow: "auto",
          }}
        >
          {raw}
        </pre>
      ),
      width: 520,
    });
  } else {
    message.error(`发送失败: ${raw}`);
  }
}

export default function AiChatPage() {
  const { token } = antdTheme.useToken();

  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<number | null>(null);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [models, setModels] = useState<AiModel[]>([]);
  const [inputText, setInputText] = useState("");
  const [useRag, setUseRag] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const unlistenRefs = useRef<UnlistenFn[]>([]);

  // 初始化
  useEffect(() => {
    loadConversations();
    loadModels();
    return () => {
      unlistenRefs.current.forEach((fn) => fn());
    };
  }, []);

  // 切换对话时加载消息
  useEffect(() => {
    if (activeConvId) {
      loadMessages(activeConvId);
    } else {
      setMessages([]);
    }
  }, [activeConvId]);

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  async function loadConversations() {
    try {
      const list = await aiChatApi.listConversations();
      setConversations(list);
    } catch (e) {
      console.error("加载对话列表失败:", e);
    }
  }

  async function loadModels() {
    try {
      const list = await aiModelApi.list();
      setModels(list);
    } catch (e) {
      console.error("加载模型列表失败:", e);
    }
  }

  async function loadMessages(convId: number) {
    try {
      const list = await aiChatApi.listMessages(convId);
      setMessages(list);
    } catch (e) {
      message.error(`加载消息失败: ${e}`);
    }
  }

  async function handleNewConversation() {
    try {
      const conv = await aiChatApi.createConversation();
      await loadConversations();
      setActiveConvId(conv.id);
    } catch (e) {
      message.error(`创建对话失败: ${e}`);
    }
  }

  async function handleDeleteConversation(id: number) {
    try {
      await aiChatApi.deleteConversation(id);
      if (activeConvId === id) {
        setActiveConvId(null);
      }
      await loadConversations();
    } catch (e) {
      message.error(`删除对话失败: ${e}`);
    }
  }

  async function handleChangeConvModel(modelId: number) {
    if (!activeConvId) return;
    try {
      await aiChatApi.updateConversationModel(activeConvId, modelId);
      // 本地同步更新，省去 list 往返
      setConversations((prev) =>
        prev.map((c) => (c.id === activeConvId ? { ...c, model_id: modelId } : c)),
      );
    } catch (e) {
      message.error(`切换模型失败: ${e}`);
    }
  }

  const handleSend = useCallback(async () => {
    if (!inputText.trim() || !activeConvId || streaming) return;

    const text = inputText.trim();
    setInputText("");
    setStreaming(true);
    setStreamingText("");

    // 乐观添加用户消息
    const userMsg: AiMessage = {
      id: Date.now(),
      conversation_id: activeConvId,
      role: "user",
      content: text,
      references: null,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    // 监听流式事件
    const cleanup = async () => {
      for (const fn of unlistenRefs.current) {
        fn();
      }
      unlistenRefs.current = [];
    };
    await cleanup();

    const tokenUnlisten = await listen<string>("ai:token", (event) => {
      setStreamingText((prev) => prev + event.payload);
    });
    const doneUnlisten = await listen("ai:done", async () => {
      setStreaming(false);
      await cleanup();
      // 重新加载消息获取完整数据
      if (activeConvId) {
        await loadMessages(activeConvId);
        await loadConversations();
      }
      setStreamingText("");
    });
    const errorUnlisten = await listen<string>("ai:error", async (event) => {
      setStreaming(false);
      await cleanup();
      setStreamingText("");
      message.error(`AI 错误: ${event.payload}`);
    });

    unlistenRefs.current = [tokenUnlisten, doneUnlisten, errorUnlisten];

    try {
      await aiChatApi.sendMessage(activeConvId, text, useRag);
    } catch (e) {
      setStreaming(false);
      await cleanup();
      setStreamingText("");
      showAiError(e);
    }
  }, [inputText, activeConvId, streaming, useRag]);

  async function handleCancel() {
    if (activeConvId) {
      try {
        await aiChatApi.cancelGeneration(activeConvId);
      } catch (e) {
        console.error("取消生成失败:", e);
      }
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const activeConv = conversations.find((c) => c.id === activeConvId);

  return (
    <div className="flex h-full" style={{ overflow: "hidden" }}>
      {/* 左侧对话列表 */}
      <div
        className="w-60 shrink-0 flex flex-col h-full"
        style={{
          borderRight: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
        }}
      >
        <div className="p-3 shrink-0">
          <Button
            type="primary"
            icon={<Plus size={14} />}
            block
            onClick={handleNewConversation}
          >
            新对话
          </Button>
        </div>

        <div className="flex-1 overflow-auto px-2 pb-2">
          {conversations.length === 0 ? (
            <div
              className="text-center py-8 text-xs"
              style={{ color: token.colorTextQuaternary }}
            >
              暂无对话
            </div>
          ) : (
            conversations.map((conv) => (
              <div
                key={conv.id}
                className="flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer group mb-0.5"
                style={{
                  background:
                    activeConvId === conv.id
                      ? token.colorPrimaryBg
                      : "transparent",
                  color: token.colorText,
                }}
                onClick={() => setActiveConvId(conv.id)}
              >
                <MessageSquare
                  size={14}
                  style={{ flexShrink: 0, color: token.colorTextSecondary }}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">{conv.title}</div>
                  <div
                    className="text-xs"
                    style={{ color: token.colorTextQuaternary }}
                  >
                    {relativeTime(conv.updated_at)}
                  </div>
                </div>
                <Dropdown
                  menu={{
                    items: [
                      {
                        key: "delete",
                        label: "删除",
                        danger: true,
                        icon: <Trash2 size={12} />,
                        onClick: (e) => {
                          e.domEvent.stopPropagation();
                          handleDeleteConversation(conv.id);
                        },
                      },
                    ],
                  }}
                  trigger={["click"]}
                >
                  <button
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-black/5 transition-opacity"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                </Dropdown>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 右侧聊天区域 */}
      <div className="flex-1 flex flex-col min-w-0">
        {!activeConvId ? (
          <div className="flex-1 flex items-center justify-center">
            <Empty
              description="选择或创建一个对话开始 AI 问答"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            >
              <Button type="primary" onClick={handleNewConversation}>
                开始新对话
              </Button>
            </Empty>
          </div>
        ) : (
          <>
            {/* 顶部栏 */}
            <div
              className="flex items-center justify-between px-4 py-2 shrink-0"
              style={{
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
                background: token.colorBgContainer,
              }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="font-medium truncate"
                  style={{ color: token.colorText }}
                >
                  {activeConv?.title || "对话"}
                </span>
                <Tooltip title="切换当前会话使用的 AI 模型">
                  <Select
                    size="small"
                    value={activeConv?.model_id}
                    style={{ width: 180 }}
                    disabled={streaming || models.length === 0}
                    onChange={handleChangeConvModel}
                    options={models.map((m) => ({
                      value: m.id,
                      label: m.is_default ? `${m.name} (默认)` : m.name,
                    }))}
                    placeholder="选择模型"
                  />
                </Tooltip>
              </div>
              <div className="flex items-center gap-2">
                <Tooltip title="启用 RAG：搜索相关笔记作为上下文">
                  <div className="flex items-center gap-1.5">
                    <BookOpen size={14} style={{ color: token.colorTextSecondary }} />
                    <Switch
                      size="small"
                      checked={useRag}
                      onChange={setUseRag}
                    />
                  </div>
                </Tooltip>
              </div>
            </div>

            {/* 消息列表 */}
            <div
              className="flex-1 overflow-auto px-4 py-4"
              style={{ background: token.colorBgLayout }}
            >
              {messages.length === 0 && !streaming && (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center">
                    <Edit3
                      size={40}
                      style={{
                        color: token.colorTextQuaternary,
                        marginBottom: 12,
                      }}
                    />
                    <div style={{ color: token.colorTextSecondary }}>
                      输入问题开始对话，AI 会参考你的笔记内容回答
                    </div>
                  </div>
                </div>
              )}

              {messages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  token={token}
                />
              ))}

              {/* 流式响应中 */}
              {streaming && streamingText && (
                <div className="flex gap-3 mb-4">
                  <div
                    className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-xs font-bold"
                    style={{
                      background: token.colorPrimaryBg,
                      color: token.colorPrimary,
                    }}
                  >
                    AI
                  </div>
                  <div
                    className="max-w-[75%] px-3 py-2 rounded-lg text-sm ai-markdown"
                    style={{
                      background: token.colorBgContainer,
                      color: token.colorText,
                    }}
                  >
                    <Markdown>{streamingText}</Markdown>
                    <span className="inline-block w-1.5 h-4 ml-0.5 animate-pulse" style={{ background: token.colorPrimary }} />
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* 输入区域 */}
            <div
              className="shrink-0 px-4 py-3"
              style={{
                borderTop: `1px solid ${token.colorBorderSecondary}`,
                background: token.colorBgContainer,
              }}
            >
              <div className="flex gap-2 items-end">
                <TextArea
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="输入问题… (Enter 发送，Shift+Enter 换行)"
                  autoSize={{ minRows: 1, maxRows: 4 }}
                  disabled={streaming}
                  className="flex-1"
                />
                {streaming ? (
                  <Button
                    danger
                    icon={<StopCircle size={16} />}
                    onClick={handleCancel}
                  >
                    停止
                  </Button>
                ) : (
                  <Button
                    type="primary"
                    icon={<Send size={16} />}
                    onClick={handleSend}
                    disabled={!inputText.trim()}
                  >
                    发送
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 消息气泡组件 */
function MessageBubble({
  message: msg,
  token,
}: {
  message: AiMessage;
  token: any;
}) {
  const isUser = msg.role === "user";
  const refs: number[] = msg.references
    ? JSON.parse(msg.references)
    : [];

  return (
    <div
      className={`flex gap-3 mb-4 ${isUser ? "flex-row-reverse" : ""}`}
    >
      {/* 头像 */}
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-xs font-bold"
        style={{
          background: isUser ? token.colorPrimary : token.colorPrimaryBg,
          color: isUser ? "#fff" : token.colorPrimary,
        }}
      >
        {isUser ? "我" : "AI"}
      </div>

      {/* 内容 */}
      <div className={`max-w-[75%] ${isUser ? "text-right" : ""}`}>
        <div
          className={`px-3 py-2 rounded-lg text-sm ${isUser ? "whitespace-pre-wrap" : "ai-markdown"}`}
          style={{
            background: isUser ? token.colorPrimary : token.colorBgContainer,
            color: isUser ? "#fff" : token.colorText,
          }}
        >
          {isUser ? msg.content : <Markdown>{msg.content}</Markdown>}
        </div>

        {/* 引用笔记 */}
        {refs.length > 0 && (
          <div
            className="mt-1 text-xs flex items-center gap-1"
            style={{ color: token.colorTextQuaternary }}
          >
            <BookOpen size={10} />
            参考了 {refs.length} 篇笔记
          </div>
        )}
      </div>
    </div>
  );
}
