import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  Search,
  Sparkles,
  BookOpenText,
  ListChecks,
  Languages,
  MessageCircle,
  MessageSquarePlus,
  Plus,
  Link2,
  Share2,
  Download,
  Pencil,
  Trash2,
  CheckSquare,
  Square,
  Eraser,
} from "lucide-react";
import { ShareConfigModal } from "@/components/config-share/ShareConfigModal";
import { ImportConfigModal } from "@/components/config-share/ImportConfigModal";
import { exportAiModel, type Envelope } from "@/lib/configShare";
import { Input, Modal, message } from "antd";
import { aiChatApi, aiModelApi } from "@/lib/api";
import type { AiConversation, AiModel } from "@/types";
import { relativeTime } from "@/lib/utils";
import { MobileAiModelModal } from "@/components/ai/MobileAiModelModal";
import { useLongPress } from "@/hooks/useLongPress";
import { ActionSheet, type ActionSheetItem } from "@/components/mobile/ActionSheet";

/**
 * 移动端 AI 助手列表页（设计稿：06-ai.html）
 *
 * 结构：
 * - 顶栏：标题"AI 助手" + 当前模型/对话数 + 搜索按钮
 * - 模型 chips 横滑（点击切换 default 模型）
 * - 4 个快捷入口（写作 / 解读 / 任务规划 / 翻译） — 点击 = 用预设 Prompt 创建新对话
 * - 对话历史列表（按 updated_at desc）
 * - 右下 FAB（橙色）= 创建空白对话
 *
 * 跳转：
 * - 点击对话 / FAB / 快捷入口 → 暂走 /ai?conv=ID（桌面 AiChatPage 已支持），
 *   等 MobileAiChat 做完再换 /ai-chat/:id
 *
 * 对话管理（此前完全缺失：「管理」按钮 navigate("/ai") 指向本页 = 点了没反应，
 * 且没有任何删除入口，历史只增不减）：
 * - 长按单条 → ActionSheet：重命名 / 删除
 * - 顶部「管理」→ ActionSheet：进入多选批量删除 / 一键清理 N 天前的对话
 * 后端能力早已具备（delete_ai_conversation / delete_ai_conversations_before /
 * rename_ai_conversation），桌面端 pages/ai/index.tsx 一直在用，这里只是接上。
 */

/** 「清理更早对话」可选的保留天数 */
const CLEANUP_DAYS = [7, 30, 90];

interface QuickEntry {
  key: string;
  icon: React.ReactNode;
  bg: string;
  label: string;
  /** 创建对话后预填到首条 user 消息的 prompt（暂未实现 prefill，先创建空对话） */
  preset?: string;
}

const QUICK_ENTRIES: QuickEntry[] = [
  {
    key: "write",
    icon: <Sparkles size={20} className="text-[#FA8C16]" />,
    bg: "bg-orange-50",
    label: "写作助手",
  },
  {
    key: "read",
    icon: <BookOpenText size={20} className="text-[#1677FF]" />,
    bg: "bg-blue-50",
    label: "解读笔记",
  },
  {
    key: "tasks",
    icon: <ListChecks size={20} className="text-green-600" />,
    bg: "bg-green-50",
    label: "任务规划",
  },
  {
    key: "translate",
    icon: <Languages size={20} className="text-purple-600" />,
    bg: "bg-purple-50",
    label: "翻译润色",
  },
];

