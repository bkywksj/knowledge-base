/**
 * AI 流式输出过滤工具。
 *
 * 与 Rust 侧 `services::ai::strip_pseudo_tool_calls` 行为对齐：
 * 当模型在最后一轮（tools 已禁用）退化输出"伪工具调用"文本时，前端在
 * 渲染 `streamingText` 之前先剥一道，避免用户看到 `<tool_call>...</tool_call>`
 * 这种残文。Rust 侧已在持久化前过滤过，前端这道是"流式途中"的兜底。
 *
 * 改这里的正则前请同步检查 `src-tauri/src/services/ai.rs` 同名函数。
 */

const PSEUDO_TOOL_PATTERNS: RegExp[] = [
  // XML 风格：<tool_call>...</tool_call> / <tool_use> / <tool> / <function_call>
  /<\s*(tool_call|tool_use|tool|function_call)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
  // 围栏代码块：```tool_call ... ``` / ```tool_code ... ``` / ```function_call ... ```
  /```\s*(?:tool_call|tool_code|tool_use|function_call)\b[\s\S]*?```/gi,
  // 函数调用风格：行首 functions.xxx(...) / tool: xxx(...) / tool_call: xxx(...)
  /^[ \t]*(?:functions\.|tool:\s*|tool_call:\s*)[a-z_][a-z0-9_]*\s*\([^\n]*\)[ \t]*$/gim,
];

/** 多个连续空行合并为单空行，避免剥完留大段空白 */
const COLLAPSE_BLANK_LINES = /\n{3,}/g;

/**
 * 引用标记 `<!--refs:[1,3]-->`。
 *
 * 模型被要求在回答末尾自报实际参考了哪几篇笔记，Rust 侧据此做白名单校验
 * （见 `src-tauri/src/services/citations.rs`）。这行标记是给程序看的，不该展示给用户。
 *
 * 末尾的 `(?:-->|$)` 是关键：流式途中标记可能只吐了一半（`<!--refs:[1`），
 * 此时也要剥掉 —— 否则用户会眼睁睁看着半截标记挂在回答末尾好几秒。
 * 这与伪工具调用的策略相反（那边未闭合就保留，因为标签中间是正文；
 * 这边标记内部只有数字，提前剥不会误伤内容）。
 */
const CITATION_MARKER = /\n*<!--\s*refs\b\s*:?[^>]*?(?:-->|$)/gi;

/**
 * 流式途中也安全调用 —— 伪工具调用标签未闭合时正则不匹配，保留原样到下一个 token
 * 拼上 closing tag 才剥，不会"半剥"造成视觉跳动；引用标记则未闭合也剥（见上）。
 */
export function stripPseudoToolCalls(text: string): string {
  let out = text;
  for (const re of PSEUDO_TOOL_PATTERNS) {
    out = out.replace(re, "");
  }
  out = out.replace(CITATION_MARKER, "");
  return out.replace(COLLAPSE_BLANK_LINES, "\n\n");
}
