import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { message } from "antd";
import { Search, Pin, Plus, MoreHorizontal, Copy, Trash2 } from "lucide-react";
import { noteApi, trashApi } from "@/lib/api";
import { useAppStore } from "@/store";
import type { Note } from "@/types";
import { relativeTime } from "@/lib/utils";
import { useLongPress } from "@/hooks/useLongPress";
import { ActionSheet, type ActionSheetItem } from "@/components/mobile/ActionSheet";

/**
 * 移动端笔记列表（设计稿：output/UI原型/2026-05-04_知识库移动端App/01-notes.html）
 *
 * 结构：
 * - 顶栏：标题"笔记" + 数量 + 搜索按钮 + 更多按钮（功能暂留）
 * - 文件夹 chips 横滑（暂用静态 ["全部"]，后续从 folderApi.list 拉）
 * - 置顶区（is_pinned 笔记）+ 普通区
 * - 笔记卡片：标题 / 2 行预览 / 时间 / 反链数（如有）
 * - FAB 在 MobileLayout 提供，不需重复
 *
 * 性能：第一屏 page_size=20，下拉到底加载下一页（暂未实现，后续 PR）
 */

const PAGE_SIZE = 30;

export function MobileNotes() {
  const navigate = useNavigate();
  const [notes, setNotes] = useState<Note[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  // 长按唤起的动作面板：null = 关闭，非 null = 对该笔记操作
  const [sheetNote, setSheetNote] = useState<Note | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await noteApi.list({ page: 1, page_size: PAGE_SIZE });
      setNotes(res.items ?? []);
      setTotal(res.total ?? 0);
    } catch (e) {
      console.error("[MobileNotes] load failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  // notesRefreshTick：MobileNoteEditor 保存返回时 bump，触发列表重新拉
  const refreshTick = useAppStore((s) => s.notesRefreshTick);

  useEffect(() => {
    void load();
  }, [load, refreshTick]);

  const pinned = notes.filter((n) => n.is_pinned);
  const others = notes.filter((n) => !n.is_pinned);

  // 长按动作面板的操作项（复用桌面右键的核心动作：置顶 / 复制 ID / 删除）
  const sheetItems: ActionSheetItem[] = sheetNote
    ? [
        {
          key: "pin",
          label: sheetNote.is_pinned ? "取消置顶" : "置顶",
          icon: <Pin size={20} />,
          onClick: async () => {
            try {
              await noteApi.togglePin(sheetNote.id);
              message.success(sheetNote.is_pinned ? "已取消置顶" : "已置顶");
              await load();
            } catch (e) {
              message.error(String(e));
            }
          },
        },
        {
          key: "copy-id",
          label: "复制笔记 ID",
          icon: <Copy size={20} />,
          onClick: () => {
            // 与桌面 NotesPanel 一致：给外部 agent / MCP 用，拿到 ID 直接 get_note(id)
            navigator.clipboard
              .writeText(String(sheetNote.id))
              .then(() => message.success(`已复制 ID：${sheetNote.id}`))
              .catch(() => message.error("复制失败"));
          },
        },
        {
          key: "delete",
          label: "删除",
          icon: <Trash2 size={20} />,
          danger: true,
          onClick: async () => {
            // 软删到回收站（可在 /trash 恢复），无需二次确认
            try {
              await trashApi.softDelete(sheetNote.id);
              message.success("已移到回收站");
              await load();
            } catch (e) {
              message.error(String(e));
            }
          },
        },
      ]
    : [];

  return (
    <div className="text-slate-800">
      {/* 顶栏 */}
      <div className="bg-white px-4 pt-3 pb-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">笔记</h1>
            <div className="mt-0.5 text-xs text-slate-400">
              共 {total} 篇
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => navigate("/search")}
              aria-label="搜索"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 active:bg-slate-200"
            >
              <Search size={18} className="text-slate-700" />
            </button>
            <button
              aria-label="更多"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 active:bg-slate-200"
            >
              <MoreHorizontal size={18} className="text-slate-700" />
            </button>
          </div>
        </div>

        {/* 文件夹 chips（暂只显示"全部"，后续接 folderApi） */}
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1 -mx-4 px-4 scrollbar-none">
          <span className="shrink-0 rounded-full bg-[#1677FF] px-3 py-1.5 text-sm font-medium text-white whitespace-nowrap">
            全部 {total}
          </span>
        </div>
      </div>

      {/* 列表 */}
      <div className="bg-slate-50 pb-24">
        {loading && notes.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-slate-400">
            加载中...
          </div>
        ) : notes.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-slate-400">
            <Plus size={40} className="text-slate-300" />
            <span className="text-sm">还没有笔记</span>
            <span className="text-xs text-slate-300">
              点右下 + 按钮新建第一篇
            </span>
          </div>
        ) : (
          <>
            {pinned.length > 0 && (
              <>
                <SectionLabel icon={<Pin size={12} />} text="置顶" />
                {pinned.map((note) => (
                  <NoteCard
                    key={note.id}
                    note={note}
                    onOpen={() => navigate(`/notes/${note.id}`)}
                    onLongPress={() => setSheetNote(note)}
                  />
                ))}
              </>
            )}

            {others.length > 0 && (
              <>
                <SectionLabel text="最近" />
                {others.map((note) => (
                  <NoteCard
                    key={note.id}
                    note={note}
                    onOpen={() => navigate(`/notes/${note.id}`)}
                    onLongPress={() => setSheetNote(note)}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>

      {/* 长按笔记卡片唤起的底部操作面板 */}
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
}: {
  text: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1 px-4 pt-3 pb-1 text-xs font-medium text-slate-400">
      {icon}
      <span>{text}</span>
    </div>
  );
}

function NoteCard({
  note,
  onOpen,
  onLongPress,
}: {
  note: Note;
  onOpen: () => void;
  onLongPress: () => void;
}) {
  // 笔记预览：去掉 HTML 标签，截 80 字
  const preview = (note.content || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  // 轻点进入编辑，长按唤起动作面板（滑动/滚动不误触）
  const longPress = useLongPress(onLongPress, { onClick: onOpen });

  return (
    <div
      {...longPress}
      role="button"
      className="block w-full cursor-pointer select-none px-4 mb-2 text-left active:opacity-80 transition-opacity"
      style={{ WebkitTouchCallout: "none" }}
    >
      <div className="rounded-2xl bg-white p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="flex-1 truncate text-base font-semibold text-slate-900">
            {note.title || "未命名笔记"}
          </h3>
          {note.is_pinned && (
            <Pin size={14} className="mt-1 shrink-0 text-amber-500" />
          )}
        </div>
        {preview && (
          <p className="mt-1 line-clamp-2 text-sm text-slate-500">{preview}</p>
        )}
        <div className="mt-2 flex items-center gap-2 text-xs text-slate-400">
          <span className="ml-auto">{relativeTime(note.updated_at)}</span>
        </div>
      </div>
    </div>
  );
}
