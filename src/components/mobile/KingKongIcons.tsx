import { useId } from "react";

/**
 * 金刚区彩色图标（原型 docs/design/mobile-v4 首页 / 新建面板）。
 *
 * 主流 App 的做法：不垫底色块、不加阴影，图标本身是带渐变的实心图形。
 * 每个入口一个专属色，和功能语义对应：笔记 = 品牌紫、待办 = 完成绿、日记 = 日历橙、AI = 蓝紫、语音 = 天蓝。
 * 这组颜色是插画色，不随主题变（主流 App 的金刚区也不跟主题换色）。
 *
 * 渐变 id 用 useId 生成：同一页可能出现两次同一图标（首页 + 新建面板），id 撞了会互相串色。
 */

export type KingKongKind = "note" | "todo" | "daily" | "ai" | "voice";

const GRADIENTS: Record<KingKongKind, [string, string]> = {
  note: ["#A990F7", "#6447D6"],
  todo: ["#56D8A0", "#1F9C68"],
  daily: ["#FFC861", "#F08A26"],
  ai: ["#6CC0FF", "#6A55EE"],
  voice: ["#7CC9FF", "#3C7BE6"],
};

interface Props {
  kind: KingKongKind;
  size?: number;
  /** 日历图标上印的日期，默认今天 */
  day?: number;
}

export function KingKongIcon({ kind, size = 44, day }: Props) {
  const gid = `kk-${kind}-${useId().replace(/:/g, "")}`;
  const [from, to] = GRADIENTS[kind];
  const fill = `url(#${gid})`;

  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={from} />
          <stop offset="1" stopColor={to} />
        </linearGradient>
      </defs>
      {kind === "note" && (
        <>
          <path d="M9 4h15.5L35 14.5V33a3.5 3.5 0 0 1-3.5 3.5h-22.5A3.5 3.5 0 0 1 5.5 33V7.5A3.5 3.5 0 0 1 9 4z" fill={fill} />
          <path d="M24.5 4v7.5a3 3 0 0 0 3 3H35z" fill="#fff" fillOpacity=".42" />
          <path d="M20.2 18.5v10M15.2 23.5h10" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" />
        </>
      )}
      {kind === "todo" && (
        <>
          <rect x="5" y="5" width="30" height="30" rx="9.5" fill={fill} />
          <path d="M12.8 20.6l5.2 5.1 9.6-10.2" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {kind === "daily" && (
        <>
          <rect x="5" y="8" width="30" height="27.5" rx="7.5" fill={fill} />
          <path d="M5 16.5h30" stroke="#fff" strokeOpacity=".5" strokeWidth="1.6" />
          <rect x="12" y="4" width="3.4" height="8.5" rx="1.7" fill="#D9701A" />
          <rect x="24.6" y="4" width="3.4" height="8.5" rx="1.7" fill="#D9701A" />
          <text
            x="20"
            y="31"
            textAnchor="middle"
            fontFamily="Segoe UI, PingFang SC, sans-serif"
            fontSize="12.5"
            fontWeight="800"
            fill="#fff"
          >
            {day ?? new Date().getDate()}
          </text>
        </>
      )}
      {kind === "ai" && (
        <>
          <path d="M17 4c1.5 9.2 4.3 12 13.5 13.5C21.3 19 18.5 21.8 17 31c-1.5-9.2-4.3-12-13.5-13.5C12.7 16 15.5 13.2 17 4z" fill={fill} />
          <path d="M31 23.5c.6 3.4 1.6 4.4 5 5-3.4.6-4.4 1.6-5 5-.6-3.4-1.6-4.4-5-5 3.4-.6 4.4-1.6 5-5z" fill={fill} fillOpacity=".75" />
        </>
      )}
      {kind === "voice" && (
        <>
          <rect x="13" y="4" width="14" height="22" rx="7" fill={fill} />
          <path d="M8.5 19.5a11.5 11.5 0 0 0 23 0M20 31v5" fill="none" stroke={to} strokeWidth="3" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}
