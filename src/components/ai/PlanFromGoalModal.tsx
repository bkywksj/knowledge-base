import { useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Empty,
  Input,
  InputNumber,
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
  Target,
} from "lucide-react";
import dayjs, { type Dayjs } from "dayjs";
import { aiPlanApi, taskApi } from "@/lib/api";
import type {
  MilestoneDraft,
  TaskSuggestion,
  PlanFromGoalResponse,
} from "@/types";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 落库后回调：传入此次的 batchId 给宿主页用于"撤销"提示 */
  onSaved?: (batchId: string, createdCount: number) => void;
}

interface DraftTask extends TaskSuggestion {
  uid: string;
  selected: boolean;
}

const PRIORITY_OPTIONS = [
  { value: 0, label: "紧急" },
  { value: 1, label: "普通" },
  { value: 2, label: "低" },
];

/** 由 priority + important 推导四象限 */
function quadrantOf(
  priority?: number | null,
  important?: boolean | null,
): { num: 1 | 2 | 3 | 4; label: string; color: string } {
  const urgent = priority === 0;
  const imp = !!important;
  if (urgent && imp) return { num: 1, label: "立即做", color: "#f5222d" };
  if (!urgent && imp) return { num: 2, label: "计划做", color: "#fa8c16" };
  if (urgent && !imp) return { num: 3, label: "委派", color: "#1677ff" };
  return { num: 4, label: "可延后", color: "#8c8c8c" };
}

function toDraft(s: TaskSuggestion, idx: number): DraftTask {
  return {
    ...s,
    priority: s.priority ?? 1,
    important: s.important ?? false,
    uid: `goal-${Date.now()}-${idx}`,
    selected: true,
  };
}

/**
 * 目标驱动 AI 智能规划 Modal
 *
 * 流程：
 * 1. idle    用户输入目标 + 周期 + 起始日期 + 个人补充
 * 2. loading AI 生成中（10~30s）
 * 3. review  显示 tasks（默认全选）+ milestones（仅展示）+ summary，用户可勾选/编辑
 * 4. 保存：批量创建任务，每条都带 batchId 作为 source_batch_id
 *
 * 落库后回调 onSaved(batchId, count)，宿主页可借此提供"撤销整批"操作。
 */
