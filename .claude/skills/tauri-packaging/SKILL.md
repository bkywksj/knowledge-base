---
name: tauri-packaging
description: |
  Tauri 打包与分发技能,指导桌面端（Windows/macOS/Linux）与移动端（Android/iOS）的构建、签名和分发。

  触发场景:
  - 需要构建生产安装包（exe/dmg/deb/apk/aab/ipa）
  - 需要配置各平台打包参数
  - 需要代码签名（Windows 证书 / Android keystore / iOS 描述文件）
  - 需要减小安装包体积
  - 需要设置应用图标和元数据
  - 需要打包 Android / iOS App

  触发词: 打包、构建、build、发布、安装包、exe、dmg、deb、apk、aab、ipa、签名、分发、release、android build、ios build、移动端打包
---

# Tauri 打包与分发

> **本项目同时支持桌面端 + 移动端**：桌面三平台靠 `pnpm tauri build`，Android 靠 `pnpm tauri android build`，iOS 靠 `pnpm tauri ios build`（需 macOS）。
> 移动端踩坑较多，单独看下方「移动端打包」章节。

## 桌面端构建命令

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

## 桌面端输出位置

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

## 🤖 移动端打包（Android）

### dev 模式 vs build 模式（先搞清楚这个）

| 模式 | 命令 | webview 加载来源 | 是否依赖电脑 | 用途 |
|------|------|-----------------|------------|------|
| **dev** | `pnpm tauri android dev` | `http://<电脑IP>:1421`（vite live server） | ✅ 必须连电脑（同 Wi-Fi 或 adb reverse），hot reload | 日常开发 |
| **build** | `pnpm tauri android build` | `tauri://localhost`（APK 内打包好的静态资源） | ❌ 完全独立，断 USB / 关电脑都能用 | 测试 / 发布 |

> 关键：发布版（build 模式）APK 把 `frontendDist`（`dist/`）和 `libknowledge_base_lib.so` 都打进 APK，invoke 走 webview↔JNI 桥，**不走任何网络**。dev 模式那个 `http://192.168.x.x:1421` 连不上的错误只在 dev 模式有。

### 构建命令

```bash
# debug APK（含 debuginfo，体积大 ~300MB+，可直接 adb install）
pnpm tauri android build --debug --apk
# release APK（LTO + strip，体积小 ~50-100MB，需签名才能上架）
pnpm tauri android build --apk
# AAB（Google Play 上架格式）
pnpm tauri android build --aab
# 只构建某个 ABI（加快编译，去掉 universal 多 ABI）
pnpm tauri android build --debug --apk --target aarch64
```

### 🔴 项目路径含中文 → 必须设 CARGO_TARGET_DIR

本项目路径 `E:\my\桌面软件tauri\knowledge_base` 含中文，Android NDK 的 `ld.lld` 在 Windows 下用 ANSI codepage 解析路径，遇到中文会报：

```
ld.lld: error: cannot open ...knowledge_base_lib.*.rcgu.o : unspecified system_category error
```

**所有 `tauri android` 命令必须带 `CARGO_TARGET_DIR` 指到纯 ASCII 路径**（用 inline `env VAR=val`，不要 `export`，否则 background wrapper 会吞掉）：

```bash
mkdir -p /c/cargo-target/kb-android
env CARGO_TARGET_DIR="C:\\cargo-target\\kb-android" pnpm tauri android build --debug --apk
```

> `subst K:` / `mklink /J` 都不行 —— tauri-cli 的 mobile 模块会 `canonicalize` 还原虚拟盘符，触发 `AssetDirOutsideOfAppRoot`。只能改 cargo 编译输出目录。详见 `bug-detective` 技能。

### APK / AAB 输出位置

```
src-tauri/gen/android/app/build/outputs/
├── apk/
│   ├── universal/debug/app-universal-debug.apk   ← 4 ABI 合一（体积最大）
│   ├── arm64/debug/app-arm64-debug.apk           ← 只 arm64（现代手机用这个）
│   ├── universal/release/app-universal-release.apk
│   └── ...
└── bundle/
    └── universalRelease/app-universal-release.aab ← 传 Google Play
```

装机：`adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`

### Android 签名（release 上架前必做）

debug APK 用 Android SDK 自带的 debug keystore 自动签名，**装机可以但不能上架**。release 需要自己的 keystore：

```bash
# 1. 生成 keystore（一次性，妥善保管，丢了无法更新已上架应用）
keytool -genkey -v -keystore kb-release.jks -keyalg RSA -keysize 2048 \
  -validity 10000 -alias kb

# 2. 在 src-tauri/gen/android/ 下建 key.properties（已 .gitignore，不要提交）
cat > src-tauri/gen/android/key.properties <<'EOF'
storeFile=../../kb-release.jks
storePassword=<store密码>
keyAlias=kb
keyPassword=<key密码>
EOF
```

