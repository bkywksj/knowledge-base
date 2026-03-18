---
name: tauri-packaging
description: |
  Tauri 打包与分发技能,指导跨平台安装包构建、签名和分发。

  触发场景:
  - 需要构建生产安装包
  - 需要配置各平台打包参数
  - 需要代码签名
  - 需要减小安装包体积
  - 需要设置应用图标和元数据

  触发词: 打包、构建、build、发布、安装包、exe、dmg、deb、签名、分发、release
---

# Tauri 打包与分发

## 构建命令

```bash
# 构建所有平台安装包
pnpm tauri build

# 仅构建特定格式
pnpm tauri build --bundles msi    # Windows MSI
pnpm tauri build --bundles nsis   # Windows NSIS
pnpm tauri build --bundles dmg    # macOS DMG
pnpm tauri build --bundles deb    # Linux DEB
pnpm tauri build --bundles appimage # Linux AppImage

# Debug 构建(包含 DevTools)
pnpm tauri build --debug
```

---

## 打包配置 (tauri.conf.json)

### 基础配置

```json
{
  "productName": "MyApp",
  "version": "1.0.0",
  "identifier": "com.company.myapp",
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "resources": [],
    "copyright": "Copyright (c) 2026 Company",
    "category": "Productivity",
    "shortDescription": "我的桌面应用",
    "longDescription": "一个使用 Tauri 构建的跨平台桌面应用"
  }
}
```

### Windows 配置

```json
{
  "bundle": {
    "windows": {
      "certificateThumbprint": null,
      "digestAlgorithm": "sha256",
      "timestampUrl": "",
      "wix": null,
      "nsis": {
        "displayLanguageSelector": true,
        "languages": ["SimpChinese", "English"],
        "installerIcon": "icons/icon.ico"
      }
    }
  }
}
```

### macOS 配置

```json
{
  "bundle": {
    "macOS": {
      "entitlements": null,
      "frameworks": [],
      "minimumSystemVersion": "10.15",
      "signingIdentity": null
    }
  }
}
```

### Linux 配置

```json
{
  "bundle": {
    "linux": {
      "deb": {
        "depends": ["libwebkit2gtk-4.0-37"],
        "section": "utility"
      },
      "appimage": {
        "bundleMediaFramework": false
      }
    }
  }
}
```

---

## 图标生成

```bash
# 从 1024x1024 PNG 生成所有平台图标
pnpm tauri icon path/to/icon-1024x1024.png
```

需要准备的图标:
| 文件 | 尺寸 | 平台 |
|------|------|------|
| `icon.ico` | 多尺寸合一 | Windows |
| `icon.icns` | 多尺寸合一 | macOS |
| `32x32.png` | 32x32 | 通用 |
| `128x128.png` | 128x128 | 通用 |
| `128x128@2x.png` | 256x256 | HiDPI |

---

## 体积优化

```toml
# src-tauri/Cargo.toml
[profile.release]
opt-level = "z"       # 最小体积
lto = true            # 链接时优化
codegen-units = 1     # 单代码生成单元
strip = true          # 剥离调试信息
panic = "abort"       # abort 而非 unwind
```

### 典型打包体积

| 平台 | 基础模板 | 中等应用 |
|------|---------|---------|
| Windows (.msi) | ~3 MB | ~5-10 MB |
| macOS (.dmg) | ~5 MB | ~8-15 MB |
| Linux (.deb) | ~4 MB | ~6-12 MB |

---

## 输出位置

```
src-tauri/target/release/bundle/
├── msi/        → .msi 安装包 (Windows)
├── nsis/       → .exe 安装程序 (Windows)
├── dmg/        → .dmg 磁盘映像 (macOS)
├── macos/      → .app 应用包 (macOS)
├── deb/        → .deb 包 (Debian/Ubuntu)
└── appimage/   → .AppImage (通用 Linux)
```

---

## 版本管理

版本号需在 3 处同步:

```bash
# 1. package.json
"version": "1.0.0"

# 2. src-tauri/Cargo.toml
version = "1.0.0"

# 3. src-tauri/tauri.conf.json
"version": "1.0.0"
```

---

## CI 自动构建（推荐）

项目已配置 GitHub Actions CI（`.github/workflows/release.yml`），推送 `v*.*.*` Tag 后自动构建三平台安装包。

使用 `/release` 命令可自动完成全部发布流程，详见 `release-publish` 技能。

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 不配置 release profile | 添加 LTO + strip 优化体积 |
| 图标尺寸不全 | 使用 `tauri icon` 命令自动生成 |
| 版本号不同步 | 3 处版本号保持一致 |
| 不测试安装包 | 每次发布前在干净环境安装测试 |
| 不设置应用标识 | identifier 使用反向域名格式 |
| Rust 中启动子进程未设 `CREATE_NO_WINDOW` | 打包后变 GUI 进程，所有 `Command::new()` 必须设 `creation_flags(0x08000000)` |
| `productName` 含中文导致 WiX MSI 打包失败 | 改用 NSIS (`"targets": ["nsis"]`) 或改 productName 为纯 ASCII |
| `bundle.targets` 设为 `"all"` 在 CI 上出错 | CI 中通过 `--bundles` 参数指定，本地可用 `["nsis"]` |
