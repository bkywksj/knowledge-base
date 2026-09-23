/**
 * AI 助手的回复卡片：一轮回复 = 一张卡片。
 *
 * 从用户发出提问到这一轮结束，AI 说的话、调的工具、思考过程、结局（完成 / 停止 / 失败）
 * 全在这一张卡片里。以前是工具一个小卡片、正文一个气泡、引用和图片各占一行，
 * 失败只弹一个几秒就消失的 toast。
 *
 * 从上到下：卡片头（状态 + 统计）→ 执行过程（可折叠）→ 回答 → 结局提示 → 参考来源 → 操作栏
 */
import { useEffect, useRef, useState } from "react";
import { Button, message, theme as antdTheme } from "antd";
import {
  AlertTriangle,
  BookOpen,
  Copy,
  FileText,
  ListTree,
  Loader2,
  RotateCcw,
  Settings,
  Square,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { MarkdownContent as Markdown } from "@/components/ai/MarkdownContent";
import { NoteImageRefs } from "@/components/ai/NoteImageRefs";
import { noteApi } from "@/lib/api";
import type { AiMessage } from "@/types";
import { TurnProcess } from "./TurnProcess";
import { formatDuration, turnToMarkdown, type TurnStatus, type TurnView } from "./turnModel";

interface Props {
  view: TurnView;
  /** 这一轮是会话里最后一轮（只有最后一轮能「重新生成」） */
  isLast: boolean;
  /** 本会话正在生成别的回复：期间禁用重新生成，免得两条流抢同一个会话 */
  busy: boolean;
  /** 页面「全部收起」按钮每点一次加 1，卡片据此收起执行过程 */
  collapseSignal: number;
  onStop?: () => void;
  onRegenerate?: () => void;
  onContextMenu?: (e: React.MouseEvent, m: AiMessage) => void;
  contextActive?: boolean;
}

/**
 * 执行过程默认开不开：
 * - 回复中：开，看得到每一步
 * - 正常完成：收成一行摘要，让回答成为主角
 * - 失败 / 停止：开，一眼看到停在哪一步
 */
function defaultProcessOpen(view: TurnView): boolean {
  if (view.live) return true;
  return view.status !== "done" && view.rounds.length > 0;
}

export function TurnCard({
  view,
  isLast,
  busy,
  collapseSignal,
  onStop,
  onRegenerate,
  onContextMenu,
  contextActive,
}: Props) {
  const { token } = antdTheme.useToken();
  const navigate = useNavigate();
  const [processOpen, setProcessOpen] = useState(() => defaultProcessOpen(view));
  const [savingNote, setSavingNote] = useState(false);

  // 「全部收起」：只响应变化，挂载时的初值不算
  const firstSignal = useRef(collapseSignal);
  useEffect(() => {
    if (collapseSignal !== firstSignal.current) setProcessOpen(false);
  }, [collapseSignal]);

  const hasProcess = view.rounds.length > 0 || !!view.thinking;
  const toolCount = view.rounds.reduce((n, r) => n + r.calls.length, 0);
  const borderColor =
    view.status === "error" ? token.colorErrorBorder : contextActive ? token.colorPrimary : token.colorBorderSecondary;

  function copy(withProcess: boolean) {
    navigator.clipboard
      .writeText(turnToMarkdown(view, withProcess))
      .then(() => message.success("已复制"))
      .catch((e) => message.error(`复制失败：${e}`));
  }

  async function saveAsNote() {
    if (!view.answer || savingNote) return;
    setSavingNote(true);
    try {
      // 标题取回答第一行，去掉 Markdown 标记符
      const firstLine = view.answer.split("\n").find((l) => l.trim()) ?? "AI 回答";
      const title = firstLine.replace(/^[#>*\-\s]+/, "").slice(0, 40) || "AI 回答";
      const note = await noteApi.create({ title, content: view.answer, folder_id: null });
      message.success({
        content: (
          <span>
            已存为笔记「{title}」
            <a className="ml-2" onClick={() => navigate(`/notes/${note.id}`)}>
              打开
            </a>
          </span>
        ),
      });
    } catch (e) {
      message.error(`保存失败：${e}`);
    } finally {
      setSavingNote(false);
    }
  }

  return (
    <div
      className="w-full max-w-[860px] rounded-lg overflow-hidden text-sm"
      style={{ background: token.colorBgContainer, border: `1px solid ${borderColor}` }}
      onContextMenu={
        onContextMenu && view.message
          ? (e) => {
              e.preventDefault();
              onContextMenu(e, view.message!);
            }
          : undefined
      }
    >
      <CardHeader view={view} toolCount={toolCount} onStop={onStop} />

      {hasProcess && (
        <TurnProcess view={view} open={processOpen} onToggle={() => setProcessOpen(!processOpen)} />
      )}

      {view.answer ? (
        <div
          className="px-4 py-3 ai-markdown break-words"
          style={{ color: token.colorText, overflowWrap: "anywhere" }}
        >
          <Markdown>{view.answer}</Markdown>
          {view.live && (
            <span className="inline-block w-1.5 h-4 ml-0.5 animate-pulse" style={{ background: token.colorPrimary }} />
          )}
        </div>
      ) : (
        view.live &&
        !hasProcess && (
          <div className="px-4 py-3 flex items-center gap-2" style={{ color: token.colorTextSecondary }}>
            <Loader2 size={14} className="animate-spin" style={{ color: token.colorPrimary }} />
            {/* 本地模型首次 prompt-eval 可能要等很久，得让人看出「在想」而不是卡死 */}
            <span>AI 正在分析…</span>
          </div>
        )
      )}

      <OutcomeNotice
        view={view}
        canRetry={isLast && !busy && !!onRegenerate}
        onRetry={onRegenerate}
        onOpenModelSettings={() => navigate("/settings", { state: { scrollTo: "settings-ai-models" } })}
      />

      {view.refs.length > 0 && (
        <div className="px-4 pb-3 flex flex-col gap-1.5">
          <div className="text-xs flex items-center gap-1" style={{ color: token.colorTextTertiary }}>
            <BookOpen size={11} />
            参考了 {view.refs.length} 篇笔记
          </div>
          {/* 溯源图片：把引用笔记里的图片挂出来，点击可放大 */}
          <NoteImageRefs noteIds={view.refs} />
        </div>
      )}

      {!view.live && (
        <div
          className="flex items-center gap-0.5 px-2 py-1"
          style={{ borderTop: `1px solid ${token.colorBorderSecondary}` }}
        >
          <ActionButton icon={<Copy size={13} />} label="复制" disabled={!view.answer} onClick={() => copy(false)} />
          {toolCount > 0 && (
            <ActionButton
              icon={<ListTree size={13} />}
              label="复制含过程"
              title="连同工具调用过程一起复制为 Markdown"
              disabled={!view.answer}
              onClick={() => copy(true)}
            />
          )}
          <ActionButton
            icon={<FileText size={13} />}
            label="存为笔记"
            title="把这条回答单独存成一篇笔记"
            disabled={!view.answer || savingNote}
            onClick={saveAsNote}
          />
          {/* 失败 / 停止时提示条里已经有「重试 / 重新生成」，这里不再重复 */}
          {isLast && onRegenerate && view.status === "done" && (
            <ActionButton
              icon={<RotateCcw size={13} />}
              label="重新生成"
              title={busy ? "正在生成中" : "撤掉这条回答，用同样的提问再问一次"}
              disabled={busy}
              onClick={onRegenerate}
            />
          )}
        </div>
      )}
    </div>
  );
}

const STATUS_TEXT: Record<TurnStatus, string> = {
  thinking: "思考中",
  tools: "调用工具",
  answering: "回答中",
  done: "已完成",
  stopped: "已停止",
  error: "失败",
};

function CardHeader({ view, toolCount, onStop }: { view: TurnView; toolCount: number; onStop?: () => void }) {
  const { token } = antdTheme.useToken();

  // 流式中每秒刷新一次耗时
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!view.live) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [view.live]);

  const color: Record<TurnStatus, string> = {
    thinking: token.colorPrimary,
    tools: token.colorPrimary,
    answering: token.colorPrimary,
    done: token.colorSuccess,
    stopped: token.colorTextSecondary,
    error: token.colorError,
  };
  const doneCalls = view.rounds.flatMap((r) => r.calls).filter((c) => c.status !== "running").length;
  const label =
    view.status === "tools" ? `${STATUS_TEXT.tools} ${doneCalls}/${toolCount}` : STATUS_TEXT[view.status];

  const elapsed = view.live && view.startedAt ? now - view.startedAt : view.durationMs;
  const stats = [
    view.rounds.length > 0 && `${view.rounds.length} 轮`,
    toolCount > 0 && `${toolCount} 次工具`,
    elapsed != null &&
      elapsed > 0 &&
      // 流式中每秒跳一次，显示整秒（「3s」而不是「3.0s」）；结束后显示精确耗时
      (view.live && elapsed < 60_000 ? `${Math.floor(elapsed / 1000)}s` : formatDuration(elapsed)),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex items-center gap-2 px-4 py-2">
      <div
        className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-[10px] font-bold"
        style={{ background: token.colorPrimaryBg, color: token.colorPrimary }}
      >
        AI
      </div>
      <span
        className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded"
        style={{ color: color[view.status], background: token.colorFillQuaternary }}
      >
        {view.live && <Loader2 size={11} className="animate-spin" />}
        {label}
      </span>
      <span className="flex-1" />
      {stats && (
        <span className="text-xs tabular-nums" style={{ color: token.colorTextQuaternary }}>
          {stats}
        </span>
      )}
      {view.live && onStop && (
        <Button size="small" type="text" danger icon={<Square size={11} />} onClick={onStop}>
          停止
        </Button>
      )}
    </div>
  );
}

/** 结局提示：失败 / 停止一直留在卡片上，附带下一步能做什么 */
function OutcomeNotice({
  view,
  canRetry,
  onRetry,
  onOpenModelSettings,
}: {
  view: TurnView;
  canRetry: boolean;
  onRetry?: () => void;
  onOpenModelSettings: () => void;
}) {
  const { token } = antdTheme.useToken();
  if (view.status === "error") {
    return (
      <div
        className="mx-4 mb-3 px-3 py-2 rounded text-xs flex flex-col gap-2"
        style={{ background: token.colorErrorBg, border: `1px solid ${token.colorErrorBorder}` }}
      >
        <div className="flex items-start gap-1.5" style={{ color: token.colorError }}>
          <AlertTriangle size={13} className="shrink-0 mt-px" />
          <pre
            className="m-0 whitespace-pre-wrap break-words"
            style={{ fontFamily: "inherit", maxHeight: 200, overflow: "auto", overflowWrap: "anywhere" }}
          >
            {view.error || "AI 请求失败"}
          </pre>
        </div>
        <div className="flex gap-2">
          {canRetry && (
            <Button size="small" icon={<RotateCcw size={12} />} onClick={onRetry}>
              重试
            </Button>
          )}
          <Button size="small" type="text" icon={<Settings size={12} />} onClick={onOpenModelSettings}>
            去改模型服务
          </Button>
        </div>
      </div>
    );
  }
  if (view.status === "stopped") {
    return (
      <div
        className="mx-4 mb-3 px-3 py-1.5 rounded text-xs flex items-center gap-2"
        style={{ background: token.colorFillQuaternary, color: token.colorTextSecondary }}
      >
        <Square size={11} />
        <span>已手动停止{view.answer ? "，上面是停止前生成的内容" : "，还没来得及生成回答"}</span>
        <span className="flex-1" />
        {canRetry && (
          <Button size="small" type="link" className="!px-0" onClick={onRetry}>
            重新生成
          </Button>
        )}
      </div>
    );
  }
  return null;
}

function ActionButton({
  icon,
  label,
  title,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button size="small" type="text" icon={icon} disabled={disabled} onClick={onClick} title={title}>
      <span className="text-xs">{label}</span>
    </Button>
  );
}
