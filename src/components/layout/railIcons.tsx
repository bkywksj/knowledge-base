import type { ReactNode } from "react";

/**
 * 活动栏图标：原样取自 v4 原型 docs/design/ui-v4/index.html 的 <symbol>（24 网格、线宽 1.6）。
 *
 * 不用 lucide 的原因：原型这套是自绘的，形状与 lucide 对不上（「图谱」是三点连成三角、
 * 「复习」是两张叠放的卡片、线条也更细），换 lucide 怎么挑都和原型不一致。
 *
 * 接口与 lucide 组件保持一致（size / color），ActivityBar 用 cloneElement 注入 color 的写法不用改。
 * stroke 走 currentColor + style.color：color 传 CSS 变量也能生效（SVG 的 stroke 属性不认 var()）。
 */
interface RailIconProps {
  size?: number;
  color?: string;
}

function railIcon(children: ReactNode) {
  return function RailIcon({ size = 18, color }: RailIconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={color ? { color } : undefined}
        aria-hidden
      >
        {children}
      </svg>
    );
  };
}

export const RailHome = railIcon(
  <path d="M3.5 10.2 12 3.5l8.5 6.7V19a1.5 1.5 0 0 1-1.5 1.5h-4.2v-5.8H9.2v5.8H5A1.5 1.5 0 0 1 3.5 19z" />,
);
export const RailNote = railIcon(
  <>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M9 13h6M9 17h4" />
  </>,
);
export const RailCalendar = railIcon(
  <>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
    <path d="M8 3v4M16 3v4M3.5 10h17" />
  </>,
);
export const RailCheck = railIcon(
  <>
    <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
    <path d="m8.5 12 2.5 2.5 4.5-5" />
  </>,
);
export const RailCards = railIcon(
  <>
    <rect x="6" y="3.5" width="14" height="14" rx="2.5" />
    <path d="M4 7.5v10A3 3 0 0 0 7 20.5h10" />
  </>,
);
export const RailSearch = railIcon(
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </>,
);
export const RailTag = railIcon(
  <>
    <path d="M12.6 3.6a2 2 0 0 0-1.4-.6H5a2 2 0 0 0-2 2v6.2a2 2 0 0 0 .6 1.4l8.2 8.2a2 2 0 0 0 2.8 0l6-6a2 2 0 0 0 0-2.8z" />
    <circle cx="7.8" cy="7.8" r="1.3" />
  </>,
);
export const RailGraph = railIcon(
  <>
    <circle cx="6" cy="7" r="2.5" />
    <circle cx="18" cy="6" r="2.5" />
    <circle cx="12" cy="18" r="2.5" />
    <path d="M8.2 8.3 10.8 15.8M15.6 6.3 8.5 6.9M13.4 15.9l3.4-7.6" />
  </>,
);
export const RailBot = railIcon(
  <>
    <rect x="4" y="8" width="16" height="11.5" rx="3.5" />
    <path d="M12 8V4.5M9.5 13v1.5M14.5 13v1.5M2.5 13.5v2M21.5 13.5v2" />
  </>,
);
export const RailSpark = railIcon(
  <>
    <path d="M12 3.5 13.6 8 18 9.6 13.6 11.2 12 15.7 10.4 11.2 6 9.6 10.4 8z" />
    <path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
  </>,
);
export const RailBell = railIcon(
  <>
    <path d="M6.5 9a5.5 5.5 0 0 1 11 0c0 5.5 2.5 7.5 2.5 7.5H4s2.5-2 2.5-7.5" />
    <path d="M10.3 20a1.9 1.9 0 0 0 3.4 0" />
  </>,
);
export const RailLock = railIcon(
  <>
    <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
  </>,
);
export const RailEyeOff = railIcon(
  <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.2A9.8 9.8 0 0 1 12 5c5 0 8.5 4.5 9.5 7a13 13 0 0 1-2.4 3.5M6.6 6.6C4.5 8 3.1 10.1 2.5 12c1 2.5 4.5 7 9.5 7a9.6 9.6 0 0 0 5.4-1.6" />,
);
export const RailTrash = railIcon(
  <path d="M4 6.5h16M9.5 6.5V4.5h5v2M6 6.5l.9 12.6A1.5 1.5 0 0 0 8.4 20.5h7.2a1.5 1.5 0 0 0 1.5-1.4L18 6.5" />,
);
export const RailInfo = railIcon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 16v-4.5M12 8h.01" />
  </>,
);
