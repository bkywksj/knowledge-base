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
import type { MenuProps } from "antd";
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
  Paperclip,
  Save,
  X,
} from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useNavigate, useLocation } from "react-router-dom";
import { aiChatApi, aiModelApi, noteApi } from "@/lib/api";
import type { AiConversation, AiMessage, AiModel, Note, SkillCall } from "@/types";
import { relativeTime } from "@/lib/utils";
import { stripPseudoToolCalls } from "@/lib/aiFilter";

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
  const navigate = useNavigate();
  const location = useLocation();

  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<number | null>(null);
  // 双击会话进入重命名态：editingConvId 标识哪条在编辑，editingTitle 是受控值
  const [editingConvId, setEditingConvId] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  async function commitRenameConversation() {
    if (editingConvId == null) return;
    const id = editingConvId;
    const title = editingTitle.trim();
    setEditingConvId(null);
    setEditingTitle("");
    // 空标题视为取消
    if (!title) return;
    const original = conversations.find((c) => c.id === id);
    if (!original || original.title === title) return;
    try {
      await aiChatApi.renameConversation(id, title);
      // 局部更新避免整列表抖动；后端是 source-of-truth，下一次 list 会校正
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, title } : c)),
      );
    } catch (e) {
      message.error(`重命名失败: ${e}`);
    }
  }
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [models, setModels] = useState<AiModel[]>([]);
  const [inputText, setInputText] = useState("");
  const [useRag, setUseRag] = useState(true);
  // T-004: Skills 框架开关。启用时 RAG 自动关（AI 自己调 search_notes）
  const [useSkills, setUseSkills] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  // 附加笔记（A 方向）：当前对话的 attached_note_ids 对应的完整笔记对象
  const [attachedNotes, setAttachedNotes] = useState<Note[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  // 归档（B 方向）：把对话存为笔记的 Modal
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveTitle, setArchiveTitle] = useState("");
  const [archiving, setArchiving] = useState(false);
  // 流式过程中 AI 调用的工具列表（带 running/ok/error 状态）；done 后并入 messages 清空
  const [streamingSkillCalls, setStreamingSkillCalls] = useState<SkillCall[]>([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const unlistenRefs = useRef<UnlistenFn[]>([]);
  // 跟踪组件挂载状态：handleSend 内每个 await listen 之后检查，
  // 若 unmounted 则立即 unlisten 避免泄漏 + 后续 setState 报警告
  const mountedRef = useRef(true);

  // 初始化
  useEffect(() => {
    loadConversations();
    loadModels();
    return () => {
      mountedRef.current = false;
      unlistenRefs.current.forEach((fn) => fn());
      unlistenRefs.current = [];
    };
  }, []);

  // 待发送的自动 prompt（首页"问 AI"入口跳过来时携带）
  // 等 activeConvId 切到目标对话后再触发 handleSend(prompt)
  const pendingAutoSendRef = useRef<{ convId: number; prompt: string } | null>(
    null,
  );

  // 接收外部跳转过来的"激活对话 ID"（笔记列表"发到 AI" / 首页"问 AI" 入口）
  // 拿到一次后清掉 state，避免用户后续再切回 AI 页又被自动跳走
  useEffect(() => {
    const state = location.state as
      | { activeConvId?: number; pendingPrompt?: string }
      | null;
    const incomingId = state?.activeConvId;
    if (incomingId) {
      setActiveConvId(incomingId);
      // 触发对话列表刷新让 chip 区拿到 attached_note_ids
      loadConversations();
      if (state?.pendingPrompt) {
        pendingAutoSendRef.current = {
          convId: incomingId,
          prompt: state.pendingPrompt,
        };
      }
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.state]);

  // 切换对话时加载消息
  useEffect(() => {
    if (activeConvId) {
      loadMessages(activeConvId);
    } else {
      setMessages([]);
    }
  }, [activeConvId]);

  // 切换对话时同步「附加笔记」chips：从对话的 attached_note_ids 拉对应笔记对象
  // conversations 列表更新时也跟随（用户在 Modal 里改完会通过 loadConversations 触发重拉）
  useEffect(() => {
    const conv = conversations.find((c) => c.id === activeConvId);
    const ids = conv?.attached_note_ids ?? [];
    if (ids.length === 0) {
      setAttachedNotes([]);
      return;
    }
    let cancelled = false;
    Promise.all(
      ids.map((id) =>
        noteApi.get(id).catch(() => null),
      ),
    ).then((arr) => {
      if (cancelled) return;
      // 过滤掉拉取失败的（笔记被删了）
      setAttachedNotes(arr.filter((n): n is Note => n !== null));
    });
    return () => {
      cancelled = true;
    };
  }, [activeConvId, conversations]);

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

  /** A 方向：移除单条挂载笔记（从 chip 区点 × 触发） */
  async function handleRemoveAttached(noteId: number) {
    if (!activeConvId) return;
    const newIds = attachedNotes.filter((n) => n.id !== noteId).map((n) => n.id);
    try {
      await aiChatApi.setAttachedNotes(activeConvId, newIds);
      // 重新拉对话列表让 useEffect 重计算 chips
      await loadConversations();
    } catch (e) {
      message.error(`移除失败: ${e}`);
    }
  }

  /** A 方向：Modal 里点确认提交新的挂载列表 */
  async function handleAttachConfirm(ids: number[]) {
    if (!activeConvId) return;
    try {
      await aiChatApi.setAttachedNotes(activeConvId, ids);
      await loadConversations();
      setAttachOpen(false);
      message.success(
        ids.length === 0 ? "已清空附加笔记" : `已附加 ${ids.length} 篇笔记`,
      );
    } catch (e) {
      message.error(`保存失败: ${e}`);
    }
  }

  /** B 方向：归档当前对话为一篇笔记 */
  async function handleArchiveConfirm() {
    if (!activeConvId) return;
    setArchiving(true);
    try {
      const note = await aiChatApi.archiveToNote(
        activeConvId,
        archiveTitle.trim() || undefined,
      );
      message.success("已归档为笔记");
      setArchiveOpen(false);
      setArchiveTitle("");
      // 顺手跳到新建的笔记编辑器，方便用户立刻整理
      navigate(`/notes/${note.id}`);
    } catch (e) {
      message.error(`归档失败: ${e}`);
    } finally {
      setArchiving(false);
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

  /** 批量清理：days = undefined 全清，否则清理 N 天前未活动的对话；走二次确认 */
  function handleCleanupConversations(days: number | undefined) {
    const title = days == null ? "清空全部对话？" : `清理 ${days} 天前未活动的对话？`;
    const content =
      days == null
        ? "所有对话及其消息将被永久删除，且不可恢复。"
        : `所有 ${days} 天内没有活动的对话将被永久删除，且不可恢复。`;
    Modal.confirm({
      title,
      content,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        try {
          const removed = await aiChatApi.deleteConversationsBefore(days);
          if (removed === 0) {
            message.info("没有符合条件的对话");
            return;
          }
          message.success(`已清理 ${removed} 条对话`);
          // 拉新列表；若当前激活会话已被清掉，清空选中避免聊天区残留旧消息
          const fresh = await aiChatApi.listConversations();
          setConversations(fresh);
          if (activeConvId != null && !fresh.some((c) => c.id === activeConvId)) {
            setActiveConvId(null);
          }
        } catch (e) {
          message.error(`清理失败: ${e}`);
        }
      },
    });
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

  const handleSend = useCallback(async (textOverride?: string) => {
    const raw = textOverride ?? inputText;
    const text = raw.trim();
    if (!text || !activeConvId || streaming) return;
    if (!textOverride) setInputText("");
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

    // 每个 listen 注册后立即 push 到 unlistenRefs，避免一次性赋值时
    // 中间 await 期间 unmount 导致前面 listener 泄漏。
    // 同时检查 mountedRef，unmounted 后立即 unlisten 不再 push。
    const safeRegister = async <T,>(
      event: string,
      handler: (e: { payload: T }) => void,
    ) => {
      const fn = await listen<T>(event, handler);
      if (mountedRef.current) {
        unlistenRefs.current.push(fn);
      } else {
        fn(); // 已 unmount → 立即解绑
      }
    };

    await safeRegister<string>("ai:token", (event) => {
      setStreamingText((prev) => prev + event.payload);
    });
    await safeRegister<unknown>("ai:done", async () => {
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
    await safeRegister<string>("ai:error", async (event) => {
      setStreaming(false);
      await cleanup();
      setStreamingText("");
      setStreamingSkillCalls([]);
      message.error(`AI 错误: ${event.payload}`);
    });
    // T-004: tool_call 事件可能多次触发（running → ok/error）
    await safeRegister<SkillCall>("ai:tool_call", (event) => {
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

  // handleSend 是 useCallback,闭包会随依赖变化重新生成；
  // pendingAutoSend 触发时需要拿最新的 handleSend,用 ref 桥接
  const handleSendRef = useRef(handleSend);
  useEffect(() => {
    handleSendRef.current = handleSend;
  }, [handleSend]);

  // activeConvId 切到目标对话且未在 streaming → 触发待发送的 prompt
  useEffect(() => {
    const pending = pendingAutoSendRef.current;
    if (!pending) return;
    if (activeConvId !== pending.convId) return;
    if (streaming) return;
    pendingAutoSendRef.current = null;
    // microtask 让 handleSendRef 收到最新闭包(activeConvId 变化触发的 useCallback 重建)
    Promise.resolve().then(() => handleSendRef.current(pending.prompt));
  }, [activeConvId, streaming, handleSend]);

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
        <div className="p-3 shrink-0 flex items-center gap-2">
          <Button
            type="primary"
            icon={<Plus size={14} />}
            className="flex-1"
            onClick={handleNewConversation}
          >
            新对话
          </Button>
          <Dropdown
            menu={{
              items: [
                {
                  key: "clean-7d",
                  label: "清理 7 天前未活动",
                  onClick: () => handleCleanupConversations(7),
                },
                {
                  key: "clean-30d",
                  label: "清理 30 天前未活动",
                  onClick: () => handleCleanupConversations(30),
                },
                { type: "divider" },
                {
                  key: "clean-all",
                  label: "清空全部对话",
                  danger: true,
                  onClick: () => handleCleanupConversations(undefined),
                },
              ],
            }}
            trigger={["click"]}
            placement="bottomRight"
          >
            <Tooltip title="批量清理">
              <Button icon={<MoreHorizontal size={14} />} />
            </Tooltip>
          </Dropdown>
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
            conversations.map((conv) => {
              const isActive = activeConvId === conv.id;
              // 同一组卡片操作复用给两处 trigger：右键整条 + 点击 MoreHorizontal
              // 阻止 e.domEvent 冒泡，避免触发 div 的 onClick 切换会话
              const convMenuItems: MenuProps["items"] = [
                {
                  key: "rename",
                  label: "重命名",
                  icon: <Edit3 size={12} />,
                  onClick: (e) => {
                    e.domEvent.stopPropagation();
                    setEditingConvId(conv.id);
                    setEditingTitle(conv.title);
                  },
                },
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
              ];
              return (
              <Dropdown
                key={conv.id}
                menu={{ items: convMenuItems }}
                trigger={["contextMenu"]}
              >
              <div
                className="ai-conv-item flex items-center gap-2 px-3 py-2 cursor-pointer group mb-1"
                style={{
                  background: isActive ? token.colorPrimaryBg : "transparent",
                  color: token.colorText,
                  borderRadius: 10,
                  transition: "background 0.15s ease",
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLDivElement).style.background = token.colorFillTertiary;
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLDivElement).style.background = "transparent";
                  }
                }}
                onClick={() => setActiveConvId(conv.id)}
              >
                <MessageSquare
                  size={14}
                  style={{ flexShrink: 0, color: token.colorTextSecondary }}
                />
                <div className="flex-1 min-w-0">
                  {editingConvId === conv.id ? (
                    // 重命名输入框：Enter / 失焦提交；Esc 放弃；点击不冒泡到 div 切换会话
                    <Input
                      autoFocus
                      size="small"
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onPressEnter={commitRenameConversation}
                      onBlur={commitRenameConversation}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.stopPropagation();
                          setEditingConvId(null);
                          setEditingTitle("");
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                      style={{ fontSize: 13, padding: "2px 6px" }}
                    />
                  ) : (
                    <div
                      className="text-sm truncate select-none"
                      onDoubleClick={(e) => {
                        // 双击重命名：阻止冒泡避免 div 的 onClick 切换会话；
                        // select-none + e.preventDefault 阻止双击选中文本
                        e.stopPropagation();
                        e.preventDefault();
                        setEditingConvId(conv.id);
                        setEditingTitle(conv.title);
                      }}
                      title="双击重命名"
                    >
                      {conv.title}
                    </div>
                  )}
                  <div
                    className="text-xs"
                    style={{ color: token.colorTextQuaternary }}
                  >
                    {relativeTime(conv.updated_at)}
                  </div>
                </div>
                <button
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-black/5 transition-opacity"
                  onClick={(e) => {
                    // 不切换会话；不冒泡到外层 contextMenu Dropdown 的 click 监听
                    e.stopPropagation();
                    // 把"点三个点"翻译成一次右键事件，让外层 Dropdown
                    // (trigger=contextMenu) 接住——单一 Dropdown 实例，
                    // 不会出现"右键菜单 + 点三点菜单"两层并存的情况
                    const ev = new MouseEvent("contextmenu", {
                      bubbles: true,
                      cancelable: true,
                      view: window,
                      button: 2,
                      clientX: e.clientX,
                      clientY: e.clientY,
                    });
                    e.currentTarget.dispatchEvent(ev);
                  }}
                >
                  <MoreHorizontal size={14} />
                </button>
              </div>
              </Dropdown>
              );
            })
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
                {/* B 方向：把整个对话归档成笔记 */}
                <Tooltip title="把整个对话归档成一篇笔记">
                  <Button
                    size="small"
                    type="text"
                    icon={<Save size={14} />}
                    disabled={messages.length === 0 || streaming}
                    onClick={() => {
                      // 默认标题用对话现有 title（首问截短）
                      const conv = conversations.find((c) => c.id === activeConvId);
                      setArchiveTitle(conv?.title ?? "");
                      setArchiveOpen(true);
                    }}
                  >
                    存为笔记
                  </Button>
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

              {/* 流式响应中 —— 渲染前剥掉伪 tool_call 残文（与 Rust 侧 strip_pseudo_tool_calls
                  同口径），避免最后一轮模型退化输出的 XML/围栏标签直接秀给用户 */}
              {streaming && (() => {
                const cleanText = stripPseudoToolCalls(streamingText);
                if (!cleanText && streamingSkillCalls.length === 0) return null;
                return (
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
                      {cleanText && (
                        <div
                          className="px-3 py-2 rounded-lg text-sm ai-markdown"
                          style={{
                            background: token.colorBgContainer,
                            color: token.colorText,
                          }}
                        >
                          <Markdown>{cleanText}</Markdown>
                          <span className="inline-block w-1.5 h-4 ml-0.5 animate-pulse" style={{ background: token.colorPrimary }} />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}

              <div ref={messagesEndRef} />
            </div>

            {/* 输入区域（上方为附加笔记 chip 区，强制塞进上下文） */}
            <div
              className="shrink-0 px-4 py-3"
              style={{
                borderTop: `1px solid ${token.colorBorderSecondary}`,
                background: token.colorBgContainer,
              }}
            >
              {/* 附加笔记 chip 区：仅在挂载了笔记时显示 */}
              {attachedNotes.length > 0 && (
                <div
                  className="flex flex-wrap items-center gap-1.5 mb-2 pb-2"
                  style={{
                    borderBottom: `1px dashed ${token.colorBorderSecondary}`,
                  }}
                >
                  <span
                    className="text-xs shrink-0"
                    style={{ color: token.colorTextSecondary }}
                  >
                    📎 已附加：
                  </span>
                  {attachedNotes.map((n) => (
                    <span
                      key={n.id}
                      className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
                      style={{
                        background: token.colorPrimaryBg,
                        color: token.colorPrimary,
                        maxWidth: 180,
                      }}
                    >
                      <span className="truncate">{n.title || "未命名"}</span>
                      <X
                        size={11}
                        style={{ cursor: "pointer", flexShrink: 0 }}
                        onClick={() => handleRemoveAttached(n.id)}
                      />
                    </span>
                  ))}
                </div>
              )}

              <div className="flex gap-2 items-end">
                <Tooltip title="附加笔记到本对话上下文（整对话共享）">
                  <Button
                    icon={<Paperclip size={16} />}
                    onClick={() => setAttachOpen(true)}
                    disabled={streaming}
                  />
                </Tooltip>
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
                    onClick={() => handleSend()}
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

      {/* A 方向：附加笔记选择 Modal */}
      <AttachNotesModal
        open={attachOpen}
        currentIds={attachedNotes.map((n) => n.id)}
        onClose={() => setAttachOpen(false)}
        onConfirm={handleAttachConfirm}
      />

      {/* B 方向：归档对话 Modal */}
      <Modal
        title="把对话归档为笔记"
        open={archiveOpen}
        onCancel={() => setArchiveOpen(false)}
        onOk={handleArchiveConfirm}
        confirmLoading={archiving}
        okText="归档并打开"
        cancelText="取消"
        destroyOnHidden
      >
        <div className="flex flex-col gap-3">
          <div className="text-sm" style={{ color: token.colorTextSecondary }}>
            会把本对话所有消息按 Q/A 顺序拼成 markdown 存为一篇新笔记，并跳到编辑器。
          </div>
          <Input
            value={archiveTitle}
            onChange={(e) => setArchiveTitle(e.target.value)}
            placeholder="笔记标题（留空则用对话标题）"
            maxLength={120}
          />
        </div>
      </Modal>
    </div>
  );
}

/** A 方向：附加笔记多选 Modal — 复用 noteApi.list 拉全部，前端 Select multiple 多选搜索 */
function AttachNotesModal({
  open,
  currentIds,
  onClose,
  onConfirm,
}: {
  open: boolean;
  currentIds: number[];
  onClose: () => void;
  onConfirm: (ids: number[]) => void;
}) {
  const [allNotes, setAllNotes] = useState<Note[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);

  // 打开时拉全部笔记 + 把当前已挂载的 ID 同步到选择器
  useEffect(() => {
    if (!open) return;
    setSelected(currentIds);
    setLoading(true);
    noteApi
      .list({ page: 1, page_size: 500 })
      .then((res) => setAllNotes(res.items))
      .catch((e) => message.error(`加载笔记失败: ${e}`))
      .finally(() => setLoading(false));
  }, [open, currentIds]);

  return (
    <Modal
      title="附加笔记到对话上下文"
      open={open}
      onCancel={onClose}
      onOk={() => onConfirm(selected)}
      okText={`确认（已选 ${selected.length}）`}
      cancelText="取消"
      width={560}
      destroyOnHidden
    >
      <div className="flex flex-col gap-2">
        <div className="text-xs" style={{ color: "#888" }}>
          被选中的笔记会作为本对话的强制上下文（整个对话共享）。
          每篇按 60% 模型上下文的均分预算自动截断。
        </div>
        <Select
          mode="multiple"
          showSearch
          value={selected}
          onChange={setSelected}
          loading={loading}
          placeholder="搜索 / 选择笔记…"
          style={{ width: "100%" }}
          maxTagCount={5}
          maxTagPlaceholder={(omitted) => `+${omitted.length}`}
          filterOption={(input, option) =>
            String(option?.label ?? "")
              .toLowerCase()
              .includes(input.toLowerCase())
          }
          options={allNotes.map((n) => ({
            value: n.id,
            label: n.title || `笔记 #${n.id}`,
          }))}
        />
      </div>
    </Modal>
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

      {/* 内容
          min-w-0：默认 flex 子项 min-width: auto = 内容固有宽度，会顶破 max-w-[75%]；
          手动归零才能让 max-width 生效，长文本/无空格长串才能被裁到 75% 以内。 */}
      <div className={`max-w-[75%] min-w-0 flex flex-col gap-2 ${isUser ? "items-end" : "items-start"}`}>
        {/* Skill 调用折叠卡片（在气泡上方） */}
        {skillCalls.length > 0 && (
          <SkillCallList calls={skillCalls} token={token} />
        )}

        <div
          className={`px-3 py-2 rounded-lg text-sm break-words ${isUser ? "whitespace-pre-wrap" : "ai-markdown"}`}
          style={{
            background: isUser ? token.colorPrimary : token.colorBgContainer,
            color: isUser ? "#fff" : token.colorText,
            // overflowWrap: anywhere 比 break-word 更激进：连无空格的纯英文长串
            // （如 DOI / URL）也能在任意字符处断行，避免气泡被撑开溢出聊天区
            overflowWrap: "anywhere",
            maxWidth: "100%",
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
