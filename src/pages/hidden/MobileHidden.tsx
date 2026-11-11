import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, EyeOff, FileText, Trash2 } from "lucide-react";
import { Modal, message } from "antd";
import { folderApi, hiddenApi, hiddenPinApi, noteApi, trashApi } from "@/lib/api";
import type { Folder, Note } from "@/types";
import { useAppStore } from "@/store";
import { relativeTime } from "@/lib/utils";
import { useLongPress } from "@/hooks/useLongPress";
import { HiddenPinUnlockModal } from "@/components/hidden/HiddenPinUnlockModal";
import { HiddenPinSection } from "@/components/hidden/HiddenPinSection";
import { ActionSheet, type ActionSheetItem } from "@/components/mobile/ActionSheet";
import { MGroup, MNavBar, MSectionHeader } from "@/components/mobile/primitives";

/**
 * 移动端隐藏笔记（路由 /hidden）
 *
 * 🔒 PIN 拦截在页面里做：PC 是点活动栏「隐藏笔记」时拦，手机没有活动栏，「我的」/ 全部功能直接跳 /hidden，
 * 原来手机上设了 PIN 照样能直接进来。现在进页面先查：设过 PIN 且本次会话没解锁 → 弹解锁框，取消就退回上一页。
 *
 * - 列表：分页 50，加载更多；轻点打开笔记，右侧「取消隐藏」，长按 = 打开 / 取消隐藏 / 移到回收站
 * - 底部：PIN 设置（复用设置页的 HiddenPinSection：设置 / 修改 / 清除）
 */

const PAGE_SIZE = 50;

type Gate = "checking" | "locked" | "open";

