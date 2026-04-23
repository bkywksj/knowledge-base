# 发布更新

## 概述

Knowledge Base 桌面应用采用 **CI 构建 + 本地推送 + R2 CDN** 模式：

```
本地：更新版本号 → 提交 → 打 Tag → 推送（触发 CI）
  ↓ CI 构建中（不推送任何内容到 release 仓库）
CI：构建 Windows + macOS + Linux 安装包 → 上传到 GitHub Release（草稿）
  ↓ CI 完成后，用户下载产物到 D:/download/download/
本地：上传产物到 R2 CDN + 更新 README + 复制产物 + 生成 update.json → 推送到 GitHub release 仓库 → publish Release
```

> **关键原则**：CI 构建完成、用户提供下载文件之前，**不要推送任何内容到 release 仓库**。
> README 更新、产物复制、update.json 生成在获得产物后一次性完成并推送。

> **本地不需要执行 `pnpm tauri build`**。CI 负责构建和签名。
> 构建完成后，用户手动从 GitHub Release 下载产物，Claude 负责本地处理和推送。

### 支持平台

本项目 CI 构建 **Windows + macOS + Linux** 三平台。

| 平台 | Runner | Bundle 参数 |
|------|--------|-------------|
| Windows x64 | `windows-latest` | `--bundles nsis` |
| macOS Apple Silicon | `macos-latest` + target `aarch64-apple-darwin` | `--bundles app,dmg` |
| macOS Intel | `macos-latest` + target `x86_64-apple-darwin` | `--bundles app,dmg` |
| Linux x64 | `ubuntu-22.04` | `--bundles deb,appimage` |

> Linux runner 在构建前需安装 webkit2gtk-4.1 / soup-3.0 / ayatana-appindicator3 等系统包
> （工作流里的 "Install Linux system dependencies" 步骤已覆盖，只在 `matrix.platform == 'ubuntu-22.04'` 时触发）。

### 三级分发策略

| 用途 | 平台 | 角色 | 原因 |
|------|------|------|------|
| **源码托管** | GitHub 私有 `bkywksj/knowledge-base` | — | 代码管理 + CI 构建 |
| **CI 构建** | GitHub Actions | — | 跨平台构建 + 签名 |
| **安装包下载 + 自动更新（主）** | Cloudflare R2 CDN | **主源** | 国内快，零流量费，全球 CDN |
| **自动更新备源 + 海外存档** | GitHub 公开 `bkywksj/knowledge-base-release` | **备源 1** | R2 不通时兜底，含签名产物 |
| **自动更新兜底 + 国内镜像** | Gitee 公开 `bkywksj/knowledge-base-release` | **备源 2** | 国内免代理访问，raw URL 作为 update.json 发现兜底 |

> **Gitee 仓库的 update.json 与 GitHub 版内容完全一致**（url 都指向 GitHub raw）。
> Gitee endpoint 主要作用是"读取 update.json"时的兜底（在 R2 和 GitHub 都挂的场景下至少能发现新版本）。
> 完整下载链路走 R2（首选）或 GitHub raw（R2 不通时）。

### 为什么不让 CI 推送到 release 仓库？

GitHub Actions 在美国服务器运行，推送二进制产物到国内通常超时。
改为用户本地下载产物后，由 Claude 在本地完成推送，速度更快且更可控。

---

## 关键配置

| 项目 | 值 |
|------|-----|
| **应用名（productName）** | `Knowledge Base`（CI 产物前缀会变成 `Knowledge.Base_`，空格→点）|
| **签名私钥** | GitHub Secrets `TAURI_SIGNING_PRIVATE_KEY`（已配置）|
| **签名公钥** | `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` |
| **更新端点 1（R2 主）** | `https://pub-9d9e6c0cb6934fb0a0c505e3c64f39b2.r2.dev/knowledge-base/update.json` |
| **更新端点 2（GitHub raw 备）** | `https://github.com/bkywksj/knowledge-base-release/raw/main/update.json` |
| **更新端点 3（Gitee raw 兜底）** | `https://gitee.com/bkywksj/knowledge-base-release/raw/master/update.json` |
| **R2 CDN 公开地址** | `https://pub-9d9e6c0cb6934fb0a0c505e3c64f39b2.r2.dev/knowledge-base` |
| **R2 rclone remote** | `r2:downloads/knowledge-base/`（`~/.config/rclone/rclone.conf`）|
| **R2 rclone 程序** | `~/bin/rclone.exe` |
| **源码仓库本地路径** | `E:/my/桌面软件tauri/knowledge_base` |
| **源码仓库分支** | `master`（GitHub remote 名为 `github`，Gitee remote 名为 `origin`）|
| **Release 仓库（GitHub 公开）** | `https://github.com/bkywksj/knowledge-base-release`（remote: `origin`）|
| **Release 仓库（Gitee 公开）** | `https://gitee.com/bkywksj/knowledge-base-release`（remote: `gitee`）|
| **本地 Release 仓库路径** | `E:/my/桌面软件tauri/knowledge-base-release` |
| **Release 仓库分支** | 本地 `main`；GitHub 远端 `main`；**Gitee 远端 `master`**（推 Gitee 时用 refspec `main:master`）|
| **默认下载目录** | `D:/download/download/`（浏览器下载保存位置）|
| **GitHub Actions 工作流** | `.github/workflows/release.yml` |
| **平台配置** | `.claude/release-config.json`（含所有自动化参数）|

