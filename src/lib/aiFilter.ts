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
 * 流式途中也安全调用 —— 标签未闭合时正则不匹配，保留原样到下一个 token 拼上 closing tag 才剥。
 * 不会"半剥"造成视觉跳动。
 */
export function stripPseudoToolCalls(text: string): string {
  let out = text;
  for (const re of PSEUDO_TOOL_PATTERNS) {
    out = out.replace(re, "");
  }
  return out.replace(COLLAPSE_BLANK_LINES, "\n\n");
}
