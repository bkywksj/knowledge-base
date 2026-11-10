import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Info, FileText, RotateCcw, Trash, Trash2, ClockAlert } from "lucide-react";
import { Modal, message } from "antd";
import { trashApi } from "@/lib/api";
import { useAppStore } from "@/store";
import type { Note } from "@/types";
import { dailyToPlainLines } from "@/lib/dailyTimeline";
import { useLongPress } from "@/hooks/useLongPress";
import { ActionSheet, type ActionSheetItem } from "@/components/mobile/ActionSheet";
import { MGroup, MNavBar } from "@/components/mobile/primitives";

/**
 * 移动端回收站（v4 样式，交互同原版）
 *
 * 路由 /trash —— isMobile=true 时通过 wrapper 加载本组件。
 *
 * - 信息横幅：保留 30 天，当前共 N 项
 * - 即将清理（剩余 < 7 天）单独一组，卡片上直接「还原 / 永久删除」
 * - 最近删除：常规列表，右侧「还原」，长按 = 还原 / 永久删除
 * - 底部：「全部还原」+「清空回收站」（都要确认）
 *
 * 后端接口：trashApi.list(page, pageSize) / restore(id) / permanentDelete(id) / empty()
 * 「全部还原」后端没有批量接口：分页取全量 id 后逐条 restore，失败的计数汇报、不中断其余
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

/** 正文预览：去掉 HTML / Markdown 标记（原来直出原文，会露出 <p>、** 之类） */
function preview(content: string | null | undefined): string {
  return content ? dailyToPlainLines(content).join(" ").slice(0, 80) : "";
}

