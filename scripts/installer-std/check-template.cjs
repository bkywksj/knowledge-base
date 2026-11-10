// [installer-std] 构建前检查：NSIS 自定义模板是不是用当前 tauri-cli 版本生成的
//
// 挂在 tauri.conf.json 的 build.beforeBuildCommand 最前面：
//   "beforeBuildCommand": "node scripts/installer-std/check-template.cjs && pnpm build"
//
// 为什么要这一步：模板是从某个版本的 tauri-cli 里取出来再打补丁的，package.json 写的是 ^ 范围，
// 有人更新了 CLI 而没重新生成模板时，打包照样成功，只是用着旧模板 —— 拿不到上游的修复，
// 新 CLI 改了模板变量时还可能装出坏的安装包。这里让 Windows 构建直接失败，提示重新生成。
//
// 只在 Windows 上检查（NSIS 安装包只在 Windows 构建）；没有模板、或模板不是 installer-std 生成的，直接放行。

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE = path.join(ROOT, 'src-tauri', 'nsis', 'installer.nsi');
const CLI_PKG = path.join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'package.json');

function main() {
  if (process.platform !== 'win32') return;
  if (!fs.existsSync(TEMPLATE)) return;

  const firstLine = fs.readFileSync(TEMPLATE, 'utf8').split('\n', 1)[0];
  const m = firstLine.match(/^; \[installer-std\] template: .*\(tauri-cli ([^)]+)\)/);
  if (!m) return;
  const templateVersion = m[1].trim();

  if (!fs.existsSync(CLI_PKG)) {
    console.warn(`[installer-std] 找不到 ${CLI_PKG}，跳过模板版本检查`);
    return;
  }
  const cliVersion = JSON.parse(fs.readFileSync(CLI_PKG, 'utf8')).version;
  if (cliVersion === templateVersion) return;

  console.error(
    [
      '',
      `[installer-std] NSIS 模板是用 tauri-cli ${templateVersion} 生成的，现在装的是 ${cliVersion}。`,
      '在应用根目录重新生成后再打包（顺手看一眼 git diff，上游可能改了模板）：',
      '',
      '    node scripts/installer-std/regen-template.cjs',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

main();
