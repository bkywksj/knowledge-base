import { useEffect } from "react";
import type { ReactNode } from "react";

/**
 * 移动端底部动作面板（Bottom Action Sheet）。
 *
 * 取代桌面端坐标锚定的右键 Dropdown（`useContextMenu` + `ContextMenuOverlay`）——
 * 触屏场景下：从底部滑出、热区 ≥ 52px、适配安全区、点遮罩关闭。
 * 配合 `@/hooks/useLongPress`：长按列表项 → 打开本面板承载该项的操作（菜单项与 PC 右键菜单一致）。
 *
 * v4 结构（原型 docs/design/mobile-v4 的 03 / 06 屏），从上到下：
 *   摘要（标题 + 副标题 + 图标）→ 操作格（grid，放一块面板里分格）→ 列表项 → 危险操作单独成组 → 取消
 * 危险项（danger）自动从列表里拆出来放到最后一组，调用方不用自己分。
 *
 * 轻量手写（不套 antd Drawer），样式在 styles/mobile.css（.m-sheet / .m-group / .m-row / .m-grid-cell）。
 */
export interface ActionSheetItem {
  key: string;
  label: string;
  icon?: ReactNode;
  /** 危险操作（删除等）：红字，自动放到最后单独一组 */
  danger?: boolean;
  /** 右侧附加说明（如「MD · Word · HTML」） */
  extra?: ReactNode;
  onClick: () => void;
}

export interface ActionSheetGridItem {
  key: string;
  label: string;
  icon: ReactNode;
  /** 已开启的状态（如「已置顶」）：主色浅底高亮 */
  active?: boolean;
  onClick: () => void;
}

interface ActionSheetProps {
  open: boolean;
  /** 面板顶部标题（如笔记标题），可选 */
  title?: string;
  /** 标题下的一行说明（如「2,140 字 · 链入 4」），可选 */
  subtitle?: ReactNode;
  /** 标题左侧的图标，可选 */
  headerIcon?: ReactNode;
  /** 顶部操作格（4 列），可选 */
  grid?: ActionSheetGridItem[];
  items: ActionSheetItem[];
  onClose: () => void;
}

export function ActionSheet({ open, title, subtitle, headerIcon, grid, items, onClose }: ActionSheetProps) {
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

  const normal = items.filter((it) => !it.danger);
  const danger = items.filter((it) => it.danger);
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div className="m-sheet-mask" role="dialog" aria-modal="true">
      <div className="m-sheet-backdrop" onClick={onClose} />

      <div className="m-sheet">
        <div className="m-sheet-grabber" />

        {title && (
          <div className="m-gutter flex items-center gap-3 pt-1 pb-3">
            {headerIcon && (
              <span
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--m-r-l)]"
                style={{ background: "var(--m-well)", color: "var(--m-ink2)" }}
              >
                {headerIcon}
              </span>
            )}
            <div className="min-w-0">
              <div className="m-t-title truncate">{title}</div>
              {subtitle != null && <div className="m-t-cap mt-0.5 truncate">{subtitle}</div>}
            </div>
          </div>
        )}

        {grid && grid.length > 0 && (
          <div className="m-group mx-4 grid grid-cols-4 gap-1 p-1.5">
            {grid.map((g) => (
              <button key={g.key} type="button" className={g.active ? "m-grid-cell is-on" : "m-grid-cell"} onClick={run(g.onClick)}>
                <span style={{ color: g.active ? "var(--m-accent-ink)" : "var(--m-ink2)" }}>{g.icon}</span>
                {g.label}
              </button>
            ))}
          </div>
        )}

        <div className="m-gutter">
          {normal.length > 0 && (
            <div className={grid && grid.length > 0 ? "m-group mt-3" : "m-group"}>
              {normal.map((it) => (
                <button key={it.key} type="button" className={it.icon ? "m-row m-row-icon" : "m-row"} onClick={run(it.onClick)}>
                  {it.icon && <span className="flex w-6 shrink-0 justify-center" style={{ color: "var(--m-ink2)" }}>{it.icon}</span>}
                  <span className="min-w-0 flex-1 truncate text-[15px]">{it.label}</span>
                  {it.extra != null && <span className="m-t-meta shrink-0 whitespace-nowrap">{it.extra}</span>}
                </button>
              ))}
            </div>
          )}

          {danger.length > 0 && (
            <div className="m-group mt-3">
              {danger.map((it) => (
                <button key={it.key} type="button" className={it.icon ? "m-row m-row-icon m-row-danger" : "m-row m-row-danger"} onClick={run(it.onClick)}>
                  {it.icon && <span className="flex w-6 shrink-0 justify-center">{it.icon}</span>}
                  <span className="min-w-0 flex-1 truncate text-[15px]">{it.label}</span>
                </button>
              ))}
            </div>
          )}

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