export function MobileTrash() {
  const navigate = useNavigate();
  const [items, setItems] = useState<Note[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
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

  function handlePermanentDelete(note: Note) {
    Modal.confirm({
      title: `永久删除「${note.title || "未命名笔记"}」？`,
      content: "此操作不可撤销。",
      okText: "永久删除",
      okType: "danger",
      cancelText: "取消",
      centered: true,
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

  function handleRestoreAll() {
    if (items.length === 0 || busy) return;
    Modal.confirm({
      title: `全部还原（${total} 项）？`,
      content: "笔记会回到原来的文件夹；原文件夹已不存在的落到根目录。",
      okText: "全部还原",
      cancelText: "取消",
      centered: true,
      onOk: async () => {
        setBusy(true);
        try {
          // 列表只取了前 PAGE_SIZE 条，还原要覆盖全部：按页取全量 id
          const ids: number[] = [];
          for (let page = 1; ; page++) {
            const res = await trashApi.list(page, PAGE_SIZE);
            ids.push(...(res.items ?? []).map((n) => n.id));
            if (!res.items?.length || ids.length >= (res.total ?? 0)) break;
          }
          let failed = 0;
          for (const id of ids) {
            try {
              await trashApi.restore(id);
            } catch (e) {
              failed += 1;
              console.error("[MobileTrash] 还原失败:", id, e);
            }
          }
          if (failed > 0) message.warning(`已还原 ${ids.length - failed} 项，${failed} 项失败`);
          else message.success(`已还原 ${ids.length} 项`);
          useAppStore.getState().bumpNotesRefresh();
        } catch (e) {
          message.error(`还原失败: ${e}`);
        } finally {
          setBusy(false);
          await load();
        }
      },
    });
  }

  function handleEmpty() {
    if (items.length === 0 || busy) return;
    Modal.confirm({
      title: `清空回收站（${total} 项）？`,
      content: "所有已删除笔记将被永久清除，无法恢复。",
      okText: "清空",
      okType: "danger",
      cancelText: "取消",
      centered: true,
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
        { key: "restore", label: "还原", icon: <RotateCcw size={20} />, onClick: () => void handleRestore(sheetNote) },
        { key: "permanent", label: "永久删除", icon: <Trash size={20} />, danger: true, onClick: () => handlePermanentDelete(sheetNote) },
      ]
    : [];

  return (
    <div className="flex h-full flex-col" style={{ color: "var(--m-ink)" }}>
      <div className="shrink-0">
        <MNavBar onBack={() => navigate(-1)} title="回收站" />
      </div>

      {/* 提示横幅 */}
      <div className="m-px shrink-0">
        <div className="flex items-start gap-2 rounded-[var(--m-r-l)] px-3 py-2.5" style={{ background: "var(--m-warn-soft)", color: "var(--m-warn)" }}>
          <Info size={16} className="mt-0.5 shrink-0" />
          <p className="text-[13px] leading-relaxed">
            已删除笔记保留 {RETENTION_DAYS} 天，到期后自动清理。当前共 <strong>{total} 项</strong>。
          </p>
        </div>
      </div>

      {/* 列表 */}
      <main className="m-px flex-1 overflow-y-auto pt-2 pb-6">
        {loading && items.length === 0 ? (
          <div className="m-t-meta py-8 text-center">加载中…</div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <Trash2 size={36} style={{ color: "var(--m-ink4)" }} />
            <span className="m-t-body" style={{ color: "var(--m-ink2)" }}>回收站为空</span>
            <span className="m-t-cap">删除的笔记会暂存在这里 {RETENTION_DAYS} 天</span>
          </div>
        ) : (
          <>
            {expiring.length > 0 && (
              <>
                <div className="mt-2 mb-2 flex items-center gap-1.5 px-1 text-[13px] font-semibold" style={{ color: "var(--m-bad)" }}>
                  <ClockAlert size={15} /> 即将清理
                </div>
                {expiring.map((n) => (
                  <ExpiringCard key={n.id} note={n} onRestore={() => void handleRestore(n)} onPermanent={() => handlePermanentDelete(n)} />
                ))}
              </>
            )}
            {normal.length > 0 && (
              <>
                <div className="m-t-sec mt-4 mb-2 px-1">最近删除</div>
                <MGroup>
                  {normal.map((n, i) => (
                    <RegularRow key={n.id} note={n} divider={i > 0} onRestore={() => void handleRestore(n)} onLongPress={() => setSheetNote(n)} />
                  ))}
                </MGroup>
              </>
            )}
            <div className="m-t-cap py-6 text-center">{total > items.length ? `已显示前 ${items.length} 项，共 ${total} 项` : `已显示全部 ${total} 项`}</div>
          </>
        )}
      </main>

      {/* 底部操作栏 */}
      {items.length > 0 && (
        <footer
          className="m-px flex shrink-0 gap-3 pt-3"
          style={{ background: "var(--m-surface)", borderTop: "0.5px solid var(--m-hair)", paddingBottom: "calc(12px + env(safe-area-inset-bottom, 0px))" }}
        >
          <button type="button" onClick={handleRestoreAll} disabled={busy} className="m-btn flex-1 gap-1.5" style={{ background: "var(--m-well)", color: "var(--m-ink)" }}>
            <RotateCcw size={16} /> {busy ? "还原中…" : "全部还原"}
          </button>
          <button type="button" onClick={handleEmpty} disabled={busy} className="m-btn flex-1 gap-1.5" style={{ background: "var(--m-bad-soft)", color: "var(--m-bad)" }}>
            <Trash2 size={16} /> 清空回收站
          </button>
        </footer>
      )}

      {/* 长按回收站条目唤起的底部操作面板 */}
      <ActionSheet open={sheetNote !== null} title={sheetNote?.title || "未命名笔记"} items={sheetItems} onClose={() => setSheetNote(null)} />
    </div>
  );
}

function ExpiringCard({ note, onRestore, onPermanent }: { note: Note; onRestore: () => void; onPermanent: () => void }) {
  const remain = daysUntilCleanup(note.updated_at);
  const text = preview(note.content);
  return (
    <div className="mb-2 rounded-[var(--m-r-xl)] p-4" style={{ background: "var(--m-surface)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--m-bad) 35%, transparent)" }}>
      <div className="flex items-start gap-3">
        <span className="flex w-6 shrink-0 justify-center pt-0.5" style={{ color: "var(--m-bad)" }}>
          <FileText size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold" style={{ color: "var(--m-ink)" }}>
            {note.title || "未命名笔记"}
          </div>
          {text && <p className="m-t-meta mt-0.5 line-clamp-2">{text}</p>}
          <div className="m-t-cap mt-1.5">
            {new Date(note.updated_at).toLocaleDateString("zh-CN")} 删除
            <span style={{ color: "var(--m-bad)", fontWeight: 600 }}> · {remain === 0 ? "今天" : `${remain} 天后`}清理</span>
          </div>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={onRestore} className="m-btn h-11 flex-1 gap-1 px-3 text-[14px]" style={{ background: "var(--m-well)", color: "var(--m-ink)" }}>
              <RotateCcw size={15} /> 还原
            </button>
            <button type="button" onClick={onPermanent} className="m-btn h-11 flex-1 gap-1 px-3 text-[14px]" style={{ background: "var(--m-bad-soft)", color: "var(--m-bad)" }}>
              <Trash size={15} /> 永久删除
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RegularRow({ note, divider, onRestore, onLongPress }: { note: Note; divider: boolean; onRestore: () => void; onLongPress: () => void }) {
  const remain = daysUntilCleanup(note.updated_at);
  // 长按条目正文区唤起动作面板（还原/永久删除）；右侧"还原"按钮独立保留
  const longPress = useLongPress(onLongPress);
  return (
    <div className="relative flex min-h-[60px] items-center gap-3 pr-1 pl-4">
      {divider && <span className="pointer-events-none absolute top-0 right-0 left-[52px] h-[0.5px]" style={{ background: "var(--m-hair)" }} />}
      <span className="flex w-6 shrink-0 justify-center" style={{ color: "var(--m-ink3)" }}>
        <FileText size={20} />
      </span>
      <div {...longPress} className="min-w-0 flex-1 select-none self-stretch py-3" style={{ WebkitTouchCallout: "none" }}>
        <div className="truncate text-[15px] font-medium" style={{ color: "var(--m-ink)" }}>
          {note.title || "未命名笔记"}
        </div>
        <div className="m-t-cap mt-0.5">
          {new Date(note.updated_at).toLocaleDateString("zh-CN")} 删除 · {remain} 天后清理
        </div>
      </div>
      <button type="button" onClick={onRestore} aria-label="还原" className="m-icon-btn shrink-0" style={{ color: "var(--m-accent-ink)" }}>
        <RotateCcw size={18} />
      </button>
    </div>
  );
}
