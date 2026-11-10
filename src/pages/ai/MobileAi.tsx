import { useEffect, useMemo, useState, useCallback } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  Search,
  PenLine,
  BookOpenText,
  ListChecks,
  Languages,
  MessageCircle,
  MessageSquarePlus,
  Plus,
  Share2,
  Download,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  CheckSquare,
  Square,
  Eraser,
  Check,
  X,
  BookText,
} from "lucide-react";
import { ShareConfigModal } from "@/components/config-share/ShareConfigModal";
import { ImportConfigModal } from "@/components/config-share/ImportConfigModal";
import { exportAiModel, type Envelope } from "@/lib/configShare";
import { Modal, message } from "antd";
import { aiChatApi, aiModelApi } from "@/lib/api";
import type { AiConversation, AiModel } from "@/types";
import { relativeTime } from "@/lib/utils";
import { MobileAiModelModal } from "@/components/ai/MobileAiModelModal";
import { useLongPress } from "@/hooks/useLongPress";
import { ActionSheet, type ActionSheetItem } from "@/components/mobile/ActionSheet";
import { TextPromptModal } from "@/components/mobile/TextPromptModal";
import { MGroup, MPageHeader, MSectionHeader } from "@/components/mobile/primitives";

/**
 * 移动端 AI 首页（v4 样式；AI Tab 进来先到这里，点对话再进 /ai-chat/:id）
 *
 * - 顶部「AI 助手」+ 默认模型 · 对话数；右侧 搜索（按标题筛对话）/ 分享当前模型 / 导入模型
 * - 模型胶囊横滑：点一下设为默认（新对话用它）；「+」新建模型服务
 * - 4 个快捷入口：新建对话并进入，输入框预填对应的开头（解读笔记会先弹出选笔记）
 * - 对话历史：置顶在前；轻点进入，长按 = 重命名 / 置顶 / 删除；「管理」= 批量删除 / 清理 N 天前
 * - 右下自带「新对话」按钮（全局 FAB 在本页隐藏）
 */

/** 「清理更早对话」可选的保留天数 */
const CLEANUP_DAYS = [7, 30, 90];

/** 快捷入口 → 进对话页时带过去的状态（MobileAiChat 读 location.state） */
export interface AiChatEntryState {
  /** 预填到输入框的开头，用户补完再发 */
  draft?: string;
  /** 进来先弹出「附加笔记」选择 */
  pickNotes?: boolean;
}

interface QuickEntry {
  key: string;
  label: string;
  icon: ReactNode;
  color: string;
  state: AiChatEntryState;
}

const QUICK_ENTRIES: QuickEntry[] = [
  { key: "write", label: "写作助手", icon: <PenLine size={26} />, color: "var(--m-accent-ink)", state: { draft: "帮我写一篇：" } },
  { key: "read", label: "解读笔记", icon: <BookOpenText size={26} />, color: "var(--m-info)", state: { draft: "帮我解读附加的笔记：讲了什么、要点有哪些、还有什么没说清", pickNotes: true } },
  { key: "tasks", label: "任务规划", icon: <ListChecks size={26} />, color: "var(--m-ok)", state: { draft: "帮我把这件事拆成可执行的待办步骤：" } },
  { key: "translate", label: "翻译润色", icon: <Languages size={26} />, color: "var(--m-warn)", state: { draft: "把下面这段翻译成英文，并润色得自然一些：\n" } },
];