`src-tauri/gen/android/app/build.gradle.kts` 里 tauri 已生成 `signingConfigs` 读取 `key.properties` 的模板（如果没有，参考 Tauri 文档手动加 `release { signingConfig = signingConfigs.getByName("release") }`）。然后 `pnpm tauri android build --aab` 即生成已签名 AAB。

### AndroidManifest 权限（与 capabilities 是两套）

`src-tauri/gen/android/app/src/main/AndroidManifest.xml` 里的 `<uses-permission>` 是 **Android 系统层权限**，跟 `src-tauri/capabilities/*.json` 的 Tauri 权限是两回事，**两边都要声明**：

| 功能 | AndroidManifest `<uses-permission>` | 备注 |
|------|-------------------------------------|------|
| 联网（dev server / WebDAV / AI API） | `android.permission.INTERNET` | tauri 默认已有 |
| 扫码（WebView getUserMedia 调摄像头） | `android.permission.CAMERA` | 不声明则 `onPermissionRequest` 里申请运行时权限被系统直接拒，弹 `NotAllowedError` |
| 语音录入（getUserMedia 录音） | `android.permission.RECORD_AUDIO` + `MODIFY_AUDIO_SETTINGS` | 同上 |

> ⚠️ `pnpm tauri android init` 会覆盖 `gen/android/` 下大部分文件，**手改的 AndroidManifest / strings.xml / 图标会丢**，改完要么不再 init，要么记下手改内容重新打。

### 图标 / 应用名同步（不会自动跟 PC 同步）

- PC 端图标源：`src-tauri/icons/`（`icon.png` 512×512 + `tauri icon` 生成的全套）
- Android 用：`src-tauri/gen/android/app/src/main/res/mipmap-*/` —— **`tauri android init` 时从 `src-tauri/icons/android/` 拷一份，之后不会自动跟 PC 同步**
- 改图标：把整个 `src-tauri/icons/android/`（含 `mipmap-*` 和 `values/ic_launcher_background.xml`，**别漏 values 子目录**否则 Gradle 报 `resource color/ic_launcher_background not found`）拷到 `gen/android/.../res/`
- 应用名：`src-tauri/gen/android/app/src/main/res/values/strings.xml` 的 `app_name` / `main_activity_title`（默认是 `productName`，本项目手改为「知识库」）

### 软键盘 / viewport

- `AndroidManifest.xml` activity 需 `android:windowSoftInputMode="adjustResize"`，否则配合 `enableEdgeToEdge()` 时 input 获得焦点也不弹键盘
- `index.html` viewport 建议 `width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover`

---

## 🍎 移动端打包（iOS，需 macOS）

```bash
pnpm tauri ios init        # 一次性，生成 src-tauri/gen/apple/
pnpm tauri ios dev         # 模拟器 / 真机 dev
pnpm tauri ios build       # 生成 .ipa（需 Apple Developer Program 账号 + 描述文件）
```

- 签名走 Xcode 的 Signing & Capabilities（Team + Provisioning Profile），不像 Android 用 keystore
- 上架走 TestFlight / App Store Connect
- 本项目 iOS 链路尚未跑通（无 Mac 设备），相关任务见 `docs/tasks/mobile-migration-tasks.md` T-M005/T-M016/T-M018

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

- **桌面三平台**：已配置 GitHub Actions CI（`.github/workflows/release.yml`），推送 `v*.*.*` Tag 后自动构建 Windows/macOS/Linux 安装包。用 `/release` 命令一键发布，详见 `release-publish` 技能。
- **Android debug APK**：已配置 `.github/workflows/android.yml`（T-M020 一期），CI 出 debug APK；release 签名 APK / AAB 的 CI 尚未接（T-M020 二期）。
- **iOS**：CI 尚未接（需 Apple Developer 账号 + macOS runner，T-M020 待办）。

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
| **Android：项目路径含中文直接 `tauri android build`** | 必须 `env CARGO_TARGET_DIR="C:\\cargo-target\\<name>-android"` 前缀（NDK ld.lld 不认非 ASCII 路径） |
| **以为发布 APK 还要连电脑** | `tauri android build` 出的 APK 是独立的（`tauri://localhost` 读 APK 内资源），只有 `tauri android dev` 模式才连 dev server |
| **手改 `gen/android/` 后又跑 `tauri android init`** | init 会覆盖 AndroidManifest / strings.xml / 图标，手改的全丢；改完别再 init，或记下手改内容重新打 |
| **Android 权限只在 capabilities 里声明** | AndroidManifest `<uses-permission>` 和 Tauri capabilities 是两套，摄像头/录音/联网两边都要声明 |
| **同步 Android 图标只拷 `mipmap-*`** | 必须连 `values/ic_launcher_background.xml` 一起拷，否则 Gradle 报 `resource color/ic_launcher_background not found` |
| **release APK 用 debug keystore** | 上架前必须用自己的 keystore（`key.properties` + `signingConfigs`），debug 签名不能上架且 keystore 丢了无法更新已上架应用 |
| **input 获焦不弹键盘（Android）** | activity 加 `android:windowSoftInputMode="adjustResize"` |