export function MobileAi() {
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [models, setModels] = useState<AiModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [shareEnv, setShareEnv] = useState<Envelope | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  // ── 对话管理 ──
  /** 长按单条唤起的动作面板 */
  const [sheetConv, setSheetConv] = useState<AiConversation | null>(null);
  /** 顶部「管理」唤起的动作面板 */
  const [manageSheetOpen, setManageSheetOpen] = useState(false);
  /** 多选模式（批量删除） */
  const [manageMode, setManageMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  /** 重命名弹窗：非 null = 正在重命名该对话 */
  const [renameConv, setRenameConv] = useState<AiConversation | null>(null);
  const [renameText, setRenameText] = useState("");

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

  async function switchDefaultModel(id: number) {
    try {
      await aiModelApi.setDefault(id);
      await load();
    } catch (e) {
      message.error(`切换失败: ${e}`);
    }
  }

  function openConversation(conv: AiConversation) {
    navigate(`/ai-chat/${conv.id}`);
  }

  function exitManageMode() {
    setManageMode(false);
    setSelectedIds([]);
  }

  function toggleSelected(id: number) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
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

  async function submitRename() {
    if (!renameConv) return;
    const title = renameText.trim();
    if (!title) return;
    try {
      await aiChatApi.renameConversation(renameConv.id, title);
      setRenameConv(null);
      await load();
    } catch (e) {
      message.error(`重命名失败: ${e}`);
    }
  }

  /** 长按单条对话的操作项 */
  const convSheetItems: ActionSheetItem[] = sheetConv
    ? [
        {
          key: "rename",
          label: "重命名",
          icon: <Pencil size={20} />,
          onClick: () => {
            setRenameText(sheetConv.title || "");
            setRenameConv(sheetConv);
          },
        },
        {
          key: "delete",
          label: "删除",
          icon: <Trash2 size={20} />,
          danger: true,
          onClick: () => confirmDeleteOne(sheetConv),
        },
      ]
    : [];

  /** 顶部「管理」的操作项 */
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

  async function createNew() {
    try {
      const conv = await aiChatApi.createConversation();
      navigate(`/ai-chat/${conv.id}`);
    } catch (e) {
      message.error(`创建失败: ${e}`);
    }
  }

  return (
    <div className="text-slate-800">
      {/* 顶栏 */}
      <div className="bg-white px-4 pt-3 pb-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">AI 助手</h1>
            <div className="mt-0.5 text-xs text-slate-400">
              {defaultModel ? defaultModel.name : "未配置模型"} ·{" "}
              {conversations.length} 个对话
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => {
                if (defaultModel) setShareEnv(exportAiModel(defaultModel));
                else message.warning("请先配置一个 AI 模型");
              }}
              aria-label="分享当前模型"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 active:bg-slate-200"
            >
              <Share2 size={18} className="text-slate-700" />
            </button>
            <button
              onClick={() => setImportOpen(true)}
              aria-label="导入模型"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 active:bg-slate-200"
            >
              <Download size={18} className="text-slate-700" />
            </button>
            <button
              aria-label="搜索"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 active:bg-slate-200"
            >
              <Search size={18} className="text-slate-700" />
            </button>
          </div>
        </div>

        {/* 模型 chips */}
        <div className="mt-3 flex gap-2 overflow-x-auto -mx-4 px-4 pb-1 scrollbar-none">
          {models.length === 0 ? (
            <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1.5 text-sm text-slate-400">
              请到 设置 → AI 模型 添加
            </span>
          ) : (
            models.map((m) => (
              <button
                key={m.id}
                onClick={() => switchDefaultModel(m.id)}
                className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium ${
                  m.is_default
                    ? "border border-orange-200 bg-orange-50 text-orange-700"
                    : "bg-slate-100 text-slate-600"
                }`}
              >
                {m.name}
                {m.is_default && " ✓"}
              </button>
            ))
          )}
          <button
            onClick={() => setAddModelOpen(true)}
            aria-label="新增模型"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* 主体 */}
      <div className="bg-slate-50 pb-24">
        {/* 4 快捷入口 */}
        <div className="px-4 py-3">
          <div className="grid grid-cols-4 gap-3">
            {QUICK_ENTRIES.map((q) => (
              <button
                key={q.key}
                onClick={createNew}
                className="flex flex-col items-center gap-1.5 active:scale-95 transition-transform"
              >
                <div
                  className={`flex h-12 w-12 items-center justify-center rounded-2xl ${q.bg}`}
                >
                  {q.icon}
                </div>
                <span className="text-[11px] text-slate-700">{q.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 对话历史标题 */}
        <div className="flex items-center justify-between px-4 pt-1 pb-1 text-xs font-medium text-slate-400">
          <span>
            对话历史
            {manageMode && selectedIds.length > 0 && ` · 已选 ${selectedIds.length}`}
          </span>
          <button
            onClick={() =>
              manageMode ? exitManageMode() : setManageSheetOpen(true)
            }
            className="text-[#1677FF]"
          >
            {manageMode ? "完成" : "管理"}
          </button>
        </div>

        {/* 对话列表 */}
        {loading && conversations.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-slate-400">
            加载中...
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-slate-400">
            <MessageSquarePlus size={40} className="text-slate-300" />
            <span className="text-sm">还没有对话</span>
            <span className="text-xs text-slate-300">
              点右下橙色按钮开始对话
            </span>
          </div>
        ) : (
          conversations.map((conv) => (
            <ConversationCard
              key={conv.id}
              conv={conv}
              modelName={
                models.find((m) => m.id === conv.model_id)?.name ?? "未知模型"
              }
              manageMode={manageMode}
              selected={selectedIds.includes(conv.id)}
              onClick={() =>
                manageMode ? toggleSelected(conv.id) : openConversation(conv)
              }
              onLongPress={() => {
                if (!manageMode) setSheetConv(conv);
              }}
            />
          ))
        )}
      </div>

      {/* 多选模式底部操作条（悬在 Tab 之上） */}
      {manageMode && (
        <div
          className="fixed inset-x-0 z-30 flex items-center gap-3 border-t border-slate-200 bg-white px-4 py-2"
          style={{ bottom: `calc(64px + env(safe-area-inset-bottom, 0px))` }}
        >
          <button
            onClick={() =>
              setSelectedIds(
                selectedIds.length === conversations.length
                  ? []
                  : conversations.map((c) => c.id),
              )
            }
            className="rounded-full bg-slate-100 px-4 text-sm font-medium text-slate-600 active:bg-slate-200"
            style={{ minHeight: 44 }}
          >
            {selectedIds.length === conversations.length && conversations.length > 0
              ? "取消全选"
              : "全选"}
          </button>
          <button
            onClick={confirmDeleteSelected}
            disabled={selectedIds.length === 0}
            className="flex-1 rounded-full bg-[#ff4d4f] text-sm font-medium text-white active:opacity-80 disabled:opacity-40"
            style={{ minHeight: 44 }}
          >
            删除{selectedIds.length > 0 ? ` (${selectedIds.length})` : ""}
          </button>
        </div>
      )}

      {/* FAB（替代全局蓝色 + FAB，MobileLayout 已感知 /ai 隐藏全局 FAB）
          多选模式下隐藏，避免与底部批量操作条抢位 */}
      {!manageMode && (
      <button
        onClick={createNew}
        aria-label="新对话"
        className="fixed right-5 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-[#FA8C16] text-white shadow-[0_8px_24px_rgba(250,140,22,0.4)] active:scale-95 transition-transform"
        style={{
          bottom: `calc(64px + env(safe-area-inset-bottom, 0px) + 16px)`,
        }}
      >
        <MessageSquarePlus size={24} />
      </button>
      )}

      {/* 长按单条对话唤起 */}
      <ActionSheet
        open={sheetConv !== null}
        title={sheetConv?.title || "未命名对话"}
        items={convSheetItems}
        onClose={() => setSheetConv(null)}
      />

      {/* 顶部「管理」唤起 */}
      <ActionSheet
        open={manageSheetOpen}
        title="管理对话历史"
        items={manageSheetItems}
        onClose={() => setManageSheetOpen(false)}
      />

      {/* 重命名对话 */}
      <Modal
        title="重命名对话"
        open={renameConv !== null}
        onCancel={() => setRenameConv(null)}
        onOk={submitRename}
        okText="保存"
        cancelText="取消"
        okButtonProps={{ disabled: !renameText.trim() }}
        destroyOnClose
      >
        <Input
          autoFocus
          value={renameText}
          onChange={(e) => setRenameText(e.target.value)}
          placeholder="对话标题"
          onPressEnter={submitRename}
          maxLength={100}
        />
      </Modal>

      <MobileAiModelModal
        open={addModelOpen}
        onClose={() => setAddModelOpen(false)}
        onSaved={() => {
          void load();
        }}
        okText="保存"
      />

      <ShareConfigModal
        open={shareEnv !== null}
        onClose={() => setShareEnv(null)}
        envelope={shareEnv}
      />

      <ImportConfigModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => void load()}
      />
    </div>
  );
}

function ConversationCard({
  conv,
  modelName,
  manageMode,
  selected,
  onClick,
  onLongPress,
}: {
  conv: AiConversation;
  modelName: string;
  manageMode: boolean;
  selected: boolean;
  onClick: () => void;
  onLongPress: () => void;
}) {
  const hasNotes = conv.attached_note_ids && conv.attached_note_ids.length > 0;
  // 长按 = 桌面右键：唤起重命名 / 删除面板；轻点仍进对话（多选模式下则是切换选中）
  const longPress = useLongPress(onLongPress, { onClick });

  return (
    <div
      {...longPress}
      role="button"
      className="block w-full select-none px-4 mb-2 text-left active:opacity-80"
      style={{ WebkitTouchCallout: "none" }}
    >
      <div
        className={`rounded-2xl bg-white p-4 ${
          selected ? "ring-2 ring-[#FA8C16]" : ""
        }`}
      >
        <div className="flex items-start gap-3">
          {manageMode ? (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center">
              {selected ? (
                <CheckSquare size={20} className="text-[#FA8C16]" />
              ) : (
                <Square size={20} className="text-slate-300" />
              )}
            </div>
          ) : (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-orange-100">
              <MessageCircle size={16} className="text-[#FA8C16]" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-base font-semibold text-slate-900">
              {conv.title || "未命名对话"}
            </h3>
            <div className="mt-2 flex items-center gap-2 text-xs text-slate-400">
              <span className="rounded bg-orange-50 px-1.5 py-0.5 text-[10px] text-orange-600">
                {modelName}
              </span>
              {hasNotes && (
                <span className="flex items-center gap-1 text-slate-500">
                  <Link2 size={12} />
                  {conv.attached_note_ids.length} 篇
                </span>
              )}
              <span className="ml-auto">{relativeTime(conv.updated_at)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
