// [installer-std] 重新生成 NSIS 自定义模板：tauri-cli 内置模板原件 + 两处标准补丁
//
// 用法（在应用根目录，Windows）：
//   node scripts/installer-std/regen-template.cjs            写到 src-tauri/nsis/installer.nsi
//   node scripts/installer-std/regen-template.cjs --out <文件>  写到别处（比对、试验用）
//
// 什么时候跑：接入模板时跑一次；之后 pnpm-lock.yaml 里的 tauri-cli 版本一变就再跑一次。
// 忘了跑，check-template.cjs 会让 Windows 构建失败并提示这条命令。
//
// 为什么从 CLI 二进制里取原件：模板是 tauri-bundler 用 include_str! 原样编进 CLI 的，
// node_modules 里装的那个 CLI 就是本应用打包时真正用的版本，不用联网、也不会拿错 tag。
// 模板在 tauri 仓库里是 CRLF，这里统一输出 LF、无 BOM、纯 ASCII。
//
// 两处补丁（生成的文件里搜 "installer-std patch"）：
//   1. default-zh：语言选择框默认简体中文。上游默认跟系统语言，选过一次就记进注册表不再弹。
//      只在开了 displayLanguageSelector 时生效，没开的应用带着也无害。
//   2. upgrade-in-place：手动运行安装包升级时不弹「安装前卸载」，也不问安装目录，直接装回原位置。
//      上游这一页默认选「卸载」，旧卸载器不带 /UPDATE 运行，会删开机自启，还有「删除应用程序数据」
//      复选框。应用内更新带 /UPDATE，本来就不出这一页。同版本重装、降级、从 WiX 迁移保留上游页面。
//
// 补丁写成「锚点 → 替换」：每个锚点必须在原件里恰好出现一次，否则报错指出是哪一处。
// 上游改了相关代码时，对照新版原件改这里的锚点，再在所有用模板的应用里重新生成。
// 改补丁内容时把 PATCH_LEVEL 里对应的版本号加一，方便从文件头看出谁是旧补丁。

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_OUT = path.join(ROOT, 'src-tauri', 'nsis', 'installer.nsi');
const PATCH_LEVEL = 'default-zh v1, upgrade-in-place v1';