---

## 版本号位置（三处必须同步）

| 文件 | 字段 |
|------|------|
| `src-tauri/tauri.conf.json` | `"version": "x.y.z"` |
| `src-tauri/Cargo.toml` | `version = "x.y.z"` |
| `package.json` | `"version": "x.y.z"` |

---

## 完整发布流程

### 步骤 1：本地 tsc 自检 + 询问版本号和更新说明

```bash
# 避免 CI 因 unused import 失败
cd "E:/my/桌面软件tauri/knowledge_base" && npx tsc --noEmit
```

使用 AskUserQuestion 询问：
1. 新版本号（当前版本读取自 `tauri.conf.json`）
2. 更新说明（将写入 release 仓库 README 版本历史）

### 步骤 2：更新三处版本号

```
Edit src-tauri/tauri.conf.json   # "version": "x.y.z"
Edit src-tauri/Cargo.toml         # version = "x.y.z"
Edit package.json                 # "version": "x.y.z"
```

### 步骤 3：更新 release 仓库 README.md

更新 3 处：
1. 顶部 "最新版本: vx.y.z" 下载表格（文件名用 `Knowledge.Base_x.y.z_...`，注意**带点**）
2. "版本历史" 添加 v_x.y.z_ 条目
3. "项目结构" 树中添加 v_x.y.z_ 目录

**下载表格模板**（Windows + macOS，所有文件名带点）：

```markdown
### 最新版本: vx.y.z

| 平台 | 下载链接 |
|------|---------|
| Windows x64 | [Knowledge.Base_x.y.z_x64-setup.exe](releases/vx.y.z/Knowledge.Base_x.y.z_x64-setup.exe) |
| macOS Apple Silicon | [Knowledge.Base_x.y.z_aarch64.dmg](releases/vx.y.z/Knowledge.Base_x.y.z_aarch64.dmg) |
| macOS Intel | [Knowledge.Base_x.y.z_x64.dmg](releases/vx.y.z/Knowledge.Base_x.y.z_x64.dmg) |
```

### 步骤 4：提交并推送 release 仓库 README

> 推送前必须先 `git pull --rebase origin main`（上次 CI 可能已推）。

```bash
cd "E:/my/桌面软件tauri/knowledge-base-release"
git add README.md
git commit -m "docs: 更新 README 至 vx.y.z

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
git pull --rebase origin main
git push origin main
```

### 步骤 5：提交源码仓库并打 Tag 触发 CI

```bash
cd "E:/my/桌面软件tauri/knowledge_base"
git add src-tauri/tauri.conf.json src-tauri/Cargo.toml package.json
# 如有其他变更一起 add
git commit -m "release: vx.y.z

<更新说明摘要>

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
git push github master
git tag "vx.y.z"
git push github "vx.y.z"
```

### 步骤 6：等待 CI 构建完成（15-30 分钟）

向用户提示：
- CI 进度：https://github.com/bkywksj/knowledge-base/actions
- 构建完成后去 Releases 草稿下载产物：https://github.com/bkywksj/knowledge-base/releases

**要下载的 13 个文件**（CI 产物前缀 Windows/macOS 为 `Knowledge.Base_`，Linux 为 `knowledge-base_`，具体前缀首次 Linux CI 后按实际产物名校正）：

