---
name: tauri-updater
description: |
  Tauri 应用自动更新技能,使用 tauri-plugin-updater 实现版本更新。

  触发场景:
  - 需要实现应用自动更新
  - 需要配置更新服务器
  - 需要处理更新 UI 和流程
  - 需要管理更新签名和安全

  触发词: 更新、update、自动更新、版本更新、升级、updater、OTA
---

# Tauri 应用自动更新

## 安装

```toml
# Cargo.toml
tauri-plugin-updater = "2"
```

```bash
pnpm add @tauri-apps/plugin-updater
```

## 注册

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_updater::Builder::new().build())
```

## Capabilities

```json
{ "permissions": ["updater:default"] }
```

---

## 更新端点配置

### tauri.conf.json

```json
{
  "plugins": {
    "updater": {
      "endpoints": [
        "https://releases.myapp.com/update.json"
      ],
      "pubkey": "YOUR_PUBLIC_KEY_HERE"
    }
  },
  "bundle": {
    "createUpdaterArtifacts": true
  }
}
```

> **注意**: `createUpdaterArtifacts: true` 让构建自动生成 `.sig` 签名文件和更新用的 `.zip` 包。

### 端点 URL 模式

| 模式 | 示例 | 说明 |
|------|------|------|
| **静态 JSON 文件** | `https://cdn.example.com/update.json` | 最简单，适合静态托管 |
| **动态端点** | `https://api.example.com/{{target}}/{{arch}}/{{current_version}}` | 服务端可按条件返回 |
| **GitHub Pages** | `https://username.github.io/releases/update.json` | 免费托管 |

### 更新服务器响应格式（update.json）

完整示例，包含所有平台：

```json
{
  "version": "1.1.0",
  "notes": "修复了若干问题,提升了性能",
  "pub_date": "2026-03-05T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "url": "https://github.com/user/repo/releases/download/v1.1.0/MyApp_1.1.0_x64-setup.nsis.zip",
      "signature": "CONTENT_OF_.sig_FILE"
    },
    "darwin-aarch64": {
      "url": "https://github.com/user/repo/releases/download/v1.1.0/MyApp.app.tar.gz",
      "signature": "CONTENT_OF_.sig_FILE"
    },
    "darwin-x86_64": {
      "url": "https://github.com/user/repo/releases/download/v1.1.0/MyApp.app.tar.gz",
      "signature": "CONTENT_OF_.sig_FILE"
    },
    "linux-x86_64": {
      "url": "https://github.com/user/repo/releases/download/v1.1.0/MyApp_1.1.0_amd64.AppImage.tar.gz",
      "signature": "CONTENT_OF_.sig_FILE"
    }
  }
}
```

> **signature 值**: 构建产物的 `.sig` 文件内容（Base64 字符串），不是文件路径。

### 平台选择指导

| 平台 | 构建产物 | 包大小参考 | 建议 |
|------|---------|-----------|------|
| **Windows x86_64** | `.nsis.zip` | ~10-30MB | 推荐，覆盖最大用户群 |
| **macOS aarch64** (Apple Silicon) | `.app.tar.gz` + `.dmg` | ~10-20MB | 推荐，新 Mac 必需 |
| **macOS x86_64** (Intel) | `.app.tar.gz` + `.dmg` | ~10-20MB | 推荐，兼容旧 Mac |
| **Linux x86_64** | `.AppImage.tar.gz` + `.deb` | ~60-80MB | 可选，体积较大 |

> **决策建议**: 小团队可先只支持 Windows + macOS，Linux 用户量少且 AppImage 体积大。在 update.json 的 `platforms` 中只包含你实际构建的平台即可。

---

## 前端更新检查

```typescript
import { check } from "@tauri-apps/plugin-updater";

async function checkForUpdate() {
  const update = await check();

  if (update) {
    console.log(`发现新版本: ${update.version}`);
    console.log(`更新说明: ${update.body}`);

    // 下载并安装
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          console.log(`开始下载,总大小: ${event.data.contentLength}`);
          break;
        case "Progress":
          console.log(`下载中: ${event.data.chunkLength} bytes`);
          break;
        case "Finished":
          console.log("下载完成");
          break;
      }
    });

    // 安装完成后需要重启
    // await relaunch();
  } else {
    console.log("已是最新版本");
  }
}
```

---

## 生成签名密钥

```bash
# 生成更新签名密钥对
pnpm tauri signer generate -w ~/.tauri/myapp.key

# 输出:
# 私钥: ~/.tauri/myapp.key
# 公钥: 显示在终端(复制到 tauri.conf.json 的 pubkey)
```

### 环境变量

```bash
# 构建时设置签名密钥
TAURI_SIGNING_PRIVATE_KEY=~/.tauri/myapp.key pnpm tauri build
```

---

## GitHub Actions CI 构建模板

CI 负责构建、签名并上传到 GitHub Release。根据需要调整构建矩阵。

### 完整模板（Windows + macOS 双架构）

```yaml
# .github/workflows/release.yml
name: Release
on:
  push:
    tags: ['v*.*.*']

jobs:
  release:
    strategy:
      fail-fast: false
      matrix:
        include:
          # Windows
          - platform: windows-latest
            args: '--bundles nsis'
          # macOS Apple Silicon
          - platform: macos-latest
            args: '--bundles app,dmg'
            target: aarch64-apple-darwin
          # macOS Intel
          - platform: macos-latest
            args: '--bundles app,dmg'
            target: x86_64-apple-darwin
          # Linux（可选，取消注释启用）
          # - platform: ubuntu-22.04
          #   args: '--bundles appimage,deb'
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: lts/*
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}
      - run: pnpm install
      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: 'MyApp ${{ github.ref_name }}'
          releaseDraft: true
          args: ${{ matrix.args }}
```

### CI 所需 Secrets

| Secret | 说明 |
|--------|------|
| `GITHUB_TOKEN` | 自动提供，无需配置 |
| `TAURI_SIGNING_PRIVATE_KEY` | 更新签名私钥内容 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码（无密码则设为空字符串） |

### 发布流程

1. 更新 `tauri.conf.json` 和 `package.json` 中的版本号
2. 提交并打 Tag: `git tag v1.1.0 && git push --tags`
3. CI 自动构建并上传到 GitHub Release（草稿）
4. 从 Release 下载产物，读取 `.sig` 文件内容填入 `update.json`
5. 将 `update.json` 推送到更新端点（静态文件托管）

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 不签名更新包 | 必须使用签名确保安全 |
| 私钥提交到仓库 | 私钥只放在 CI 密钥或本地 |
| 更新后不提示重启 | 提示用户重启以应用更新 |
| 不处理下载失败 | catch 错误并允许重试 |
| 不做灰度发布 | 先小范围测试再全量推送 |
