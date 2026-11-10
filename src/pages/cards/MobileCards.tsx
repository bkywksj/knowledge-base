import { useEffect, useState, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { BarChart3, Sparkles } from "lucide-react";
import { message } from "antd";
import {
  fsrs,
  createEmptyCard,
  generatorParameters,
  Rating,
  type Card as FsrsCard,
  type State,
  type RecordLog,
} from "ts-fsrs";
import { cardApi } from "@/lib/api";
import type { Card, CardStats } from "@/types";
import { MNavBar, MRow } from "@/components/mobile/primitives";
import { MSheet } from "@/components/mobile/MSheet";

/**
 * 移动端闪卡复习页（v4 样式，交互同原版）
 *
 * 路由 /cards —— 桌面端有 desktop CardsPage，移动端用本组件（wrapper 模式分发）
 *
 * - 拉 listDue 队列 → 大卡片显示正反面（默认只显示正面，点击翻面）
 * - 4 档评分按钮（忘了/困难/良好/轻松）→ 用 ts-fsrs 算下次复习时间 → 提交后端 → 下一张
 * - 顶部进度条 + 待复习数量 + 估算时间；全部复习完显示"今日已复习 X 张"
 * - 顶栏「统计」：今日到期 / 学习中 / 复习中 / 新卡 / 总数（cardApi.stats）+ 本次已复习
 *
 * 不做：卡片新建（桌面端有）、deck / 笔记反链显示、滑动跳过、长按标记
 */

type GradeRating = Rating.Again | Rating.Hard | Rating.Good | Rating.Easy;

function toFsrsCard(c: Card): FsrsCard {
  return {
    ...createEmptyCard(),
    due: new Date(c.due),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsed_days,
    scheduled_days: c.scheduled_days,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state as State,
    last_review: c.last_review ? new Date(c.last_review) : undefined,
  };
}

function toSqliteLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function formatInterval(card: FsrsCard, now: Date): string {
  const ms = card.due.getTime() - now.getTime();
  if (ms < 60_000) return "<1m";
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86400_000) return `${Math.round(ms / 3600_000)}h`;
  const days = Math.round(ms / 86400_000);
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

export function MobileCards() {
  const navigate = useNavigate();
  const [queue, setQueue] = useState<Card[]>([]);
  const [completed, setCompleted] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const scheduler = useMemo(
    () => fsrs(generatorParameters({ enable_short_term: false })),
    [],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await cardApi.listDue(50);
      setQueue(list);
      setCompleted(0);
      setRevealed(false);
    } catch (e) {
      message.error(`加载失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const current = queue[0];
  const total = queue.length + completed;

  async function rate(rating: GradeRating) {
    if (!current || submitting) return;
    setSubmitting(true);
    const now = new Date();
    const fsrsCard = toFsrsCard(current);
    const log: RecordLog = scheduler.repeat(fsrsCard, now);
    const result = log[rating].card;
    try {
      await cardApi.review({
        cardId: current.id,
        rating,
        state: result.state,
        due: toSqliteLocal(result.due),
        stability: result.stability,
        difficulty: result.difficulty,
        elapsedDays: result.elapsed_days,
        lastElapsedDays: fsrsCard.elapsed_days,
        scheduledDays: result.scheduled_days,
      });
      // 出队 + 翻面状态重置
      setQueue((q) => q.slice(1));
      setCompleted((c) => c + 1);
      setRevealed(false);
    } catch (e) {
      message.error(`提交失败: ${e}`);
    } finally {
      setSubmitting(false);
    }
  }

  // 估算 4 档下次复习时间用于按钮 hint
  const previewIntervals = useMemo(() => {
    if (!current) return null;
    const now = new Date();
    const log = scheduler.repeat(toFsrsCard(current), now);
    return {
      again: formatInterval(log[Rating.Again].card, now),
      hard: formatInterval(log[Rating.Hard].card, now),
      good: formatInterval(log[Rating.Good].card, now),
      easy: formatInterval(log[Rating.Easy].card, now),
    };
  }, [current, scheduler]);

  const progressPct = total > 0 ? Math.round((completed / total) * 100) : 0;

  const [statsOpen, setStatsOpen] = useState(false);
  const [stats, setStats] = useState<CardStats | null>(null);

  function openStats() {
    setStatsOpen(true);
    cardApi
      .stats()
      .then(setStats)
      .catch((e) => message.error(`统计加载失败: ${e}`));
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: "var(--m-page)", color: "var(--m-ink)", paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <div className="shrink-0">
        <MNavBar
          onBack={() => navigate(-1)}
          title="闪卡复习"
          subtitle={`FSRS · 待复习 ${queue.length} 张`}
          actions={
            <button type="button" aria-label="统计" className="m-icon-btn" onClick={openStats}>
              <BarChart3 size={20} />
            </button>
          }
        />
      </div>

      {/* 进度条 */}
      <div className="m-px shrink-0 pb-2">
        <div className="m-t-cap mb-1.5 flex items-center justify-between">
          <span className="m-num">
            {completed} / {total}
          </span>
          {queue.length > 0 && <span style={{ color: "var(--m-accent-ink)", fontWeight: 600 }}>预计 {Math.max(1, Math.round(queue.length * 0.8))} 分钟</span>}
        </div>
        <div className="h-1.5 overflow-hidden rounded-full" style={{ background: "var(--m-well)" }}>
          <div className="h-full rounded-full transition-all" style={{ width: `${progressPct}%`, background: "var(--m-btn)" }} />
        </div>
      </div>

      {/* 主体 */}
      <main className="m-px flex min-h-0 flex-1 flex-col py-3">
        {loading ? (
          <div className="m-t-meta flex flex-1 items-center justify-center">加载中…</div>
        ) : !current ? (
          <DoneState completed={completed} onAgain={load} />
        ) : (
          <>
            {/* 卡片 */}
            <button
              type="button"
              onClick={() => setRevealed((r) => !r)}
              className="flex min-h-0 flex-1 flex-col rounded-[var(--m-r-xl)] p-5 text-left"
              style={{ background: "var(--m-surface)" }}
            >
              <div className="m-t-cap">{revealed ? "反面 · 答案" : "正面 · 问题（点击翻面）"}</div>
              <div className="mt-3 flex-1 overflow-y-auto">
                <p className="whitespace-pre-wrap text-[17px] leading-relaxed" style={{ color: "var(--m-ink)" }}>
                  {revealed ? current.back : current.front}
                </p>
              </div>
              {/* 卡片元信息 */}
              <div className="mt-3 flex items-center justify-around pt-3" style={{ borderTop: "0.5px solid var(--m-hair)" }}>
                <Stat label="复习" value={`第 ${current.reps + 1} 次`} />
                <Stat label="稳定性" value={`${current.stability.toFixed(1)} d`} />
                <Stat label="难度" value={current.difficulty.toFixed(1)} />
              </div>
            </button>

            {/* 4 档评分按钮 */}
            <div className="mt-4 grid grid-cols-4 gap-2">
              <RateButton tone="bad" num={1} label="忘了" interval={previewIntervals?.again} disabled={!revealed || submitting} onClick={() => rate(Rating.Again)} />
              <RateButton tone="warn" num={2} label="困难" interval={previewIntervals?.hard} disabled={!revealed || submitting} onClick={() => rate(Rating.Hard)} />
              <RateButton tone="accent" num={3} label="良好" interval={previewIntervals?.good} disabled={!revealed || submitting} onClick={() => rate(Rating.Good)} highlight />
              <RateButton tone="ok" num={4} label="轻松" interval={previewIntervals?.easy} disabled={!revealed || submitting} onClick={() => rate(Rating.Easy)} />
            </div>

            <div className="m-t-cap mt-2 text-center" style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
              {revealed ? "选择评分进入下一张" : "点卡片翻看答案"}
            </div>
          </>
        )}
      </main>

      <MSheet open={statsOpen} title="复习统计" caption="FSRS 按记忆曲线安排每张卡的下次复习时间" onClose={() => setStatsOpen(false)}>
        <div className="m-group">
          <MRow right={<StatNum v={completed} />}>本次已复习</MRow>
          <MRow right={<StatNum v={stats?.dueToday} />}>今日到期</MRow>
          <MRow right={<StatNum v={stats?.newCards} />}>新卡</MRow>
          <MRow right={<StatNum v={stats?.learning} />}>学习中</MRow>
          <MRow right={<StatNum v={stats?.review} />}>复习中</MRow>
          <MRow right={<StatNum v={stats?.total} />}>卡片总数</MRow>
        </div>
      </MSheet>
    </div>
  );
}

function StatNum({ v }: { v: number | undefined }) {
  return <span className="m-num text-[15px] font-semibold" style={{ color: "var(--m-ink)" }}>{v ?? "—"}</span>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <div className="m-num text-[14px] font-semibold" style={{ color: "var(--m-ink)" }}>{value}</div>
      <div className="m-t-cap">{label}</div>
    </div>
  );
}

const TONE: Record<"bad" | "warn" | "accent" | "ok", { bg: string; fg: string }> = {
  bad: { bg: "var(--m-bad-soft)", fg: "var(--m-bad)" },
  warn: { bg: "var(--m-warn-soft)", fg: "var(--m-warn)" },
  accent: { bg: "var(--m-accent-soft2)", fg: "var(--m-accent-ink)" },
  ok: { bg: "var(--m-ok-soft)", fg: "var(--m-ok)" },
};

function RateButton({
  tone,
  num,
  label,
  interval,
  disabled,
  onClick,
  highlight,
}: {
  tone: keyof typeof TONE;
  num: number;
  label: string;
  interval?: string;
  disabled: boolean;
  onClick: () => void;
  highlight?: boolean;
}) {
  const c = TONE[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-[72px] flex-col items-center justify-center rounded-[var(--m-r-xl)] transition-transform active:scale-95 disabled:opacity-45"
      style={{ background: c.bg, color: c.fg, boxShadow: highlight ? `inset 0 0 0 1.5px ${c.fg}` : undefined }}
    >
      <span className="m-num text-[17px] font-bold leading-tight">{num}</span>
      <span className="text-[13px] font-semibold leading-tight">{label}</span>
      {interval && <span className="m-num mt-0.5 text-[12px] leading-tight">{interval}</span>}
    </button>
  );
}

function DoneState({ completed, onAgain }: { completed: number; onAgain: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <Sparkles size={44} style={{ color: "var(--m-accent)" }} />
      <div className="text-[20px] font-bold" style={{ color: "var(--m-ink)" }}>
        {completed > 0 ? `今日已复习 ${completed} 张 🎉` : "今天没有待复习的闪卡"}
      </div>
      <div className="m-t-meta">{completed > 0 ? "明天见，FSRS 会自动安排下一轮" : "去笔记里把段落转成卡片吧"}</div>
      <button type="button" onClick={onAgain} className="m-btn mt-4" style={{ background: "var(--m-accent-soft2)", color: "var(--m-accent-ink)" }}>
        重新加载
      </button>
    </div>
  );
}
