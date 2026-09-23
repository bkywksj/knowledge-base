import { describe, it, expect } from "vitest";
import type { AiMessage, SkillCall } from "@/types";
import {
  compactTurnText,
  describeTool,
  liveAppendToken,
  liveStartRound,
  liveUpsertCall,
  newLiveTurn,
  summarizeArgs,
  summarizeResult,
  turnFromLive,
  turnFromMessage,
} from "./turnModel";

function call(id: string, round: number, status: SkillCall["status"] = "ok"): SkillCall {
  return { id, name: "search_notes", argsJson: '{"query":"周报"}', result: "[1,2]", status, round };
}

function assistant(content: string, extra: Partial<AiMessage> = {}): AiMessage {
  return {
    id: 7,
    conversation_id: 1,
    role: "assistant",
    content,
    references: null,
    skill_calls: null,
    created_at: "",
    ...extra,
  };
}

describe("流式事件 → 卡片", () => {
  it("调工具前说的话变成时间线插话，最后一轮的话才是回答", () => {
    let t = newLiveTurn(1);
    t = liveStartRound(t, 0);
    t = liveAppendToken(t, "我先搜一下");
    t = liveUpsertCall(t, call("a", 0, "running"));
    let v = turnFromLive(t);
    expect(v.status).toBe("tools");
    expect(v.answer).toBe("");
    expect(v.rounds).toHaveLength(1);
    expect(v.rounds[0].text).toBe("我先搜一下");

    t = liveUpsertCall(t, call("a", 0, "ok"));
    t = liveStartRound(t, 1);
    expect(turnFromLive(t).status).toBe("thinking");

    t = liveAppendToken(t, "找到了两篇");
    v = turnFromLive(t);
    expect(v.status).toBe("answering");
    expect(v.answer).toBe("找到了两篇");
    // running → ok 是同一个调用，不能变成两行
    expect(v.rounds[0].calls).toHaveLength(1);
    expect(v.rounds[0].calls[0].status).toBe("ok");
  });

  it("RAG 路径不发 ai:round，第一个 token 自动补出第 0 轮", () => {
    const v = turnFromLive(liveAppendToken(newLiveTurn(1), "直接回答"));
    expect(v.rounds).toHaveLength(0);
    expect(v.answer).toBe("直接回答");
  });

  it("正文里的 <think> 块拆到思考过程，流式中未闭合时标记为思考中", () => {
    const v = turnFromLive(liveAppendToken(newLiveTurn(1), "<think>先想想"));
    expect(v.answer).toBe("");
    expect(v.thinking).toBe("先想想");
    expect(v.thinkingOpen).toBe(true);
  });
});

describe("已存消息 → 卡片", () => {
  it("按 round 分组，插话取自 turn_meta.roundTexts", () => {
    const v = turnFromMessage(
      assistant("结论", {
        skill_calls: JSON.stringify([call("a", 0), call("b", 0), call("c", 1)]),
        turn_meta: JSON.stringify({ endReason: "done", durationMs: 3200, roundTexts: ["先搜", "再读"] }),
      }),
    );
    expect(v.status).toBe("done");
    expect(v.rounds.map((r) => [r.round, r.text, r.calls.length])).toEqual([
      [0, "先搜", 2],
      [1, "再读", 1],
    ]);
    expect(v.durationMs).toBe(3200);
  });

  it("存量消息（没有 round / turn_meta）全部归到第 0 轮、按已完成处理", () => {
    const legacy = [{ id: "a", name: "get_note", argsJson: "{}", result: "x", status: "ok" }];
    const v = turnFromMessage(assistant("答", { skill_calls: JSON.stringify(legacy) }));
    expect(v.status).toBe("done");
    expect(v.rounds).toHaveLength(1);
    expect(v.rounds[0].round).toBe(0);
  });

  it("坏 JSON 不阻断渲染", () => {
    const v = turnFromMessage(assistant("答", { skill_calls: "{oops", turn_meta: "nope" }));
    expect(v.status).toBe("done");
    expect(v.answer).toBe("答");
  });

  it("紧凑视图给失败 / 停止补一句说明", () => {
    expect(
      compactTurnText(assistant("", { turn_meta: '{"endReason":"error","error":"401 未授权\\n详情"}' })),
    ).toBe("⚠️ 回答失败：401 未授权");
    expect(compactTurnText(assistant("", { turn_meta: '{"endReason":"stopped"}' }))).toContain("已手动停止");
    expect(compactTurnText(assistant("正常"))).toBe("正常");
  });
});

describe("展示小工具", () => {
  it("工具名：内置译成中文，MCP 带出服务名，kb__ 前缀去掉", () => {
    expect(describeTool("search_notes")).toEqual({ label: "检索笔记" });
    expect(describeTool("kb__create_note")).toEqual({ label: "新建笔记" });
    expect(describeTool("mcp__github__list_issues")).toEqual({ label: "list_issues", source: "github" });
  });

  it("参数摘要优先取检索词，结果摘要对数组报条数", () => {
    expect(summarizeArgs('{"limit":5,"query":"周报"}')).toBe("“周报”");
    expect(summarizeArgs('{"id":42}')).toBe("id=42");
    expect(summarizeArgs("not json")).toBe("");
    expect(summarizeResult("[1,2,3]")).toBe("3 条结果");
    expect(summarizeResult("\n第一行\n第二行")).toBe("第一行");
  });
});
