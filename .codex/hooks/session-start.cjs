#!/usr/bin/env node
/**
 * Codex SessionStart Hook - 会话启动时注入经验摘要
 *
 * 功能：CLAUDE.md/AGENTS.md 约定"会话开始读 .claude/docs/experience/ 最近摘要"——
 * 在 Codex 端是模型自觉读取，命中率不稳定。这里改为 hook 自动注入到
 * additionalContext，零依赖模型记忆。
 *
 * Codex stdin schema：
 *   { session_id, source, cwd, hook_event_name, model }
 *   source ∈ { startup, resume, clear }
 *
 * Codex 输出：
 *   - {hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: "..."}} → 加入开发者上下文
 *   - 普通文本 → 同 additionalContext
 *   - {} → 不注入
 *
 * 触发策略：仅 startup（resume/clear 时上下文已存在或被刻意清空，不应再塞）
 */

const fs = require('fs');
const path = require('path');

let raw = '';
let input = {};
try {
  raw = fs.readFileSync(0, 'utf8');
  if (raw) input = JSON.parse(raw);
} catch {
  process.stdout.write('{}');
  process.exit(0);
}

const source = input.source || '';
const cwd = input.cwd || process.cwd();

// 仅在新会话启动时加载（resume/clear 跳过）
if (source && source !== 'startup') {
  process.stdout.write('{}');
  process.exit(0);
}

const expDir = path.join(cwd, '.claude', 'docs', 'experience');

let summaryFile = null;
try {
  // 找最新的 *-exp-summary.md
  const dateDirs = fs.readdirSync(expDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort()
    .reverse();

  for (const d of dateDirs) {
    const sub = path.join(expDir, d);
    const files = fs.readdirSync(sub)
      .filter(f => f.endsWith('-exp-summary.md'))
      .sort()
      .reverse();
    if (files.length) {
      summaryFile = path.join(sub, files[0]);
      break;
    }
  }
} catch {
  // 目录不存在或无权限，静默退出
}

if (!summaryFile) {
  process.stdout.write('{}');
  process.exit(0);
}

let content = '';
try {
  content = fs.readFileSync(summaryFile, 'utf8');
} catch {
  process.stdout.write('{}');
  process.exit(0);
}

// 控制注入体积：超过 8KB 时截断（保留头部）
const MAX = 8 * 1024;
if (content.length > MAX) {
  content = content.slice(0, MAX) + '\n\n…（已截断，完整内容见原文件）';
}

const relPath = path.relative(cwd, summaryFile).replace(/\\/g, '/');
const wrapped = `## 历史经验加载（来自 ${relPath}）

> 以下为最近一次 \`/exp\` 沉淀的经验摘要，包含已沉淀的禁令、踩过的坑、待观察事项。
> 本次会话开始前自动加载，避免重蹈覆辙。

${content}`;

// Codex 校验 SessionStart 输出 schema：顶层 additionalContext 会被判为
// "invalid session start JSON output"，必须放进 hookSpecificOutput 嵌套结构
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: wrapped,
  },
}));
process.exit(0);
