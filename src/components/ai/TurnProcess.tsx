/**
 * 回复卡片里的「执行过程」区：思考过程 + 按轮分组的工具调用时间线。
 *
 * 不再套小卡片：整块用浅底色和卡片正文区分开，每个工具一行，点开才看参数和结果。
 * 展开 / 收起由 `TurnCard` 控制（它知道这一轮是在跑、完成还是失败）。
 */
import { useState } from "react";
import { Modal, message, theme as antdTheme } from "antd";
import {
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  Maximize2,
  XCircle,
} from "lucide-react";
import type { SkillCall } from "@/types";
import {
  describeTool,
  formatDuration,
  summarizeArgs,
  summarizeResult,
  type TurnView,
} from "./turnModel";

interface Props {
  view: TurnView;
  open: boolean;
  onToggle: () => void;
}

export function TurnProcess({ view, open, onToggle }: Props) {
  const { token } = antdTheme.useToken();
  const calls = view.rounds.flatMap((r) => r.calls);
  const failed = calls.filter((c) => c.status === "error").length;
  const toolMs = calls.reduce((sum, c) => sum + (c.durationMs ?? 0), 0);

  const summary = [
    view.rounds.length > 0 && `${view.rounds.length} 轮`,
    calls.length > 0 && `${calls.length} 次工具调用`,
    failed > 0 && `${failed} 次失败`,
    toolMs > 0 && `工具耗时 ${formatDuration(toolMs)}`,
    calls.length === 0 && view.thinking && "思考过程",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      style={{
        background: token.colorFillQuaternary,
        borderTop: `1px solid ${token.colorBorderSecondary}`,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <button
        type="button"
        className="w-full flex items-center gap-1.5 px-4 py-2 text-xs text-left"
        style={{ color: token.colorTextSecondary }}
        onClick={onToggle}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span style={{ color: token.colorText }}>执行过程</span>
        <span>{summary}</span>
        {failed > 0 && <XCircle size={12} style={{ color: token.colorError }} />}
      </button>

      {open && (
        <div className="px-4 pb-3 flex flex-col gap-2.5">
          {view.thinking && (
            <ThinkingBlock
              text={view.thinking}
              // 模型还在想、还没开口时展开给人看；否则默认收起，别挡住后面的步骤
              defaultOpen={view.live && view.thinkingOpen && !view.answer}
              live={view.live && view.thinkingOpen}
            />
          )}
          {view.rounds.map((r) => (
            <div key={r.round} className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-xs" style={{ color: token.colorTextTertiary }}>
                <span>第 {r.round + 1} 轮</span>
                {r.calls.length > 1 && (
                  <span
                    className="px-1.5 rounded"
                    style={{ background: token.colorFillSecondary, color: token.colorTextSecondary }}
                    title="模型在同一轮里一次要了这几个工具"
                  >
                    并行 {r.calls.length} 个
                  </span>
                )}
              </div>
              {r.text && (
                <div
                  className="text-xs italic whitespace-pre-wrap break-words"
                  style={{ color: token.colorTextSecondary, overflowWrap: "anywhere" }}
                >
                  {r.text}
                </div>
              )}
              <div
                className="flex flex-col"
                style={
                  r.calls.length > 1
                    ? { borderLeft: `2px dashed ${token.colorBorder}`, paddingLeft: 8 }
                    : undefined
                }
              >
                {r.calls.map((c) => (
                  <StepRow key={c.id} call={c} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({ text, defaultOpen, live }: { text: string; defaultOpen: boolean; live: boolean }) {
  const { token } = antdTheme.useToken();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="text-xs">
      <button
        type="button"
        className="flex items-center gap-1.5"
        style={{ color: token.colorTextSecondary }}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Brain size={12} />
        <span>{live ? "思考中…" : "思考过程"}</span>
        <span style={{ color: token.colorTextQuaternary }}>{text.length} 字</span>
      </button>
      {open && (
        <div
          className="mt-1 whitespace-pre-wrap break-words"
          style={{
            color: token.colorTextTertiary,
            borderLeft: `2px solid ${token.colorBorderSecondary}`,
            paddingLeft: 8,
            maxHeight: 240,
            overflow: "auto",
            overflowWrap: "anywhere",
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
}

function StepRow({ call }: { call: SkillCall }) {
  const { token } = antdTheme.useToken();
  const [open, setOpen] = useState(false);
  const { label, source } = describeTool(call.name);
  const args = summarizeArgs(call.argsJson);
  const done = call.status !== "running";

  const icon =
    call.status === "running" ? (
      <Loader2 size={13} className="animate-spin shrink-0" style={{ color: token.colorPrimary }} />
    ) : call.status === "error" ? (
      <XCircle size={13} className="shrink-0" style={{ color: token.colorError }} />
    ) : (
      <CheckCircle2 size={13} className="shrink-0" style={{ color: token.colorSuccess }} />
    );

  return (
    <div className="text-xs">
      <button
        type="button"
        className="w-full flex items-center gap-2 py-1 text-left rounded"
        onClick={() => setOpen(!open)}
        title={call.name}
      >
        {icon}
        <span className="shrink-0" style={{ color: token.colorText }}>
          {label}
        </span>
        {source && (
          <span
            className="shrink-0 px-1 rounded"
            style={{ background: token.colorFillSecondary, color: token.colorTextSecondary }}
          >
            {source}
          </span>
        )}
        {args && (
          <span className="shrink-0 max-w-[40%] truncate" style={{ color: token.colorTextSecondary }}>
            {args}
          </span>
        )}
        <span className="flex-1 min-w-0 truncate" style={{ color: token.colorTextQuaternary }}>
          {done && call.result ? `→ ${summarizeResult(call.result)}` : ""}
        </span>
        {call.durationMs != null && (
          <span className="shrink-0 tabular-nums" style={{ color: token.colorTextQuaternary }}>
            {formatDuration(call.durationMs)}
          </span>
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 pl-5 pb-1.5">
          <DetailBlock title="参数" text={prettyJson(call.argsJson)} />
          {done && (
            <DetailBlock
              title="结果"
              text={prettyJson(call.result)}
              danger={call.status === "error"}
            />
          )}
        </div>
      )}
    </div>
  );
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function DetailBlock({ title, text, danger }: { title: string; text: string; danger?: boolean }) {
  const { token } = antdTheme.useToken();
  const [full, setFull] = useState(false);

  function copy() {
    navigator.clipboard
      .writeText(text)
      .then(() => message.success("已复制"))
      .catch((e) => message.error(`复制失败：${e}`));
  }

  const pre = (maxHeight?: number) => (
    <pre
      className="whitespace-pre-wrap break-all"
      style={{
        margin: 0,
        fontSize: 11,
        fontFamily: "var(--font-mono, monospace)",
        color: danger ? token.colorError : token.colorTextSecondary,
        background: token.colorBgContainer,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: 4,
        padding: "6px 8px",
        maxHeight,
        overflow: "auto",
      }}
    >
      {text || "（空）"}
    </pre>
  );

  return (
    <div>
      <div className="flex items-center gap-2 mb-0.5" style={{ color: token.colorTextTertiary }}>
        <span>{title}</span>
        <span className="flex-1" />
        <button type="button" title="复制" onClick={copy} className="flex items-center">
          <Copy size={11} />
        </button>
        <button type="button" title="全屏查看" onClick={() => setFull(true)} className="flex items-center">
          <Maximize2 size={11} />
        </button>
      </div>
      {pre(200)}
      <Modal open={full} onCancel={() => setFull(false)} footer={null} width="80vw" title={title}>
        {pre(window.innerHeight * 0.7)}
      </Modal>
    </div>
  );
}