```
# Windows (3)
Knowledge.Base_x.y.z_x64-setup.exe          # Windows 安装包
Knowledge.Base_x.y.z_x64-setup.exe.sig      # Windows 签名
Knowledge.Base_x.y.z_x64-setup.nsis.zip     # Windows updater zip

# macOS (6)
Knowledge.Base_x.y.z_aarch64.dmg            # macOS ARM 镜像
Knowledge.Base_x.y.z_x64.dmg                # macOS Intel 镜像
Knowledge.Base_aarch64.app.tar.gz           # macOS ARM updater（无版本号）
Knowledge.Base_aarch64.app.tar.gz.sig       # macOS ARM updater 签名
Knowledge.Base_x64.app.tar.gz               # macOS Intel updater（无版本号）
Knowledge.Base_x64.app.tar.gz.sig           # macOS Intel updater 签名

# Linux (4) —— 首次 CI 后按实际文件名校正，tauri-bundler 对含空格的 productName
#          通常会规范化为 kebab-case 或 snake_case，可能是以下任一形式：
#            knowledge-base_x.y.z_amd64.deb
#            Knowledge Base_x.y.z_amd64.AppImage
#            knowledge_base_x.y.z_amd64.AppImage.tar.gz
knowledge-base_x.y.z_amd64.deb              # Linux Debian/Ubuntu 包
knowledge-base_x.y.z_amd64.AppImage         # Linux 通用 AppImage
knowledge-base_x.y.z_amd64.AppImage.tar.gz  # Linux AppImage updater（v1Compatible 模式）
knowledge-base_x.y.z_amd64.AppImage.tar.gz.sig  # Linux updater 签名
```

> ⚠️ **dmg 带版本号**，**macOS app.tar.gz 不带版本号**，这是 tauri-action 的约定。
> ⚠️ **Linux AppImage.tar.gz 带版本号**（与 macOS app.tar.gz 不同），本项目 `createUpdaterArtifacts: "v1Compatible"` 模式下产出。
> ⚠️ 用户容易漏下 `.exe` 主文件（浏览器只下 `.sig`），清点时要核对**所有 13 个都在**。
> ⚠️ **首次 Linux CI 后**，务必把实际产物文件名回填到本文件，修正占位符。

使用 AskUserQuestion 询问下载目录（默认 `D:/download/download/`，回车用默认）。

### 步骤 7：处理产物（Claude 自动执行）

```bash
VERSION="x.y.z"
DOWNLOAD_DIR="D:/download/download"   # 或用户提供的
GITHUB_DIR="E:/my/桌面软件tauri/knowledge-base-release"
TARGET="$GITHUB_DIR/releases/v$VERSION"
RCLONE="$HOME/bin/rclone.exe"

mkdir -p "$TARGET"

# 7a. 复制 13 个产物到 release 仓库
# Windows
cp "$DOWNLOAD_DIR"/Knowledge.Base_${VERSION}_x64-setup.exe "$TARGET/"
cp "$DOWNLOAD_DIR"/Knowledge.Base_${VERSION}_x64-setup.exe.sig "$TARGET/"
cp "$DOWNLOAD_DIR"/Knowledge.Base_${VERSION}_x64-setup.nsis.zip "$TARGET/"
# macOS
cp "$DOWNLOAD_DIR"/Knowledge.Base_${VERSION}_aarch64.dmg "$TARGET/"
cp "$DOWNLOAD_DIR"/Knowledge.Base_${VERSION}_x64.dmg "$TARGET/"
cp "$DOWNLOAD_DIR"/Knowledge.Base_aarch64.app.tar.gz "$TARGET/"
cp "$DOWNLOAD_DIR"/Knowledge.Base_aarch64.app.tar.gz.sig "$TARGET/"
cp "$DOWNLOAD_DIR"/Knowledge.Base_x64.app.tar.gz "$TARGET/"
cp "$DOWNLOAD_DIR"/Knowledge.Base_x64.app.tar.gz.sig "$TARGET/"
# Linux（首次 Linux CI 后按实际文件名校正 LINUX_PREFIX 和 ARCH_SUFFIX）
LINUX_PREFIX="knowledge-base"        # 可能是 knowledge-base / knowledge_base / "Knowledge Base"
LINUX_ARCH="amd64"
cp "$DOWNLOAD_DIR"/${LINUX_PREFIX}_${VERSION}_${LINUX_ARCH}.deb "$TARGET/"
cp "$DOWNLOAD_DIR"/${LINUX_PREFIX}_${VERSION}_${LINUX_ARCH}.AppImage "$TARGET/"
cp "$DOWNLOAD_DIR"/${LINUX_PREFIX}_${VERSION}_${LINUX_ARCH}.AppImage.tar.gz "$TARGET/"
cp "$DOWNLOAD_DIR"/${LINUX_PREFIX}_${VERSION}_${LINUX_ARCH}.AppImage.tar.gz.sig "$TARGET/"

# 7b. 上传本版本所有产物到 R2（并发快，~10 秒内完成）
$RCLONE copy "$TARGET/" "r2:downloads/knowledge-base/v$VERSION/" --progress --stats 5s
```

