---
name: release-publish
description: |
  发布版本/发布更新/release/推送Gitee/签名构建/update.json/版本发布

  触发场景：
  - 需要发布新版本
  - 需要执行发布流程
  - 需要更新版本号并推送

  触发词：发布、release、版本发布、推送、打Tag、update.json、签名构建
---

# 发布更新

## 概述

Tauri 桌面应用采用 **CI 构建 + 本地推送** 模式：

```
本地：更新版本号 → 提交 → 打 Tag → 推送
  ↓ 触发
CI：构建安装包（按配置的平台） → 上传到 GitHub Release（草稿）
  ↓ CI 完成后
本地：从 GitHub Release 下载产物 → 复制到 release 仓库 → 生成 update.json → 推送到 Gitee/GitHub
```

> **本地不需要执行 `pnpm tauri build`**。CI 负责构建和签名。
> 构建完成后，用户手动从 GitHub Release 下载产物，Claude 负责本地处理和推送。

### 平台配置

发布流程支持按需选择构建平台，通过 `.claude/release-config.json` 的 `platforms` 字段配置：

| platforms 值 | CI 构建矩阵 | 产物数量 |
|-------------|------------|---------|
| `["windows", "macos"]` | Windows + macOS ARM + macOS Intel | 8 个 |
| `["windows", "macos", "linux"]` | 全平台 | 11 个 |
| `["windows"]` | 仅 Windows | 2 个 |
| `["macos"]` | 仅 macOS ARM + Intel | 6 个 |

> **首次发布时通过 `/release` 命令询问用户选择平台，记录后不再重复询问。**
> 去掉 Linux 可节省 CI 时间、减少产物体积（Linux AppImage 约 80MB）。

### 双仓库发布策略

由于 GitHub raw URL 在中国大陆不稳定，应用内自动更新使用 **Gitee** 作为更新端点：

| 用途 | 平台 | 原因 |
|------|------|------|
| **源码托管** | GitHub（私有） | 代码管理 + CI 构建 |
| **CI 构建** | GitHub Actions | 跨平台构建 + 签名 |
| **自动更新端点** | Gitee（公开） | 中国大陆可访问 |
| **安装包下载** | Gitee（公开） | 中国大陆可下载 |
| **备份存档** | GitHub（公开） | 海外用户 + 备份 |

### 为什么不让 CI 推送到 release 仓库？

GitHub Actions 在美国服务器运行，推送二进制产物到 Gitee（中国）经常超时（50 分钟+）。
因此改为用户本地下载产物后，由 Claude 在本地完成推送，速度更快且更可控。

---

## 首次发布前的准备工作

> **首次使用发布功能时，必须先完成以下配置。后续发布跳过此节。**

### 1. 创建 Release 仓库

需要创建两个 **公开** 仓库用于存放安装包和 update.json：

```bash
# Gitee（主更新端点，中国大陆可访问）
https://gitee.com/<用户名>/<项目名>-release

# GitHub（备份）
https://github.com/<用户名>/<项目名>-release
```

每个仓库需要一个 `README.md` 和 `update.json`（本地推送时自动生成 update.json）。

### 2. 生成签名密钥

```bash
# 在项目根目录生成更新签名密钥对
pnpm tauri signer generate -w src-tauri/keys/tauri-updater.key
# 密码提示时直接按两次回车（空密码）
```

生成后：
- 将 `.key.pub` 文件内容复制到 `tauri.conf.json` → `plugins.updater.pubkey`
- 将 `.key` 文件内容添加到 GitHub Secrets → `TAURI_SIGNING_PRIVATE_KEY`
- 确保 `src-tauri/keys/` 已加入 `.gitignore`

### 3. 配置 GitHub Secrets

在 **源码仓库**（私有）的 Settings → Secrets and variables → Actions 中添加：

| Secret 名称 | 值 | 说明 |
|-------------|-----|------|
| `TAURI_SIGNING_PRIVATE_KEY` | `src-tauri/keys/tauri-updater.key` 文件的完整内容 | 更新签名私钥 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 空字符串（留空即可） | 私钥密码（无密码） |

