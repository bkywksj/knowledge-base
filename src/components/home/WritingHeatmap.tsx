import { useMemo, useState } from "react";
import type { DailyWritingStat } from "@/types";
import { buildYearHeatmap } from "@/lib/writingHeatmap";

const WEEKDAY_LABELS = ["一", "", "三", "", "五", "", "日"];

/**
 * 首页「写作活力」年度热力图：53 周 × 7 天的每日方块（gitee / GitHub 贡献图样式）。
 * 数据计算在 lib/writingHeatmap（有单测）；这里只负责画。
 * 格子用 CSS grid 等分宽度 + aspect-ratio 保持正方形，卡片变窄时整体等比缩小，不会横向溢出。
 *
 * 格子很小，单靠悬停气泡用户发现不了日期（2026-11-05 用户反馈），所以悬停时在底栏左侧
 * 同步显示「日期 · 字数 · 篇数」；有记录的格子可点，交给 onSelectDay 列出当天的笔记。
 */
export function WritingHeatmap({
  trend,
  onSelectDay,
}: {
  trend: DailyWritingStat[];
  /** 点了有记录的格子：date = YYYY-MM-DD，el = 格子本身（宿主用来定位弹层） */
  onSelectDay?: (date: string, el: HTMLElement) => void;
}) {
  const hm = useMemo(() => buildYearHeatmap(trend), [trend]);
  const noteCountByDate = useMemo(
    () => new Map(trend.map((d) => [d.date, d.note_count])),
    [trend],
  );
  const [hovered, setHovered] = useState<{ date: string; words: number } | null>(null);

  return (
    <div className="kb-heat">
      <div className="kb-heat-months">
        {hm.months.map((m) => (
          <span key={`${m.col}-${m.label}`} style={{ gridColumn: `${m.col + 1} / span 3` }}>
            {m.label}
          </span>
        ))}
      </div>
      <div className="kb-heat-body">
        <div className="kb-heat-weekdays" aria-hidden>
          {WEEKDAY_LABELS.map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </div>
        <div
          className="kb-heat-grid"
          role="img"
          aria-label="近一年每日写作字数热力图"
          onMouseLeave={() => setHovered(null)}
        >
          {hm.columns.map((col, ci) => (
            <div className="kb-heat-col" key={ci}>
              {col.map((c) => {
                const clickable = !c.future && c.words > 0 && !!onSelectDay;
                return (
                  <i
                    key={c.date}
                    className={
                      (c.future ? "kb-heat-cell is-future" : `kb-heat-cell l${c.level}`) +
                      (clickable ? " is-clickable" : "")
                    }
                    onMouseEnter={c.future ? undefined : () => setHovered({ date: c.date, words: c.words })}
                    onClick={clickable ? (e) => onSelectDay!(c.date, e.currentTarget) : undefined}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="kb-heat-foot">
        {hovered ? (
          <span className="kb-heat-read">
            <b>{hovered.date}</b>
            {hovered.words > 0
              ? ` · ${hovered.words.toLocaleString()} 字 · ${noteCountByDate.get(hovered.date) ?? 0} 篇${onSelectDay ? " · 点击查看" : ""}`
              : " · 没有记录"}
          </span>
        ) : (
          <span>
            近一年有 {hm.activeDays} 天在写
            {onSelectDay && " · 点格子查看当天写过的笔记"}
          </span>
        )}
        <span className="kb-heat-legend">
          少
          {[0, 1, 2, 3, 4].map((l) => (
            <i key={l} className={`kb-heat-cell l${l}`} />
          ))}
          多
        </span>
      </div>
    </div>
  );
}
