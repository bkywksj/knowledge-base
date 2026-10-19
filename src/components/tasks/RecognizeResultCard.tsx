/**
 * 「粘贴识别」结果卡片：显示刚刚自动回填了什么，像快递地址识别一样可以一眼核对、
 * 一键换时间、一键撤销 —— 识别结果是建议，不能悄悄覆盖用户已经填好的内容。
 */
import { Button, Tag, theme as antdTheme } from "antd";
import { Sparkles, Undo2, X } from "lucide-react";

import type { RecognizedTask } from "@/lib/taskTextParser";

export type RecognizeSource = "local" | "ai";

interface Props {
  result: RecognizedTask;
  source: RecognizeSource;
  /** 当前用的是 candidates 里第几个时间 */
  picked: number;
  onPick: (index: number) => void;
  onUndo: () => void;
  onClose: () => void;
  /** 用 AI 重新识别（本地结果不满意时） */
  onAiRetry?: () => void;
  aiLoading?: boolean;
  /** AI 没跑成（未配置模型 / 失败）时的提示 */
  aiNote?: string | null;
  /** 子任务是否已加进草稿（编辑已有待办时不自动加） */
  subtasksApplied: boolean;
}

function fmtDue(
  d: { date: string; time: string | null },
  start?: string | null,
): string {
  const md = (s: string) => s.slice(5).replace("-", "/");
  const body = `${md(d.date)}${d.time ? ` ${d.time}` : ""}`;
  return start ? `${md(start)} ~ ${body}` : body;
}

function fmtRemind(m: number): string {
  if (m === 0) return "准时";
  if (m < 60) return `提前 ${m} 分钟`;
  if (m < 1440) return `提前 ${m / 60} 小时`;
  return `提前 ${m / 1440} 天`;
}

export default function RecognizeResultCard({
  result: r,
  source,
  picked,
  onPick,
  onUndo,
  onClose,
  onAiRetry,
  aiLoading,
  aiNote,
  subtasksApplied,
}: Props) {
  const { token } = antdTheme.useToken();
  const pickable = r.candidates.filter((c) => c.role !== "publish");
  const facts: string[] = [];
  if (r.remindBefore != null && r.due)
    facts.push(`提醒 ${fmtRemind(r.remindBefore)}`);
  if (r.urgent) facts.push("紧急");
  else if (r.important) facts.push("重要");
  if (r.location) facts.push(`地点 ${r.location}`);
  if (r.subtasks.length > 0) {
    facts.push(
      subtasksApplied
        ? `已加入 ${r.subtasks.length} 条子任务`
        : `识别到 ${r.subtasks.length} 条子任务`,
    );
  }

  return (
    <div
      className="rounded-md px-3 py-2 text-xs flex flex-col gap-1.5"
      style={{
        background: token.colorPrimaryBg,
        border: `1px solid ${token.colorPrimaryBorder}`,
      }}
    >
      <div className="flex items-center gap-2">
        <Sparkles size={13} style={{ color: token.colorPrimary }} />
        <span style={{ color: token.colorText, fontWeight: 500 }}>
          已识别并回填{source === "ai" ? "（AI）" : "（本地规则）"}
        </span>
        {!r.confident && source === "local" && (
          <span style={{ color: token.colorWarning }}>· 不太确定，请核对</span>
        )}
        <span className="flex-1" />
        {onAiRetry && source === "local" && (
          <Button
            type="link"
            size="small"
            loading={aiLoading}
            style={{ fontSize: 12, padding: 0, height: 20 }}
            onClick={onAiRetry}
          >
            AI 重新识别
          </Button>
        )}
        <Button
          type="text"
          size="small"
          icon={<Undo2 size={12} />}
          style={{ fontSize: 12, height: 20 }}
          onClick={onUndo}
          title="恢复到识别前的内容"
        >
          撤销
        </Button>
        <Button
          type="text"
          size="small"
          icon={<X size={12} />}
          style={{ height: 20, width: 20 }}
          onClick={onClose}
          title="收起（保留已回填的内容）"
        />
      </div>

      {r.due ? (
        <div className="flex items-center flex-wrap gap-1">
          <span style={{ color: token.colorTextSecondary }}>时间</span>
          {pickable.length > 1 ? (
            pickable.map((c) => {
              const idx = r.candidates.indexOf(c);
              return (
                <Tag.CheckableTag
                  key={idx}
                  checked={idx === picked}
                  onChange={() => onPick(idx)}
                  style={{ fontSize: 12, marginInlineEnd: 0 }}
                >
                  {fmtDue(c, c.start)} · {c.label}
                  {c.past ? "（已过）" : ""}
                </Tag.CheckableTag>
              );
            })
          ) : (
            <span style={{ color: token.colorText }}>
              {fmtDue(r.due, r.start)}
            </span>
          )}
        </div>
      ) : (
        <div style={{ color: token.colorTextSecondary }}>
          没有识别出时间，可手动选择
        </div>
      )}

      {facts.length > 0 && (
        <div style={{ color: token.colorTextSecondary }}>
          {facts.join(" · ")}
        </div>
      )}
      {aiLoading && source === "local" && (
        <div style={{ color: token.colorTextTertiary }}>
          AI 正在识别，稍后会自动更新…
        </div>
      )}
      {aiNote && <div style={{ color: token.colorTextTertiary }}>{aiNote}</div>}
    </div>
  );
}