> **注意**：不再需要 `RELEASE_REPO_TOKEN`、`GITEE_USERNAME`、`GITEE_TOKEN`，
> 因为 CI 不再推送到 release 仓库，推送由本地完成。

### 4. 配置 tauri.conf.json

```json
{
  "plugins": {
    "updater": {
      "endpoints": ["https://gitee.com/<用户名>/<项目名>-release/raw/master/update.json"],
      "pubkey": "<公钥内容>"
    }
  },
  "bundle": {
    "targets": ["nsis"],
    "createUpdaterArtifacts": "v1Compatible"
  }
}
```

### 5. 添加 GitHub remote（如仅有 Gitee remote）

```bash
git remote add github https://github.com/<用户名>/<项目名>.git
```

### 6. 克隆 Release 仓库到本地

```bash
# 建议放在源码仓库的同级目录
git clone https://gitee.com/<用户名>/<项目名>-release.git   # Gitee
git clone https://github.com/<用户名>/<项目名>-release.git  # GitHub（另一个目录名）
```

### 7. 根据平台配置修改 CI workflow

根据 `.claude/release-config.json` 中的 `platforms` 配置，修改 `.github/workflows/release.yml` 的构建矩阵：

**Windows + macOS（推荐，不含 Linux）：**
```yaml
matrix:
  include:
    - platform: windows-latest
      args: '--bundles nsis'
    - platform: macos-latest
      args: '--bundles app,dmg'
      target: aarch64-apple-darwin
    - platform: macos-latest
      args: '--bundles app,dmg'
      target: x86_64-apple-darwin
```

**全平台（含 Linux）：**
```yaml
matrix:
  include:
    - platform: windows-latest
      args: '--bundles nsis'
    - platform: macos-latest
      args: '--bundles app,dmg'
      target: aarch64-apple-darwin
    - platform: macos-latest
      args: '--bundles app,dmg'
      target: x86_64-apple-darwin
    - platform: ubuntu-22.04
      args: '--bundles deb,appimage'
```

---

## 关键配置（用户须在首次发布时提供）

> **以下信息在首次发布时通过 `/release` 命令询问用户获取，后续自动记忆。**

| 配置项 | 说明 | 示例 |
|--------|------|------|
| **应用名称** | CI 产物前缀（productName） | `MyApp` |
| **支持平台** | 构建哪些平台 | `["windows", "macos"]` |
| **源码仓库 GitHub remote 名** | 推送源码用 | `github` 或 `origin` |
| **源码仓库 GitHub URL** | CI 所在仓库 | `https://github.com/user/my-app` |
| **Release 仓库（Gitee）URL** | 主更新端点 | `https://gitee.com/user/my-app-release` |
| **Release 仓库（GitHub）URL** | 备份 | `https://github.com/user/my-app-release` |
| **本地 Release 仓库（Gitee）路径** | 本地 clone 目录 | `../my-app-release-gitee` |
| **本地 Release 仓库（GitHub）路径** | 本地 clone 目录 | `../my-app-release` |
| **主分支名** | master 或 main | `master` |

---

## 版本号位置（三处必须同步）

| 文件 | 字段 |
|------|------|
| `src-tauri/tauri.conf.json` | `"version": "x.y.z"` |
| `src-tauri/Cargo.toml` | `version = "x.y.z"` |
| `package.json` | `"version": "x.y.z"` |

---

## 完整发布流程

### 步骤 1：询问版本号和更新说明

```
使用 AskUserQuestion 询问：
1. 新版本号？（当前版本读取自 tauri.conf.json）
2. 更新说明？（将写入 release 仓库 README.md 版本历史）
```

### 步骤 2：更新三处版本号

```bash
Edit src-tauri/tauri.conf.json   # "version": "新版本号"
Edit src-tauri/Cargo.toml        # version = "新版本号"
Edit package.json                # "version": "新版本号"
```

### 步骤 3：更新两个 release 仓库的 README.md

> **CI 产物文件名规则**：CI 构建的产物前缀为 `<productName>_`，
> 由 `tauri.conf.json` 的 `productName` 决定（空格会被替换为连字符或下划线）。
> README 中的下载链接和项目结构树必须使用 CI 实际产物文件名。
> **只包含 `platforms` 配置中的平台**。

