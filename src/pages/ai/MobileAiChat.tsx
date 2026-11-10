import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ArrowUp,
  BookText,
  ChevronDown,
  Copy,
  FileDown,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Sparkles,
  Square,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { Modal, message } from "antd";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { aiChatApi, aiModelApi, noteApi, promptApi } from "@/lib/api";
import type { AiConversation, AiMessage, AiModel, PromptTemplate, SkillCall } from "@/types";
import { MobileAiModelModal } from "@/components/ai/MobileAiModelModal";
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
import { useKeyboardInset } from "@/hooks/useKeyboardInset";
import { useLongPress } from "@/hooks/useLongPress";
import { MNavBar } from "@/components/mobile/primitives";
import { MSheet, PickRow } from "@/components/mobile/MSheet";
import { ActionSheet, type ActionSheetItem } from "@/components/mobile/ActionSheet";
import { TextPromptModal } from "@/components/mobile/TextPromptModal";
import { NotePickerSheet, type PickedNote } from "@/components/mobile/NotePickerSheet";
import type { AiChatEntryState } from "./MobileAi";

/**
 * 移动端 AI 对话页（v4 原型 11 屏，与 PC AI 页同构）
 *
 * 路由：/ai-chat/:id
 *
 * - 一轮回复 = 一张卡片：直接复用 PC 的 TurnCard + turnModel（状态与耗时 → 执行过程 → 回答 → 参考来源 → 复制 / 存为笔记 / 重新生成）
 * - 流式：全局监听 ai:round / ai:token / ai:tool_call / ai:reasoning / ai:done（mount once，按 conversationId 过滤）
 *   不监听 ai:error（同 PC）：上下文超长时后端先发一次 error 再自动减历史重试，按事件收尾会把能成功的回复提前判死；
 *   失败以 sendMessage 的 reject 为准，后端已把错误存成这一轮的卡片
 * - 顶栏：标题 + 模型 · 模式（点开切模型）；「…」= 会话菜单（重命名 / 置顶 / 复制为 Markdown / 归档为笔记 / 删除）
 * - 提问：长按 → 复制 / 编辑重发（撤回它及之后的消息再发，同 PC）
 * - 输入区：附加笔记（整个会话共享）/ 提示词（角色预设）/ 智能模式（让 AI 自己调工具查笔记）
 */

/** 带附件的提问：正文前面拼了整段附件内容，塞回输入框没法编辑，只能「重新生成」（同 PC） */
const ATTACHMENT_PREFIX = "📎 用户附带了";
/** 乐观插入的提问用负 id，落库前不能编辑重发 */
const isOptimistic = (id: number) => id < 0;