export function MobileAi() {
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [models, setModels] = useState<AiModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [shareEnv, setShareEnv] = useState<Envelope | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  // ── 对话管理 ──
  /** 长按单条唤起的动作面板 */
  const [sheetConv, setSheetConv] = useState<AiConversation | null>(null);
  /** 「管理」唤起的动作面板 */
  const [manageSheetOpen, setManageSheetOpen] = useState(false);
  /** 多选模式（批量删除） */
  const [manageMode, setManageMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  /** 重命名弹窗：非 null = 正在重命名该对话 */
  const [renameConv, setRenameConv] = useState<AiConversation | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [convs, mods] = await Promise.all([
        aiChatApi.listConversations().catch(() => [] as AiConversation[]),
        aiModelApi.list().catch(() => [] as AiModel[]),
      ]);
      setConversations(convs);
      setModels(mods);
    } catch (e) {
      console.error("[MobileAi] load failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const defaultModel = models.find((m) => m.is_default) ?? models[0];

  // 搜索只按标题筛（本地）；置顶在前，其余保持后端的 updated_at 倒序
  const shown = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    const list = k ? conversations.filter((c) => (c.title || "未命名对话").toLowerCase().includes(k)) : conversations;
    return { pinned: list.filter((c) => c.is_pinned), others: list.filter((c) => !c.is_pinned), total: list.length };
  }, [conversations, keyword]);

  async function switchDefaultModel(id: number) {
    try {
      await aiModelApi.setDefault(id);
      await load();
    } catch (e) {
      message.error(`切换失败: ${e}`);
    }
  }

  async function shareModel() {
    if (!defaultModel) {
      message.warning("请先配置一个模型服务");
      return;
    }
    // Key 明文不随列表返回（P0-1b），分享时按 id 单独取
    let key: string | null = null;
    try {
      key = await aiModelApi.getApiKey(defaultModel.id);
    } catch (e) {
      message.warning(`未能读取 API Key（${e}），分享内容不含密钥`);
    }
    setShareEnv(exportAiModel(defaultModel, key));
  }

  function exitManageMode() {
    setManageMode(false);
    setSelectedIds([]);
  }

  function toggleSelected(id: number) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  /** 删除若干对话（逐条调后端，失败的计数汇报，不中断其余） */
  async function deleteConversations(ids: number[]) {
    let failed = 0;
    for (const id of ids) {
      try {
        await aiChatApi.deleteConversation(id);
      } catch (e) {
        failed += 1;
        console.error("[MobileAi] 删除对话失败:", id, e);
      }
    }
    if (failed > 0) message.warning(`${ids.length - failed} 条已删除，${failed} 条失败`);
    else message.success(`已删除 ${ids.length} 条`);
    await load();
  }

  function confirmDeleteOne(conv: AiConversation) {
    Modal.confirm({
      title: `删除「${conv.title || "未命名对话"}」？`,
      content: "对话及其全部消息将被永久删除，不可恢复。",
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      centered: true,
      onOk: () => deleteConversations([conv.id]),
    });
  }

  function confirmDeleteSelected() {
    if (selectedIds.length === 0) return;
    const ids = [...selectedIds];
    Modal.confirm({
      title: `删除选中的 ${ids.length} 条对话？`,
      content: "对话及其全部消息将被永久删除，不可恢复。",
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      centered: true,
      onOk: async () => {
        await deleteConversations(ids);
        exitManageMode();
      },
    });
  }

  /** 清理 N 天前的对话（后端一次性按时间删，比逐条选快得多） */
  function confirmCleanupBefore(days: number) {
    Modal.confirm({
      title: `清理 ${days} 天前的对话？`,
      content: `最近 ${days} 天内更新过的对话会保留，更早的将被永久删除。`,
      okText: "清理",
      okType: "danger",
      cancelText: "取消",
      centered: true,
      onOk: async () => {
        try {
          const removed = await aiChatApi.deleteConversationsBefore(days);
          message.success(removed > 0 ? `已清理 ${removed} 条` : "没有更早的对话");
          await load();
        } catch (e) {
          message.error(`清理失败: ${e}`);
        }
      },
    });
  }

  /** 长按单条对话的操作项 */
  const convSheetItems: ActionSheetItem[] = sheetConv
    ? [
        { key: "rename", label: "重命名", icon: <Pencil size={20} />, onClick: () => setRenameConv(sheetConv) },
        {
          key: "pin",
          label: sheetConv.is_pinned ? "取消置顶" : "置顶",
          icon: sheetConv.is_pinned ? <PinOff size={20} /> : <Pin size={20} />,
          onClick: () =>
            void aiChatApi
              .setPinned(sheetConv.id, !sheetConv.is_pinned)
              .then(load)
              .catch((e) => message.error(`操作失败: ${e}`)),
        },
        { key: "delete", label: "删除", icon: <Trash2 size={20} />, danger: true, onClick: () => confirmDeleteOne(sheetConv) },
      ]
    : [];

  /** 「管理」的操作项 */
  const manageSheetItems: ActionSheetItem[] = [
    {
      key: "multi",
      label: "批量选择删除",
      icon: <CheckSquare size={20} />,
      onClick: () => {
        setSelectedIds([]);
        setManageMode(true);
      },
    },
    ...CLEANUP_DAYS.map((d) => ({
      key: `cleanup-${d}`,
      label: `清理 ${d} 天前的对话`,
      icon: <Eraser size={20} />,
      danger: true,
      onClick: () => confirmCleanupBefore(d),
    })),
  ];

  async function createNew(state?: AiChatEntryState) {
    try {
      const conv = await aiChatApi.createConversation();
      navigate(`/ai-chat/${conv.id}`, { state });
    } catch (e) {
      message.error(`创建失败: ${e}`);
    }
  }

  const allSelected = shown.total > 0 && selectedIds.length === shown.total;
  const renderRows = (list: AiConversation[]) =>
    list.map((conv, i) => (
      <ConversationRow
        key={conv.id}
        conv={conv}
        divider={i > 0}
        modelName={models.find((m) => m.id === conv.model_id)?.name ?? "未知模型"}
        manageMode={manageMode}
        selected={selectedIds.includes(conv.id)}
        onClick={() => (manageMode ? toggleSelected(conv.id) : navigate(`/ai-chat/${conv.id}`))}
        onLongPress={() => {
          if (!manageMode) setSheetConv(conv);
        }}
      />
    ));

  return (
    <div className="mx-auto w-full max-w-[860px]" style={{ paddingBottom: manageMode ? 140 : 110 }}>
      <MPageHeader
        title="AI 助手"
        subtitle={`${defaultModel ? defaultModel.name : "未配置模型服务"} · ${conversations.length} 个对话`}
        actions={
          <>
            <button
              type="button"
              aria-label={searchOpen ? "收起搜索" : "搜索对话"}
              className="m-icon-btn"
              onClick={() => {
                if (searchOpen) setKeyword("");
                setSearchOpen(!searchOpen);
              }}
            >
              {searchOpen ? <X size={22} /> : <Search size={22} />}
            </button>
            <button type="button" aria-label="分享当前模型" className="m-icon-btn" onClick={() => void shareModel()}>
              <Share2 size={20} />
            </button>
            <button type="button" aria-label="导入模型" className="m-icon-btn" onClick={() => setImportOpen(true)}>
              <Download size={20} />
            </button>
          </>
        }
      />

      {searchOpen && (
        <div className="m-px mt-2">
          <div className="flex h-11 items-center gap-2 rounded-[var(--m-r-l)] px-3" style={{ background: "var(--m-surface)" }}>
            <Search size={18} className="shrink-0" style={{ color: "var(--m-ink3)" }} />
            <input
              autoFocus
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="按标题搜对话"
              aria-label="按标题搜对话"
              className="h-full min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-[var(--m-ink3)]"
              style={{ color: "var(--m-ink)" }}
            />
          </div>
        </div>
      )}

      {/* 模型胶囊：点一下设为默认 */}
      <div className="m-px m-hscroll mt-3 flex items-center gap-2 pb-1">
        {models.length === 0 ? (
          <span className="m-t-meta shrink-0">请到 设置 → 模型服务 添加，或点右边 + 新建</span>
        ) : (
          models.map((m) => (
            <button
              key={m.id}
              type="button"
              className="m-chip shrink-0 gap-1"
              aria-pressed={!!m.is_default}
              style={m.is_default ? { background: "var(--m-accent-soft2)", color: "var(--m-accent-ink)", fontWeight: 700 } : { background: "var(--m-surface)" }}
              onClick={() => void switchDefaultModel(m.id)}
            >
              {m.is_default && <Check size={14} />}
              {m.name}
            </button>
          ))
        )}
        <button type="button" aria-label="新建模型服务" className="m-chip shrink-0" style={{ background: "var(--m-surface)" }} onClick={() => setAddModelOpen(true)}>
          <Plus size={16} />
        </button>
      </div>

      {/* 快捷入口 */}
      <div className="m-px mt-3">
        <MGroup className="grid grid-cols-4 px-1 py-2">
          {QUICK_ENTRIES.map((q) => (
            <button key={q.key} type="button" className="m-kk" onClick={() => void createNew(q.state)}>
              <span style={{ color: q.color }}>{q.icon}</span>
              {q.label}
            </button>
          ))}
        </MGroup>
      </div>

      {/* 对话历史 */}
      <div className="m-px mt-6">
        <MSectionHeader
          className="mb-2 px-1"
          title={manageMode && selectedIds.length > 0 ? `已选 ${selectedIds.length}` : "对话历史"}
          count={manageMode ? undefined : shown.total}
          action={
            <button
              type="button"
              className="m-tapx text-[15px] font-semibold"
              style={{ color: "var(--m-accent-ink)" }}
              onClick={() => (manageMode ? exitManageMode() : setManageSheetOpen(true))}
            >
              {manageMode ? "完成" : "管理"}
            </button>
          }
        />
        {loading && conversations.length === 0 ? (
          <div className="m-t-meta py-8 text-center">加载中…</div>
        ) : shown.total === 0 ? (
          <div className="flex flex-col items-center gap-2 py-14 text-center">
            <MessageSquarePlus size={36} style={{ color: "var(--m-ink4)" }} />
            <span className="m-t-body" style={{ color: "var(--m-ink2)" }}>{keyword.trim() ? `没有标题含「${keyword.trim()}」的对话` : "还没有对话"}</span>
            {!keyword.trim() && <span className="m-t-cap">点右下角按钮开始对话</span>}
          </div>
        ) : (
          <>
            {shown.pinned.length > 0 && (
              <>
                <div className="m-t-cap mb-1.5 px-1">置顶</div>
                <MGroup className="mb-4">{renderRows(shown.pinned)}</MGroup>
              </>
            )}
            {shown.others.length > 0 && <MGroup>{renderRows(shown.others)}</MGroup>}
          </>
        )}
      </div>

      {/* 多选模式底部操作条（悬在 Tab 之上） */}
      {manageMode && (
        <div
          className="m-px fixed inset-x-0 z-30 flex items-center gap-3 py-2"
          style={{ bottom: "calc(56px + env(safe-area-inset-bottom, 0px))", background: "var(--m-surface)", borderTop: "0.5px solid var(--m-hair)" }}
        >
          <button
            type="button"
            className="m-btn"
            style={{ background: "var(--m-well)", color: "var(--m-ink)" }}
            onClick={() => setSelectedIds(allSelected ? [] : [...shown.pinned, ...shown.others].map((c) => c.id))}
          >
            {allSelected ? "取消全选" : "全选"}
          </button>
          {/* 固定深红（同角标底色）：暗色主题的 --m-bad 是浅粉，白字压不住 */}
          <button type="button" className="m-btn flex-1" style={{ background: "#B83D53", color: "#fff" }} disabled={selectedIds.length === 0} onClick={confirmDeleteSelected}>
            删除{selectedIds.length > 0 ? ` (${selectedIds.length})` : ""}
          </button>
        </div>
      )}

      {/* 自带「新对话」按钮（全局 FAB 在 /ai 隐藏）；多选时隐藏，免得和底部操作条抢位 */}
      {!manageMode && (
        <button
          type="button"
          aria-label="新对话"
          className="m-fab"
          style={{ bottom: "calc(56px + env(safe-area-inset-bottom, 0px) + 16px)" }}
          onClick={() => void createNew()}
        >
          <MessageSquarePlus size={24} />
        </button>
      )}

      <ActionSheet open={sheetConv !== null} title={sheetConv?.title || "未命名对话"} items={convSheetItems} onClose={() => setSheetConv(null)} />
      <ActionSheet open={manageSheetOpen} title="管理对话历史" items={manageSheetItems} onClose={() => setManageSheetOpen(false)} />

      <TextPromptModal
        open={renameConv !== null}
        title="重命名对话"
        initialValue={renameConv?.title ?? ""}
        placeholder="对话标题"
        okText="保存"
        maxLength={100}
        onOk={async (t) => {
          if (!renameConv) return;
          try {
            await aiChatApi.renameConversation(renameConv.id, t);
            await load();
          } catch (e) {
            message.error(`重命名失败: ${e}`);
          }
        }}
        onClose={() => setRenameConv(null)}
      />

      <MobileAiModelModal open={addModelOpen} onClose={() => setAddModelOpen(false)} onSaved={() => void load()} okText="保存" />
      <ShareConfigModal open={shareEnv !== null} onClose={() => setShareEnv(null)} envelope={shareEnv} />
      <ImportConfigModal open={importOpen} onClose={() => setImportOpen(false)} onImported={() => void load()} />
    </div>
  );
}

