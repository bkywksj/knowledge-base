import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Tabs,
  Card as AntCard,
  Button,
  Modal,
  Form,
  Input,
  Space,
  Statistic,
  message,
  Spin,
  Empty,
  Table,
  Popconfirm,
  Tooltip,
  theme as antdTheme,
} from "antd";
import {
  Plus,
  RotateCcw,
  CheckCircle2,
  Sparkles,
  Trash2,
  Pencil,
  FileText,
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
import { cardApi } from "@/lib/api";
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

export default function CardsPage() {
  const [tab, setTab] = useState<"review" | "list">("review");
  const [stats, setStats] = useState<CardStats | null>(null);

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

  return (
    <div className="px-6 py-4 max-w-4xl mx-auto">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles size={18} />
        <h1 className="text-lg font-semibold m-0">卡片复习</h1>
      </div>

      {stats && <StatsBar stats={stats} />}

      <Tabs
        activeKey={tab}
        onChange={(k) => setTab(k as "review" | "list")}
        items={[
          {
            key: "review",
            label: `今日复习 ${stats?.dueToday ?? 0}`,
            children: <ReviewTab onChanged={refreshStats} />,
          },
          {
            key: "list",
            label: `全部卡片 ${stats?.total ?? 0}`,
            children: <ListTab onChanged={refreshStats} />,
          },
        ]}
      />
    </div>
  );
}

// ─── 顶部统计条 ────────────────────────────────────────────

function StatsBar({ stats }: { stats: CardStats }) {
  const { token } = antdTheme.useToken();
  return (
    <div
      className="grid grid-cols-4 gap-3 px-5 py-3 rounded-lg mb-3"
      style={{
        background: token.colorBgContainer,
        border: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <Statistic
        title="今日待复习"
        value={stats.dueToday}
        valueStyle={{ color: token.colorPrimary, fontSize: 22 }}
      />
      <Statistic title="新卡" value={stats.newCards} valueStyle={{ fontSize: 22 }} />
      <Statistic title="学习中" value={stats.learning} valueStyle={{ fontSize: 22 }} />
      <Statistic title="总卡数" value={stats.total} valueStyle={{ fontSize: 22 }} />
    </div>
  );
}

// ─── 复习 Tab ─────────────────────────────────────────────

function ReviewTab({ onChanged }: { onChanged: () => void }) {
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

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await cardApi.listDue();
      setQueue(list);
      setIdx(0);
      setShowBack(false);
      setDoneCount(0);
    } catch (e) {
      message.error(`加载待复习失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const current = queue[idx];

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

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spin size="large" />
      </div>
    );
  }

  if (queue.length === 0) {
    return (
      <Empty
        className="py-16"
        description='暂无待复习卡片，先去"全部卡片" Tab 创建几张吧'
      />
    );
  }

  if (idx >= queue.length) {
    return (
      <div className="text-center py-16">
        <CheckCircle2 size={48} className="mx-auto mb-3" style={{ color: "#52c41a" }} />
        <h2 className="text-lg font-semibold mb-2">今日复习完成 🎉</h2>
        <p className="text-gray-500 mb-4">本轮共复习 {doneCount} 张卡</p>
        <Button icon={<RotateCcw size={14} />} onClick={() => void reload()}>
          重新加载（如有新到期卡）
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      {/* 进度 + 笔记跳转 */}
      <div className="flex items-center justify-between mb-2 px-1">
        <span className="text-xs text-gray-500">
          {idx + 1} / {queue.length}
        </span>
        {current.note_id != null && (
          <Tooltip title="打开原笔记">
            <Button
              size="small"
              type="text"
              icon={<FileText size={13} />}
              onClick={() => navigate(`/notes/${current.note_id}`)}
            >
              <span className="text-xs">原笔记</span>
            </Button>
          </Tooltip>
        )}
      </div>

      {/* 卡片正反面 */}
      <AntCard
        className="mb-3"
        styles={{ body: { minHeight: 180, padding: "28px 24px" } }}
      >
        <div className="text-center text-base whitespace-pre-wrap break-words">
          {current.front}
        </div>
        {showBack && (
          <>
            <div
              className="my-4 border-t border-dashed"
              style={{ borderColor: "rgba(0,0,0,0.12)" }}
            />
            <div className="text-center text-base whitespace-pre-wrap break-words">
              {current.back}
            </div>
          </>
        )}
      </AntCard>

      {/* 操作区 */}
      {!showBack ? (
        <div className="flex justify-center">
          <Button type="primary" size="large" onClick={() => setShowBack(true)}>
            显示答案 (空格)
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-2">
          <RateBtn label="忘了" interval={previews?.again} color="#ff4d4f" onClick={() => rate(Rating.Again)} />
          <RateBtn label="模糊" interval={previews?.hard} color="#fa8c16" onClick={() => rate(Rating.Hard)} />
          <RateBtn label="还行" interval={previews?.good} color="#1677ff" onClick={() => rate(Rating.Good)} />
          <RateBtn label="记牢了" interval={previews?.easy} color="#52c41a" onClick={() => rate(Rating.Easy)} />
        </div>
      )}

      {/* 空格键翻面 */}
      <SpaceShortcut
        enabled={!showBack && !!current}
        onSpace={() => setShowBack(true)}
      />
    </div>
  );
}

function RateBtn({
  label,
  interval,
  color,
  onClick,
}: {
  label: string;
  interval?: string;
  color: string;
  onClick: () => void;
}) {
  return (
    <Button
      size="large"
      onClick={onClick}
      style={{ height: 64, borderColor: color, color }}
    >
      <div className="flex flex-col items-center gap-0.5">
        <span style={{ fontWeight: 600 }}>{label}</span>
        {interval && <span className="text-xs opacity-70">{interval}</span>}
      </div>
    </Button>
  );
}

/** 监听空格键翻面：仅 enabled 时生效 */
function SpaceShortcut({ enabled, onSpace }: { enabled: boolean; onSpace: () => void }) {
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        onSpace();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, onSpace]);
  return null;
}

// ─── 列表 Tab ─────────────────────────────────────────────

function ListTab({ onChanged }: { onChanged: () => void }) {
  const navigate = useNavigate();
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Card | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setCards(await cardApi.list());
    } catch (e) {
      message.error(`加载失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function handleDelete(id: number) {
    try {
      await cardApi.delete(id);
      message.success("已删除");
      void reload();
      onChanged();
    } catch (e) {
      message.error(`删除失败: ${e}`);
    }
  }

  return (
    <div>
      <div className="mb-3 flex justify-between">
        <Space>
          <Button
            type="primary"
            icon={<Plus size={14} />}
            onClick={() => setCreateOpen(true)}
          >
            新建卡片
          </Button>
        </Space>
      </div>

      <Table<Card>
        rowKey="id"
        loading={loading}
        dataSource={cards}
        size="small"
        pagination={{ pageSize: 20 }}
        columns={[
          {
            title: "正面",
            dataIndex: "front",
            ellipsis: true,
            render: (s: string) => <span title={s}>{s}</span>,
          },
          {
            title: "反面",
            dataIndex: "back",
            ellipsis: true,
            render: (s: string) => <span title={s}>{s}</span>,
          },
          {
            title: "状态",
            dataIndex: "state",
            width: 80,
            render: (s: number) => ["新卡", "学习中", "复习中", "重学"][s] ?? s,
          },
          {
            title: "下次到期",
            dataIndex: "due",
            width: 140,
            render: (s: string) => s.slice(0, 16),
          },
          {
            title: "操作",
            width: 140,
            render: (_, c) => (
              <Space size="small">
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
                <Tooltip title="编辑">
                  <Button
                    type="text"
                    size="small"
                    icon={<Pencil size={13} />}
                    onClick={() => setEditing(c)}
                  />
                </Tooltip>
                <Popconfirm title="确定删除？" onConfirm={() => handleDelete(c.id)}>
                  <Button type="text" size="small" danger icon={<Trash2 size={13} />} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <CardEditModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={() => {
          void reload();
          onChanged();
        }}
      />
      <CardEditModal
        open={!!editing}
        editing={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          void reload();
          onChanged();
        }}
      />
    </div>
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
   * 关键：destroyOnHidden + form.setFieldsValue 在 useEffect 里有时序问题
   * （Form 子树重新挂载前 setFieldsValue 没生效）。改用 Modal 的 key
   * 强制 remount + Form initialValues 初始化，是 antd 推荐的稳妥写法。
   */
  const modalKey = editing ? `edit-${editing.id}` : "create";
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
      key={modalKey}
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