```bash
VERSION="x.y.z"
GITEE_DIR="<本地 Gitee Release 仓库路径>"
GITHUB_DIR="<本地 GitHub Release 仓库路径>"

# 需要更新 3 处：
# 1. 最新版本下载表格（版本号 + 多平台链接，按 platforms 过滤）
# 2. 版本历史（添加新版本条目）
# 3. 项目结构树（添加新版本目录，按 platforms 过滤）

# 两个仓库的 README.md 内容一致，同步更新
Edit "$GITEE_DIR/README.md"
Edit "$GITHUB_DIR/README.md"
```

**下载表格模板**（根据 platforms 配置选择包含哪些行）：

```markdown
### 最新版本: vx.y.z

| 平台 | 下载链接 |
|------|---------|
| Windows x64 | [<AppName>_x.y.z_x64-setup.exe](releases/vx.y.z/<AppName>_x.y.z_x64-setup.exe) |          ← platforms 含 windows
| macOS Apple Silicon | [<AppName>_x.y.z_aarch64.dmg](releases/vx.y.z/<AppName>_x.y.z_aarch64.dmg) |  ← platforms 含 macos
| macOS Intel | [<AppName>_x.y.z_x64.dmg](releases/vx.y.z/<AppName>_x.y.z_x64.dmg) |                  ← platforms 含 macos
| Linux x64 (AppImage) | [<AppName>_x.y.z_amd64.AppImage](releases/vx.y.z/<AppName>_x.y.z_amd64.AppImage) | ← platforms 含 linux
| Linux x64 (deb) | [<AppName>_x.y.z_amd64.deb](releases/vx.y.z/<AppName>_x.y.z_amd64.deb) |          ← platforms 含 linux
```

### 步骤 4：提交并推送 release 仓库 README 变更

> **推送前必须先拉取**：上一版本可能已推送产物到远程，本地可能落后。

```bash
# === Gitee release 仓库 ===
cd "$GITEE_DIR"
git add README.md
git commit -m "docs: 更新 README 至 v$VERSION

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
git pull --rebase origin master
git push origin master

# === GitHub release 仓库 ===
cd "$GITHUB_DIR"
git add README.md
git commit -m "docs: 更新 README 至 v$VERSION

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
git pull --rebase origin master
git push origin master
```

### 步骤 5：提交源码仓库并打 Tag 触发 CI

```bash
cd "<源码仓库路径>"

# 提交版本号更新 + 其他变更
git add src-tauri/tauri.conf.json src-tauri/Cargo.toml package.json
git commit -m "release: v$VERSION

<更新说明摘要>

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"

# 推送到 GitHub（remote 名根据用户配置）
git push <github_remote> <主分支名>

# 打 Tag 并推送（触发 GitHub Actions CI）
git tag "v$VERSION"
git push <github_remote> "v$VERSION"
```

### 步骤 6：等待 CI 构建完成

根据 `platforms` 配置输出对应平台的文件清单。

**各平台对应的 CI 产物**：

| 平台 | 产物数量 | 文件列表 |
|------|---------|---------|
| Windows | 2 个 | `.exe` + `.exe.sig` |
| macOS ARM | 3 个 | `_aarch64.dmg` + `_aarch64.app.tar.gz` + `_aarch64.app.tar.gz.sig` |
| macOS Intel | 3 个 | `_x64.dmg` + `_x64.app.tar.gz` + `_x64.app.tar.gz.sig` |
| Linux | 3 个 | `.AppImage` + `.AppImage.sig` + `.deb` |

使用 AskUserQuestion 询问：**文件下载到了哪个目录？**

### 步骤 7：处理下载的产物（Claude 自动执行）

用户提供下载目录后，Claude 自动执行以下操作：

