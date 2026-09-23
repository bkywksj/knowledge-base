/**
 * 「一轮回复 = 一张卡片」的数据层。
 *
 * 卡片有两个来源，渲染却必须长得一样：
 * - **已存的回复**：一条 assistant 消息（正文 + `skill_calls` + `turn_meta`）
 * - **正在流式的回复**：页面按 `ai:round` / `ai:token` / `ai:tool_call` / `ai:reasoning`
 *   事件累积的 {@link LiveTurn}
 *
 * 两者都先转成 {@link TurnView}，`TurnCard` 只认它 —— 以前流式气泡和历史气泡是两套 JSX，
 * 生成结束那一刻样式会跳一下，改一处还常忘了改另一处。
 */
import type { AiMessage, SkillCall, TurnMeta } from "@/types";
import { splitThinking } from "@/lib/stripThinking";
import { stripPseudoToolCalls } from "@/lib/aiFilter";

/** 卡片状态：前三个只在流式中出现，后三个是落库后的结局 */
export type TurnStatus = "thinking" | "tools" | "answering" | "done" | "stopped" | "error";

/** 调过工具的一轮 */
export interface TurnRound {
  round: number;
  /** 这一轮调工具前模型说的话（可能为空） */
  text: string;
  calls: SkillCall[];
}

export interface TurnView {
  status: TurnStatus;
  /** 只含调过工具的轮次；最后那轮（给出回答的）不在这里 */
  rounds: TurnRound[];
  /** 最终回答（已剥掉思考块和伪工具调用残文） */
  answer: string;
  /** 思考过程：reasoning_content + 正文里摘出来的 `<think>` 块 */
  thinking: string;
  /** 流式中：思考块还没闭合（模型还在想） */
  thinkingOpen: boolean;
  error?: string;
  /** 已结束的回复：总耗时（存量消息没有） */
  durationMs?: number;
  /** 流式中：开始时间，卡片头据此跑计时 */
  startedAt?: number;
  /** 回答参考了哪些笔记 */
  refs: number[];
  /** 已存回复对应的消息；流式卡片为空 */
  message?: AiMessage;
  live: boolean;
}

/** 页面在流式期间累积的状态；`rounds` 下标 = 轮次 */
export interface LiveTurn {
  convId: number;
  startedAt: number;
  rounds: { text: string; calls: SkillCall[] }[];
  reasoning: string;
}

export function newLiveTurn(convId: number): LiveTurn {
  return { convId, startedAt: Date.now(), rounds: [], reasoning: "" };
}

// ─── 流式事件 → LiveTurn（纯函数，给 setState 用）──────────────

/** `ai:round`：新一轮开始 */
export function liveStartRound(t: LiveTurn, round: number): LiveTurn {
  const rounds = t.rounds.slice();
  while (rounds.length <= round) rounds.push({ text: "", calls: [] });
  return { ...t, rounds };
}

/** `ai:token`：追加到当前（最后一）轮。RAG 路径不发 ai:round，第一个 token 到达时补出第 0 轮 */
export function liveAppendToken(t: LiveTurn, content: string): LiveTurn {
  const rounds = t.rounds.length ? t.rounds.slice() : [{ text: "", calls: [] }];
  const last = rounds[rounds.length - 1];
  rounds[rounds.length - 1] = { ...last, text: last.text + content };
  return { ...t, rounds };
}

/** `ai:tool_call`：同一个 id 先 running 后 ok/error，按 id 覆盖；新调用挂到它所属的轮次 */
export function liveUpsertCall(t: LiveTurn, call: SkillCall): LiveTurn {
  const rounds = t.rounds.map((r) => {
    const idx = r.calls.findIndex((c) => c.id === call.id);
    if (idx < 0) return r;
    const calls = r.calls.slice();
    calls[idx] = call;
    return { ...r, calls };
  });
  if (rounds.some((r) => r.calls.some((c) => c.id === call.id))) {
    return { ...t, rounds };
  }
  const target = call.round ?? Math.max(rounds.length - 1, 0);
  const next = liveStartRound({ ...t, rounds }, target);
  next.rounds[target] = { ...next.rounds[target], calls: [...next.rounds[target].calls, call] };
  return next;
}