export function MobileHidden() {
  const navigate = useNavigate();
  const [gate, setGate] = useState<Gate>("checking");
  const [items, setItems] = useState<Note[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [sheetNote, setSheetNote] = useState<Note | null>(null);

  // 进页面先过 PIN（同 ActivityBar 的规则：查询失败时不锁死入口，但给提示）
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (useAppStore.getState().isHiddenUnlocked()) {
        if (alive) setGate("open");
        return;
      }
      try {
        const set = await hiddenPinApi.isSet();
        if (alive) setGate(set ? "locked" : "open");
      } catch (e) {
        console.warn("[hidden-pin] isSet 查询失败:", e);
        message.warning("PIN 状态查询失败，已跳过验证");
        if (alive) setGate("open");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const load = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const res = await hiddenApi.list({ page: p, pageSize: PAGE_SIZE });
      setItems((prev) => (p === 1 ? res.items : [...prev, ...res.items]));
      setTotal(res.total);
      setPage(p);
    } catch (e) {
      message.error(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (gate !== "open") return;
    void load(1);
    folderApi
      .list()
      .then(setFolders)
      .catch(() => {});
  }, [gate, load]);

  const folderName = useMemo(() => {
    const map = new Map<number, string>();
    const walk = (list: Folder[]) => {
      for (const f of list) {
        map.set(f.id, f.name);
        if (f.children?.length) walk(f.children);
      }
    };
    walk(folders);
    return (id: number | null) => (id == null ? "未分类" : map.get(id) ?? "未分类");
  }, [folders]);

  async function unhide(n: Note) {
    try {
      await noteApi.setHidden(n.id, false);
      message.success("已取消隐藏");
      setItems((prev) => prev.filter((x) => x.id !== n.id));
      setTotal((t) => Math.max(0, t - 1));
      useAppStore.getState().bumpNotesRefresh();
    } catch (e) {
      message.error(`操作失败: ${e}`);
    }
  }

  function moveToTrash(n: Note) {
    Modal.confirm({
      title: `把「${n.title || "未命名笔记"}」移到回收站？`,
      content: "回收站保留 30 天，期间可还原。",
      okText: "移到回收站",
      okType: "danger",
      cancelText: "取消",
      centered: true,
      onOk: async () => {
        try {
          await trashApi.softDelete(n.id);
          message.success("已移到回收站");
          setItems((prev) => prev.filter((x) => x.id !== n.id));
          setTotal((t) => Math.max(0, t - 1));
        } catch (e) {
          message.error(`删除失败: ${e}`);
        }
      },
    });
  }

  const sheetItems: ActionSheetItem[] = sheetNote
    ? [
        { key: "open", label: "打开", icon: <FileText size={20} />, onClick: () => navigate(`/notes/${sheetNote.id}`) },
        { key: "unhide", label: "取消隐藏", icon: <Eye size={20} />, onClick: () => void unhide(sheetNote) },
        { key: "trash", label: "移到回收站", icon: <Trash2 size={20} />, danger: true, onClick: () => moveToTrash(sheetNote) },
      ]
    : [];

  return (
    <div className="mx-auto w-full max-w-[860px] pb-12">
      <MNavBar onBack={() => navigate(-1)} title="隐藏笔记" subtitle={gate === "open" ? `${total} 篇` : undefined} />

      {gate === "open" && (
        <>
          <div className="m-gutter m-t-cap mt-1">隐藏的笔记不出现在笔记列表、搜索和 AI 检索里</div>
          <div className="m-gutter mt-4">
            {loading && items.length === 0 ? (
              <div className="m-t-meta py-10 text-center">加载中…</div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-14 text-center">
                <EyeOff size={36} style={{ color: "var(--m-ink4)" }} />
                <span className="m-t-body" style={{ color: "var(--m-ink2)" }}>没有隐藏的笔记</span>
                <span className="m-t-cap">在笔记的「…」菜单里可以把笔记设为隐藏</span>
              </div>
            ) : (
              <>
                <MGroup>
                  {items.map((n, i) => (
                    <HiddenRow
                      key={n.id}
                      note={n}
                      folder={folderName(n.folder_id)}
                      divider={i > 0}
                      onOpen={() => navigate(`/notes/${n.id}`)}
                      onUnhide={() => void unhide(n)}
                      onMenu={() => setSheetNote(n)}
                    />
                  ))}
                </MGroup>
                {items.length < total && (
                  <button type="button" className="m-btn mt-3 w-full" style={{ background: "var(--m-well)", color: "var(--m-ink)" }} disabled={loading} onClick={() => void load(page + 1)}>
                    {loading ? "加载中…" : `加载更多（还有 ${total - items.length} 篇）`}
                  </button>
                )}
              </>
            )}
          </div>

          <div className="m-gutter m-pin-section mt-8">
            <MSectionHeader className="mb-2 px-1" title="PIN 设置" />
            <HiddenPinSection />
          </div>
        </>
      )}

      {gate === "locked" && <div className="m-t-meta py-16 text-center">需要输入 PIN 才能查看</div>}

      <HiddenPinUnlockModal
        open={gate === "locked"}
        onSuccess={() => setGate("open")}
        onCancel={() => navigate(-1)}
      />
      <ActionSheet open={!!sheetNote} title={sheetNote?.title || "未命名笔记"} items={sheetItems} onClose={() => setSheetNote(null)} />
    </div>
  );
}

function HiddenRow({
  note,
  folder,
  divider,
  onOpen,
  onUnhide,
  onMenu,
}: {
  note: Note;
  folder: string;
  divider: boolean;
  onOpen: () => void;
  onUnhide: () => void;
  onMenu: () => void;
}) {
  const lp = useLongPress(onMenu, { onClick: onOpen });
  return (
    <div className="relative flex min-h-[60px] items-center gap-3 pr-1 pl-4">
      {divider && <span className="pointer-events-none absolute top-0 right-0 left-[52px] h-[0.5px]" style={{ background: "var(--m-hair)" }} />}
      <span className="flex w-6 shrink-0 justify-center" style={{ color: "var(--m-ink3)" }}>
        <EyeOff size={20} />
      </span>
      <div {...lp} role="button" tabIndex={0} className="min-w-0 flex-1 cursor-pointer select-none self-stretch py-3" style={{ WebkitTouchCallout: "none" }}>
        <div className="truncate text-[15px] font-medium" style={{ color: "var(--m-ink)" }}>
          {note.title || "未命名笔记"}
        </div>
        <div className="m-t-cap mt-0.5 truncate">
          {folder} · {relativeTime(note.updated_at)}
        </div>
      </div>
      <button type="button" aria-label={`取消隐藏「${note.title || "未命名笔记"}」`} className="m-icon-btn shrink-0" style={{ color: "var(--m-accent-ink)" }} onClick={onUnhide}>
        <Eye size={18} />
      </button>
    </div>
  );
}