### 步骤 8：生成两份 update.json（GitHub 版 + R2 版）

> 🔴 **签名注入规则（违反会导致应用内更新签名验证失败）**
>
> 1. 必须用脚本从 `.sig` 文件直接读内容（去掉末尾换行），**禁止手动复制粘贴**
> 2. 三份 JSON（R2/GitHub）只有 URL 的 `BASE` 不同，签名完全相同
> 3. 生成后必须**验证 JSON 中的签名与 .sig 原始内容完全一致**

用 Python 生成（放在 `$GITHUB_DIR` 执行）：

```python
import json
from datetime import datetime, timezone

VERSION = 'x.y.z'
NOTES = '<更新说明>'
GITHUB_BASE = f'https://github.com/bkywksj/knowledge-base-release/raw/main/releases/v{VERSION}'
R2_BASE = f'https://pub-9d9e6c0cb6934fb0a0c505e3c64f39b2.r2.dev/knowledge-base/v{VERSION}'
RELEASE_DIR = f'releases/v{VERSION}'

def read_sig(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read().strip()

def build(base):
    return {
        'version': VERSION,
        'notes': NOTES,
        'pub_date': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'platforms': {
            'windows-x86_64': {
                'url': f'{base}/Knowledge.Base_{VERSION}_x64-setup.exe',
                'signature': read_sig(f'{RELEASE_DIR}/Knowledge.Base_{VERSION}_x64-setup.exe.sig'),
            },
            'darwin-aarch64': {
                'url': f'{base}/Knowledge.Base_aarch64.app.tar.gz',
                'signature': read_sig(f'{RELEASE_DIR}/Knowledge.Base_aarch64.app.tar.gz.sig'),
            },
            'darwin-x86_64': {
                'url': f'{base}/Knowledge.Base_x64.app.tar.gz',
                'signature': read_sig(f'{RELEASE_DIR}/Knowledge.Base_x64.app.tar.gz.sig'),
            },
            # Linux x86_64（首次 CI 后按实际文件名校正 LINUX_PREFIX 占位符）
            'linux-x86_64': {
                'url': f'{base}/knowledge-base_{VERSION}_amd64.AppImage.tar.gz',
                'signature': read_sig(f'{RELEASE_DIR}/knowledge-base_{VERSION}_amd64.AppImage.tar.gz.sig'),
            },
        },
    }

# GitHub 版 → git 仓库 update.json
with open('update.json', 'w', encoding='utf-8') as f:
    json.dump(build(GITHUB_BASE), f, ensure_ascii=False, indent=2)
# R2 版 → 备档到 git（方便排查），同时上传到 R2
with open('update-r2.json', 'w', encoding='utf-8') as f:
    json.dump(build(R2_BASE), f, ensure_ascii=False, indent=2)
print('✅ 两份 update.json 已生成')
```

### 步骤 9：上传 R2 版 update.json 覆盖 R2 根目录

```bash
$RCLONE copy "$GITHUB_DIR/update-r2.json" r2:downloads/knowledge-base/
$RCLONE moveto r2:downloads/knowledge-base/update-r2.json r2:downloads/knowledge-base/update.json

# 验证 R2 可访问
curl -s -o /dev/null -w "R2 update.json HTTP %{http_code}\n" \
  "https://pub-9d9e6c0cb6934fb0a0c505e3c64f39b2.r2.dev/knowledge-base/update.json"
```

### 步骤 9.5：更新 R2 versions.json（文档站下载页依赖此文件）

文档站 `knowledge-base-docs` 的 `DownloadSection.vue` 在**构建时**（`config.ts` 顶层 await）
从 R2 拉取 `versions.json` 并嵌入 bundle（浏览器直连 R2 受 CORS 限制，运行时 fetch 会失败）。
所以每次发布新版本后，必须更新 R2 的 `versions.json`，文档站重建时才能拿到最新快照。

