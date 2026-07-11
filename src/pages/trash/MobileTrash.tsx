import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronLeft,
  Info,
  FileText,
  RotateCcw,
  Trash,
  Trash2,
  ClockAlert,
} from "lucide-react";
import { Modal, message } from "antd";
import { trashApi } from "@/lib/api";
import { useAppStore } from "@/store";
import type { Note } from "@/types";
import { useLongPress } from "@/hooks/useLongPress";
import { ActionSheet, type ActionSheetItem } from "@/components/mobile/ActionSheet";

/**
 * 移动端回收站（设计稿：13-trash.html）
 *
 * 路由 /trash —— isMobile=true 时通过 wrapper 加载本组件。
 *
 * 功能：
 * - 顶栏：返回 + 「回收站」 + （编辑按钮暂占位）
 * - 信息横幅：保留 30 天，当前共 N 项
 * - 即将清理（删除时间 ≥ 28 天前）红框单独高亮
 * - 最近删除：常规列表，每项支持「还原」按钮
 * - 底部：「全部还原」+「清空回收站」（双确认）
 *
 * 后端接口：
 * - trashApi.list(page, pageSize) → PageResult<Note>
 * - trashApi.restore(id)
 * - trashApi.permanentDelete(id)
 * - trashApi.empty() → 删除条数
 */

const RETENTION_DAYS = 30;
const PAGE_SIZE = 50;

/** 计算"还有几天自动清理"。删除日期 + 30 天 - 今天。 */
function daysUntilCleanup(updatedAt: string): number {
  const deletedAt = new Date(updatedAt).getTime();
  const cleanupAt = deletedAt + RETENTION_DAYS * 86400_000;
  const remain = Math.ceil((cleanupAt - Date.now()) / 86400_000);
  return Math.max(0, remain);
}

export function MobileTrash() {
  const navigate = useNavigate();
  const [items, setItems] = useState<Note[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  // 长按普通行唤起的动作面板
  const [sheetNote, setSheetNote] = useState<Note | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await trashApi.list(1, PAGE_SIZE);
      setItems(res.items ?? []);
      setTotal(res.total ?? 0);
    } catch (e) {
      console.error("[MobileTrash] load failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRestore(note: Note) {
    try {
      await trashApi.restore(note.id);
      message.success("已还原");
      useAppStore.getState().bumpNotesRefresh();
      await load();
    } catch (e) {
      message.error(`还原失败: ${e}`);
    }
  }

  async function handlePermanentDelete(note: Note) {
    Modal.confirm({
      title: `永久删除「${note.title || "未命名笔记"}」？`,
      content: "此操作不可撤销。",
      okText: "永久删除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        try {
          await trashApi.permanentDelete(note.id);
          message.success("已永久删除");
          await load();
        } catch (e) {
          message.error(`删除失败: ${e}`);
        }
      },
    });
  }

  function handleEmpty() {
    if (items.length === 0) return;
    Modal.confirm({
      title: `清空回收站（${total} 项）？`,
      content: "所有已删除笔记将被永久清除，无法恢复。",
      okText: "清空",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        try {
          const n = await trashApi.empty();
          message.success(`已清除 ${n} 项`);
          await load();
        } catch (e) {
          message.error(`清空失败: ${e}`);
        }
      },
    });
  }

  // 分组：即将清理（剩余天数 < 7） vs 最近删除
  const expiring = items.filter((n) => daysUntilCleanup(n.updated_at) < 7);
  const normal = items.filter((n) => daysUntilCleanup(n.updated_at) >= 7);

  // 长按动作面板：还原 / 永久删除（普通行原本只有"还原"快捷键）
  const sheetItems: ActionSheetItem[] = sheetNote
    ? [
        {
          key: "restore",
          label: "还原",
          icon: <RotateCcw size={20} />,
          onClick: () => handleRestore(sheetNote),
        },
        {
          key: "permanent",
          label: "永久删除",
          icon: <Trash size={20} />,
          danger: true,
          onClick: () => handlePermanentDelete(sheetNote),
        },
      ]
    : [];

  return (
    <div className="flex h-full flex-col text-slate-800">
      {/* 顶栏 */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-2">
        <button
          onClick={() => navigate(-1)}
          aria-label="返回"
          className="flex h-10 w-10 items-center justify-center"
        >
          <ChevronLeft size={24} className="text-slate-700" />
        </button>
        <h1 className="text-base font-semibold">回收站</h1>
        <div className="w-10" />
      </header>

      {/* 提示横幅 */}
      <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5">
        <Info size={16} className="mt-0.5 shrink-0 text-amber-600" />
        <p className="text-xs leading-relaxed text-amber-800">
          已删除笔记保留 {RETENTION_DAYS} 天，到期后自动清理。当前共{" "}
          <strong>{total} 项</strong>。
        </p>
      </div>

      {/* 列表 */}
      <main className="flex-1 overflow-y-auto bg-slate-50 pb-24">
        {loading && items.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-slate-400">
            加载中…
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-slate-400">
            <Trash2 size={40} className="text-slate-300" />
            <span className="text-sm">回收站为空</span>
            <span className="text-xs text-slate-300">
              删除的笔记会暂存在这里 {RETENTION_DAYS} 天
            </span>
          </div>
        ) : (
          <>
            {expiring.length > 0 && (
              <>
                <SectionLabel
                  text="即将清理"
                  icon={<ClockAlert size={14} className="text-red-500" />}
                  color="text-red-600"
                />
                {expiring.map((n) => (
                  <ExpiringCard
                    key={n.id}
                    note={n}
                    onRestore={() => handleRestore(n)}
                    onPermanent={() => handlePermanentDelete(n)}
                  />
                ))}
              </>
            )}
            {normal.length > 0 && (
              <>
                <SectionLabel text="最近删除" />
                <div className="mx-4 mb-2 divide-y divide-slate-100 rounded-2xl bg-white">
                  {normal.map((n) => (
                    <RegularRow
                      key={n.id}
                      note={n}
                      onRestore={() => handleRestore(n)}
                      onLongPress={() => setSheetNote(n)}
                    />
                  ))}
                </div>
              </>
            )}
            <div className="px-4 py-6 text-center text-xs text-slate-400">
              已显示全部 {total} 项
            </div>
          </>
        )}
      </main>

      {/* 底部操作栏 */}
      {items.length > 0 && (
        <footer
          className="border-t border-slate-200 bg-white px-4 py-3 shrink-0"
          style={{ paddingBottom: "calc(12px + env(safe-area-inset-bottom, 0px))" }}
        >
          <button
            onClick={handleEmpty}
            className="flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-red-50 text-sm font-medium text-red-600 active:bg-red-100"
          >
            <Trash2 size={16} /> 清空回收站
          </button>
        </footer>
      )}

      {/* 长按回收站条目唤起的底部操作面板 */}
      <ActionSheet
        open={sheetNote !== null}
        title={sheetNote?.title || "未命名笔记"}
        items={sheetItems}
        onClose={() => setSheetNote(null)}
      />
    </div>
  );
}

