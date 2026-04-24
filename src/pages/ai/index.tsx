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
  Wrench,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Loader2,
} from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { aiChatApi, aiModelApi } from "@/lib/api";
import type { AiConversation, AiMessage, AiModel, SkillCall } from "@/types";
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
  // T-004: Skills 框架开关。启用时 RAG 自动关（AI 自己调 search_notes）
  const [useSkills, setUseSkills] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  // 流式过程中 AI 调用的工具列表（带 running/ok/error 状态）；done 后并入 messages 清空
  const [streamingSkillCalls, setStreamingSkillCalls] = useState<SkillCall[]>([]);

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
    setStreamingSkillCalls([]);

    // 乐观添加用户消息
    const userMsg: AiMessage = {
      id: Date.now(),
      conversation_id: activeConvId,
      role: "user",
      content: text,
      references: null,
      skill_calls: null,
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
      setStreamingSkillCalls([]);
    });
    const errorUnlisten = await listen<string>("ai:error", async (event) => {
      setStreaming(false);
      await cleanup();
      setStreamingText("");
      setStreamingSkillCalls([]);
      message.error(`AI 错误: ${event.payload}`);
    });
    // T-004: tool_call 事件可能多次触发（running → ok/error）
    const toolCallUnlisten = await listen<SkillCall>("ai:tool_call", (event) => {
      const incoming = event.payload;
      setStreamingSkillCalls((prev) => {
        const idx = prev.findIndex((c) => c.id === incoming.id);
        if (idx >= 0) {
          const next = prev.slice();
          next[idx] = incoming;
          return next;
        }
        return [...prev, incoming];
      });
    });

    unlistenRefs.current = [
      tokenUnlisten,
      doneUnlisten,
      errorUnlisten,
      toolCallUnlisten,
    ];

    try {
      await aiChatApi.sendMessage(activeConvId, text, useRag, useSkills);
    } catch (e) {
      setStreaming(false);
      await cleanup();
      setStreamingText("");
      setStreamingSkillCalls([]);
      showAiError(e);
    }
  }, [inputText, activeConvId, streaming, useRag, useSkills]);

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
              <div className="flex items-center gap-3">
                <Tooltip title={useSkills ? "启用 Skills 时，RAG 由 AI 自己调 search_notes 替代" : "启用 RAG：搜索相关笔记作为上下文"}>
                  <div className="flex items-center gap-1.5" style={{ opacity: useSkills ? 0.4 : 1 }}>
                    <BookOpen size={14} style={{ color: token.colorTextSecondary }} />
                    <Switch
                      size="small"
                      checked={useRag && !useSkills}
                      disabled={useSkills}
                      onChange={setUseRag}
                    />
                  </div>
                </Tooltip>
                <Tooltip title="启用 Skills：AI 可调用 搜笔记 / 读笔记 / 列标签 等工具（仅 OpenAI 兼容模型）">
                  <div className="flex items-center gap-1.5">
                    <Wrench size={14} style={{ color: token.colorTextSecondary }} />
                    <Switch
                      size="small"
                      checked={useSkills}
                      onChange={setUseSkills}
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
              {streaming && (streamingText || streamingSkillCalls.length > 0) && (
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
                  <div className="max-w-[75%] flex flex-col gap-2">
                    {streamingSkillCalls.length > 0 && (
                      <SkillCallList calls={streamingSkillCalls} token={token} defaultOpen />
                    )}
                    {streamingText && (
                      <div
                        className="px-3 py-2 rounded-lg text-sm ai-markdown"
                        style={{
                          background: token.colorBgContainer,
                          color: token.colorText,
                        }}
                      >
                        <Markdown>{streamingText}</Markdown>
                        <span className="inline-block w-1.5 h-4 ml-0.5 animate-pulse" style={{ background: token.colorPrimary }} />
                      </div>
                    )}
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
  // T-004: 历史消息里如果有 skill_calls_json 就反序列化出来展示
  let skillCalls: SkillCall[] = [];
  if (msg.skill_calls) {
    try {
      skillCalls = JSON.parse(msg.skill_calls);
    } catch {
      // 静默忽略：坏数据不阻断消息渲染
    }
  }

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
      <div className={`max-w-[75%] flex flex-col gap-2 ${isUser ? "items-end" : "items-start"}`}>
        {/* Skill 调用折叠卡片（在气泡上方） */}
        {skillCalls.length > 0 && (
          <SkillCallList calls={skillCalls} token={token} />
        )}

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
            className="text-xs flex items-center gap-1"
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

/** Skill 调用列表（折叠卡片）
 *
 * 一组工具调用整体默认折叠：头部显示"🔧 调用了 N 个工具"，展开后逐条列出
 * 参数和结果。流式进行中（`defaultOpen`）自动展开，让用户能看到 running 过程。
 */
function SkillCallList({
  calls,
  token,
  defaultOpen = false,
}: {
  calls: SkillCall[];
  token: any;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hasRunning = calls.some((c) => c.status === "running");
  const hasError = calls.some((c) => c.status === "error");

  return (
    <div
      className="rounded-md text-xs"
      style={{
        background: token.colorFillQuaternary,
        border: `1px solid ${token.colorBorderSecondary}`,
        minWidth: 260,
      }}
    >
      <button
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left"
        style={{ color: token.colorTextSecondary }}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Wrench size={12} style={{ color: token.colorPrimary }} />
        <span>
          AI 调用了 {calls.length} 个工具
        </span>
        {hasRunning && (
          <Loader2 size={12} className="animate-spin" style={{ color: token.colorPrimary }} />
        )}
        {!hasRunning && hasError && (
          <XCircle size={12} style={{ color: token.colorError }} />
        )}
        {!hasRunning && !hasError && (
          <CheckCircle2 size={12} style={{ color: token.colorSuccess }} />
        )}
      </button>
      {open && (
        <div
          style={{
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            padding: 8,
          }}
        >
          {calls.map((c) => (
            <SkillCallItem key={c.id} call={c} token={token} />
          ))}
        </div>
      )}
    </div>
  );
}

function SkillCallItem({ call, token }: { call: SkillCall; token: any }) {
  const statusIcon = (() => {
    if (call.status === "running")
      return <Loader2 size={11} className="animate-spin" style={{ color: token.colorPrimary }} />;
    if (call.status === "error")
      return <XCircle size={11} style={{ color: token.colorError }} />;
    return <CheckCircle2 size={11} style={{ color: token.colorSuccess }} />;
  })();

  // 参数 JSON 尽量美化一下；解析失败就原样显示
  let prettyArgs = call.argsJson;
  try {
    prettyArgs = JSON.stringify(JSON.parse(call.argsJson), null, 2);
  } catch {
    // keep original
  }

  return (
    <div className="mb-1.5 last:mb-0">
      <div className="flex items-center gap-1.5 mb-1" style={{ color: token.colorText }}>
        {statusIcon}
        <code
          style={{
            background: token.colorFillTertiary,
            padding: "1px 4px",
            borderRadius: 3,
            fontFamily: "var(--font-mono, monospace)",
          }}
        >
          {call.name}
        </code>
      </div>
      <pre
        className="whitespace-pre-wrap break-all"
        style={{
          margin: 0,
          fontSize: 11,
          color: token.colorTextSecondary,
          fontFamily: "var(--font-mono, monospace)",
          maxHeight: 160,
          overflow: "auto",
          padding: "4px 6px",
          background: token.colorBgContainer,
          borderRadius: 3,
        }}
      >
        {prettyArgs}
        {call.result && call.status !== "running" && (
          <>
            {"\n\n→ "}
            {truncateForDisplay(call.result, 500)}
          </>
        )}
      </pre>
    </div>
  );
}

function truncateForDisplay(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `…（共 ${s.length} 字符）`;
}
