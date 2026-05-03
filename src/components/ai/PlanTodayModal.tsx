import { useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Empty,
  Input,
  Modal,
  Select,
  Spin,
  message,
  theme as antdTheme,
} from "antd";
import {
  Sparkles,
  RefreshCcw,
  CheckCircle2,
  Trash2,
} from "lucide-react";
import { aiPlanApi, taskApi } from "@/lib/api";
import type { TaskSuggestion } from "@/types";
import { MicButton } from "@/components/MicButton";

interface PlanTodayModalProps {
  open: boolean;
  onClose: () => void;
  /** 保存成功后回调，宿主页面据此刷新列表 */
  onSaved?: (createdCount: number) => void;
}

interface DraftTask extends TaskSuggestion {
  /** 本地 UID，给 React key 和勾选状态用 */
  uid: string;
  selected: boolean;
}

const PRIORITY_OPTIONS = [
  { value: 0, label: "紧急" },
  { value: 1, label: "普通" },
  { value: 2, label: "低" },
];

const REMIND_OPTIONS = [
  { value: null, label: "不提醒" },
  { value: 0, label: "准时" },
  { value: 15, label: "提前15分" },
  { value: 30, label: "提前30分" },
  { value: 60, label: "提前1小时" },
  { value: 180, label: "提前3小时" },
  { value: 1440, label: "提前1天" },
  { value: 10080, label: "提前1周" },
];

/** 由 priority + important 推导四象限 */
function quadrantOf(priority?: number | null, important?: boolean | null): {
  num: 1 | 2 | 3 | 4;
  label: string;
  color: string;
} {
  const urgent = priority === 0;
  const imp = !!important;
  if (urgent && imp) return { num: 1, label: "立即做", color: "#f5222d" };
  if (!urgent && imp) return { num: 2, label: "计划做", color: "#fa8c16" };
  if (urgent && !imp) return { num: 3, label: "委派", color: "#1677ff" };
  return { num: 4, label: "可延后", color: "#8c8c8c" };
}

function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toDraft(s: TaskSuggestion, idx: number): DraftTask {
  return {
    ...s,
    priority: s.priority ?? 1,
    important: s.important ?? false,
    dueDate: s.dueDate ?? todayStr(),
    uid: `sug-${Date.now()}-${idx}`,
    selected: true,
  };
}

/**
 * T-005 AI 规划今日待办 Modal
 *
 * 三个阶段：
 * 1. idle   — 显示目标输入框 + "生成建议"按钮
 * 2. loading — 等待 AI 响应（5~15s）
 * 3. review — 建议列表 + 勾选/编辑/保存
 *
 * 保存时批量调 `taskApi.create`，单条失败不阻断后续条目；最后 toast 汇报。
 */