```bash
VERSION="x.y.z"
DOWNLOAD_DIR="<用户提供的下载目录>"
GITEE_DIR="<本地 Gitee Release 仓库路径>"
GITHUB_DIR="<本地 GitHub Release 仓库路径>"

# 1. 复制所有产物到两个 release 仓库
for DIR in "$GITEE_DIR" "$GITHUB_DIR"; do
  mkdir -p "$DIR/releases/v$VERSION"
  # 按 platforms 配置复制对应文件
  cp "$DOWNLOAD_DIR"/*.exe "$DIR/releases/v$VERSION/" 2>/dev/null         # windows
  cp "$DOWNLOAD_DIR"/*.exe.sig "$DIR/releases/v$VERSION/" 2>/dev/null     # windows
  cp "$DOWNLOAD_DIR"/*.dmg "$DIR/releases/v$VERSION/" 2>/dev/null         # macos
  cp "$DOWNLOAD_DIR"/*.app.tar.gz "$DIR/releases/v$VERSION/" 2>/dev/null  # macos
  cp "$DOWNLOAD_DIR"/*.app.tar.gz.sig "$DIR/releases/v$VERSION/" 2>/dev/null # macos
  cp "$DOWNLOAD_DIR"/*.AppImage "$DIR/releases/v$VERSION/" 2>/dev/null    # linux
  cp "$DOWNLOAD_DIR"/*.AppImage.sig "$DIR/releases/v$VERSION/" 2>/dev/null # linux
  cp "$DOWNLOAD_DIR"/*.deb "$DIR/releases/v$VERSION/" 2>/dev/null         # linux
done

# 2. 读取签名文件，生成 update.json（仅包含已配置平台）
```

**update.json 模板**（根据 platforms 配置选择包含哪些平台）：

```json
{
  "version": "x.y.z",
  "notes": "Release vx.y.z",
  "pub_date": "2026-03-10T12:00:00Z",
  "platforms": {
    "windows-x86_64": { ... },      // ← platforms 含 windows
    "darwin-aarch64": { ... },       // ← platforms 含 macos
    "darwin-x86_64": { ... },        // ← platforms 含 macos
    "linux-x86_64": { ... }          // ← platforms 含 linux
  }
}
```

> **注意**：Gitee 版和 GitHub 版 update.json 只有 URL 中的 `<BASE>` 不同。
> - Gitee: `https://gitee.com/<用户名>/<项目名>-release/raw/master/releases/vx.y.z`
> - GitHub: `https://github.com/<用户名>/<项目名>-release/raw/master/releases/vx.y.z`

### 步骤 8：推送 release 仓库（产物 + update.json）

```bash
# === Gitee release 仓库 ===
cd "$GITEE_DIR"
git add -A
git commit -m "release: v$VERSION

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
git pull --rebase origin master
git push origin master

# === GitHub release 仓库 ===
cd "$GITHUB_DIR"
git add -A
git commit -m "release: v$VERSION

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
git pull --rebase origin master
git push origin master
```

### 步骤 9：完成报告

```markdown
## 发布完成

| 项目 | 值 |
|------|-----|
| 版本 | vx.y.z |
| 支持平台 | <从 platforms 配置读取> |
| 源码仓库 | 已推送到 <GitHub URL> |
| CI 构建 | 已完成，产物已上传到 GitHub Release |
| Release 仓库（Gitee） | 产物 + update.json 已推送 |
| Release 仓库（GitHub） | 产物 + update.json 已推送 |
| 应用内自动更新 | Gitee 端点已生效 |
```

---

## CI 构建流程

### 概述

通过 GitHub Actions 在云端自动构建安装包并签名，无需本地构建。
CI **只负责构建和上传到 GitHub Release**，不负责推送到 release 仓库。
构建矩阵由 `platforms` 配置决定。

### 工作流文件

`.github/workflows/release.yml`

### 触发方式

推送 `v*.*.*` 格式的 Git Tag 时自动触发：

```bash
git tag v0.2.0
git push <github_remote> v0.2.0
```

### 构建矩阵（按 platforms 配置）

