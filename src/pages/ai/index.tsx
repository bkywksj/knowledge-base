import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Button,
  Input,
  Empty,
  message,
  Modal,
  Select,
  Switch,
  Checkbox,
  Tooltip,
  Dropdown,
  TreeSelect,
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
  ChevronsDownUp,
  Paperclip,
  Save,
  X,
  Copy,
  Quote,
  FolderOpen,
} from "lucide-react";
import { CloseCircleFilled } from "@ant-design/icons";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useNavigate, useLocation } from "react-router-dom";
import {
  aiChatApi,
  aiModelApi,
  noteApi,
  aiAttachmentApi,
  folderApi,
  dailyApi,
  promptApi,
} from "@/lib/api";
import { useAppStore } from "@/store";
import type {
  AiConversation,
  AiMessage,
  AiModel,
  AttachmentPreview,
  DailyEntry,
  Folder,
  MessageAttachment,
  Note,
  PromptTemplate,
  SkillCall,
} from "@/types";
import { AttachmentChip } from "@/components/ai/AttachmentChip";
import { TurnCard } from "@/components/ai/TurnCard";
import {
  liveAppendReasoning,
  liveAppendToken,
  liveStartRound,
  liveUpsertCall,
  newLiveTurn,
  turnFromLive,
  turnFromMessage,
  type LiveTurn,
  type TurnView,
} from "@/components/ai/turnModel";
import { MicButton } from "@/components/MicButton";

/** 多附件总字符上限：超过则阻止再加，避免炸 context window */
const TOTAL_ATTACHMENT_CHAR_LIMIT = 80_000;

/** 把前端 AttachmentPreview 转成后端期望的 MessageAttachment（按 kind 分发字段） */
function previewToMessageAttachment(a: AttachmentPreview): MessageAttachment {
  switch (a.kind) {
    case "excel":
      return {
        kind: "excel",
        filePath: a.filePath,
        displayName: a.displayName,
        markdown: a.markdown,
        totalRows: a.totalRows,
        truncatedSheets: a.truncatedSheets,
      };
    case "text":
      return {
        kind: "text",
        filePath: a.filePath,
        displayName: a.displayName,
        content: a.content,
        truncated: a.truncated,
      };
    case "pdf":
      return {
        kind: "pdf",
        filePath: a.filePath,
        displayName: a.displayName,
        content: a.content,
        truncated: a.truncated,
      };
  }
}
import { relativeTime } from "@/lib/utils";
import { useContextMenu } from "@/hooks/useContextMenu";
import {
  ContextMenuOverlay,
  type ContextMenuEntry,
} from "@/components/ui/ContextMenuOverlay";

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

