import type { ButtonHTMLAttributes, ReactNode } from "react";
import { ChevronLeft, Link2 } from "lucide-react";

/**
 * 手机端 v4 基础组件。样式全在 `styles/mobile.css`（.m-* 类 + --m-* 令牌），这里只管结构。
 *
 * 设计规则见 docs/tasks/mobile-v4-redesign-tasks.md「设计规则」：
 * 分组面板只靠白底、浮起卡只靠阴影；分隔线从文字处起；主色只给主操作和选中态。
 */

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** 分组面板：一组同类条目放进一块白底圆角面板 */
export function MGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("m-group", className)}>{children}</div>;
}

interface MRowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 左侧图标；有图标时分隔线从文字处起（缩进 52px） */
  icon?: ReactNode;
  /** 右侧附加内容（数量、状态、开关等） */
  right?: ReactNode;
  /** 右侧显示 › 箭头（表示进入下一级） */
  chevron?: boolean;
  /** 危险操作：红字加粗，通常单独成组放最后 */
  danger?: boolean;
}

/** 列表行：最小高 52px；整行可点 */
export function MRow({ icon, right, chevron, danger, children, className, ...rest }: MRowProps) {
  return (
    <button
      type="button"
      className={cx("m-row", icon != null && "m-row-icon", danger && "m-row-danger", className)}
      {...rest}
    >
      {icon != null && <span className="flex w-6 shrink-0 justify-center">{icon}</span>}
      <span className="min-w-0 flex-1 truncate text-[15px]">{children}</span>
      {right != null && <span className="m-t-meta shrink-0">{right}</span>}
      {chevron && (
        <svg width="16" height="16" viewBox="0 0 24 24" className="shrink-0" style={{ color: "var(--m-ink4)" }} aria-hidden="true">
          <path d="m9 18 6-6-6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

/** 筛选胶囊：选中态为深色实底 */
export function MChip({
  active,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button type="button" className={cx("m-chip", active && "is-on", className)} {...rest}>
      {children}
    </button>
  );
}

type TagTone = "accent" | "ok" | "bad" | "warn" | "info" | "neutral";

const TAG_TONE: Record<TagTone, { bg: string; fg: string }> = {
  accent: { bg: "var(--m-accent-soft2)", fg: "var(--m-accent-ink)" },
  ok: { bg: "var(--m-ok-soft)", fg: "var(--m-ok)" },
  bad: { bg: "var(--m-bad-soft)", fg: "var(--m-bad)" },
  warn: { bg: "var(--m-warn-soft)", fg: "var(--m-warn)" },
  info: { bg: "var(--m-info-soft)", fg: "var(--m-info)" },
  neutral: { bg: "var(--m-well)", fg: "var(--m-ink2)" },
};

/** 标签：高 22，软底无描边 */
export function MTag({ tone = "neutral", children, className }: { tone?: TagTone; children: ReactNode; className?: string }) {
  const c = TAG_TONE[tone];
  return (
    <span className={cx("m-tag", className)} style={{ background: c.bg, color: c.fg }}>
      {children}
    </span>
  );
}

/**
 * 双链记号（手机端的功能记号）：「↔ 链入 4」「链出 3 · 链入 4」或引用的笔记名。
 * 只放在有意义的位置：笔记行、编辑器、待办关联、搜索结果、AI 引用。
 */
export function LinkBadge({
  children,
  size = "sm",
  onClick,
}: {
  children: ReactNode;
  size?: "sm" | "md";
  onClick?: () => void;
}) {
  const style = size === "md" ? { height: 26, padding: "0 9px" } : undefined;
  const body = (
    <>
      <Link2 size={14} strokeWidth={2} />
      {children}
    </>
  );
  return onClick ? (
    <button type="button" className="m-link-badge m-tapx" style={style} onClick={onClick}>
      {body}
    </button>
  ) : (
    <span className="m-link-badge" style={style}>
      {body}
    </span>
  );
}

/** 一级页面头部：28px 大标题 + 右侧操作 */
export function MPageHeader({
  title,
  subtitle,
  actions,
  titleSuffix,
}: {
  title: ReactNode;
  /** 标题上方的小字（如日期） */
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** 紧跟标题的附加内容（如下拉箭头、篇数） */
  titleSuffix?: ReactNode;
}) {
  return (
    <div className="m-gutter flex items-end pt-2">
      <div className="min-w-0">
        {subtitle != null && <div className="m-t-meta">{subtitle}</div>}
        <div className="flex items-center gap-1.5">
          <h1 className="m-t-large truncate">{title}</h1>
          {titleSuffix}
        </div>
      </div>
      <div className="flex-1" />
      {actions != null && <div className="-mr-2 flex items-center">{actions}</div>}
    </div>
  );
}

/** 二级页面导航栏：返回 + 标题（可带副标题）+ 右侧操作 */
export function MNavBar({
  title,
  subtitle,
  onBack,
  actions,
  center = false,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  onBack?: () => void;
  actions?: ReactNode;
  /** 标题居中（对话页这类）；默认跟在返回键后面 */
  center?: boolean;
}) {
  return (
    <div className="flex h-12 items-center px-1">
      {onBack && (
        <button type="button" aria-label="返回" className="m-icon-btn" onClick={onBack}>
          <ChevronLeft size={24} />
        </button>
      )}
      <div className={cx("min-w-0", center ? "flex-1 text-center" : "flex-1")}>
        {title != null && <div className="truncate text-[17px] font-bold" style={{ color: "var(--m-ink)" }}>{title}</div>}
        {subtitle != null && <div className="m-t-cap truncate">{subtitle}</div>}
      </div>
      {actions}
    </div>
  );
}

/** 区块标题：17px 粗体 + 灰色计数 + 右侧链接 */
export function MSectionHeader({
  title,
  count,
  action,
  className,
}: {
  title: ReactNode;
  count?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex items-baseline", className)}>
      <span className="m-t-sec">{title}</span>
      {count != null && <span className="m-t-meta m-num ml-2">{count}</span>}
      {action != null && <span className="ml-auto">{action}</span>}
    </div>
  );
}