`versions.json` 格式（对象数组，含 notes/pub_date）：

```json
{
  "versions": [
    { "version": "v0.2.1", "notes": "本次更新说明", "pub_date": "2026-04-21T12:34:56Z" },
    { "version": "v0.2.0", "notes": "上次更新说明", "pub_date": "..." }
  ]
}
```

```bash
# NOTES 与步骤 1 询问用户时的"更新说明"保持一致（可多行，用 \n 分隔）
RELEASE_NOTES="<本次发布说明>"
PUB_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
R2_PUBLIC="https://pub-9d9e6c0cb6934fb0a0c505e3c64f39b2.r2.dev/knowledge-base"

# 下载当前 versions.json（不存在则初始化空数组）
curl -s "${R2_PUBLIC}/versions.json" -o /tmp/versions-old.json 2>/dev/null \
  || echo '{"versions":[]}' > /tmp/versions-old.json

# 用 Node 脚本：把旧格式（字符串）规整为对象格式，去重后在头部插入新版本
NOTES="$RELEASE_NOTES" PUB="$PUB_DATE" VER="v${VERSION}" node -e "
const fs = require('fs');
const old = JSON.parse(fs.readFileSync('/tmp/versions-old.json', 'utf8'));
const existing = (old.versions || [])
  .map(v => typeof v === 'string' ? { version: v } : v)
  .filter(v => v.version && v.version !== process.env.VER);
const next = { versions: [
  { version: process.env.VER, notes: process.env.NOTES, pub_date: process.env.PUB },
  ...existing
] };
fs.writeFileSync('/tmp/versions.json', JSON.stringify(next, null, 2));
"

# 上传覆盖 R2
$RCLONE copyto /tmp/versions.json r2:downloads/knowledge-base/versions.json --progress

# 验证
curl -s "${R2_PUBLIC}/versions.json" | head -c 500
```

### 步骤 10：推送 release 仓库（产物 + update.json + update-r2.json）到 GitHub + Gitee

```bash
cd "$GITHUB_DIR"
git add -A
git commit -m "release: vx.y.z

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
git pull --rebase origin main
git push origin main           # GitHub（remote 名 origin，远端分支 main）
git push gitee main:master     # Gitee（远端分支 master；本地 main → 远端 master 的 refspec 映射）

# 如果任一 push 超时（SSL_ERROR_SYSCALL 等），不要重试，提示用户手动执行：
#   cd "E:/my/桌面软件tauri/knowledge-base-release" && git push origin main
#   cd "E:/my/桌面软件tauri/knowledge-base-release" && git push gitee main:master
```

> **Gitee push 比 GitHub 快**（国内直连，~10 秒）。如果 GitHub 超时而 Gitee 成功，国内用户的自动更新仍然能从 Gitee endpoint 读取 update.json 并通过 update.json 里的 GitHub/R2 url 下载。

### 步骤 11：发布 GitHub Release（从 draft → published）

用 GitHub API patch bkywksj token，找到 vX.Y.Z 的 draft Release 并发布：

```python
import urllib.request, json, subprocess
proc = subprocess.run(['git', 'credential', 'fill'],
    input='protocol=https\nhost=github.com\n', capture_output=True, text=True)
token = next(l.split('=',1)[1] for l in proc.stdout.splitlines() if l.startswith('password='))

req = urllib.request.Request('https://api.github.com/repos/bkywksj/knowledge-base/releases')
req.add_header('Authorization', f'Bearer {token}')
releases = json.loads(urllib.request.urlopen(req).read())
target = next((r for r in releases if r['tag_name'] == 'vX.Y.Z'), None)
if target and target['draft']:
    body = json.dumps({
        'draft': False,
        'name': f'Knowledge Base vX.Y.Z',
        'body': '<更新说明>\n\n自动更新：R2 CDN（主）+ GitHub raw（备）'
    }).encode()
    r = urllib.request.Request(f'https://api.github.com/repos/bkywksj/knowledge-base/releases/{target["id"]}',
        data=body, method='PATCH')
    r.add_header('Authorization', f'Bearer {token}')
    r.add_header('Accept', 'application/vnd.github+json')
    urllib.request.urlopen(r)
    print('✅ Release 已 publish')
```

### 步骤 11.5：触发文档站重建（同步 R2 versions.json 到下载页）