function DesktopAiChatPage() {
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
  // 智能模式：默认开启 = 让 LLM 自己调 search_notes / list_tags / get_today_tasks
  // 等内置工具 + 所有外部 MCP 工具。关掉就是纯聊天（不接入任何知识库）。
  //
  // 设计上不再区分"RAG 模式 / Skills 模式"——RAG 本质就是预先调一次 search_notes，
  // Skills 让 LLM 按需调，是 RAG 的超集。把选择权交给 LLM，用户只管开关。
  const [useSkills, setUseSkills] = useState(true);
  // AI 写权限：默认 true（保留旧 UX）。关掉后内置 MCP 的 11 个写工具会在 Rust 侧被拦截。
  // 真相在 app_config.ai_writable，启动时已 loadAiWritable() 同步过。
  const aiWritable = useAppStore((s) => s.aiWritable);
  const setAiWritable = useAppStore((s) => s.setAiWritable);
  // 当前正在流式生成的会话 ID（null = 没有进行中的流）。
  // 用它而不是单纯的 boolean，是为了支持「会话 A 流式中途切到会话 B」：
  // - 后端的 ai:token / ai:error 事件现在带 conversationId，前端按 activeConvId 过滤，
  //   A 后续吐的 token 不会再贴到 B 上（多会话串台 Bug）
  // - "停止"按钮 / 流式气泡 / 输入框禁用只对「正在被查看的那个会话」生效
  const [streamingConvId, setStreamingConvId] = useState<number | null>(null);
  // 正在生成的这一轮：按 ai:round / ai:token / ai:tool_call / ai:reasoning 累积，
  // 渲染成与历史回复同一种 TurnCard；ai:done 后清空，改由落库的那条消息接管
  const [live, setLive] = useState<LiveTurn | null>(null);
  // 「编辑重发」：正在编辑的那条提问 id。发送时先撤回它及之后的消息再发
  const [editingFrom, setEditingFrom] = useState<AiMessage | null>(null);
  // 「全部收起」：每点一次加 1，各卡片据此收起执行过程
  const [collapseSignal, setCollapseSignal] = useState(0);
  // 附加笔记（A 方向）：当前对话的 attached_note_ids 对应的完整笔记对象
  const [attachedNotes, setAttachedNotes] = useState<Note[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  /**
   * 角色预设（v50）：复用提示词库（设置 → 提示词）里的条目当"系统角色"。
   * 选中后由后端在每轮请求把该提示词追加到 system prompt 末尾——
   * 前端只负责选，不参与拼接。
   */
  const [presets, setPresets] = useState<PromptTemplate[]>([]);
  useEffect(() => {
    promptApi
      .list(true)
      .then(setPresets)
      .catch(() => setPresets([]));
  }, []);

  // 文件夹范围（scope_folder_id）：AI 页"附加文件夹"按钮 → 选文件夹 → 限定 RAG 检索范围
  const [scopeModalOpen, setScopeModalOpen] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [scopePick, setScopePick] = useState<number | undefined>(undefined);
  // 归档（B 方向）：把对话存为笔记的 Modal
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveTitle, setArchiveTitle] = useState("");
  const [archiving, setArchiving] = useState(false);
  // 路线 A 会话附件：当前输入框「待发送」的附件列表（Excel/Text/PDF 混合），发送后清空
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentPreview[]>([]);
  const [attachingFile, setAttachingFile] = useState(false);

  // ─── 消息气泡右键菜单 ────────────────────────
  const msgCtx = useContextMenu<AiMessage>();

  const msgMenuItems: ContextMenuEntry[] = useMemo(() => {
    const m = msgCtx.state.payload;
    if (!m) return [];
    return [
      {
        key: "copy",
        label: "复制内容",
        icon: <Copy size={13} />,
        onClick: () => {
          msgCtx.close();
          navigator.clipboard
            .writeText(m.content)
            .then(() => message.success("已复制"))
            .catch((e) => message.error(`复制失败：${e}`));
        },
      },
      {
        key: "copy-quote",
        label: "复制为引用块",
        icon: <Quote size={13} />,
        onClick: () => {
          msgCtx.close();
          // 每行前加 "> " 转 markdown 引用，方便贴回笔记保留出处
          const quoted = m.content
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n");
          navigator.clipboard
            .writeText(quoted)
            .then(() => message.success("已复制为引用"))
            .catch((e) => message.error(`复制失败：${e}`));
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgCtx.state.payload]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  // 跟踪组件挂载状态（防 setState on unmounted）
  const mountedRef = useRef(true);
  // activeConvId 的 ref 镜像 —— 给 mount-once 的 ai:* 事件 handler 用，避免闭包陷阱
  const activeConvIdRef = useRef<number | null>(null);
  // streamingConvId 的 ref 镜像 —— 同上，handler 里靠它判断事件属不属于当前流
  const streamingConvIdRef = useRef<number | null>(null);

  // 「正在被查看的会话是否在流式生成」：流式状态绑到具体会话，切到别的会话就视为没在流。
  // 输入框禁用 / "停止"按钮 / 流式气泡都用这个 derived 值，不再用全局 boolean。
  const streaming = streamingConvId !== null && streamingConvId === activeConvId;

  // 初始化
  useEffect(() => {
    loadConversations();
    loadModels();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ─── 全局 ai:* 事件监听（mount once） ─────────────────────────
  //
  // 历史 bug：之前在 handleSend 里 await listen() 4 次再 await sendMessage。
  // - 切走时 useEffect cleanup → unlisten → 流式 token 丢失 → 切回只能 loadMessages
  //   看到完整答案，streaming 期间 UI 一直空白
  // - 4 次串行 await listen() 的 100~200ms 注册延迟期间如果上游就开始流，可能丢前几个 token
  //
  // 修复：listen 提到顶层，整个组件生命周期内只注册一次。
  // 切走 → 组件 unmount → cleanup unlisten；切回 mount → 重新 listen，无需依赖 send。
  // 各 setter 是 stable 引用，闭包陷阱不存在；activeConvId 通过 ref 镜像拿最新。
  useEffect(() => {
    let unlistens: UnlistenFn[] = [];
    let cancelled = false;

    // 只把事件记到「它所属会话」的流式卡片上：payload 都带 conversationId，
    // 会话 A 流式还没完就切到 / 新建会话 B 时，A 后续的事件不能贴到 B 上（多会话串台 Bug）。
    // 按流式会话而不是「正在看的会话」过滤：切走再切回来，A 的卡片照样是完整的。
    const updateLive = (cid: number, fn: (t: LiveTurn) => LiveTurn) =>
      setLive((prev) => (prev && prev.convId === cid ? fn(prev) : prev));

    (async () => {
      const roundUnlisten = await listen<{ conversationId: number; round: number }>(
        "ai:round",
        (event) => updateLive(event.payload.conversationId, (t) => liveStartRound(t, event.payload.round)),
      );
      const tokenUnlisten = await listen<{ conversationId: number; content: string }>(
        "ai:token",
        (event) => updateLive(event.payload.conversationId, (t) => liveAppendToken(t, event.payload.content)),
      );
      // tool_call 事件可能多次触发（running → ok/error），按 id upsert
      const toolCallUnlisten = await listen<SkillCall & { conversationId: number }>(
        "ai:tool_call",
        (event) => updateLive(event.payload.conversationId, (t) => liveUpsertCall(t, event.payload)),
      );
      const reasoningUnlisten = await listen<{ conversationId: number; content: string }>(
        "ai:reasoning",
        (event) =>
          updateLive(event.payload.conversationId, (t) => liveAppendReasoning(t, event.payload.content)),
      );
      const doneUnlisten = await listen<number>("ai:done", async (event) => {
        const cid = event.payload;
        // 不管哪个会话结束都刷一下侧边栏（标题可能自动改了 / updated_at 变了导致排序变）
        await loadConversations();
        // 只在"结束的会话正是当前查看的会话"时重拉消息列表；其它会话切回去时自然会 loadMessages。
        // 先拿到列表、再在同一个同步块里「换上新列表 + 撤掉流式卡片」：两个 setState 被合并成
        // 一次渲染，不会出现新卡片和流式卡片同时在屏上的那一帧
        const list =
          cid === activeConvIdRef.current
            ? await aiChatApi.listMessages(cid).catch((e) => {
                message.error(`加载消息失败: ${e}`);
                return null;
              })
            : null;
        if (list) setMessages(list);
        // 结束的会话正是当前流式的会话 → 清掉流式状态（此时这一轮已经落库，由消息列表接管）
        if (cid === streamingConvIdRef.current) {
          streamingConvIdRef.current = null;
          setStreamingConvId(null);
          setLive(null);
        }
      });
      // 不再监听 ai:error：失败以 send_ai_message 的 reject 为准（见 handleSend 的 catch）。
      // 上下文超长时后端会先发一次 ai:error 再自动减历史重试，按事件收尾会把一次能成功的回复
      // 提前判死；而最终失败时后端已把错误存成这一轮的卡片，不需要事件来驱动 UI。

      if (cancelled) {
        // 注册期间已 unmount，立即解绑
        roundUnlisten();
        tokenUnlisten();
        toolCallUnlisten();
        reasoningUnlisten();
        doneUnlisten();
      } else {
        unlistens = [roundUnlisten, tokenUnlisten, toolCallUnlisten, reasoningUnlisten, doneUnlisten];
      }
    })();

    return () => {
      cancelled = true;
      unlistens.forEach((fn) => fn());
    };
    // 故意空依赖：mount once。state setters 都是 stable，
    // activeConvId 通过 activeConvIdRef.current 拿最新值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 同步 activeConvId / streamingConvId 到 ref，给 mount-once 的 ai:* handler 用
  useEffect(() => {
    activeConvIdRef.current = activeConvId;
  }, [activeConvId]);
  useEffect(() => {
    streamingConvIdRef.current = streamingConvId;
  }, [streamingConvId]);

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
  }, [messages, live]);

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
        ids.length === 0 ? "已清空附加内容" : `已附加 ${ids.length} 项`,
      );
    } catch (e) {
      message.error(`保存失败: ${e}`);
    }
  }

  /** 打开"附加文件夹"Modal：加载文件夹树 + 回填当前范围 */
  function openScopeModal() {
    if (!activeConvId) return;
    const conv = conversations.find((c) => c.id === activeConvId);
    setScopePick(conv?.scope_folder_id ?? undefined);
    folderApi.list().then(setFolders).catch(() => setFolders([]));
    setScopeModalOpen(true);
  }

  /** 确认设置文件夹范围（RAG 检索限定到该文件夹及子孙）；scopePick 为空则清除范围 */
  async function handleConfirmScope() {
    if (!activeConvId) return;
    try {
      await aiChatApi.setScopeFolder(activeConvId, scopePick ?? null);
      await loadConversations();
      setScopeModalOpen(false);
      message.success(scopePick == null ? "已清除文件夹范围" : "已限定文件夹范围");
    } catch (e) {
      message.error(`设置范围失败: ${e}`);
    }
  }

  /** 范围 chip 上的 × ：清除文件夹范围，恢复全库检索 */
  async function handleClearScope() {
    if (!activeConvId) return;
    try {
      await aiChatApi.setScopeFolder(activeConvId, null);
      await loadConversations();
    } catch (e) {
      message.error(`清除范围失败: ${e}`);
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

  /**
   * 发送一条提问。
   *
   * @param textOverride 不传就取输入框
   * @param opts.resendFrom 「重新生成 / 编辑重发」：先撤回这条提问及之后的所有消息再发
   * @param opts.skipAttachments 重新生成时附件内容已经在原提问正文里了，别把输入框里待发的附件再塞一遍
   */
  const handleSend = useCallback(async (
    textOverride?: string,
    opts: { resendFrom?: AiMessage; skipAttachments?: boolean } = {},
  ) => {
    const raw = textOverride ?? inputText;
    const text = raw.trim();
    if (!text || !activeConvId || streaming) return;
    // 同步防重入：setStreamingConvId 是异步的，在 React 把「发送」按钮翻成「停止」、
    // 输入框置灰之前，用户狂点发送 / 连按 Enter 会带着 streaming=false 的旧闭包重复进来，
    // 造成同一句话被连发十几遍。streamingConvIdRef 上一次发送时已同步标记为本会话 id，
    // 用它挡住这些「渲染前」的重复发送（state 尚未翻转，但 ref 已经是最新值）。
    if (streamingConvIdRef.current === activeConvId) return;
    const convId = activeConvId;
    const resendFrom = opts.resendFrom ?? editingFrom ?? undefined;
    if (!textOverride) setInputText("");
    setEditingFrom(null);
    // 直接同步 ref：紧接着可能就有 ai:token 事件进来，得让 handler 立刻知道当前流式会话是谁
    streamingConvIdRef.current = convId;
    setStreamingConvId(convId);
    setLive(newLiveTurn(convId));

    if (resendFrom) {
      try {
        await aiChatApi.truncateFrom(convId, resendFrom.id);
      } catch (e) {
        streamingConvIdRef.current = null;
        setStreamingConvId(null);
        setLive(null);
        showAiError(e);
        return;
      }
    }

    // 乐观添加用户消息（撤回的那几条同时从列表里拿掉）
    const userMsg: AiMessage = {
      id: Date.now(),
      conversation_id: convId,
      role: "user",
      content: text,
      references: null,
      skill_calls: null,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [
      ...(resendFrom ? prev.filter((m) => m.id < resendFrom.id) : prev),
      userMsg,
    ]);

    // 注：ai:* 事件 listener 已经在顶层 useEffect 全局注册（mount once），
    // 这里只管发请求。事件流期间 live 会被全局 listener 持续刷新，无需再 register / cleanup。

    // 把 AttachmentPreview 按 kind 转成后端期望的 MessageAttachment
    const attachmentsPayload: MessageAttachment[] = opts.skipAttachments
      ? []
      : pendingAttachments.map(previewToMessageAttachment);

    try {
      // use_rag 永远传 false：智能模式下由 LLM 自己调 search_notes，
      // 不再走自动预召回（避免 token 浪费 + 让 LLM 有判断空间）。
      // 关掉智能模式时也不开 RAG，纯聊天体验最干净。
      await aiChatApi.sendMessage(
        convId,
        text,
        false,
        useSkills,
        attachmentsPayload.length > 0 ? attachmentsPayload : undefined,
      );
      // 发送成功后清空附件（失败时保留，让用户重试）
      if (!opts.skipAttachments) setPendingAttachments([]);
    } catch (e) {
      // 失败时 ai:done 不会来，这里收尾。
      // 仅当"当前流式会话还是我这次发起的那个"才清，避免误伤期间又开始的另一个会话的流。
      if (streamingConvIdRef.current === convId) {
        streamingConvIdRef.current = null;
        setStreamingConvId(null);
        setLive(null);
      }
      // 后端已把错误存成这一轮的卡片 → 重拉列表让卡片显示出来，不再另弹提示。
      // 模型没配好这类「提问都没存下」的早期失败没有卡片可挂，才退回弹窗。
      let shownOnCard = false;
      if (convId === activeConvIdRef.current) {
        try {
          const list = await aiChatApi.listMessages(convId);
          setMessages(list);
          const last = list[list.length - 1];
          shownOnCard = last?.role === "assistant" && turnFromMessage(last).status === "error";
        } catch {
          // 拉不到就走弹窗兜底
        }
      }
      if (!shownOnCard) showAiError(e);
    }
  }, [inputText, activeConvId, streaming, useSkills, pendingAttachments, editingFrom]);

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

  /**
   * 选一个或多个文件 → 后端按扩展名自动分发到 Excel/Text/PDF 解析器 → 加入附件列表。
   *
   * 总字符守门：累计 > TOTAL_ATTACHMENT_CHAR_LIMIT 时拒绝继续加，避免爆 context window。
   * 同名文件去重：filePath 已存在则跳过（用户重复点同一文件不会叠加）。
   */
  async function handleAddAttachment() {
    if (attachingFile || streaming) return;
    try {
      const picked = await openDialog({
        multiple: true,
        filters: [
          {
            name: "支持的文件",
            extensions: [
              "xlsx", "xls", "xlsm", "xlsb", "ods",
              "pdf",
              "md", "markdown", "txt", "json", "csv", "log",
            ],
          },
        ],
      });
      if (!picked) return;
      const paths = Array.isArray(picked) ? picked : [picked];
      if (paths.length === 0) return;

      setAttachingFile(true);
      const existingPaths = new Set(pendingAttachments.map((a) => a.filePath));
      let totalChars = pendingAttachments.reduce(
        (sum, a) => sum + a.charsEstimated,
        0,
      );

      const addedNames: string[] = [];
      const truncatedNames: string[] = [];
      const skippedTooLarge: string[] = [];
      const failed: string[] = [];

      for (const path of paths) {
        if (existingPaths.has(path)) continue;
        try {
          const preview = await aiAttachmentApi.parseAttachment(path);
          if (totalChars + preview.charsEstimated > TOTAL_ATTACHMENT_CHAR_LIMIT) {
            skippedTooLarge.push(preview.displayName);
            continue;
          }
          totalChars += preview.charsEstimated;
          existingPaths.add(path);
          setPendingAttachments((prev) => [...prev, preview]);
          addedNames.push(preview.displayName);
          if (
            (preview.kind === "excel" && preview.truncatedSheets.length > 0) ||
            (preview.kind !== "excel" && preview.truncated)
          ) {
            truncatedNames.push(preview.displayName);
          }
        } catch (e) {
          const fileName = path.split(/[\\/]/).pop() || path;
          failed.push(`${fileName}: ${e}`);
        }
      }

      if (addedNames.length > 0) {
        message.success(`已添加 ${addedNames.length} 个附件`);
      }
      if (truncatedNames.length > 0) {
        message.warning(
          `${truncatedNames.length} 个附件体积较大，已自动截断：${truncatedNames.join("、")}`,
        );
      }
      if (skippedTooLarge.length > 0) {
        message.error(
          `已跳过 ${skippedTooLarge.length} 个附件：累计字符将超过 ${Math.round(TOTAL_ATTACHMENT_CHAR_LIMIT / 1000)}k 上限`,
        );
      }
      if (failed.length > 0) {
        message.error(`${failed.length} 个文件解析失败：${failed.join("；")}`);
      }
    } catch (e) {
      message.error(`选择文件失败：${e}`);
    } finally {
      setAttachingFile(false);
    }
  }

  function handleRemoveAttachment(filePath: string) {
    setPendingAttachments((prev) => prev.filter((a) => a.filePath !== filePath));
  }

  async function handleCancel() {
    if (activeConvId) {
      try {
        await aiChatApi.cancelGeneration(activeConvId);
      } catch (e) {
        console.error("取消生成失败:", e);
      }
    }
  }

  // 每条 assistant 消息解析一次（skill_calls / turn_meta 的 JSON），别在每次流式刷新时重算
  const turnViews = useMemo(() => {
    const map = new Map<number, TurnView>();
    for (const m of messages) if (m.role === "assistant") map.set(m.id, turnFromMessage(m));
    return map;
  }, [messages]);

  /** 重新生成：撤回这一轮的提问及回答，用原提问再问一次 */
  function handleRegenerate(assistantIdx: number) {
    const question = messages
      .slice(0, assistantIdx)
      .reverse()
      .find((m) => m.role === "user");
    if (!question) {
      message.warning("找不到这条回答对应的提问");
      return;
    }
    // 原提问正文里已经拼好了附件内容，不能再带输入框里待发的附件
    handleSend(question.content, { resendFrom: question, skipAttachments: true });
  }

  /** 编辑重发：把提问放回输入框，发送时撤回它及之后的消息 */
  function startEdit(msg: AiMessage) {
    setEditingFrom(msg);
    setInputText(msg.content);
  }

  function cancelEdit() {
    setEditingFrom(null);
    setInputText("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const activeConv = conversations.find((c) => c.id === activeConvId);

  return (
    // kb-surface 挂在最外层：整页是「会话列表 + 顶栏/消息区/输入区」四块拼的，
    // 四块各自当独立玻璃面板会拼出硬接缝、且半透明叠加把不透明度乘上去。
    // 外层统一承载底色，内部四块走 kb-surface-clear 透明化。
    // borderRadius 让它在 Content 的 24px 留白里收成一张卡片，
    // 跟笔记列表（同样 borderRadius: 8）口径一致，不再是贴边的硬矩形。
    <div
      className="flex h-full kb-surface"
      style={{ overflow: "hidden", borderRadius: 8 }}
    >
      {/* 左侧对话列表 */}
      <div
        className="w-60 shrink-0 flex flex-col h-full kb-surface-clear"
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
              className="flex items-center justify-between px-4 py-2 shrink-0 kb-surface-clear"
              style={{
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
                background: token.colorBgContainer,
              }}
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {/* flex-1 + min-w-0 + truncate：标题占满左侧剩余空间但窄屏时优先省略号截断，
                    不再把右侧的模型选择 / 智能模式 / 存为笔记等控件挤出去 */}
                <span
                  className="font-medium truncate flex-1 min-w-0"
                  style={{ color: token.colorText }}
                  title={activeConv?.title || "对话"}
                >
                  {activeConv?.title || "对话"}
                </span>
                <Tooltip title="切换当前会话使用的模型服务">
                  <Select
                    size="small"
                    value={activeConv?.model_id}
                    style={{ width: 180, flexShrink: 0 }}
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
              <div className="flex items-center gap-3 shrink-0">
                <Tooltip
                  title={
                    useSkills
                      ? "智能模式（已开启）：AI 自动调用搜笔记 / 读笔记 / 列标签 / 今日待办 等内置工具，并接入「设置 → MCP 服务器」里所有外部 MCP 工具。关掉切换为纯聊天（不接入知识库）"
                      : "智能模式（已关闭）：纯聊天，AI 不会读取你的笔记和外部工具"
                  }
                >
                  <div className="flex items-center gap-1.5">
                    <Wrench
                      size={14}
                      style={{
                        color: useSkills
                          ? token.colorPrimary
                          : token.colorTextSecondary,
                      }}
                    />
                    <span
                      className="text-xs"
                      style={{ color: token.colorTextSecondary }}
                    >
                      智能模式
                    </span>
                    <Switch
                      size="small"
                      checked={useSkills}
                      onChange={setUseSkills}
                    />
                  </div>
                </Tooltip>
                {/* AI 写权限：控制内置 MCP 写工具（create/update/delete 等 11 个）是否可被 AI 调用 */}
                <Tooltip
                  title={
                    aiWritable
                      ? "AI 写权限（已开启）：AI 可以创建/修改/删除你的笔记、文件夹、标签、任务。关掉变只读，AI 仍可读取，但所有写操作会被后端拦截。"
                      : "AI 写权限（已关闭，只读）：AI 只能读取知识库，不能修改任何内容。打开后 AI 才能帮你建笔记、改任务、加标签等。"
                  }
                >
                  <div className="flex items-center gap-1.5">
                    <Edit3
                      size={14}
                      style={{
                        color: aiWritable
                          ? token.colorPrimary
                          : token.colorTextSecondary,
                      }}
                    />
                    <span
                      className="text-xs"
                      style={{ color: token.colorTextSecondary }}
                    >
                      AI 写权限
                    </span>
                    <Switch
                      size="small"
                      checked={aiWritable}
                      onChange={async (v) => {
                        try {
                          await setAiWritable(v);
                          message.success(v ? "已允许 AI 修改知识库" : "已切换为只读，AI 写操作将被拦截");
                        } catch (e) {
                          message.error(`切换失败：${e}`);
                        }
                      }}
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
                <Tooltip title="把所有回复的执行过程收成一行摘要">
                  <Button
                    size="small"
                    type="text"
                    icon={<ChevronsDownUp size={14} />}
                    disabled={messages.length === 0}
                    onClick={() => setCollapseSignal((n) => n + 1)}
                  >
                    收起过程
                  </Button>
                </Tooltip>
              </div>
            </div>

            {/* 消息列表 */}
            <div
              className="flex-1 overflow-auto px-4 py-4 kb-surface-clear"
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

              {messages.map((msg, idx) =>
                msg.role === "user" ? (
                  <UserBubble
                    key={msg.id}
                    message={msg}
                    editing={editingFrom?.id === msg.id}
                    canEdit={!streaming && !isOptimisticId(msg.id)}
                    onEdit={() => startEdit(msg)}
                    onContextMenu={(e, m) => msgCtx.open(e.nativeEvent, m)}
                    contextActive={msgCtx.state.payload?.id === msg.id}
                  />
                ) : (
                  <div key={msg.id} className="mb-4">
                    <TurnCard
                      view={turnViews.get(msg.id) ?? turnFromMessage(msg)}
                      isLast={idx === messages.length - 1}
                      busy={streaming}
                      collapseSignal={collapseSignal}
                      onRegenerate={() => handleRegenerate(idx)}
                      onContextMenu={(e, m) => msgCtx.open(e.nativeEvent, m)}
                      contextActive={msgCtx.state.payload?.id === msg.id}
                    />
                  </div>
                ),
              )}

              {/* 正在生成的这一轮：与历史回复同一种卡片，只是状态实时变化 */}
              {streaming && live && live.convId === activeConvId && (
                <div className="mb-4">
                  <TurnCard
                    view={turnFromLive(live)}
                    isLast
                    busy
                    collapseSignal={collapseSignal}
                    onStop={handleCancel}
                  />
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* 输入区域（上方为附加笔记 chip 区，强制塞进上下文） */}
            <div
              className="shrink-0 px-4 py-3 kb-surface-clear"
              style={{
                borderTop: `1px solid ${token.colorBorderSecondary}`,
                background: token.colorBgContainer,
              }}
            >
              {editingFrom && (
                <div
                  className="flex items-center gap-2 mb-2 text-xs px-2 py-1 rounded"
                  style={{ background: token.colorWarningBg, color: token.colorWarningText }}
                >
                  <Edit3 size={12} />
                  <span className="flex-1">
                    正在编辑一条提问：发送后会撤回它
                    {(() => {
                      const after = messages.filter((m) => m.id > editingFrom.id).length;
                      return after > 0 ? `及之后的 ${after} 条消息` : "";
                    })()}
                    ，再用新内容重新提问
                  </span>
                  <Button size="small" type="link" className="!px-0" onClick={cancelEdit}>
                    取消编辑
                  </Button>
                </div>
              )}
              {/* 文件夹范围标识：scope_folder_id 不为空时提示本会话已限定检索范围
                  （由侧边栏「对此文件夹问 AI」发起；会话标题里的 📁 文件夹名进一步指明是哪个）*/}
              {conversations.find((c) => c.id === activeConvId)?.scope_folder_id != null && (
                <div className="flex items-center gap-1.5 mb-2">
                  <span
                    className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
                    style={{ background: token.colorInfoBg, color: token.colorInfo }}
                    title="本会话只在该文件夹及其子文件夹的笔记里检索作答"
                  >
                    🔍 已限定在此文件夹（含子文件夹）范围内检索
                    <X
                      size={11}
                      style={{ cursor: "pointer", flexShrink: 0 }}
                      onClick={handleClearScope}
                    />
                  </span>
                </div>
              )}

              {/* 角色预设：给本会话套一个身份（复用提示词库），换角色不影响已有消息 */}
              {activeConvId != null && presets.length > 0 && (
                <div className="flex items-center gap-1.5 mb-2">
                  <span
                    className="text-xs shrink-0"
                    style={{ color: token.colorTextSecondary }}
                  >
                    🎭 角色
                  </span>
                  <Select
                    size="small"
                    allowClear
                    placeholder="默认助手"
                    style={{ minWidth: 160 }}
                    value={
                      conversations.find((c) => c.id === activeConvId)?.preset_id ??
                      undefined
                    }
                    onChange={async (v) => {
                      try {
                        await aiChatApi.setPreset(activeConvId, v ?? null);
                        await loadConversations();
                      } catch (e) {
                        message.error(`设置角色失败：${e}`);
                      }
                    }}
                    options={presets.map((p) => ({
                      value: p.id,
                      label: p.title,
                      title: p.description || p.prompt.slice(0, 60),
                    }))}
                    title="给本会话套一个角色；角色只影响语气与视角，不改变检索与工具使用规则"
                  />
                </div>
              )}

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

              {/* 路线 A：本次发送的附件 chip 区（每条消息独立，发送后清空） */}
              {pendingAttachments.length > 0 && (
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
                    📊 本次附件（{pendingAttachments.length}）：
                  </span>
                  {pendingAttachments.map((a) => (
                    <AttachmentChip
                      key={a.filePath}
                      attachment={a}
                      onRemove={() => handleRemoveAttachment(a.filePath)}
                    />
                  ))}
                </div>
              )}

              <div className="flex gap-2 items-end">
                <Tooltip title="附加笔记到本对话上下文（整对话共享）">
                  <Button
                    icon={<BookOpen size={16} />}
                    onClick={() => setAttachOpen(true)}
                    disabled={streaming}
                  />
                </Tooltip>
                <Tooltip title="附加文件夹：限定本对话只在某文件夹（含子文件夹）范围内检索作答">
                  <Button
                    icon={<FolderOpen size={16} />}
                    onClick={openScopeModal}
                    disabled={streaming || !activeConvId}
                  />
                </Tooltip>
                <Tooltip title="附加文件作为本次提问的上下文（支持 Excel / PDF / Markdown / TXT 等，可多选）">
                  <Button
                    icon={<Paperclip size={16} />}
                    loading={attachingFile}
                    onClick={handleAddAttachment}
                    disabled={streaming}
                  />
                </Tooltip>
                {/* TextArea 包一层 relative，mic + clear 绝对定位浮在右下角，
                    与各处带边框输入框「× 在 mic 左侧」的视觉规则一致。 */}
                <div style={{ position: "relative", flex: 1 }}>
                  <TextArea
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="输入问题… (Enter 发送，Shift+Enter 换行)"
                    autoSize={{ minRows: 1, maxRows: 4 }}
                    disabled={streaming}
                    style={{ paddingRight: 64 }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      right: 8,
                      bottom: 6,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    {inputText && !streaming && (
                      <CloseCircleFilled
                        onClick={() => setInputText("")}
                        title="清空"
                        style={{
                          cursor: "pointer",
                          fontSize: 14,
                          color: "rgba(0, 0, 0, 0.25)",
                          transition: "color 0.2s",
                        }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as unknown as HTMLElement).style.color =
                            "rgba(0, 0, 0, 0.45)";
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as unknown as HTMLElement).style.color =
                            "rgba(0, 0, 0, 0.25)";
                        }}
                      />
                    )}
                    <MicButton
                      disabled={streaming}
                      onTranscribed={(text) =>
                        setInputText((prev) => (prev ? `${prev} ${text}` : text))
                      }
                    />
                  </div>
                </div>
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

      {/* 附加文件夹：选一个文件夹限定本对话的 RAG 检索范围（含子文件夹） */}
      <Modal
        title="附加文件夹（限定检索范围）"
        open={scopeModalOpen}
        onOk={handleConfirmScope}
        onCancel={() => setScopeModalOpen(false)}
        okText="确定"
        cancelText="取消"
        destroyOnClose
      >
        <p className="text-xs mb-2" style={{ color: token.colorTextSecondary }}>
          选定后，本对话的 AI 只在该文件夹及其所有子文件夹的笔记里检索作答；留空 = 全库检索。
        </p>
        <TreeSelect
          style={{ width: "100%" }}
          value={scopePick}
          onChange={(v) => setScopePick(v as number | undefined)}
          treeData={folders as unknown as Record<string, unknown>[]}
          fieldNames={{ label: "name", value: "id", children: "children" }}
          placeholder="选择文件夹（不选 = 全库）"
          allowClear
          treeDefaultExpandAll
          showSearch
          treeNodeFilterProp="name"
        />
      </Modal>

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

      <ContextMenuOverlay
        open={!!msgCtx.state.payload}
        x={msgCtx.state.x}
        y={msgCtx.state.y}
        items={msgMenuItems}
        onClose={msgCtx.close}
      />
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
  const [allDailies, setAllDailies] = useState<DailyEntry[]>([]);
  const [includeDaily, setIncludeDaily] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);

  // 打开时拉全部笔记 + 日记，并把当前已挂载的 ID 同步到选择器
  // 日记本质是 notes 表里 is_daily=1 的笔记，id 与笔记同一空间，后端 get_note 透明可拉
  useEffect(() => {
    if (!open) return;
    setSelected(currentIds);
    setLoading(true);
    Promise.all([
      noteApi.list({ page: 1, page_size: 500 }),
      dailyApi.listAll(),
    ])
      .then(([notesRes, dailies]) => {
        setAllNotes(notesRes.items);
        setAllDailies(dailies);
        // 若已附加的条目里含日记，自动勾上"附加日记"，保证回填的 tag 正确显示
        const dailyIdSet = new Set(dailies.map((d) => d.id));
        setIncludeDaily(currentIds.some((id) => dailyIdSet.has(id)));
      })
      .catch((e) => message.error(`加载失败: ${e}`))
      .finally(() => setLoading(false));
  }, [open, currentIds]);

  // 取消勾选"附加日记"时，把已选中的日记从选择里剔除（避免遗留隐藏选择）
  function handleIncludeDailyChange(checked: boolean) {
    setIncludeDaily(checked);
    if (!checked) {
      const dailyIdSet = new Set(allDailies.map((d) => d.id));
      setSelected((prev) => prev.filter((id) => !dailyIdSet.has(id)));
    }
  }

  // 日记选项：勾选时展示全部；不勾选时仅保留已选中的（避免 tag 显示成裸 id）
  const visibleDailies = includeDaily
    ? allDailies
    : allDailies.filter((d) => selected.includes(d.id));

  const groupedOptions = [
    {
      label: "笔记",
      options: allNotes.map((n) => ({
        value: n.id,
        label: n.title || `笔记 #${n.id}`,
      })),
    },
    ...(visibleDailies.length > 0
      ? [
          {
            label: "日记",
            options: visibleDailies.map((d) => ({
              value: d.id,
              label: `📅 ${d.daily_date}${
                d.title && d.title !== d.daily_date ? ` ${d.title}` : ""
              }`,
            })),
          },
        ]
      : []),
  ];

  return (
    <Modal
      title="附加笔记 / 日记到对话上下文"
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
          被选中的内容会作为本对话的强制上下文（整个对话共享）。
          每篇按 60% 模型上下文的均分预算自动截断。
        </div>
        <Checkbox
          checked={includeDaily}
          onChange={(e) => handleIncludeDailyChange(e.target.checked)}
        >
          同时附加日记
        </Checkbox>
        <Select
          mode="multiple"
          showSearch
          value={selected}
          onChange={setSelected}
          loading={loading}
          placeholder={
            includeDaily ? "搜索 / 选择笔记或日记…" : "搜索 / 选择笔记…"
          }
          style={{ width: "100%" }}
          maxTagCount={5}
          maxTagPlaceholder={(omitted) => `+${omitted.length}`}
          filterOption={(input, option) =>
            String(option?.label ?? "")
              .toLowerCase()
              .includes(input.toLowerCase())
          }
          options={groupedOptions}
        />
      </div>
    </Modal>
  );
}

/**
 * 乐观插入的提问用 `Date.now()` 当临时 id（毫秒时间戳，13 位），真实 id 是自增主键。
 * 临时 id 在库里不存在，不能拿来「编辑重发」—— 等 ai:done 重拉列表换成真 id 后再允许。
 */
function isOptimisticId(id: number): boolean {
  return id >= 1_000_000_000_000;
}

/** 带附件的提问：正文前面拼了整段附件内容（见后端 build_message_with_attachments） */
const ATTACHMENT_PREFIX = "📎 用户附带了";

/** 用户提问气泡（AI 的回复用 TurnCard） */
function UserBubble({
  message: msg,
  editing,
  canEdit,
  onEdit,
  onContextMenu,
  contextActive,
}: {
  message: AiMessage;
  editing: boolean;
  canEdit: boolean;
  onEdit: () => void;
  onContextMenu?: (e: React.MouseEvent, m: AiMessage) => void;
  contextActive?: boolean;
}) {
  const { token } = antdTheme.useToken();
  // 附件内容动辄几万字，塞回输入框没法编辑；这类提问只能「重新生成」
  const hasAttachment = msg.content.startsWith(ATTACHMENT_PREFIX);

  return (
    <div
      className="group flex flex-col items-end gap-1 mb-4"
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault();
              onContextMenu(e, msg);
            }
          : undefined
      }
    >
      {/* min-w-0 + overflowWrap: anywhere：无空格的长串（URL / DOI）也能断行，不撑破聊天区 */}
      <div
        className="max-w-[75%] min-w-0 px-3 py-2 rounded-lg text-sm whitespace-pre-wrap break-words"
        style={{
          background: token.colorPrimary,
          color: "#fff",
          overflowWrap: "anywhere",
          outline: contextActive || editing ? `2px solid ${token.colorPrimaryBorder}` : "none",
          outlineOffset: 2,
          opacity: editing ? 0.7 : 1,
          transition: "outline .1s",
        }}
      >
        {msg.content}
      </div>
      {canEdit && !hasAttachment && !editing && (
        <button
          type="button"
          className="flex items-center gap-1 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ color: token.colorTextTertiary }}
          onClick={onEdit}
          title="把这条提问放回输入框修改后重发（会撤回它之后的消息）"
        >
          <Edit3 size={11} />
          编辑重发
        </button>
      )}
    </div>
  );
}

import { useIsMobile } from "@/hooks/useIsMobile";
import { MobileAi } from "./MobileAi";

export default function AiChatPage() {
  const isMobile = useIsMobile();
  return isMobile ? <MobileAi /> : <DesktopAiChatPage />;
}