export function liveAppendReasoning(t: LiveTurn, content: string): LiveTurn {
  return { ...t, reasoning: t.reasoning + content };
}

// ─── → TurnView ────────────────────────────────────

function joinThinking(...parts: (string | undefined)[]): string {
  return parts
    .map((p) => p?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
}

/** 两轮之间的话同样可能夹着 `<think>` 和伪工具调用，展示前一并剥掉 */
function cleanInterlude(text: string): string {
  return splitThinking(stripPseudoToolCalls(text)).content;
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // 坏数据不阻断渲染：当作没有
    return null;
  }
}

/** 已存的 assistant 消息 → 卡片 */
export function turnFromMessage(msg: AiMessage): TurnView {
  const calls = parseJson<SkillCall[]>(msg.skill_calls) ?? [];
  const meta = parseJson<TurnMeta>(msg.turn_meta);
  const refs = parseJson<number[]>(msg.references) ?? [];

  // 存量记录没有 round，全部归到第 0 轮
  const byRound = new Map<number, SkillCall[]>();
  for (const c of calls) {
    const r = c.round ?? 0;
    byRound.set(r, [...(byRound.get(r) ?? []), c]);
  }
  const rounds: TurnRound[] = [...byRound.entries()]
    .sort(([a], [b]) => a - b)
    .map(([round, cs]) => ({
      round,
      text: cleanInterlude(meta?.roundTexts?.[round] ?? ""),
      calls: cs,
    }));

  const split = splitThinking(msg.content);
  return {
    status: meta?.endReason ?? "done",
    rounds,
    answer: split.content,
    thinking: joinThinking(meta?.reasoning, split.thinking),
    thinkingOpen: false,
    error: meta?.error,
    durationMs: meta?.durationMs,
    refs,
    message: msg,
    live: false,
  };
}

/** 流式状态 → 卡片 */
export function turnFromLive(t: LiveTurn): TurnView {
  const rounds: TurnRound[] = t.rounds
    .map((r, i) => ({ round: i, text: cleanInterlude(r.text), calls: r.calls }))
    .filter((r) => r.calls.length > 0);

  // 最后一轮还没调工具 → 它的话就是（正在写的）回答；一旦它调了工具，这段话就成了时间线里的插话
  const last = t.rounds[t.rounds.length - 1];
  const answerRaw = last && last.calls.length === 0 ? last.text : "";
  const split = splitThinking(stripPseudoToolCalls(answerRaw), { streaming: true });

  const running = t.rounds.some((r) => r.calls.some((c) => c.status === "running"));
  const status: TurnStatus = running ? "tools" : split.content ? "answering" : "thinking";

  return {
    status,
    rounds,
    answer: split.content,
    thinking: joinThinking(t.reasoning, split.thinking),
    thinkingOpen: split.thinkingOpen,
    startedAt: t.startedAt,
    refs: [],
    live: true,
  };
}

// ─── 展示用小工具 ──────────────────────────────────

/** 内置工具的中文名。kb-core（`kb__` 前缀）与内置 skills 同名的共用一条 */
const TOOL_LABELS: Record<string, string> = {
  search_notes: "检索笔记",
  get_note: "读取笔记",
  list_tags: "列出标签",
  find_related: "查找相关笔记",
  get_today_tasks: "查看今日待办",
  list_datasets: "列出数据表",
  query_dataset: "查询数据表",
  search_by_tag: "按标签找笔记",
  get_backlinks: "查看反向链接",
  list_daily_notes: "列出日记",
  list_tasks: "列出任务",
  list_subtasks: "列出子任务",
  get_prompt: "读取提示词",
  list_prompts: "列出提示词",
  list_templates: "列出笔记模板",
  list_trash: "查看回收站",
  list_recent_notes: "最近更新的笔记",
  list_folders: "列出文件夹",
  list_notes_by_folder: "列出文件夹内笔记",
  move_notes_batch: "批量移动笔记",
  create_folder: "新建文件夹",
  create_note_from_template: "按模板建笔记",
  restore_note_from_trash: "从回收站还原",
  delete_note: "删除笔记",
  remove_tag_from_note: "移除标签",
  add_tag_to_note: "添加标签",
  create_task: "新建任务",
  update_task: "更新任务",
  create_note: "新建笔记",
  update_note: "修改笔记",
  ping: "连通性检查",
};

