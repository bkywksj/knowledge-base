import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Monitor } from "lucide-react";
import { MNavBar } from "./primitives";

/**
 * 手机端「这个功能请到桌面端用」的整页说明（图谱、定时推送等）。
 * 原来手机上打开这些路由直接渲染桌面页，布局挤成一团还点不动；与其半残地搬过来，不如说清楚为什么、去哪用。
 */
export function DesktopOnlyPage({
  title,
  icon,
  reason,
  tips,
}: {
  title: string;
  icon?: ReactNode;
  /** 为什么手机上不提供（一两句话） */
  reason: string;
  /** 手机上能做的替代办法（可选） */
  tips?: string[];
}) {
  const navigate = useNavigate();
  return (
    <div className="mx-auto flex min-h-full w-full max-w-[860px] flex-col">
      <MNavBar onBack={() => navigate(-1)} title={title} />
      <div className="m-px flex flex-1 flex-col items-center pt-16 text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-[var(--m-r-xl)]" style={{ background: "var(--m-accent-soft2)", color: "var(--m-accent-ink)" }}>
          {icon ?? <Monitor size={30} />}
        </span>
        <div className="m-t-sec mt-5">请在桌面端使用「{title}」</div>
        <p className="m-t-body mt-2 max-w-[22em]" style={{ color: "var(--m-ink2)" }}>
          {reason}
        </p>
        {tips && tips.length > 0 && (
          <div className="m-group mt-6 w-full max-w-[26em] px-4 py-3 text-left">
            <div className="m-t-cap mb-1.5">手机上可以这样做</div>
            {tips.map((t, i) => (
              <div key={i} className="m-t-body py-1" style={{ color: "var(--m-ink)" }}>
                · {t}
              </div>
            ))}
          </div>
        )}
        <button type="button" className="m-btn mt-8" onClick={() => navigate(-1)}>
          返回
        </button>
      </div>
    </div>
  );
}
