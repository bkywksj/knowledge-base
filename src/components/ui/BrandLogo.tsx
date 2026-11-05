import { useId } from "react";

/**
 * 应用 Logo「L08 · K · 书页负形」：淡紫渐变方块 + 白色书页，书页上用渐变色写出 K。
 * 定稿见 docs/design/ui-v4（原型 app.js 的 LOGO()）。
 * 渐变 id 用 useId 生成：同一页面里出现多个 Logo（标题栏 + 关于页 + 锁屏）时 id 不能撞。
 */
export function BrandLogo({ size = 24 }: { size?: number }) {
  const gid = `kb-logo-${useId().replace(/:/g, "")}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="6 6 108 108"
      style={{ flex: "none", display: "block" }}
      aria-label="Knowledge Base"
      role="img"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#9B85F0" />
          <stop offset="1" stopColor="#5B3FD0" />
        </linearGradient>
      </defs>
      <rect x="6" y="6" width="108" height="108" rx="28" fill={`url(#${gid})`} />
      <path d="M40 28h28l16 16v44a6 6 0 0 1-6 6H40a6 6 0 0 1-6-6V34a6 6 0 0 1 6-6z" fill="#fff" />
      <path d="M68 28v10a6 6 0 0 0 6 6h10" fill="#E4DBFD" />
      <path
        d="M48 46v38M50 66l17-18M54 62l14 22"
        stroke={`url(#${gid})`}
        strokeWidth="6.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