/**
 * 工具名 → 展示用的名字 + 来源。
 * - `mcp__<server>__<tool>`：外部 MCP 服务，来源显示服务名
 * - `kb__<tool>`：内置知识库工具，去掉前缀
 */
export function describeTool(name: string): { label: string; source?: string } {
  const mcp = name.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return { label: TOOL_LABELS[mcp[2]] ?? mcp[2], source: mcp[1] };
  const bare = name.startsWith("kb__") ? name.slice(4) : name;
  return { label: TOOL_LABELS[bare] ?? bare };
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** 参数里最能说明「这一步在干嘛」的那个值，如检索词、笔记 id */
export function summarizeArgs(argsJson: string): string {
  const args = parseJson<Record<string, unknown>>(argsJson);
  if (!args || typeof args !== "object") return "";
  const preferred = ["query", "keyword", "title", "tag", "name", "note_id", "id", "folder_id"];
  const key =
    preferred.find((k) => args[k] != null && args[k] !== "") ??
    Object.keys(args).find((k) => ["string", "number"].includes(typeof args[k]));
  if (!key) return "";
  const v = args[key];
  return typeof v === "string" ? `“${clip(v, 32)}”` : `${key}=${String(v)}`;
}

/** 结果的一句话摘要：JSON 数组报条数，否则取第一行非空文字 */
export function summarizeResult(result: string): string {
  const parsed = parseJson<unknown>(result);
  if (Array.isArray(parsed)) return `${parsed.length} 条结果`;
  const line = result.split("\n").find((l) => l.trim()) ?? "";
  return clip(line, 60);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

/**
 * 还没换成卡片的紧凑视图（移动端 / 笔记侧边抽屉）用的正文。
 *
 * v63 起失败和停止也会存成一条 assistant 消息，失败那条正文是空的；
 * 这些视图只会画一个空气泡，所以把结局写成一句话补进正文。
 * 用纯文字不用 Markdown 语法：移动端气泡按纯文本渲染。
 */
export function compactTurnText(msg: AiMessage): string {
  if (msg.role !== "assistant") return msg.content;
  const view = turnFromMessage(msg);
  if (view.status === "error") {
    return `⚠️ 回答失败：${(view.error || "AI 请求失败").split("\n")[0]}`;
  }
  if (view.status === "stopped") {
    return view.answer ? `${view.answer}\n\n（已手动停止）` : "（已手动停止，还没来得及生成回答）";
  }
  return msg.content;
}

/** 复制「含工具过程」：Markdown 里先列执行过程，再接回答 */
export function turnToMarkdown(view: TurnView, withProcess: boolean): string {
  if (!withProcess || view.rounds.length === 0) return view.answer;
  const lines: string[] = ["**执行过程**", ""];
  for (const r of view.rounds) {
    if (r.text) lines.push(`> ${r.text.replace(/\n/g, "\n> ")}`, "");
    for (const c of r.calls) {
      const mark = c.status === "error" ? "✗" : "✓";
      lines.push(`- ${mark} ${describeTool(c.name).label} \`${c.name}\` ${summarizeArgs(c.argsJson)}`.trimEnd());
    }
    lines.push("");
  }
  lines.push("---", "", view.answer);
  return lines.join("\n");
}
