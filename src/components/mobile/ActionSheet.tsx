import { useEffect } from "react";
import type { ReactNode } from "react";

/**
 * 移动端底部动作面板（Bottom Action Sheet）。
 *
 * 取代桌面端坐标锚定的右键 Dropdown（`useContextMenu` + `ContextMenuOverlay`）——
 * 触屏场景下：从底部滑出、大点击热区（≥56px）、适配安全区、点遮罩关闭。
 * 配合 `@/hooks/useLongPress`：长按列表项 → 打开本面板承载该项的操作。
 *
 * 轻量手写（不套 antd Drawer），与现有移动页 hand-rolled 风格一致，包体更小。
 */
export interface ActionSheetItem {
  key: string;
  label: string;
  icon?: ReactNode;
  /** 危险操作（删除等）红色高亮 */
  danger?: boolean;
  onClick: () => void;
}

interface ActionSheetProps {
  open: boolean;
  /** 面板顶部说明（如笔记标题），可选 */
  title?: string;
  items: ActionSheetItem[];
  onClose: () => void;
}

export function ActionSheet({ open, title, items, onClose }: ActionSheetProps) {
  // 打开时锁定背景滚动，关闭/卸载时还原
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col justify-end"
      role="dialog"
      aria-modal="true"
    >
      {/* 背景遮罩 */}
      <div
        className="absolute inset-0 bg-black/40 animate-[kbFadeIn_0.15s_ease]"
        onClick={onClose}
      />

      {/* 面板本体 */}
      <div className="relative z-10 rounded-t-2xl bg-white pb-[env(safe-area-inset-bottom,0px)] animate-[kbSheetUp_0.2s_ease]">
        {title && (
          <div className="truncate px-5 pt-4 pb-2 text-center text-xs text-slate-400">
            {title}
          </div>
        )}

        <div className="py-1">
          {items.map((it) => (
            <button
              key={it.key}
              onClick={() => {
                it.onClick();
                onClose();
              }}
              className="flex w-full items-center gap-3 px-5 text-left active:bg-slate-100"
              style={{ minHeight: 56, color: it.danger ? "#ff4d4f" : "#1f2937" }}
            >
              {it.icon && <span className="shrink-0">{it.icon}</span>}
              <span className="text-base">{it.label}</span>
            </button>
          ))}
        </div>

        {/* 取消 —— 与操作区用粗分隔条隔开 */}
        <div className="mt-1 border-t-[6px] border-slate-100">
          <button
            onClick={onClose}
            className="w-full text-base font-medium text-slate-500 active:bg-slate-100"
            style={{ minHeight: 56 }}
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
