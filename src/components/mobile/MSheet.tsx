import { useEffect } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Check } from "lucide-react";

/**
 * 手机端通用底部面板外壳：遮罩 + 抓手 + 标题 + 内容 + 底部「取消」。
 * 和 ActionSheet 同一套样式（.m-sheet-*），区别是内容由调用方自己放——单选列表、表单都行。
 * 打开时锁背景滚动；点遮罩 / 「取消」关闭。
 */
export function MSheet({
  open,
  title,
  caption,
  onClose,
  children,
  footer,
  cancelText = "取消",
}: {
  open: boolean;
  title: string;
  /** 标题下的一行说明 */
  caption?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** 替换底部「取消」组（如「取消 / 保存」并排）；传 null 则不要底部 */
  footer?: ReactNode | null;
  cancelText?: string;
}) {
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
    <div className="m-sheet-mask" role="dialog" aria-modal="true" aria-label={title}>
      <div className="m-sheet-backdrop" onClick={onClose} />
      <div className="m-sheet">
        <div className="m-sheet-grabber" />
        <div className="m-gutter pt-1 pb-3">
          <div className="m-t-sec">{title}</div>
          {caption != null && <div className="m-t-cap mt-1">{caption}</div>}
        </div>
        <div className="m-gutter">
          {children}
          {footer === undefined ? (
            <div className="m-group mt-3">
              <button type="button" className="m-row justify-center text-[15px] font-semibold" style={{ color: "var(--m-ink2)" }} onClick={onClose}>
                {cancelText}
              </button>
            </div>
          ) : (
            footer
          )}
        </div>
      </div>
    </div>
  );
}

/** 单选列表行：选中项主色字 + 右侧勾；可带左侧色点 / 图标、缩进（多级分类） */
export function PickRow({
  label,
  active,
  onClick,
  dot,
  icon,
  indent = 0,
  extra,
}: {
  label: ReactNode;
  active: boolean;
  onClick: () => void;
  dot?: string;
  icon?: ReactNode;
  /** 缩进层级（每级 16px） */
  indent?: number;
  extra?: ReactNode;
}) {
  const lead = dot != null || icon != null;
  const style: CSSProperties | undefined = indent > 0 ? { paddingLeft: 16 + indent * 16 } : undefined;
  return (
    <button type="button" className={lead ? "m-row m-row-icon" : "m-row"} style={style} onClick={onClick} aria-pressed={active}>
      {lead && (
        <span className="flex w-6 shrink-0 justify-center" style={{ color: "var(--m-ink2)" }}>
          {dot != null ? <span className="m-dot" style={{ background: dot }} /> : icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[15px]" style={active ? { color: "var(--m-accent-ink)", fontWeight: 700 } : undefined}>
        {label}
      </span>
      {extra != null && <span className="m-t-meta shrink-0">{extra}</span>}
      {active && <Check size={18} className="shrink-0" style={{ color: "var(--m-accent-ink)" }} />}
    </button>
  );
}