export function PlanTodayModal({ open, onClose, onSaved }: PlanTodayModalProps) {
  const { token } = antdTheme.useToken();
  const [phase, setPhase] = useState<"idle" | "loading" | "review">("idle");
  const [goal, setGoal] = useState("");
  const [includeCarry, setIncludeCarry] = useState(true);
  const [drafts, setDrafts] = useState<DraftTask[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function reset() {
    setPhase("idle");
    setDrafts([]);
    setSummary(null);
    setErrorText(null);
  }

  async function handleGenerate() {
    setPhase("loading");
    setErrorText(null);
    try {
      const resp = await aiPlanApi.planToday({
        goal: goal.trim() || null,
        includeYesterdayUnfinished: includeCarry,
      });
      if (!resp.tasks || resp.tasks.length === 0) {
        setErrorText("AI 没返回任何建议，可能是上下文不足。试试填一下『今日目标』？");
        setPhase("idle");
        return;
      }
      setDrafts(resp.tasks.map(toDraft));
      setSummary(resp.summary ?? null);
      setPhase("review");
    } catch (e) {
      setErrorText(String(e));
      setPhase("idle");
    }
  }

  function updateDraft(uid: string, patch: Partial<DraftTask>) {
    setDrafts((prev) => prev.map((d) => (d.uid === uid ? { ...d, ...patch } : d)));
  }

  function removeDraft(uid: string) {
    setDrafts((prev) => prev.filter((d) => d.uid !== uid));
  }

  function toggleAll(checked: boolean) {
    setDrafts((prev) => prev.map((d) => ({ ...d, selected: checked })));
  }

  async function handleSave() {
    const selected = drafts.filter((d) => d.selected && d.title.trim());
    if (selected.length === 0) {
      message.warning("没有选中可保存的建议");
      return;
    }
    setSaving(true);
    let okCount = 0;
    let failCount = 0;
    for (const d of selected) {
      try {
        await taskApi.create({
          title: d.title.trim(),
          priority: (d.priority ?? 1) as 0 | 1 | 2,
          important: !!d.important,
          due_date: d.dueDate ?? todayStr(),
          remind_before_minutes:
            d.remindBefore === undefined ? null : d.remindBefore,
        });
        okCount++;
      } catch (e) {
        console.error("保存建议失败:", d.title, e);
        failCount++;
      }
    }
    setSaving(false);
    if (okCount > 0) {
      message.success(`已保存 ${okCount} 条待办${failCount ? `（${failCount} 条失败）` : ""}`);
      onSaved?.(okCount);
      reset();
      onClose();
    } else {
      message.error("全部保存失败，请重试");
    }
  }

  function handleClose() {
    if (saving) return;
    reset();
    onClose();
  }

  const selectedCount = drafts.filter((d) => d.selected).length;

  return (
    <Modal
      title={
        <div className="flex items-center gap-2">
          <Sparkles size={16} style={{ color: token.colorPrimary }} />
          <span>AI 规划今日待办</span>
        </div>
      }
      open={open}
      onCancel={handleClose}
      width={720}
      centered
      destroyOnHidden
      footer={
        phase === "review" ? (
          <div className="flex items-center justify-between w-full">
            <Button
              icon={<RefreshCcw size={14} />}
              onClick={() => {
                setPhase("idle");
                setDrafts([]);
                setSummary(null);
              }}
              disabled={saving}
            >
              重新生成
            </Button>
            <div className="flex gap-2">
              <Button onClick={handleClose} disabled={saving}>
                取消
              </Button>
              <Button
                type="primary"
                icon={<CheckCircle2 size={14} />}
                onClick={handleSave}
                loading={saving}
                disabled={selectedCount === 0}
              >
                保存选中的 {selectedCount} 条
              </Button>
            </div>
          </div>
        ) : null
      }
      styles={{ body: { maxHeight: "70vh", overflowY: "auto" } }}
    >
      {/* idle 阶段：输入目标 */}
      {phase === "idle" && (
        <div className="flex flex-col gap-3">
          {errorText && (
            <Alert type="error" showIcon message={errorText} closable onClose={() => setErrorText(null)} />
          )}
          <div>
            <div
              style={{
                fontSize: 13,
                color: token.colorTextSecondary,
                marginBottom: 6,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span>今日目标（可选）</span>
              <MicButton
                stripTrailingPunctuation
                onTranscribed={(text) =>
                  setGoal((prev) => (prev ? `${prev} ${text}` : text))
                }
              />
            </div>
            <Input.TextArea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="例：今天想把 T-005 前端写完、回复 3 封邮件"
              autoSize={{ minRows: 2, maxRows: 5 }}
              maxLength={200}
              showCount
            />
          </div>
          <div>
            <Checkbox
              checked={includeCarry}
              onChange={(e) => setIncludeCarry(e.target.checked)}
            >
              把昨日未完成 / 过期任务一起顺延
            </Checkbox>
          </div>
          <div
            style={{
              fontSize: 12,
              color: token.colorTextTertiary,
              lineHeight: 1.7,
            }}
          >
            AI 会参考：昨天/今天的每日笔记、未完成任务、已有待办，给出 3~7 条建议；
            建议不会直接写入，你勾选确认后才会保存。
            <br />
            <strong>仅 OpenAI / DeepSeek / 智谱 / Claude 兼容模型可用；Ollama 暂不支持。</strong>
          </div>
          <div className="flex justify-end gap-2 mt-2">
            <Button onClick={handleClose}>取消</Button>
            <Button type="primary" icon={<Sparkles size={14} />} onClick={handleGenerate}>
              生成建议
            </Button>
          </div>
        </div>
      )}

      {/* loading 阶段：骨架 */}
      {phase === "loading" && (
        <div className="flex flex-col items-center justify-center py-12">
          <Spin size="large" />
          <div
            style={{
              marginTop: 16,
              color: token.colorTextSecondary,
              fontSize: 13,
            }}
          >
            AI 正在规划中（通常需要 5~15 秒）…
          </div>
        </div>
      )}

      {/* review 阶段：建议列表 */}
      {phase === "review" && (
        <div className="flex flex-col gap-3">
          {summary && (
            <Alert
              type="info"
              showIcon
              message={summary}
              style={{ marginBottom: 4 }}
            />
          )}

          {drafts.length === 0 ? (
            <Empty description="没有建议了（可能都删掉了）" />
          ) : (
            <>
              <div className="flex items-center justify-between text-xs">
                <Checkbox
                  checked={drafts.every((d) => d.selected)}
                  indeterminate={
                    drafts.some((d) => d.selected) && !drafts.every((d) => d.selected)
                  }
                  onChange={(e) => toggleAll(e.target.checked)}
                >
                  全选
                </Checkbox>
                <span style={{ color: token.colorTextTertiary }}>
                  共 {drafts.length} 条建议，已选 {selectedCount} 条
                </span>
              </div>
              <div className="flex flex-col gap-2">
                {drafts.map((d) => (
                  <DraftRow
                    key={d.uid}
                    draft={d}
                    onChange={(patch) => updateDraft(d.uid, patch)}
                    onRemove={() => removeDraft(d.uid)}
                    token={token}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

function DraftRow({
  draft,
  onChange,
  onRemove,
  token,
}: {
  draft: DraftTask;
  onChange: (patch: Partial<DraftTask>) => void;
  onRemove: () => void;
  token: any;
}) {
  return (
    <div
      className="rounded-md p-2"
      style={{
        background: draft.selected ? token.colorBgContainer : token.colorFillQuaternary,
        border: `1px solid ${token.colorBorderSecondary}`,
        opacity: draft.selected ? 1 : 0.6,
      }}
    >
      <div className="flex items-start gap-2">
        <Checkbox
          checked={draft.selected}
          onChange={(e) => onChange({ selected: e.target.checked })}
          style={{ marginTop: 4 }}
        />
        <div className="flex-1 flex flex-col gap-1.5">
          <Input
            value={draft.title}
            onChange={(e) => onChange({ title: e.target.value })}
            placeholder="任务标题"
            size="small"
            variant="borderless"
            style={{
              fontWeight: 500,
              fontSize: 14,
              color: token.colorText,
              padding: 0,
            }}
          />
          <div className="flex items-center gap-2 flex-wrap text-xs">
            {(() => {
              const q = quadrantOf(draft.priority, draft.important);
              return (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-semibold"
                  style={{
                    background: `${q.color}1a`,
                    color: q.color,
                    border: `1px solid ${q.color}33`,
                  }}
                  title={`艾森豪威尔四象限 Q${q.num}`}
                >
                  Q{q.num} · {q.label}
                </span>
              );
            })()}
            <Select
              size="small"
              value={draft.priority ?? 1}
              onChange={(v) => onChange({ priority: v })}
              options={PRIORITY_OPTIONS}
              style={{ width: 72 }}
            />
            <Checkbox
              checked={!!draft.important}
              onChange={(e) => onChange({ important: e.target.checked })}
            >
              <span style={{ fontSize: 12 }}>重要</span>
            </Checkbox>
            <Input
              size="small"
              value={draft.dueDate ?? ""}
              onChange={(e) => onChange({ dueDate: e.target.value })}
              placeholder="YYYY-MM-DD"
              style={{ width: 120 }}
            />
            <Select
              size="small"
              value={draft.remindBefore ?? null}
              onChange={(v) => onChange({ remindBefore: v })}
              options={REMIND_OPTIONS}
              style={{ width: 110 }}
              title="AI 自动设置的提醒时间，可改"
            />
          </div>
          {draft.reason && (
            <div
              style={{
                fontSize: 12,
                color: token.colorTextSecondary,
                background: token.colorFillTertiary,
                padding: "4px 8px",
                borderRadius: 4,
              }}
            >
              {draft.reason}
            </div>
          )}
        </div>
        <Button
          type="text"
          size="small"
          danger
          icon={<Trash2 size={12} />}
          onClick={onRemove}
          title="移除此建议（不会记录到历史）"
        />
      </div>
    </div>
  );
}