> **为什么需要这步**：文档站 `knowledge-base-docs` 的 `DownloadSection.vue` 在**构建时**
> 从 R2 拉取 `versions.json` 并嵌入 bundle（避免运行时 CORS + GitHub 限流/国内慢）。
> 所以每次发布新版本更新 R2 后，必须触发文档站重新构建（腾讯 EdgeOne Pages 会在 git push
> 检测到 diff 时自动重建），让下载页拿到最新快照。

```bash
DOCS_DIR="E:/my/桌面软件tauri/knowledge-base-docs"
cd "$DOCS_DIR"

# 更新版本标记文件（有真实 diff 才会触发 EdgeOne Pages 重建，比空 commit 更稳）
cat > docs/public/.last-release.json << JSONEOF
{
  "version": "v$VERSION",
  "published_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSONEOF

git add docs/public/.last-release.json
git commit -m "chore: 同步 v$VERSION 发布（触发下载页快照重建）

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
git pull --rebase origin master
git push origin master

# 如果推送超时，不要重试，提示用户手动执行：
#   cd "E:/my/桌面软件tauri/knowledge-base-docs" && git push origin master
```

推送后腾讯 EdgeOne Pages 会自动重新构建文档站，`config.ts` 里的顶层 await 重新拉取
R2 versions.json，新版本会作为构建时快照嵌入到 `download.html`。用户打开下载页
一瞬间就能看到最新版本（无需等待运行时 fetch，也不受 CORS 限制）。

### 步骤 12：完成报告

```markdown
## v_X.Y.Z_ 发布完成

| 项目 | 值 |
|------|-----|
| 版本 | vX.Y.Z |
| 源码 commit | <hash> (master) |
| Tag | vX.Y.Z |
| CI 状态 | ✅ 成功（Windows + macOS ARM + macOS Intel + Linux x64）|
| GitHub Release | https://github.com/bkywksj/knowledge-base/releases/tag/vX.Y.Z |
| Release 仓库 | <hash> (main) — 13 个产物 + 2 个 update.json |
| R2 CDN | ✅ 13 个产物 + update.json + versions.json 已上传 |
| 文档站（knowledge-base-docs） | ✅ 已推 .last-release.json 触发 EdgeOne Pages 重建，下载页将同步最新版本 |
| 应用内自动更新 | R2 主 + GitHub raw 备，双端点已生效 |
```

---

## CI 构建说明

### 工作流文件

`.github/workflows/release.yml`

### 触发方式

推送 `v*.*.*` 格式的 Git Tag 自动触发：

```bash
git push github vx.y.z
```

### 构建矩阵

| 平台 | Runner | Bundle 参数 | Updater 产物 | 安装包 |
|------|--------|-------------|-------------|--------|
| Windows | `windows-latest` | `--bundles nsis` | `.exe` + `.exe.sig` | `.exe` (NSIS) |
| macOS ARM | `macos-latest` | `--bundles app,dmg` | `.app.tar.gz` + `.sig` | `.dmg` (aarch64) |
| macOS Intel | `macos-latest` | `--bundles app,dmg` | `.app.tar.gz` + `.sig` | `.dmg` (x86_64) |
| Linux x64 | `ubuntu-22.04` | `--bundles deb,appimage` | `.AppImage.tar.gz` + `.sig` | `.deb` + `.AppImage` |

> **macOS 必须 `--bundles app,dmg`**（dmg 单独不产出 updater）
> **Linux Runner 需在 tauri-action 前安装 webkit2gtk-4.1 等系统包**（工作流已包含 Install Linux system dependencies 步骤）
> **Linux updater 产物** `.AppImage.tar.gz` 仅在 `createUpdaterArtifacts: "v1Compatible"` 模式下产生（本项目已配置）

### 签名说明

- CI 自动用 `TAURI_SIGNING_PRIVATE_KEY` 签名
- `.sig` 文件包含在产物中，无需本地签名
- Claude 读取 `.sig` 直接注入 `update.json`

---

## 密钥管理

### 当前配置

- 私钥：`src-tauri/keys/tauri-updater.key`（已 gitignore）
- 公钥：`src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`
- GitHub Secrets：`TAURI_SIGNING_PRIVATE_KEY` 已配置

### 重新生成密钥（仅在泄露时）

```bash
pnpm tauri signer generate -w src-tauri/keys/tauri-updater.key
# 密码提示时直接按两次回车（空密码）
```

