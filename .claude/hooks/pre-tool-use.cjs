#!/usr/bin/env node
/**
 * PreToolUse Hook - 工具使用前触发 (Tauri 项目 - Rust + React + TypeScript)
 * 功能:
 * 1. 阻止危险命令
 * 2. 提醒敏感操作
 * 3. 自动修正常见错误
 */

const fs = require('fs');

// 从 stdin 读取输入
let inputData = '';
try {
  inputData = fs.readFileSync(0, 'utf8');
} catch {
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
}

let input;
try {
  input = JSON.parse(inputData);
} catch {
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
}

const toolName = input.tool_name;
const toolInput = input.tool_input || {};

// ============================================================
// Bash 命令检查
// ============================================================
if (toolName === 'Bash') {
  const command = toolInput.command || '';

  // ----------------------------------------------------------
  // 1. 检测 > nul 错误用法（Windows 会创建名为 nul 的文件）
  // ----------------------------------------------------------
  const nulPattern = /[12]?\s*>\s*nul\b/i;
  if (nulPattern.test(command)) {
    const output = {
      decision: 'block',
      reason: '\u274c **\u5b89\u5168\u62e6\u622a**: Windows nul \u91cd\u5b9a\u5411\u4f1a\u521b\u5efa\u6587\u4ef6\uff0c\u8bf7\u52ff\u4f7f\u7528\n' +
        '\u547d\u4ee4: `' + command + '`\n\n' +
        '**\u89e3\u51b3\u65b9\u6848**\uff1a\n' +
        '- \u79fb\u9664\u8f93\u51fa\u91cd\u5b9a\u5411\n' +
        '- \u6216\u4f7f\u7528 `> /dev/null 2>&1`\uff08\u8de8\u5e73\u53f0\uff09'
    };
    console.log(JSON.stringify(output));
    process.exit(0);
  }

  // ----------------------------------------------------------
  // 2. 危险命令 -- 直接阻止
  // ----------------------------------------------------------
  const dangerousPatterns = [
    // 通用危险操作
    { pattern: /rm\s+-rf\s+\/(?!\w)/, reason: '\u5220\u9664\u6839\u76ee\u5f55' },
    { pattern: /rm\s+-rf\s+\*/, reason: '\u5220\u9664\u6240\u6709\u6587\u4ef6' },
    { pattern: /drop\s+database/i, reason: '\u5220\u9664\u6570\u636e\u5e93' },
    { pattern: /truncate\s+table/i, reason: '\u6e05\u7a7a\u8868\u6570\u636e' },
    { pattern: /git\s+push\s+--force\s+(origin\s+)?(main|master)/i, reason: '\u5f3a\u5236\u63a8\u9001\u5230\u4e3b\u5206\u652f' },
    { pattern: /git\s+reset\s+--hard\s+HEAD~\d+/, reason: '\u786c\u91cd\u7f6e\u591a\u4e2a\u63d0\u4ea4' },
    { pattern: />\s*\/dev\/sd[a-z]/, reason: '\u76f4\u63a5\u5199\u5165\u78c1\u76d8\u8bbe\u5907' },
    { pattern: /mkfs\./, reason: '\u683c\u5f0f\u5316\u6587\u4ef6\u7cfb\u7edf' },
    { pattern: /:(){ :|:& };:/, reason: 'Fork \u70b8\u5f39' },
    // Tauri/Rust 特有的危险操作
    { pattern: /cargo\s+publish(?!\s+--dry-run)(\s|$)/i, reason: '\u53d1\u5e03 crate \u5230 crates.io\uff08\u4e0d\u53ef\u64a4\u56de\uff09' },
    { pattern: /tauri\s+signer\s+generate/i, reason: '\u91cd\u65b0\u751f\u6210\u7b7e\u540d\u5bc6\u94a5\u4f1a\u8986\u76d6\u73b0\u6709\u5bc6\u94a5' },
  ];

  for (const { pattern, reason } of dangerousPatterns) {
    if (pattern.test(command)) {
      const output = {
        decision: 'block',
        reason: '\u26a0\ufe0f **\u5371\u9669\u64cd\u4f5c\u88ab\u963b\u6b62**\n\n' +
          '\u547d\u4ee4: `' + command + '`\n' +
          '\u539f\u56e0: ' + reason + '\n\n' +
          '\u5982\u786e\u9700\u6267\u884c\uff0c\u8bf7\u624b\u52a8\u5728\u7ec8\u7aef\u8fd0\u884c'
      };
      console.log(JSON.stringify(output));
      process.exit(0);
    }
  }

  // ----------------------------------------------------------
  // 3. 警告但不阻止的命令
  // ----------------------------------------------------------
  const warningPatterns = [
    // Git 操作
    { pattern: /git\s+push\s+--force/, warning: 'Force push \u53ef\u80fd\u8986\u76d6\u4ed6\u4eba\u4ee3\u7801' },
    // Tauri/Rust 特有警告
    { pattern: /cargo\s+clean\b/, warning: '`cargo clean` \u4f1a\u5220\u9664\u6574\u4e2a target \u76ee\u5f55\uff0c\u91cd\u65b0\u7f16\u8bd1\u53ef\u80fd\u8017\u65f6\u8f83\u957f' },
    { pattern: /rm\s+(-rf?\s+)?.*src-tauri\/target/, warning: '\u5220\u9664 Rust \u7f16\u8bd1\u7f13\u5b58\uff0c\u91cd\u65b0\u7f16\u8bd1\u53ef\u80fd\u8017\u65f6\u8f83\u957f' },
    { pattern: /cargo\s+update\b/, warning: '`cargo update` \u53ef\u80fd\u5347\u7ea7\u4f9d\u8d56\u5f15\u5165\u4e0d\u517c\u5bb9\u53d8\u66f4\uff0c\u5efa\u8bae\u5148\u67e5\u770b Cargo.lock \u5dee\u5f02' },
    { pattern: /pnpm\s+tauri\s+build(?!\s+--debug)/, warning: '`pnpm tauri build` \u751f\u4ea7\u6784\u5efa\u53ef\u80fd\u8017\u65f6\u8f83\u957f\uff0c\u5f00\u53d1\u8c03\u8bd5\u5efa\u8bae\u4f7f\u7528 `pnpm tauri build --debug`' },
    { pattern: /npm\s+tauri\s+build(?!\s+--debug)/, warning: '`npm tauri build` \u751f\u4ea7\u6784\u5efa\u53ef\u80fd\u8017\u65f6\u8f83\u957f\uff0c\u5f00\u53d1\u8c03\u8bd5\u5efa\u8bae\u4f7f\u7528 `npm tauri build --debug`' },
    { pattern: /yarn\s+tauri\s+build(?!\s+--debug)/, warning: '`yarn tauri build` \u751f\u4ea7\u6784\u5efa\u53ef\u80fd\u8017\u65f6\u8f83\u957f\uff0c\u5f00\u53d1\u8c03\u8bd5\u5efa\u8bae\u4f7f\u7528 `yarn tauri build --debug`' },
    // 前端依赖
    { pattern: /pnpm\s+(install|add)\s+--force/, warning: '\u5f3a\u5236\u91cd\u65b0\u5b89\u88c5\u4f9d\u8d56\u53ef\u80fd\u5bfc\u81f4\u7248\u672c\u4e0d\u4e00\u81f4' },
    { pattern: /npm\s+install\s+--legacy-peer-deps/, warning: '\u8df3\u8fc7 peer dependency \u68c0\u67e5\u53ef\u80fd\u5f15\u5165\u517c\u5bb9\u6027\u95ee\u9898' },
  ];

  for (const { pattern, warning } of warningPatterns) {
    if (pattern.test(command)) {
      const output = {
        continue: true,
        systemMessage: '\u26a0\ufe0f **\u6ce8\u610f**: ' + warning
      };
      console.log(JSON.stringify(output));
      process.exit(0);
    }
  }
}