function SectionLabel({
  text,
  icon,
  color = "text-slate-400",
}: {
  text: string;
  icon?: React.ReactNode;
  color?: string;
}) {
  return (
    <div
      className={`flex items-center gap-1.5 px-4 pt-3 pb-1 text-xs font-medium ${color}`}
    >
      {icon}
      <span>{text}</span>
    </div>
  );
}

function ExpiringCard({
  note,
  onRestore,
  onPermanent,
}: {
  note: Note;
  onRestore: () => void;
  onPermanent: () => void;
}) {
  const remain = daysUntilCleanup(note.updated_at);
  return (
    <div className="mx-4 mb-2 rounded-2xl border border-red-200 bg-white p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-50">
          <FileText size={18} className="text-red-400" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium text-slate-900">
            {note.title || "未命名笔记"}
          </h3>
          {note.content && (
            <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">
              {note.content.slice(0, 80)}
            </p>
          )}
          <div className="mt-2 flex items-center gap-2 text-[10px] text-slate-400">
            <span>{new Date(note.updated_at).toLocaleDateString("zh-CN")} 删除</span>
            <span className="font-medium text-red-500">
              · {remain === 0 ? "今天" : `${remain} 天后`}清理
            </span>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              onClick={onRestore}
              className="flex h-8 flex-1 items-center justify-center gap-1 rounded-lg bg-slate-100 text-xs font-medium text-slate-700 active:bg-slate-200"
            >
              <RotateCcw size={14} /> 还原
            </button>
            <button
              onClick={onPermanent}
              className="flex h-8 flex-1 items-center justify-center gap-1 rounded-lg bg-red-50 text-xs font-medium text-red-600 active:bg-red-100"
            >
              <Trash size={14} /> 永久删除
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RegularRow({
  note,
  onRestore,
  onLongPress,
}: {
  note: Note;
  onRestore: () => void;
  onLongPress: () => void;
}) {
  const remain = daysUntilCleanup(note.updated_at);
  // 长按条目正文区唤起动作面板（还原/永久删除）；右侧"还原"按钮独立保留
  const longPress = useLongPress(onLongPress);
  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100">
          <FileText size={16} className="text-slate-400" />
        </div>
        <div
          {...longPress}
          className="min-w-0 flex-1 select-none"
          style={{ WebkitTouchCallout: "none" }}
        >
          <h3 className="truncate text-sm font-medium text-slate-900">
            {note.title || "未命名笔记"}
          </h3>
          <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-400">
            <span>{new Date(note.updated_at).toLocaleDateString("zh-CN")} 删除</span>
            <span>· {remain} 天后清理</span>
          </div>
        </div>
        <button
          onClick={onRestore}
          aria-label="还原"
          className="flex h-9 w-9 items-center justify-center rounded-lg active:bg-slate-100"
        >
          <RotateCcw size={16} className="text-blue-500" />
        </button>
      </div>
    </div>
  );
}