function fail(msg) {
  console.error(`[installer-std] ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = path.resolve(argv[++i] || fail('--out 后面要跟文件路径'));
    else fail(`不认识的参数：${argv[i]}`);
  }
  return args;
}

/** 已安装的 @tauri-apps/cli 版本（由 pnpm-lock.yaml 锁定） */
function installedCliVersion() {
  const pkg = path.join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'package.json');
  if (!fs.existsSync(pkg)) fail(`找不到 ${pkg}，先在应用根目录 pnpm install`);
  return JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
}

/** 找到与已安装版本一致的 Windows 原生 CLI 二进制（兼容 pnpm 与 npm 的目录布局） */
function findCliBinary(version) {
  const dirs = [];
  const scoped = path.join(ROOT, 'node_modules', '@tauri-apps');
  if (fs.existsSync(scoped)) {
    for (const d of fs.readdirSync(scoped)) if (d.startsWith('cli-win32-')) dirs.push(path.join(scoped, d));
  }
  const pnpm = path.join(ROOT, 'node_modules', '.pnpm');
  if (fs.existsSync(pnpm)) {
    for (const d of fs.readdirSync(pnpm)) {
      const m = d.match(/^@tauri-apps\+(cli-win32-[^@]+)@/);
      if (m) dirs.push(path.join(pnpm, d, 'node_modules', '@tauri-apps', m[1]));
    }
  }
  for (const dir of dirs) {
    const pkg = path.join(dir, 'package.json');
    if (!fs.existsSync(pkg) || JSON.parse(fs.readFileSync(pkg, 'utf8')).version !== version) continue;
    const bin = fs.readdirSync(dir).find((f) => f.endsWith('.node'));
    if (bin) return path.join(dir, bin);
  }
  fail(`找不到 ${version} 版的 Windows CLI 二进制（@tauri-apps/cli-win32-*）。只能在 Windows 上生成，并且要先 pnpm install`);
}

/** 从 CLI 二进制里截出内置 NSIS 模板，统一成 LF */
function extractTemplate(binFile) {
  const buf = fs.readFileSync(binFile);
  for (const nl of ['\r\n', '\n']) {
    const start = buf.indexOf(Buffer.from(`Unicode true${nl}ManifestDPIAware true`));
    if (start < 0) continue;
    if (buf.indexOf(Buffer.from(`Unicode true${nl}ManifestDPIAware true`), start + 1) >= 0) {
      fail('CLI 二进制里出现了多份模板开头，无法判断用哪一份');
    }
    // 截到最后一个函数 CreateOrUpdateDesktopShortcut 的 FunctionEnd；
    // 上游要是在它后面加了函数，生成结果会缺一截，下面的锚点检查不一定能发现，升级 CLI 时对照新版源码看一眼
    const lastFn = buf.indexOf(Buffer.from('Function CreateOrUpdateDesktopShortcut'), start);
    const end = lastFn < 0 ? -1 : buf.indexOf(Buffer.from(`${nl}FunctionEnd${nl}`), lastFn);
    if (end < 0) fail('在 CLI 二进制里找不到模板结尾');
    const raw = buf.subarray(start, end + `${nl}FunctionEnd${nl}`.length);
    if (raw.includes(0)) fail('截出的模板里有空字节，截取范围不对');
    return raw.toString('utf8').replace(/\r\n/g, '\n');
  }
  fail('CLI 二进制里找不到 NSIS 模板开头');
}

const PATCHES = [
  {
    name: 'upgrade-in-place: declare UpgradeInPlace',
    find: 'Var ReinstallPageCheck\nPage custom PageReinstall PageLeaveReinstall\nFunction PageReinstall\n',
    replace: [
      'Var ReinstallPageCheck',
      '; --- installer-std patch: set when this run upgrades an existing NSIS install ---',
      'Var UpgradeInPlace',
      'Page custom PageReinstall PageLeaveReinstall',
      'Function PageReinstall',
      '  ; installer-std patch: reset first, this page re-runs if the user goes back and',
      '  ; switches install mode',
      '  StrCpy $UpgradeInPlace 0',
      '',
      '',
    ].join('\n'),
  },
  {
    name: 'upgrade-in-place: skip the reinstall page when upgrading',
    find: '  ${ElseIf} $R0 = 1\n    StrCpy $R1 "$(olderOrUnknownVersionInstalled)"\n',
    replace: [
      '  ${ElseIf} $R0 = 1',
      '    ; --- installer-std patch: upgrade in place ---',
      '    ; Upstream asks "uninstall before installing?" with uninstall pre-selected.',
      '    ; That runs the old uninstaller without /UPDATE, which drops the autostart',
      '    ; entry and offers a "delete app data" checkbox. In-app updates never reach',
      '    ; this page (/UPDATE), so a manual upgrade now does the same thing: install',
      '    ; over the existing location. The directory page is skipped as well (see',
      '    ; SkipIfPassiveOrUpgrade), otherwise a changed path orphans the old copy.',
      '    ; Same version, downgrade and WiX migration keep the upstream page.',
      '    ${If} $WixMode <> 1',
      '      StrCpy $UpgradeInPlace 1',
      '      Abort',
      '    ${EndIf}',
      '    StrCpy $R1 "$(olderOrUnknownVersionInstalled)"',
      '',
    ].join('\n'),
  },
  {
    name: 'upgrade-in-place: skip the directory page when upgrading',
    find: '!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive\n!insertmacro MUI_PAGE_DIRECTORY\n',
    replace: [
      '; installer-std patch: also skipped when upgrading in place',
      '!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassiveOrUpgrade',
      '!insertmacro MUI_PAGE_DIRECTORY',
      '',
    ].join('\n'),
  },
  {
    name: 'upgrade-in-place: SkipIfPassiveOrUpgrade function',
    find: 'Function SkipIfPassive\n  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}\nFunctionEnd\n',
    replace: [
      'Function SkipIfPassive',
      '  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}',
      'FunctionEnd',
      '; --- installer-std patch: directory page pre-function, see PageReinstall ---',
      'Function SkipIfPassiveOrUpgrade',
      '  ${IfThen} $PassiveMode = 1 ${|} Abort ${|}',
      '  ${IfThen} $UpgradeInPlace = 1 ${|} Abort ${|}',
      'FunctionEnd',
      '',
    ].join('\n'),
  },
  {
    name: 'default-zh: language selector defaults to SimpChinese',
    find: '  !if "${DISPLAYLANGUAGESELECTOR}" == "true"\n    !insertmacro MUI_LANGDLL_DISPLAY\n  !endif\n',
    replace: [
      '  !if "${DISPLAYLANGUAGESELECTOR}" == "true"',
      '    ; --- installer-std patch: language selector defaults to SimpChinese ---',
      '    ; Upstream behavior: dialog default follows OS UI language, and once a',
      '    ; language is stored in registry the dialog is skipped entirely.',
      '    ; Required behavior: every manual install shows the selector with',
      '    ; SimpChinese pre-selected. We force $LANGUAGE first, then !undef the',
      '    ; three MUI_LANGDLL_REGISTRY_* defines so MUI_LANGDLL_DISPLAY neither',
      '    ; overrides the default from registry nor skips the dialog.',
      '    ; Note: MUI_PAGE_INSTFILES above was expanded while the registry defines',
      '    ; still existed, so the user\'s choice is still saved to registry and',
      '    ; reused below for silent/passive updates.',
      '    StrCpy $LANGUAGE ${LANG_SIMPCHINESE}',
      '    ${If} $UpdateMode = 1',
      '    ${OrIf} $PassiveMode = 1',
      '      ; auto-update (/UPDATE) or passive (/P): no dialog; reuse last saved',
      '      ; language, fall back to SimpChinese when nothing was saved yet',
      '      ReadRegStr $R9 HKCU "${MANUPRODUCTKEY}" "Installer Language"',
      '      ${If} $R9 != ""',
      '        StrCpy $LANGUAGE $R9',
      '      ${EndIf}',
      '    ${Else}',
      '      !undef MUI_LANGDLL_REGISTRY_ROOT',
      '      !undef MUI_LANGDLL_REGISTRY_KEY',
      '      !undef MUI_LANGDLL_REGISTRY_VALUENAME',
      '      !insertmacro MUI_LANGDLL_DISPLAY',
      '    ${EndIf}',
      '  !endif',
      '',
    ].join('\n'),
  },
];

function header(version) {
  return [
    `; [installer-std] template: ${PATCH_LEVEL} (tauri-cli ${version})`,
    '; Generated by scripts/installer-std/regen-template.cjs from the NSIS template',
    '; built into tauri-cli, plus two patches (search for "installer-std patch"):',
    ';   1. default-zh: language selector defaults to SimpChinese (.onInit)',
    ';   2. upgrade-in-place: no uninstall prompt, no directory page (PageReinstall)',
    '; Do not edit by hand. After bumping tauri-cli, run the script again;',
    '; scripts/installer-std/check-template.cjs fails the build until you do.',
    '',
  ].join('\n');
}

function main() {
  const { out } = parseArgs(process.argv.slice(2));
  const version = installedCliVersion();
  let text = extractTemplate(findCliBinary(version));
  for (const p of PATCHES) {
    const n = text.split(p.find).length - 1;
    if (n !== 1) {
      fail(`补丁「${p.name}」的锚点在 tauri-cli ${version} 的原件里出现了 ${n} 次（应为 1 次）。` +
        '上游改了这一段，对照新版原件更新本脚本里的 PATCHES');
    }
    text = text.replace(p.find, () => p.replace);
  }
  text = header(version) + text;
  if (/[^\x00-\x7f]/.test(text)) fail('生成结果里有非 ASCII 字符，NSIS 读无 BOM 文件时可能乱码');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  console.log(`[installer-std] 已生成 ${path.relative(ROOT, out) || out}（tauri-cli ${version}，${text.split('\n').length - 1} 行）`);
}

main();
