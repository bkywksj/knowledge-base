import { useMemo } from "react";
import type { DailyWritingStat } from "@/types";
import { buildYearHeatmap } from "@/lib/writingHeatmap";

const WEEKDAY_LABELS = ["一", "", "三", "", "五", "", "日"];

/**
 * 首页「写作活力」年度热力图：53 周 × 7 天的每日方块（gitee / GitHub 贡献图样式）。
 * 数据计算在 lib/writingHeatmap（有单测）；这里只负责画。
 * 格子用 CSS grid 等分宽度 + aspect-ratio 保持正方形，卡片变窄时整体等比缩小，不会横向溢出。
 * 悬停提示用 title：全局 GlobalNativeTooltip 会把它升级成主题一致的气泡。
 */
export function WritingHeatmap({ trend }: { trend: DailyWritingStat[] }) {
  const hm = useMemo(() => buildYearHeatmap(trend), [trend]);

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
        <div className="kb-heat-grid" role="img" aria-label="近一年每日写作字数热力图">
          {hm.columns.map((col, ci) => (
            <div className="kb-heat-col" key={ci}>
              {col.map((c) => (
                <i
                  key={c.date}
                  className={c.future ? "kb-heat-cell is-future" : `kb-heat-cell l${c.level}`}
                  title={c.future ? undefined : `${c.date} · ${c.words.toLocaleString()} 字`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="kb-heat-foot">
        <span>近一年有 {hm.activeDays} 天在写</span>
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