// ============================================================
// Write 工具检查
// ============================================================
if (toolName === 'Write') {
  const filePath = toolInput.file_path || '';

  // 检查是否写入敏感配置文件
  const sensitiveFiles = [
    { file: '.env.production', hint: '\u8bf7\u786e\u4fdd\u4e0d\u8981\u63d0\u4ea4\u654f\u611f\u4fe1\u606f\uff08\u5bc6\u94a5\u3001\u5bc6\u7801\u7b49\uff09\u5230 Git' },
    { file: 'credentials.json', hint: '\u8be5\u6587\u4ef6\u53ef\u80fd\u5305\u542b\u8ba4\u8bc1\u51ed\u636e\uff0c\u8bf7\u786e\u4fdd\u5df2\u52a0\u5165 .gitignore' },
    { file: 'secrets.json', hint: '\u8be5\u6587\u4ef6\u53ef\u80fd\u5305\u542b\u673a\u5bc6\u4fe1\u606f\uff0c\u8bf7\u786e\u4fdd\u5df2\u52a0\u5165 .gitignore' },
    { file: 'tauri.conf.json', hint: '\u8be5\u6587\u4ef6\u5305\u542b\u5e94\u7528\u6807\u8bc6\u7b26\u3001\u7b7e\u540d\u914d\u7f6e\u3001\u6743\u9650\u58f0\u660e\u7b49\u5173\u952e\u914d\u7f6e\uff0c\u8bf7\u4ed4\u7ec6\u786e\u8ba4\u4fee\u6539\u5185\u5bb9' },
    { file: '.env.local', hint: '\u672c\u5730\u73af\u5883\u53d8\u91cf\u53ef\u80fd\u5305\u542b\u654f\u611f\u4fe1\u606f' },
    { file: 'tauri.conf.json5', hint: '\u8be5\u6587\u4ef6\u5305\u542b Tauri \u5173\u952e\u914d\u7f6e\uff0c\u8bf7\u4ed4\u7ec6\u786e\u8ba4\u4fee\u6539\u5185\u5bb9' },
  ];

  for (const { file, hint } of sensitiveFiles) {
    if (filePath.endsWith(file)) {
      const output = {
        continue: true,
        systemMessage: '\u26a0\ufe0f **\u654f\u611f\u6587\u4ef6**: \u6b63\u5728\u5199\u5165 `' + file + '`\n\n' + hint
      };
      console.log(JSON.stringify(output));
      process.exit(0);
    }
  }
}

// 默认：允许继续
console.log(JSON.stringify({ continue: true }));