function ConversationRow({
  conv,
  divider,
  modelName,
  manageMode,
  selected,
  onClick,
  onLongPress,
}: {
  conv: AiConversation;
  divider: boolean;
  modelName: string;
  manageMode: boolean;
  selected: boolean;
  onClick: () => void;
  onLongPress: () => void;
}) {
  const noteCount = conv.attached_note_ids?.length ?? 0;
  // 长按 = 桌面右键：唤起重命名 / 置顶 / 删除面板；轻点仍进对话（多选模式下则是切换选中）
  const longPress = useLongPress(onLongPress, { onClick });

  return (
    <div
      {...longPress}
      role="button"
      tabIndex={0}
      aria-pressed={manageMode ? selected : undefined}
      className="relative flex min-h-[60px] w-full cursor-pointer select-none items-center gap-3 px-4 py-3"
      style={{ WebkitTouchCallout: "none", background: selected ? "var(--m-accent-soft)" : undefined }}
    >
      {divider && <span className="pointer-events-none absolute top-0 right-0 left-[52px] h-[0.5px]" style={{ background: "var(--m-hair)" }} />}
      <span className="flex w-6 shrink-0 justify-center" style={{ color: manageMode && selected ? "var(--m-accent-ink)" : "var(--m-ink3)" }}>
        {manageMode ? selected ? <CheckSquare size={20} /> : <Square size={20} /> : <MessageCircle size={20} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold" style={{ color: "var(--m-ink)" }}>
          {conv.title || "未命名对话"}
        </span>
        <span className="m-t-cap mt-0.5 flex min-w-0 items-center gap-1.5">
          <span className="truncate">{modelName}</span>
          {noteCount > 0 && (
            <span className="flex shrink-0 items-center gap-0.5">
              · <BookText size={12} /> {noteCount} 篇
            </span>
          )}
        </span>
      </span>
      <span className="m-t-cap shrink-0">{relativeTime(conv.updated_at)}</span>
    </div>
  );
}