export function MobileAiChat() {
  const navigate = useNavigate();
  const { id: idParam } = useParams<{ id: string }>();
  const convId = Number(idParam);
  const keyboardInset = useKeyboardInset(); // 键盘弹出时顶起输入栏，避免遮挡

  const [conv, setConv] = useState<AiConversation | null>(null);
  const [allModels, setAllModels] = useState<AiModel[]>([]);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [input, setInput] = useState("");
  /** 正在生成的这一轮；ai:done 后清空，改由落库的那条消息接管 */
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [editingFrom, setEditingFrom] = useState<AiMessage | null>(null);
  /** 智能模式：让 AI 自己调 search_notes 等工具；关掉就是纯聊天（同 PC，默认开） */
  const [useSkills, setUseSkills] = useState(true);
  const [presets, setPresets] = useState<PromptTemplate[]>([]);
  const [attached, setAttached] = useState<PickedNote[]>([]);

  const [modelSheet, setModelSheet] = useState(false);
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [presetSheet, setPresetSheet] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [askMenu, setAskMenu] = useState<AiMessage | null>(null);
  const location = useLocation();

  // 输入框随内容长高（最多约 5 行）；预填 / 编辑重发 / 发送清空时同样要重算
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [input]);

  // AI 首页快捷入口带过来的：预填输入框开头 / 先弹出选笔记。只用一次，用完清掉，免得返回再进又弹
  useEffect(() => {
    const st = location.state as AiChatEntryState | null;
    if (!st) return;
    if (st.draft) setInput(st.draft);
    if (st.pickNotes) setPickerOpen(true);
    else if (st.draft) window.setTimeout(() => inputRef.current?.focus(), 150);
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /** 用户停在底部附近才跟随新内容滚动；往上翻看历史时不抢滚动条 */
  const stickRef = useRef(true);
  // convId 的 ref 镜像 —— 给 mount-once 的 ai:* 事件 handler 用，避免路由参数变化后闭包陷阱
  const convIdRef = useRef(convId);
  useEffect(() => {
    convIdRef.current = convId;
  }, [convId]);
  // 同步再入锁：setLive 异步，连点发送时旧闭包读到「没在生成」会重复发送
  const sendingRef = useRef(false);

  const streaming = !!live && live.convId === convId;
  const model = allModels.find((m) => m.id === conv?.model_id) ?? null;

  function scrollToBottom(force = false) {
    if (!force && !stickRef.current) return;
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  const loadConv = useCallback(async () => {
    const convs = await aiChatApi.listConversations();
    const c = convs.find((x) => x.id === convId) ?? null;
    setConv(c);
    return c;
  }, [convId]);

  const loadAll = useCallback(async () => {
    if (!convId || Number.isNaN(convId)) return;
    try {
      const [, models, msgs] = await Promise.all([loadConv(), aiModelApi.list(), aiChatApi.listMessages(convId)]);
      setAllModels(models);
      stickRef.current = true; // 打开会话先停在最新一轮，滚动交给下面跟随 messages 的 effect
      setMessages(msgs);
    } catch (e) {
      console.error("[MobileAiChat] load failed:", e);
    }
  }, [convId, loadConv]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    promptApi
      .list(true)
      .then(setPresets)
      .catch(() => setPresets([]));
  }, []);

  // 附加笔记：会话里只存 id，标题逐个取（取不到的说明笔记已删，不显示）
  const attachedKey = (conv?.attached_note_ids ?? []).join(",");
  useEffect(() => {
    const ids = conv?.attached_note_ids ?? [];
    if (ids.length === 0) {
      setAttached([]);
      return;
    }
    let alive = true;
    Promise.all(ids.map((id) => noteApi.get(id).then((n) => ({ id, title: n.title || "未命名笔记" })).catch(() => null))).then(
      (list) => alive && setAttached(list.filter((x): x is PickedNote => !!x)),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachedKey]);

  // 流式事件监听（mount once）：只记到「它所属会话」的流式卡片上
  useEffect(() => {
    let unlistens: UnlistenFn[] = [];
    let cancelled = false;
    const updateLive = (cid: number, fn: (t: LiveTurn) => LiveTurn) => {
      setLive((prev) => (prev && prev.convId === cid ? fn(prev) : prev));
      if (cid === convIdRef.current) scrollToBottom();
    };
    (async () => {
      const roundU = await listen<{ conversationId: number; round: number }>("ai:round", (e) =>
        updateLive(e.payload.conversationId, (t) => liveStartRound(t, e.payload.round)),
      );
      const tokenU = await listen<{ conversationId: number; content: string }>("ai:token", (e) =>
        updateLive(e.payload.conversationId, (t) => liveAppendToken(t, e.payload.content)),
      );
      // tool_call 可能多次触发（running → ok/error），按 id upsert
      const toolU = await listen<SkillCall & { conversationId: number }>("ai:tool_call", (e) =>
        updateLive(e.payload.conversationId, (t) => liveUpsertCall(t, e.payload)),
      );
      const reasoningU = await listen<{ conversationId: number; content: string }>("ai:reasoning", (e) =>
        updateLive(e.payload.conversationId, (t) => liveAppendReasoning(t, e.payload.content)),
      );
      const doneU = await listen<number>("ai:done", async (e) => {
        const cid = e.payload;
        // 先拿到列表、再同一个同步块里「换上新列表 + 撤掉流式卡片」，不会出现两张卡同屏的那一帧
        const list = cid === convIdRef.current ? await aiChatApi.listMessages(cid).catch(() => null) : null;
        if (list) setMessages(list);
        setLive((prev) => (prev && prev.convId === cid ? null : prev));
        if (cid === convIdRef.current) {
          sendingRef.current = false;
          void loadConv().catch(() => {}); // 标题可能被自动改了
          scrollToBottom();
        }
      });
      if (cancelled) {
        [roundU, tokenU, toolU, reasoningU, doneU].forEach((fn) => fn());
      } else {
        unlistens = [roundU, tokenU, toolU, reasoningU, doneU];
      }
    })();
    return () => {
      cancelled = true;
      unlistens.forEach((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 发送一条提问。
   * @param textOverride 不传就取输入框
   * @param resendFrom 「重新生成 / 编辑重发」：先撤回这条提问及之后的所有消息再发
   */
  async function send(textOverride?: string, resendFrom?: AiMessage) {
    const text = (textOverride ?? input).trim();
    if (!text || !convId || sendingRef.current) return;
    sendingRef.current = true;
    const from = resendFrom ?? editingFrom ?? undefined;
    if (textOverride === undefined) setInput("");
    setEditingFrom(null);
    setLive(newLiveTurn(convId));
    stickRef.current = true;

    if (from) {
      try {
        await aiChatApi.truncateFrom(convId, from.id);
      } catch (e) {
        sendingRef.current = false;
        setLive(null);
        message.error(`撤回失败: ${e}`);
        return;
      }
    }

    const optimistic: AiMessage = {
      id: -Date.now(),
      conversation_id: convId,
      role: "user",
      content: text,
      references: null,
      skill_calls: null,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...(from ? prev.filter((m) => m.id < from.id) : prev), optimistic]);
    scrollToBottom(true);

    try {
      // use_rag 永远 false：智能模式下由 AI 自己调 search_notes（同 PC）
      await aiChatApi.sendMessage(convId, text, false, useSkills);
    } catch (e) {
      sendingRef.current = false;
      setLive((prev) => (prev && prev.convId === convId ? null : prev));
      // 后端已把错误存成这一轮的卡片 → 重拉让卡片显示出来；提问都没存下的早期失败（如没配模型）才弹提示
      let shownOnCard = false;
      try {
        const list = await aiChatApi.listMessages(convId);
        setMessages(list);
        const last = list[list.length - 1];
        shownOnCard = last?.role === "assistant" && turnFromMessage(last).status === "error";
      } catch {
        // 拉不到就走弹窗兜底
      }
      if (!shownOnCard) Modal.error({ title: "AI 请求失败", content: String(e), centered: true });
    }
  }

  async function cancel() {
    try {
      await aiChatApi.cancelGeneration(convId);
    } catch (e) {
      console.error("cancel failed:", e);
    }
  }

  /** 重新生成：撤回这一轮的提问及回答，用原提问再问一次 */
  function regenerate(assistantIdx: number) {
    const question = messages
      .slice(0, assistantIdx)
      .reverse()
      .find((m) => m.role === "user");
    if (!question) {
      message.warning("找不到这条回答对应的提问");
      return;
    }
    void send(question.content, question);
  }

  function startEdit(msg: AiMessage) {
    setEditingFrom(msg);
    setInput(msg.content);
    window.setTimeout(() => inputRef.current?.focus(), 50);
  }

  async function switchModel(m: AiModel) {
    if (m.id === conv?.model_id) {
      setModelSheet(false);
      return;
    }
    try {
      await aiChatApi.updateConversationModel(convId, m.id);
      setModelSheet(false);
      message.success(`已切换到 ${m.name}`);
      await loadAll();
    } catch (e) {
      message.error(`切换失败: ${e}`);
    }
  }

  async function onModelAdded(created: AiModel) {
    // 自动把当前对话切到新模型
    try {
      await aiChatApi.updateConversationModel(convId, created.id);
    } catch (e) {
      console.error("auto switch failed:", e);
    }
    await loadAll();
  }

  async function saveAttached(notes: PickedNote[]) {
    try {
      await aiChatApi.setAttachedNotes(convId, notes.map((n) => n.id));
      setAttached(notes);
      await loadConv();
    } catch (e) {
      message.error(`附加笔记失败: ${e}`);
    }
  }

  async function setPreset(id: number | null) {
    try {
      await aiChatApi.setPreset(convId, id);
      setPresetSheet(false);
      await loadConv();
    } catch (e) {
      message.error(`设置提示词失败: ${e}`);
    }
  }

  function copyText(text: string, ok = "已复制") {
    navigator.clipboard
      ?.writeText(text)
      .then(() => message.success(ok))
      .catch(() => message.error("复制失败"));
  }

  const moreItems: ActionSheetItem[] = [
    { key: "rename", label: "重命名", icon: <Pencil size={20} />, onClick: () => setRenameOpen(true) },
    {
      key: "pin",
      label: conv?.is_pinned ? "取消置顶" : "置顶",
      icon: conv?.is_pinned ? <PinOff size={20} /> : <Pin size={20} />,
      onClick: () =>
        void aiChatApi
          .setPinned(convId, !conv?.is_pinned)
          .then(loadConv)
          .catch((e) => message.error(`操作失败: ${e}`)),
    },
    {
      key: "md",
      label: "复制为 Markdown",
      icon: <Copy size={20} />,
      onClick: () =>
        void aiChatApi
          .getConversationMarkdown(convId)
          .then((md) => copyText(md, "已复制整个对话"))
          .catch((e) => message.error(`导出失败: ${e}`)),
    },
    {
      key: "archive",
      label: "归档为笔记",
      icon: <FileDown size={20} />,
      onClick: () =>
        void aiChatApi
          .archiveToNote(convId)
          .then((n) => {
            message.success("已归档为笔记");
            navigate(`/notes/${n.id}`);
          })
          .catch((e) => message.error(`归档失败: ${e}`)),
    },
    {
      key: "delete",
      label: "删除对话",
      icon: <Trash2 size={20} />,
      danger: true,
      onClick: () =>
        Modal.confirm({
          title: `删除对话「${conv?.title || "对话"}」？`,
          content: "对话里的全部消息会一起删除，不可恢复。",
          okText: "删除",
          okType: "danger",
          cancelText: "取消",
          centered: true,
          onOk: async () => {
            try {
              await aiChatApi.deleteConversation(convId);
              navigate("/ai", { replace: true });
            } catch (e) {
              message.error(`删除失败: ${e}`);
            }
          },
        }),
    },
  ];

  // 消息列表换了（打开会话 / 一轮结束）→ 渲染后再滚到底；参考来源卡片异步拉标题会把高度撑高，稍后再补滚一次
  useEffect(() => {
    scrollToBottom();
    const t = window.setTimeout(() => scrollToBottom(), 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // 每条 assistant 消息解析一次（skill_calls / turn_meta 的 JSON），别在每次流式刷新时重算
  const turnViews = useMemo(() => {
    const map = new Map<number, TurnView>();
    for (const m of messages) if (m.role === "assistant") map.set(m.id, turnFromMessage(m));
    return map;
  }, [messages]);

  if (Number.isNaN(convId)) {
    return <div className="m-t-meta p-4 text-center">对话 ID 无效</div>;
  }

  const preset = presets.find((p) => p.id === conv?.preset_id) ?? null;
  const canEditAsk = (m: AiMessage) => !streaming && !isOptimistic(m.id) && !m.content.startsWith(ATTACHMENT_PREFIX);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: "var(--m-page)", color: "var(--m-ink)", paddingTop: "env(safe-area-inset-top, 0px)", paddingBottom: keyboardInset }}
    >
      <div className="shrink-0">
        <MNavBar
          onBack={() => navigate("/ai")}
          title={
            // 标题 + 副标题合成一个整块热区：点开切模型
            <button type="button" className="flex min-h-[44px] w-full min-w-0 flex-col items-start justify-center text-left" onClick={() => setModelSheet(true)} aria-label="切换模型">
              <span className="w-full truncate">{conv?.title || "对话"}</span>
              <span className="m-t-cap flex w-full min-w-0 items-center gap-1 font-normal">
                {streaming && <span className="m-dot shrink-0 animate-pulse" style={{ background: "var(--m-accent)" }} />}
                <span className="truncate">
                  {model?.name ?? "未选模型"} · {useSkills ? "智能模式" : "纯聊天"}
                  {streaming ? " · 生成中" : ""}
                </span>
                <ChevronDown size={12} className="shrink-0" />
              </span>
            </button>
          }
          actions={
            <button type="button" aria-label="更多" className="m-icon-btn" onClick={() => setMoreOpen(true)}>
              <MoreHorizontal size={22} />
            </button>
          }
        />
      </div>

      {/* 对话 */}
      <main
        ref={scrollRef}
        className="m-ai-thread flex-1 overflow-y-auto px-4 pt-2 pb-4"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {messages.length === 0 && !streaming && (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <span className="kb-turn-ico" style={{ width: 40, height: 40, borderRadius: 12 }}>
              <Sparkles size={20} />
            </span>
            <span className="m-t-body mt-2" style={{ color: "var(--m-ink2)" }}>开始对话吧</span>
            <span className="m-t-cap">{useSkills ? "智能模式下 AI 会自己去你的笔记里找答案" : "纯聊天：不读你的笔记"}</span>
          </div>
        )}
        {messages.map((msg, idx) =>
          msg.role === "user" ? (
            <AskBubble key={msg.id} msg={msg} editing={editingFrom?.id === msg.id} onMenu={() => setAskMenu(msg)} />
          ) : (
            <div key={msg.id} className="mb-4">
              <TurnCard
                view={turnViews.get(msg.id) ?? turnFromMessage(msg)}
                isLast={idx === messages.length - 1}
                busy={streaming}
                collapseSignal={0}
                onRegenerate={() => regenerate(idx)}
              />
            </div>
          ),
        )}
        {/* 正在生成的这一轮：与历史回复同一种卡片，只是状态实时变化 */}
        {streaming && live && (
          <div className="mb-4">
            <TurnCard view={turnFromLive(live)} isLast busy collapseSignal={0} onStop={() => void cancel()} />
          </div>
        )}
      </main>

      {/* 输入区 */}
      <footer className="m-px shrink-0 pt-2" style={{ paddingBottom: keyboardInset ? 8 : "calc(8px + env(safe-area-inset-bottom, 0px))" }}>
        {editingFrom && (
          <div className="mb-2 flex items-center gap-2 rounded-[var(--m-r-m)] px-3 py-2" style={{ background: "var(--m-warn-soft)", color: "var(--m-warn)" }}>
            <Pencil size={14} className="shrink-0" />
            <span className="min-w-0 flex-1 text-[13px]">正在编辑一条提问：发送后会撤回它和之后的消息</span>
            <button
              type="button"
              className="m-tapx shrink-0 text-[13px] font-semibold"
              onClick={() => {
                setEditingFrom(null);
                setInput("");
              }}
            >
              取消
            </button>
          </div>
        )}
        <div className="rounded-[var(--m-r-xl)] px-3 pt-2 pb-1.5" style={{ background: "var(--m-surface)" }}>
          {(attached.length > 0 || preset) && (
            <div className="m-hscroll mb-1.5 flex items-center gap-1.5">
              {preset && (
                <Tag icon={<Wand2 size={12} />} label={preset.title} onRemove={() => void setPreset(null)} removeLabel="不使用提示词" />
              )}
              {attached.map((n) => (
                <Tag
                  key={n.id}
                  icon={<BookText size={12} />}
                  label={n.title}
                  removeLabel={`移除「${n.title}」`}
                  onRemove={() => void saveAttached(attached.filter((x) => x.id !== n.id))}
                />
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              rows={1}
              onChange={(e) => setInput(e.target.value)}
              placeholder="问问你的知识库…"
              aria-label="输入问题"
              className="min-h-[44px] min-w-0 flex-1 resize-none bg-transparent py-2.5 text-[16px] leading-snug outline-none placeholder:text-[var(--m-ink3)]"
              style={{ color: "var(--m-ink)" }}
            />
            {streaming ? (
              <button type="button" aria-label="停止" className="m-icon-btn is-primary mb-0.5 shrink-0" onClick={() => void cancel()}>
                <Square size={16} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                aria-label="发送"
                className="m-icon-btn is-primary mb-0.5 shrink-0"
                disabled={!input.trim()}
                style={!input.trim() ? { opacity: 0.45 } : undefined}
                onClick={() => void send()}
              >
                <ArrowUp size={20} />
              </button>
            )}
          </div>
          <div className="m-hscroll -mx-1 flex items-center gap-1">
            <ComposerChip icon={<Plus size={15} />} label="附加笔记" count={attached.length} onClick={() => setPickerOpen(true)} />
            <ComposerChip icon={<Wand2 size={15} />} label="提示词" on={!!preset} onClick={() => setPresetSheet(true)} />
            <ComposerChip icon={<Sparkles size={15} />} label="智能模式" on={useSkills} pressed={useSkills} onClick={() => setUseSkills((v) => !v)} />
          </div>
        </div>
      </footer>

      {/* 模型切换 */}
      <MSheet
        open={modelSheet}
        title="选择模型"
        caption={allModels.length === 0 ? "手机端还没有配置模型服务（手机数据库与桌面独立，需要单独配置）" : undefined}
        onClose={() => setModelSheet(false)}
      >
        <div className="m-group max-h-[50vh] overflow-y-auto">
          {allModels.map((m) => (
            <PickRow
              key={m.id}
              label={
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{m.name}</span>
                  <span className="m-t-cap truncate font-normal">
                    {m.provider} · {m.model_id}
                  </span>
                </span>
              }
              active={m.id === conv?.model_id}
              onClick={() => void switchModel(m)}
            />
          ))}
          <PickRow
            label="新建模型服务（DeepSeek 等）"
            icon={<Plus size={18} />}
            active={false}
            onClick={() => {
              setModelSheet(false);
              setAddModelOpen(true);
            }}
          />
        </div>
      </MSheet>

      {/* 提示词（角色预设） */}
      <MSheet
        open={presetSheet}
        title="提示词"
        caption="选中后每一轮都会按这条提示词的角色回答（提示词在桌面端「设置 → 提示词」里管理）"
        onClose={() => setPresetSheet(false)}
      >
        <div className="m-group max-h-[50vh] overflow-y-auto">
          <PickRow label="不使用" active={!conv?.preset_id} onClick={() => void setPreset(null)} />
          {presets.map((p) => (
            <PickRow
              key={p.id}
              label={
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{p.title}</span>
                  {p.description && <span className="m-t-cap truncate font-normal">{p.description}</span>}
                </span>
              }
              active={conv?.preset_id === p.id}
              onClick={() => void setPreset(p.id)}
            />
          ))}
        </div>
      </MSheet>

      <NotePickerSheet
        open={pickerOpen}
        caption={`已选 ${attached.length} 篇 · 整个对话共享，每一轮都会带上全文`}
        initial={attached}
        onDone={(notes) => void saveAttached(notes)}
        onClose={() => setPickerOpen(false)}
      />

      <ActionSheet open={moreOpen} title={conv?.title || "对话"} subtitle={model?.name} headerIcon={<NotebookPen size={20} />} items={moreItems} onClose={() => setMoreOpen(false)} />

      <ActionSheet
        open={!!askMenu}
        title="这条提问"
        items={
          askMenu
            ? [
                { key: "copy", label: "复制", icon: <Copy size={20} />, onClick: () => copyText(askMenu.content) },
                ...(canEditAsk(askMenu)
                  ? [{ key: "edit", label: "编辑重发", icon: <Pencil size={20} />, extra: "会撤回它之后的消息", onClick: () => startEdit(askMenu) }]
                  : []),
              ]
            : []
        }
        onClose={() => setAskMenu(null)}
      />

      <TextPromptModal
        open={renameOpen}
        title="重命名对话"
        initialValue={conv?.title ?? ""}
        okText="保存"
        maxLength={100}
        onOk={async (t) => {
          try {
            await aiChatApi.renameConversation(convId, t);
            await loadConv();
          } catch (e) {
            message.error(`重命名失败: ${e}`);
          }
        }}
        onClose={() => setRenameOpen(false)}
      />

      {/* 新增模型 Modal（共享组件） */}
      <MobileAiModelModal open={addModelOpen} onClose={() => setAddModelOpen(false)} onSaved={onModelAdded} okText="保存并切换" />
    </div>
  );
}

/** 提问气泡：靠右、主色；长按出菜单（复制 / 编辑重发）；下方小字时间 */
function AskBubble({ msg, editing, onMenu }: { msg: AiMessage; editing: boolean; onMenu: () => void }) {
  const lp = useLongPress(onMenu);
  return (
    <div className="mb-3 flex flex-col items-end gap-1">
      <div
        {...lp}
        className="max-w-[82%] min-w-0 select-none whitespace-pre-wrap rounded-[12px_12px_4px_12px] px-3.5 py-2.5 text-[15px] leading-relaxed"
        style={{
          background: "var(--m-btn)",
          color: "var(--m-on-accent)",
          overflowWrap: "anywhere",
          opacity: editing ? 0.6 : 1,
          WebkitTouchCallout: "none",
        }}
      >
        {msg.content}
      </div>
      <span className="m-t-cap m-num px-1">
        {new Date(msg.created_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
      </span>
    </div>
  );
}

/** 输入区顶部的已选项：提示词 / 附加笔记，带 × */
function Tag({ icon, label, onRemove, removeLabel }: { icon: React.ReactNode; label: string; onRemove: () => void; removeLabel: string }) {
  return (
    <span className="m-tag max-w-[60%] shrink-0 gap-1 pr-0.5" style={{ background: "var(--m-accent-soft2)", color: "var(--m-accent-ink)" }}>
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      <button type="button" aria-label={removeLabel} className="m-tapx flex h-5 w-5 shrink-0 items-center justify-center" onClick={onRemove}>
        <X size={12} />
      </button>
    </span>
  );
}

function ComposerChip({
  icon,
  label,
  on,
  pressed,
  count,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  on?: boolean;
  /** 开关型（智能模式）才带 aria-pressed */
  pressed?: boolean;
  count?: number;
  onClick: () => void;
}) {
  const active = on || (count ?? 0) > 0;
  return (
    <button
      type="button"
      className="flex h-11 shrink-0 items-center gap-1 rounded-[var(--m-r-m)] px-2 text-[13px] font-semibold"
      style={{ color: active ? "var(--m-accent-ink)" : "var(--m-ink2)" }}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {icon}
      {label}
      {count ? <span className="m-num">{count}</span> : null}
    </button>
  );
}
