import { useEffect, useMemo } from "react";
import { Check, Folder as FolderIcon, Inbox } from "lucide-react";
import type { Folder } from "@/types";

/**
 * 「移动到…」用的文件夹选择面板（手机端）。
 *
 * 整棵树按层级缩进平铺成一列（手机上逐层点进去再点确定太绕，平铺一次就能点中）。
 * - 第一行是「未分类 / 根目录」：笔记移到未分类，文件夹移到顶层
 * - 当前所在位置打勾、不可点
 * - 移动文件夹时，它自己和它的子孙不能作为目标（会成环），直接不显示
 */
interface Props {
  open: boolean;
  title: string;
  folders: Folder[];
  /** 当前所在文件夹（null = 未分类 / 根目录），打勾且不可选 */
  currentId: number | null;
  /** 正在移动的是文件夹时传它的 id：它和子孙从列表里排除 */
  movingFolderId?: number;
  /** 第一行的文字：笔记用「未分类」，文件夹用「根目录」 */
  rootLabel: string;
  onPick: (folderId: number | null) => void;
  onClose: () => void;
}

interface FlatItem {
  folder: Folder;
  depth: number;
}

function flatten(list: Folder[], depth: number, skipId: number | undefined, out: FlatItem[]): FlatItem[] {
  for (const f of list) {
    if (f.id === skipId) continue; // 连同子孙一起跳过
    out.push({ folder: f, depth });
    if (f.children?.length) flatten(f.children, depth + 1, skipId, out);
  }
  return out;
}

export function FolderPickerSheet({ open, title, folders, currentId, movingFolderId, rootLabel, onPick, onClose }: Props) {
  const items = useMemo(() => flatten(folders, 0, movingFolderId, []), [folders, movingFolderId]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  const row = (key: string, depth: number, icon: React.ReactNode, label: string, id: number | null, color?: string | null) => {
    const current = id === currentId;
    return (
      <button
        key={key}
        type="button"
        disabled={current}
        className="m-row"
        style={{ paddingLeft: 16 + depth * 18, ["--m-inset" as string]: `${16 + depth * 18 + 34}px` }}
        onClick={() => {
          onPick(id);
          onClose();
        }}
      >
        <span className="flex w-6 shrink-0 justify-center" style={{ color: color || "var(--m-ink3)" }}>
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-[15px]" style={current ? { color: "var(--m-ink3)" } : undefined}>
          {label}
        </span>
        {current && <Check size={18} style={{ color: "var(--m-accent-ink)" }} aria-label="当前位置" />}
      </button>
    );
  };

  return (
    <div className="m-sheet-mask" role="dialog" aria-modal="true">
      <div className="m-sheet-backdrop" onClick={onClose} />
      <div className="m-sheet">
        <div className="m-sheet-grabber" />
        <div className="m-gutter m-t-sec pt-1 pb-3">{title}</div>
        <div className="m-gutter">
          <div className="m-group">
            {row("root", 0, <Inbox size={20} />, rootLabel, null)}
            {items.map(({ folder, depth }) => row(String(folder.id), depth, <FolderIcon size={20} />, folder.name, folder.id, folder.color))}
          </div>
          {items.length === 0 && <div className="m-t-meta mt-3 text-center">还没有文件夹</div>}
          <div className="m-group mt-3">
            <button type="button" className="m-row justify-center text-[15px] font-semibold" style={{ color: "var(--m-ink2)" }} onClick={onClose}>
              取消
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