| 平台 | Runner | Bundle 参数 | Updater 产物 | 安装包产物 | platforms 值 |
|------|--------|-------------|-------------|-----------|-------------|
| Windows | `windows-latest` | `--bundles nsis` | `.exe` + `.exe.sig` | `.exe` (NSIS) | `windows` |
| macOS (ARM) | `macos-latest` | `--bundles app,dmg` | `.app.tar.gz` + `.sig` | `.dmg` (aarch64) | `macos` |
| macOS (Intel) | `macos-latest` | `--bundles app,dmg` | `.app.tar.gz` + `.sig` | `.dmg` (x86_64) | `macos` |
| Linux | `ubuntu-22.04` | `--bundles deb,appimage` | `.AppImage` + `.sig` | `.deb` + `.AppImage` | `linux` |

> **macOS 必须包含 `app` bundle**
> - `dmg` 只生成安装用的 DMG 镜像，**不生成 updater 产物**
> - `app` 生成 `.app` 应用包，Tauri 会自动打包为 `.app.tar.gz` 并签名
> - 正确写法：`--bundles app,dmg`（先 app 再 dmg）

### 签名说明

- CI 构建时自动使用 `TAURI_SIGNING_PRIVATE_KEY` 进行签名
- **签名文件（`.sig`）已包含在 CI 产物中**，用户只需下载即可
- 用户不需要在本地做任何签名操作
- Claude 读取 `.sig` 文件内容来生成 `update.json`

---

## 密钥管理

### 重新生成密钥（需手动执行）

```bash
pnpm tauri signer generate -w src-tauri/keys/tauri-updater.key
# 密码提示时直接按两次回车（空密码）
```

**重新生成后必须：**
1. 更新 `tauri.conf.json` 中的 `pubkey`（读取 `.key.pub` 文件内容）
2. 更新 GitHub Secrets 中的 `TAURI_SIGNING_PRIVATE_KEY`（读取 `.key` 文件内容）
3. 重新构建并发布（旧版本的签名将不可用，但不影响已安装用户）

### 安全提醒

- **私钥 (`tauri-updater.key`) 绝不能提交到公开仓库**
- `src-tauri/keys/` 应加入主项目的 `.gitignore`

---

## 常见问题排查

### 应用内更新问题

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| 应用检查不到更新 | release 仓库是私有的 | 将仓库设为公开，否则 raw 地址需认证 |
| 应用检查不到更新 | update.json 中版本号 <= 当前版本 | 确保 update.json 的 version 大于已安装版本 |
| 签名验证失败 | 公钥不匹配 | 确保 `tauri.conf.json` 中的 pubkey 与签名使用的私钥配对 |

### Git 推送问题

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| Release 仓库 push rejected | 上一版本已推送产物到远程，本地落后 | **先 `git pull --rebase origin master` 再 push** |

### CI 构建问题（踩坑总结）

| 问题 | 根因 | 解决方案 |
|------|------|---------|
| macOS updater 产物缺失 | `--bundles dmg` 不生成 updater 产物 | **必须用 `--bundles app,dmg`** |
| Linux 编译 unused import 警告 | `#[cfg(target_os = "windows")]` 下的 import 在 Linux 不使用 | 将 import 也放在 `#[cfg()]` 块内 |
| CI 推送 Gitee 超时 | GitHub Actions（美国）推送到 Gitee（中国）太慢 | **已改为本地推送**，不再由 CI 推送 |

---

## 附录：本地构建（仅在 CI 不可用时使用）

> 正常发布流程使用 CI，以下仅作为 CI 不可用时的备用方案。

### Windows 本地签名构建

> **Windows 环境变量设置注意事项**
>
> Claude Code 的 Bash 工具运行在 Git Bash (MSYS2) 环境中。
> - **正确**：`export VAR=value && command`（bash export 语法）
> - **失败**：`set VAR=value && command`（CMD 语法在 bash 中无效）
> - **失败**：`$env:VAR='value'; command`（PowerShell 语法）

```bash
# 读取私钥并构建（单条 Bash 调用）
export TAURI_SIGNING_PRIVATE_KEY="<src-tauri/keys/tauri-updater.key 文件完整内容>" && \
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" && \
pnpm tauri build 2>&1

# 构建超时设置：600000ms（10分钟）
# 建议后台运行：run_in_background: true
# 构建成功标志：输出末尾出现 `Finished 1 updater signature at:`
```
