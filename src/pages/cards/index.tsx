import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Modal,
  Form,
  Input,
  Select,
  message,
  Spin,
  Empty,
  Popconfirm,
  Tooltip,
} from "antd";
import {
  Plus,
  RotateCcw,
  CheckCircle2,
  Sparkles,
  Trash2,
  Pencil,
  FileText,
  Layers,
  Repeat,
  Library,
  Search,
} from "lucide-react";
import {
  fsrs,
  createEmptyCard,
  generatorParameters,
  Rating,
  State,
  type Card as FsrsCard,
  type RecordLog,
} from "ts-fsrs";

/** 4 个用户面向评分（排除 Manual=0） */
type GradeRating = Rating.Again | Rating.Hard | Rating.Good | Rating.Easy;
import { cardApi, noteApi } from "@/lib/api";
import type { Card, CardStats } from "@/types";

/**
 * 后端 Card → ts-fsrs Card。
 *
 * 用 createEmptyCard 兜底所有字段（包括 ts-fsrs 5.x 的 learning_steps 等
 * 我们没在后端持久化的字段），然后覆盖业务字段。
 */
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

/** Date → SQLite 友好的 "YYYY-MM-DD HH:mm:ss"（本地时区） */
function toSqliteLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** 把 ts-fsrs 算出的 scheduled_days 翻译成"X天后/X分钟后" */
function formatNextInterval(card: FsrsCard, now: Date): string {
  const ms = card.due.getTime() - now.getTime();
  if (ms < 60_000) return "<1分钟";
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}分钟`;
  if (ms < 86400_000) return `${Math.round(ms / 3600_000)}小时`;
  const days = Math.round(ms / 86400_000);
  if (days < 30) return `${days}天`;
  if (days < 365) return `${Math.round(days / 30)}个月`;
  return `${(days / 365).toFixed(1)}年`;
}

function DesktopCardsPage() {
  const [stats, setStats] = useState<CardStats | null>(null);
  /** 顶栏「重新加载」/ 新建卡片后自增：复习区据此重拉待复习队列 */
  const [reviewKey, setReviewKey] = useState(0);
  /** 新建 / 编辑 / 删除 / 评分后自增：全部卡片列表据此重拉 */
  const [listKey, setListKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);

  const refreshStats = useCallback(async () => {
    try {
      setStats(await cardApi.stats());
    } catch (e) {
      message.error(`加载统计失败: ${e}`);
    }
  }, []);

  useEffect(() => {
    void refreshStats();
  }, [refreshStats]);

  /** 卡片增删改后：统计 + 列表都要跟着变 */
  const afterCardsChanged = useCallback(() => {
    void refreshStats();
    setListKey((k) => k + 1);
  }, [refreshStats]);

  return (
    // v4 原型：不再分「今日复习 / 全部卡片」两个 Tab，一页从上到下 = 顶栏 · 统计 · 复习区 + 快速新建 · 全部卡片
    <div className="kb-cards-page">
      <div className="kb-page-bar">
        <h1>卡片复习</h1>
        <span className="flex-1" />
        <Button
          icon={<RotateCcw size={14} />}
          onClick={() => {
            setReviewKey((k) => k + 1);
            void refreshStats();
          }}
          title="重新拉取今日到期的卡片（复习中途新到期的也会进来）"
        >
          重新加载
        </Button>
        <Button type="primary" icon={<Plus size={14} />} onClick={() => setCreateOpen(true)}>
          新建卡片
        </Button>
      </div>

      {stats && <StatsBar stats={stats} />}

      <div className="kb-cards-main">
        <ReviewPanel key={reviewKey} onChanged={afterCardsChanged} onReload={() => setReviewKey((k) => k + 1)} />
        <QuickCreatePanel onCreated={afterCardsChanged} />
      </div>

      <CardListSection reloadKey={listKey} total={stats?.total} onChanged={afterCardsChanged} />

      <CardEditModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={afterCardsChanged}
      />
    </div>
  );
}

// ─── 顶部统计（原型 .stat：四张小卡，左侧彩色图标块） ─────────────────

function StatsBar({ stats }: { stats: CardStats }) {
  const items = [
    { label: "今日待复习", value: stats.dueToday, icon: <Layers size={16} />, tone: "" },
    { label: "新卡", value: stats.newCards, icon: <Sparkles size={16} />, tone: "is-info" },
    { label: "学习中", value: stats.learning, icon: <Repeat size={16} />, tone: "is-warn" },
    { label: "总卡数", value: stats.total, icon: <Library size={16} />, tone: "is-ok" },
  ];
  return (
    <div className="kb-card-stats">
      {items.map((it, i) => (
        <div key={it.label} className="kb-card-stat">
          <span className={`kb-card-stat-ico ${it.tone}`}>{it.icon}</span>
          <div>
            <div className={i === 0 ? "kb-card-stat-num is-primary" : "kb-card-stat-num"}>{it.value}</div>
            <div className="kb-card-stat-lb">{it.label}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── 复习区 ─────────────────────────────────────────────

function ReviewPanel({ onChanged, onReload }: { onChanged: () => void; onReload: () => void }) {
  const navigate = useNavigate();
  const [queue, setQueue] = useState<Card[]>([]);
  const [idx, setIdx] = useState(0);
  const [showBack, setShowBack] = useState(false);
  const [loading, setLoading] = useState(true);
  const [doneCount, setDoneCount] = useState(0);

  // 关掉 short_term：避免 ts-fsrs 5.x 的 learning_steps 字段（后端没存）影响调度
  const scheduler = useMemo(
    () => fsrs(generatorParameters({ enable_short_term: false })),
    [],
  );

  // 只在挂载时拉一次；「重新加载」由父级换 key 整个重建本组件
  useEffect(() => {
    let alive = true;
    cardApi
      .listDue()
      .then((list) => alive && setQueue(list))
      .catch((e) => message.error(`加载待复习失败: ${e}`))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const current = queue[idx];
  const noteTitles = useNoteTitles(current?.note_id != null ? [current.note_id] : []);

  /** 用户给当前卡评分 → ts-fsrs 算新状态 → 提交后端 → 下一张 */
  async function rate(rating: GradeRating) {
    if (!current) return;
    const now = new Date();
    const fsrsCard = toFsrsCard(current);
    const recordLog: RecordLog = scheduler.repeat(fsrsCard, now);
    const next = recordLog[rating];
    try {
      await cardApi.review({
        cardId: current.id,
        rating: rating as unknown as number,
        state: next.card.state,
        due: toSqliteLocal(next.card.due),
        stability: next.card.stability,
        difficulty: next.card.difficulty,
        elapsedDays: next.card.elapsed_days,
        lastElapsedDays: next.log.elapsed_days,
        scheduledDays: next.card.scheduled_days,
      });
      setDoneCount((n) => n + 1);
      // 下一张
      if (idx + 1 < queue.length) {
        setIdx(idx + 1);
        setShowBack(false);
      } else {
        setIdx(queue.length); // 越界 → 触发"完成"视图
      }
      onChanged();
    } catch (e) {
      message.error(`提交失败: ${e}`);
    }
  }

  /** 4 个评分按钮预览的"下次间隔" */
  const previews = useMemo(() => {
    if (!current || !showBack) return null;
    const now = new Date();
    const log = scheduler.repeat(toFsrsCard(current), now);
    return {
      again: formatNextInterval(log[Rating.Again].card, now),
      hard: formatNextInterval(log[Rating.Hard].card, now),
      good: formatNextInterval(log[Rating.Good].card, now),
      easy: formatNextInterval(log[Rating.Easy].card, now),
    };
  }, [current, showBack, scheduler]);

  let body: React.ReactNode;
  if (loading) {
    body = (
      <div className="flex justify-center py-16">
        <Spin size="large" />
      </div>
    );
  } else if (queue.length === 0) {
    body = <Empty className="py-12" description="暂无待复习卡片，可在右侧或下方「全部卡片」新建" />;
  } else if (idx >= queue.length) {
    body = (
      <div className="text-center py-12">
        <CheckCircle2 size={44} className="mx-auto mb-3" style={{ color: "var(--ant-color-success)" }} />
        <h2 className="text-lg font-semibold mb-2">今日复习完成 🎉</h2>
        <p className="mb-4" style={{ color: "var(--kb-text-tertiary)" }}>
          本轮共复习 {doneCount} 张卡
        </p>
        <Button icon={<RotateCcw size={14} />} onClick={onReload}>
          重新加载（如有新到期卡）
        </Button>
      </div>
    );
  } else {
    body = (
      <>
        {/* 进度：第 n / N 张 + 进度条 + 原笔记小标签（原型 .rv-head） */}
        <div className="kb-rv-head">
          <span>
            第 {idx + 1} / {queue.length} 张
          </span>
          {current.note_id != null && (
            <button
              type="button"
              className="kb-rv-src"
              onClick={() => navigate(`/notes/${current.note_id}`)}
              title="打开原笔记"
            >
              <FileText size={12} />
              原笔记{noteTitles.get(current.note_id) ? `：${noteTitles.get(current.note_id)}` : ""}
            </button>
          )}
        </div>
        <div className="kb-rv-progress">
          <i style={{ width: `${(idx / queue.length) * 100}%` }} />
        </div>

        <div className="kb-rv-lb is-center">正面（问题 / 提示）</div>
        <div className="kb-rv-front">{current.front}</div>

        {showBack ? (
          <>
            <div className="kb-rv-lb">反面（答案）</div>
            <div className="kb-rv-back">{current.back}</div>
            <div className="kb-rv-rates">
              <RateBtn k="1" label="忘了" interval={previews?.again} tone="is-again" onClick={() => rate(Rating.Again)} />
              <RateBtn k="2" label="模糊" interval={previews?.hard} tone="is-hard" onClick={() => rate(Rating.Hard)} />
              <RateBtn k="3" label="还行" interval={previews?.good} tone="is-good" onClick={() => rate(Rating.Good)} />
              <RateBtn k="4" label="记牢了" interval={previews?.easy} tone="is-easy" onClick={() => rate(Rating.Easy)} />
            </div>
          </>
        ) : (
          <div className="flex justify-center mt-6">
            <Button type="primary" size="large" onClick={() => setShowBack(true)}>
              显示答案 (空格)
            </Button>
          </div>
        )}
        <div className="kb-rv-hint">空格翻面 · 翻面后数字键 1 – 4 评分</div>

        <ReviewShortcuts
          canFlip={!showBack}
          canRate={showBack}
          onFlip={() => setShowBack(true)}
          onRate={(n) =>
            void rate(([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as GradeRating[])[n - 1])
          }
        />
      </>
    );
  }

  return <section className="kb-cards-panel kb-rv">{body}</section>;
}

function RateBtn({
  k,
  label,
  interval,
  tone,
  onClick,
}: {
  k: string;
  label: string;
  interval?: string;
  tone: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`kb-rate ${tone}`} onClick={onClick} title={`快捷键 ${k}`}>
      <b>{label}</b>
      {interval && <span>{interval}后</span>}
    </button>
  );
}

/** 复习快捷键：空格翻面；翻面后 1–4 评分。焦点在输入框里（右侧新建表单）时不响应 */
function ReviewShortcuts({
  canFlip,
  canRate,
  onFlip,
  onRate,
}: {
  canFlip: boolean;
  canRate: boolean;
  onFlip: () => void;
  onRate: (n: 1 | 2 | 3 | 4) => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      ) {
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (canFlip && e.code === "Space") {
        e.preventDefault();
        onFlip();
      } else if (canRate && /^[1-4]$/.test(e.key)) {
        e.preventDefault();
        onRate(Number(e.key) as 1 | 2 | 3 | 4);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canFlip, canRate, onFlip, onRate]);
  return null;
}

/**
 * 按笔记 id 取标题（「来自「xx」」/ 原笔记小标签用）。
 * 进程内缓存：同一篇笔记只查一次；查不到（已删除）记成空串，不再重复查。
 */
const noteTitleCache = new Map<number, string>();
function useNoteTitles(ids: number[]): Map<number, string> {
  const [, bump] = useState(0);
  const key = ids.join(",");
  useEffect(() => {
    const missing = [...new Set(ids)].filter((id) => !noteTitleCache.has(id));
    if (missing.length === 0) return;
    let alive = true;
    Promise.all(
      missing.map((id) =>
        noteApi
          .get(id)
          .then((n) => noteTitleCache.set(id, n.title))
          .catch(() => noteTitleCache.set(id, "")),
      ),
    ).then(() => alive && bump((n) => n + 1));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return noteTitleCache;
}

// ─── 右侧快速新建（原型 .rv-side，新增；原新建弹窗仍保留在顶栏） ─────────

function QuickCreatePanel({ onCreated }: { onCreated: () => void }) {
  const [front, setFront] = useState("");
  const [back, setBack] = useState("");
  const [noteId, setNoteId] = useState<number | null>(null);
  const [noteOptions, setNoteOptions] = useState<{ value: number; label: string }[]>([]);
  const [saving, setSaving] = useState(false);

  async function searchNotes(kw: string) {
    try {
      const res = await noteApi.list({ keyword: kw || null, page: 1, page_size: 20 });
      setNoteOptions(res.items.map((n) => ({ value: n.id, label: n.title || "未命名" })));
    } catch {
      setNoteOptions([]);
    }
  }

  async function save() {
    if (!front.trim() || !back.trim()) {
      message.warning("正面和反面都要填");
      return;
    }
    setSaving(true);
    try {
      await cardApi.create({ front: front.trim(), back: back.trim(), noteId });
      message.success("已创建");
      setFront("");
      setBack("");
      setNoteId(null);
      onCreated();
    } catch (e) {
      message.error(`保存失败: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  // Ctrl / ⌘ + Enter 直接保存，连续录卡不用摸鼠标
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save();
    }
  }

  return (
    <section className="kb-cards-panel kb-qc">
      <div className="kb-qc-head">
        <span className="kb-qc-ico">
          <Plus size={14} />
        </span>
        新建卡片
      </div>
      <div className="kb-rv-lb">正面（问题 / 提示）</div>
      <Input.TextArea
        rows={3}
        value={front}
        onChange={(e) => setFront(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="例如：TCP 三次握手第二步是？"
      />
      <div className="kb-rv-lb">反面（答案）</div>
      <Input.TextArea
        rows={3}
        value={back}
        onChange={(e) => setBack(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="例如：服务端回 SYN+ACK"
      />
      <Select
        className="kb-qc-note"
        allowClear
        showSearch
        placeholder={
          <span className="inline-flex items-center gap-1.5">
            <FileText size={13} />
            关联笔记（可选）
          </span>
        }
        value={noteId ?? undefined}
        onChange={(v) => setNoteId(v ?? null)}
        onSearch={(kw) => void searchNotes(kw)}
        onOpenChange={(o) => o && noteOptions.length === 0 && void searchNotes("")}
        filterOption={false}
        options={noteOptions}
        notFoundContent="没有匹配的笔记"
      />
      <Button type="primary" block loading={saving} onClick={() => void save()}>
        保存卡片
      </Button>
      <div className="kb-rv-hint">Ctrl + Enter 保存</div>
    </section>
  );
}

// ─── 全部卡片（原型 .cl：列表行 + 搜索；原表格的反面 / 状态放进悬停提示） ─────

const CARD_STATE_LABEL = ["新卡", "学习中", "复习中", "重学"];
const LIST_PAGE = 50;

/** 「下次 今天 / 明天 / MM-DD」 */
function dueLabel(due: string): string {
  const d = due.slice(0, 10);
  const t = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ymd = (x: Date) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  const today = ymd(t);
  t.setDate(t.getDate() + 1);
  const tomorrow = ymd(t);
  if (d <= today) return "今天";
  if (d === tomorrow) return "明天";
  return d.slice(0, 4) === today.slice(0, 4) ? d.slice(5) : d;
}

function CardListSection({
  reloadKey,
  total,
  onChanged,
}: {
  reloadKey: number;
  total?: number;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [limit, setLimit] = useState(LIST_PAGE);
  const [editing, setEditing] = useState<Card | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    cardApi
      .list()
      .then((list) => alive && setCards(list))
      .catch((e) => message.error(`加载失败: ${e}`))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return cards;
    return cards.filter(
      (c) => c.front.toLowerCase().includes(kw) || c.back.toLowerCase().includes(kw),
    );
  }, [cards, keyword]);
  const shown = filtered.slice(0, limit);
  const noteTitles = useNoteTitles(
    shown.map((c) => c.note_id).filter((id): id is number => id != null),
  );

  async function handleDelete(id: number) {
    try {
      await cardApi.delete(id);
      message.success("已删除");
      onChanged();
    } catch (e) {
      message.error(`删除失败: ${e}`);
    }
  }

  return (
    <section className="kb-cards-panel kb-cl">
      <div className="kb-cl-head">
        <span className="kb-card-stat-ico is-ok">
          <Library size={14} />
        </span>
        <b>全部卡片</b>
        <span className="kb-cl-count">{total ?? cards.length}</span>
        <span className="flex-1" />
        <Input
          className="kb-cl-search"
          allowClear
          prefix={<Search size={14} />}
          placeholder="搜索卡片（正面 / 反面）"
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value);
            setLimit(LIST_PAGE);
          }}
        />
      </div>

      {loading ? (
        <div className="flex justify-center py-8">
          <Spin />
        </div>
      ) : filtered.length === 0 ? (
        <Empty className="py-8" description={keyword ? "没有匹配的卡片" : "还没有卡片"} />
      ) : (
        <>
          {shown.map((c) => (
            <div key={c.id} className="kb-cl-row" onDoubleClick={() => setEditing(c)}>
              <span className="kb-card-stat-ico">
                <Layers size={14} />
              </span>
              <Tooltip
                placement="topLeft"
                mouseEnterDelay={0.4}
                title={
                  <div className="whitespace-pre-wrap" style={{ maxWidth: 420 }}>
                    <div style={{ opacity: 0.7, marginBottom: 2 }}>
                      反面 · {CARD_STATE_LABEL[c.state] ?? c.state}
                    </div>
                    {c.back}
                  </div>
                }
              >
                <div className="kb-cl-main">
                  <div className="kb-cl-front">{c.front}</div>
                  <div className="kb-cl-sub">
                    {c.note_id != null && noteTitles.get(c.note_id)
                      ? `来自「${noteTitles.get(c.note_id)}」`
                      : c.back}
                  </div>
                </div>
              </Tooltip>
              <span className="kb-cl-due" title={c.due.slice(0, 16)}>
                下次 {dueLabel(c.due)}
              </span>
              <div className="kb-cl-actions">
                {c.note_id != null && (
                  <Tooltip title="打开原笔记">
                    <Button
                      type="text"
                      size="small"
                      icon={<FileText size={13} />}
                      onClick={() => navigate(`/notes/${c.note_id}`)}
                    />
                  </Tooltip>
                )}
                <Tooltip title="编辑（也可双击行）">
                  <Button type="text" size="small" icon={<Pencil size={13} />} onClick={() => setEditing(c)} />
                </Tooltip>
                <Popconfirm title="确定删除？" onConfirm={() => handleDelete(c.id)}>
                  <Button type="text" size="small" danger icon={<Trash2 size={13} />} />
                </Popconfirm>
              </div>
            </div>
          ))}
          {filtered.length > shown.length && (
            <div className="flex justify-center pt-3">
              <Button onClick={() => setLimit((n) => n + LIST_PAGE)}>
                再显示 {Math.min(LIST_PAGE, filtered.length - shown.length)} 张（共 {filtered.length}）
              </Button>
            </div>
          )}
        </>
      )}

      <CardEditModal
        // key 必须落在持有 useForm 的组件上：只给内部 <Modal> 加 key 无法重建
        // form 仓库，导致打开下一张卡时仓库残留上一张的 front/back（编辑串内容）。
        key={editing ? `edit-${editing.id}` : "edit-empty"}
        open={!!editing}
        editing={editing}
        onClose={() => setEditing(null)}
        onSaved={onChanged}
      />
    </section>
  );
}