export function PlanFromGoalModal({ open, onClose, onSaved }: Props) {
  const { token } = antdTheme.useToken();
  const [phase, setPhase] = useState<"idle" | "loading" | "review">("idle");

  // idle 表单状态
  const [goal, setGoal] = useState("");
  const [horizonDays, setHorizonDays] = useState<number>(30);
  const [startDate, setStartDate] = useState<Dayjs>(dayjs());
  const [profileHint, setProfileHint] = useState("");

  // review 状态
  const [drafts, setDrafts] = useState<DraftTask[]>([]);
  const [milestones, setMilestones] = useState<MilestoneDraft[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string>("");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function reset() {
    setPhase("idle");
    setDrafts([]);
    setMilestones([]);
    setSummary(null);
    setBatchId("");
    setErrorText(null);
  }

  async function handleGenerate() {
    if (goal.trim().length < 4) {
      setErrorText("目标至少 4 个字，AI 才能理解你想做什么");
      return;
    }
    setPhase("loading");
    setErrorText(null);
    try {
      const resp: PlanFromGoalResponse = await aiPlanApi.planFromGoal({
        goal: goal.trim(),
        horizonDays,
        startDate: startDate.format("YYYY-MM-DD"),
        profileHint: profileHint.trim() || null,
      });
      if (!resp.tasks || resp.tasks.length === 0) {
        setErrorText("AI 没返回任何待办，目标描述可能太抽象了，再具体一点试试");
        setPhase("idle");
        return;
      }
      setDrafts(resp.tasks.map(toDraft));
      setMilestones(resp.milestones ?? []);
      setSummary(resp.summary ?? null);
      setBatchId(resp.batchId);
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
      message.warning("没有勾选任何待办");
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
          due_date: d.dueDate ?? null,
          source_batch_id: batchId,
        });
        okCount++;
      } catch (e) {
        console.error("保存失败:", d.title, e);
        failCount++;
      }
    }
    setSaving(false);
    if (okCount > 0) {
      message.success(
        `已导入 ${okCount} 条待办${failCount ? `（${failCount} 条失败）` : ""}，可在历史中撤销整批`,
      );
      onSaved?.(batchId, okCount);
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
  const endDate = startDate.add(Math.max(1, horizonDays) - 1, "day");

  return (
    <Modal
      title={
        <div className="flex items-center gap-2">
          <Target size={16} style={{ color: token.colorPrimary }} />
          <span>AI 智能规划</span>
          <span
            className="text-[11px] font-normal"
            style={{ color: token.colorTextTertiary }}
          >
            目标 → 自动拆分四象限待办
          </span>
        </div>
      }
      open={open}
      onCancel={handleClose}
      width={780}
      centered
      destroyOnClose
      footer={
        phase === "review" ? (
          <div className="flex items-center justify-between w-full">
            <Button
              icon={<RefreshCcw size={14} />}
              onClick={() => {
                setPhase("idle");
                setDrafts([]);
                setMilestones([]);
                setSummary(null);
                setBatchId("");
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
                导入选中的 {selectedCount} 条
              </Button>
            </div>
          </div>
        ) : null
      }
      styles={{ body: { maxHeight: "72vh", overflowY: "auto" } }}
    >
      {phase === "idle" && (
        <div className="flex flex-col gap-4">
          {errorText && (
            <Alert
              type="error"
              showIcon
              message={errorText}
              closable
              onClose={() => setErrorText(null)}
            />
          )}

          <div>
            <div
              style={{ fontSize: 13, color: token.colorTextSecondary, marginBottom: 6 }}
            >
              你的目标 <span style={{ color: token.colorError }}>*</span>
            </div>
            <Input.TextArea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="例：180 天减肥到 55 公斤 / 三个月通过二建考试 / 30 天养成早睡早起习惯"
              autoSize={{ minRows: 2, maxRows: 5 }}
              maxLength={300}
              showCount
            />
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <div>
              <div
                style={{
                  fontSize: 12,
                  color: token.colorTextSecondary,
                  marginBottom: 4,
                }}
              >
                计划周期（天）
              </div>
              <InputNumber
                min={1}
                max={365}
                value={horizonDays}
                onChange={(v) => setHorizonDays(Math.max(1, Math.min(365, Number(v) || 30)))}
                style={{ width: 100 }}
              />
            </div>
            <div>
              <div
                style={{
                  fontSize: 12,
                  color: token.colorTextSecondary,
                  marginBottom: 4,
                }}
              >
                起始日期
              </div>
              <DatePicker
                value={startDate}
                onChange={(v) => v && setStartDate(v)}
                format="YYYY-MM-DD"
                allowClear={false}
              />
            </div>
            <div className="flex flex-col">
              <div
                style={{
                  fontSize: 12,
                  color: token.colorTextSecondary,
                  marginBottom: 4,
                }}
              >
                覆盖范围
              </div>
              <span
                className="text-xs"
                style={{ color: token.colorTextTertiary, lineHeight: "32px" }}
              >
                {startDate.format("YYYY-MM-DD")} ~ {endDate.format("YYYY-MM-DD")}
              </span>
            </div>
          </div>

          <div>
            <div
              style={{ fontSize: 13, color: token.colorTextSecondary, marginBottom: 6 }}
            >
              个人信息（可选）
            </div>
            <Input.TextArea
              value={profileHint}
              onChange={(e) => setProfileHint(e.target.value)}
              placeholder="作息 / 时间约束 / 身体情况 / 兴趣等。例：工作日 19:00 才有空、早上能跑步"
              autoSize={{ minRows: 2, maxRows: 4 }}
              maxLength={300}
            />
          </div>

          <div
            style={{
              fontSize: 12,
              color: token.colorTextTertiary,
              lineHeight: 1.7,
            }}
          >
            AI 用艾森豪威尔四象限法则把目标拆成 10~30 条可执行待办 + 2~6 个阶段里程碑。
            <br />
            <strong>仅 OpenAI / DeepSeek / 智谱 / Claude 兼容模型可用；Ollama 不支持。</strong>
            生成后所有待办默认勾选，你可以逐条编辑或取消。
          </div>

          <div className="flex justify-end gap-2 mt-1">
            <Button onClick={handleClose}>取消</Button>
            <Button
              type="primary"
              icon={<Sparkles size={14} />}
              onClick={handleGenerate}
              disabled={goal.trim().length < 4}
            >
              生成规划
            </Button>
          </div>
        </div>
      )}

      {phase === "loading" && (
        <div className="flex flex-col items-center justify-center py-16">
          <Spin size="large" />
          <div
            style={{
              marginTop: 18,
              color: token.colorTextSecondary,
              fontSize: 13,
            }}
          >
            AI 正在按四象限规划中（通常需要 10~30 秒）…
          </div>
          <div
            style={{
              marginTop: 6,
              color: token.colorTextTertiary,
              fontSize: 11,
            }}
          >
            周期 {horizonDays} 天 · 起始 {startDate.format("YYYY-MM-DD")}
          </div>
        </div>
      )}

      {phase === "review" && (
        <div className="flex flex-col gap-3">
          {summary && (
            <Alert type="info" showIcon message={summary} style={{ marginBottom: 0 }} />
          )}

          {milestones.length > 0 && (
            <div
              className="rounded-md p-3"
              style={{
                background: token.colorFillQuaternary,
                border: `1px solid ${token.colorBorderSecondary}`,
              }}
            >
              <div
                className="text-xs font-semibold mb-2"
                style={{ color: token.colorTextSecondary }}
              >
                阶段里程碑（仅参考，不会写入待办）
              </div>
              <div className="flex flex-col gap-1.5">
                {milestones.map((m, i) => (
                  <div key={i} className="text-xs flex items-baseline gap-2">
                    <span
                      className="font-semibold shrink-0"
                      style={{ color: token.colorPrimary }}
                    >
                      {m.title}
                    </span>
                    {m.dateRange && (
                      <span style={{ color: token.colorTextTertiary }}>
                        · {m.dateRange}
                      </span>
                    )}
                    {m.description && (
                      <span style={{ color: token.colorTextSecondary }}>
                        — {m.description}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {drafts.length === 0 ? (
            <Empty description="所有建议都被移除了" />
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
                  共 {drafts.length} 条 · 已选 {selectedCount} 条 · batch_id:{" "}
                  <code style={{ fontSize: 10 }}>{batchId.slice(0, 24)}</code>
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
  token: ReturnType<typeof antdTheme.useToken>["token"];
}) {
  const q = quadrantOf(draft.priority, draft.important);
  return (
    <div
      className="rounded-md p-2"
      style={{
        background: draft.selected ? token.colorBgContainer : token.colorFillQuaternary,
        border: `1px solid ${token.colorBorderSecondary}`,
        opacity: draft.selected ? 1 : 0.55,
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
          title="移除此条"
        />
      </div>
    </div>
  );
}