重新生成后必须：
1. 更新 `tauri.conf.json` 的 `pubkey`（从 `.key.pub` 读）
2. 更新 GitHub Secrets 的 `TAURI_SIGNING_PRIVATE_KEY`（从 `.key` 读）
3. 重新构建发布新版本（旧签名对新公钥无效，但已安装用户仍能升级）

### 安全提醒

- 私钥绝不能进公开仓库，`src-tauri/keys/` 已 gitignore
- R2 credentials 在 `~/.config/rclone/rclone.conf`，不要放入项目

---

## Cloudflare R2 CDN 配置

### 当前配置

| 项 | 值 |
|----|-----|
| Bucket | `downloads`（APAC 区域） |
| 公开地址 | `https://pub-9d9e6c0cb6934fb0a0c505e3c64f39b2.r2.dev` |
| 目录结构 | `downloads/knowledge-base/vX.Y.Z/` + `downloads/knowledge-base/update.json` |
| rclone remote | `r2:downloads/` |

### R2 目录规划（Bucket 共享）

```
downloads/                              ← Bucket 根（与 aicoder 共享）
├── aicoder/                            ← 智码 AICoder（其他项目）
└── knowledge-base/                     ← 本项目
    ├── vX.Y.Z/                        ← 版本产物
    │   ├── Knowledge.Base_X.Y.Z_x64-setup.exe
    │   ├── ...
    └── update.json                    ← Tauri 自动更新端点
```

### R2 成本（永久免费额度内）

| 项目 | 免费额度 | 实际用量 |
|------|---------|---------|
| 存储 | 10 GB/月 | ~300MB（20 版本） |
| 出站流量 | **无限免费** | — |

---

## 常见问题排查

### 应用内更新问题

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| 应用检查不到更新 | update.json 版本号 ≤ 当前版本 | 确保 update.json 的 version 严格大于已安装版本 |
| R2 下载失败 | R2.dev 域名偶尔被墙 | Tauri updater 自动 fallback 到 GitHub raw 备源 |
| GitHub raw 下载慢 | 国内访问慢 | R2 为主源已解决此问题 |
| 签名验证失败 | 公钥/私钥不匹配 | 确保 `tauri.conf.json` 的 pubkey 与 CI 签名私钥配对 |
| 签名验证失败 | update.json 签名与 .sig 不一致 | **禁止手动粘贴签名**，用脚本从 .sig 文件读取 |

### Git 推送问题

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| Release 仓库 push rejected（fetch first） | 上版本已推，本地落后 | **先 `git pull --rebase origin main` 再 push** |
| Release 仓库 push 超时（SSL_ERROR_SYSCALL） | 二进制产物大，网络不稳 | **不要重试**，提示用户手动 push，继续后续步骤 |
| 推到了 master | release 仓库分支是 main | **release 仓库用 `main`，源码仓库用 `master`** |

### CI 构建问题（踩坑总结，已修复）

| 问题 | 根因 | 解决方案 |
|------|------|---------|
| TS `noUnusedLocals` 致 CI 失败 | 未使用的 import | **打 tag 前本地 `npx tsc --noEmit`** |
| macOS `panic_unwind` 冲突 | `Cargo.toml [profile.release] panic = "abort"` 与 html2md 子依赖冲突 | **不要设 `panic = "abort"`** |
| macOS updater 产物缺失 | `--bundles dmg` 不产出 updater | **必须 `--bundles app,dmg`** |
| 文件名空格问题 | productName "Knowledge Base" 含空格 | CI 产物前缀变 `Knowledge.Base_`（空格→点）|
| 用户漏下 `.exe` | 浏览器只给 `.sig` | 清点 9 个文件都要齐全 |

---

## 附录：本地构建（仅在 CI 不可用时使用）

### Windows 环境变量设置注意事项

Claude Code 的 Bash 工具运行在 Git Bash (MSYS2)：
- ✅ `export VAR=value && command`（bash 语法）
- ❌ `set VAR=value && command`（CMD 语法，无效）
- ❌ `$env:VAR='value'; command`（PowerShell 语法，无效）

```bash
export TAURI_SIGNING_PRIVATE_KEY="<src-tauri/keys/tauri-updater.key 完整内容>" && \
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" && \
cd "E:/my/桌面软件tauri/knowledge_base" && \
pnpm tauri build 2>&1

# 构建超时 600000ms（10 分钟）；建议后台运行
# 成功标志：输出末尾 `Finished 1 updater signature at:`
```