function CardEditModal({
  open,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing?: Card | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form] = Form.useForm<{ front: string; back: string }>();
  const [saving, setSaving] = useState(false);

  /**
   * 表单初值。本组件由父级 `key={edit-<id>}` 按卡片整组重建（含 useForm
   * 实例），所以每次打开都是全新 form 仓库，initialValues 能可靠生效，
   * 不会出现「打开 B 却显示上一张 A」的串内容问题。
   */
  const initialValues = {
    front: editing?.front ?? "",
    back: editing?.back ?? "",
  };

  async function handleOk() {
    try {
      const v = await form.validateFields();
      setSaving(true);
      if (editing) {
        await cardApi.updateContent(editing.id, v.front, v.back);
        message.success("已更新");
      } else {
        await cardApi.create({ front: v.front, back: v.back });
        message.success("已创建");
      }
      onSaved();
      onClose();
    } catch (e) {
      if ((e as { errorFields?: unknown }).errorFields) return; // 表单校验失败，提示已显示
      message.error(`保存失败: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      title={editing ? "编辑卡片" : "新建卡片"}
      onCancel={onClose}
      onOk={handleOk}
      confirmLoading={saving}
      destroyOnHidden
      width={520}
    >
      <Form
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={initialValues}
      >
        <Form.Item
          name="front"
          label="正面（问题/提示）"
          rules={[{ required: true, message: "请输入正面" }]}
        >
          <Input.TextArea rows={3} placeholder="例如：TCP 三次握手第二步是？" autoFocus />
        </Form.Item>
        <Form.Item
          name="back"
          label="反面（答案）"
          rules={[{ required: true, message: "请输入反面" }]}
        >
          <Input.TextArea rows={4} placeholder="例如：服务端回 SYN+ACK" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

import { useIsMobile } from "@/hooks/useIsMobile";
import { MobileCards } from "./MobileCards";

export default function CardsPage() {
  const isMobile = useIsMobile();
  return isMobile ? <MobileCards /> : <DesktopCardsPage />;
}
