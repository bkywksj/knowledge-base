# 应用图标源文件（L08「K · 书页负形」）

与应用内 Logo `src/components/ui/BrandLogo.tsx` 同一图形。改图标只改这里的 SVG，再按下面重新生成。

| 文件 | 用途 |
|---|---|
| `app-icon.svg` | 桌面（Windows / macOS / Linux）：圆角方块，四周留约 3% 边距 |
| `mobile-full.svg` | iOS（系统自己切圆角）+ Android 旧版启动器：满版无圆角 |
| `android-fg.svg` / `android-bg.svg` | Android 自适应图标前景（书页 + K，透明底）/ 背景（渐变铺满） |
| `mobile-manifest.json` | 移动端生成清单 |
| `legacy_launcher.py` | 重切 Android 旧版启动器图标（生成器裁出来的书页过大） |

## 重新生成

`tauri icon` 会同时写桌面和移动端全部文件，所以两套分别生成到临时目录再挑着拷：

```bash
# 桌面：只拷根目录的 png / ico / icns 到 src-tauri/icons/
pnpm tauri icon src-tauri/icons/source/app-icon.svg -o "$TEMP/kb-icon/desktop"

# 移动端：生成 → 重切旧版启动器 → ios/* 拷到 src-tauri/icons/ios/，
# android/mipmap-* 同时拷到 src-tauri/icons/android/ 和 src-tauri/gen/android/app/src/main/res/
pnpm tauri icon src-tauri/icons/source/mobile-manifest.json -o "$TEMP/kb-icon/mobile"
python src-tauri/icons/source/legacy_launcher.py "$TEMP/kb-icon/mobile"
```

`public/app-icon.png`（移动端「我的」页）= 桌面 `icon.png` 缩到 256。

## ⚠️ 换完图标本地编译前先 `touch src-tauri/build.rs`

图标是 tauri-build 在构建脚本里写进 Windows 资源的，它只在配置变化时重跑；
只换图标文件、增量编译出来的 exe 仍是旧图标（本地 evsign 签名包同样中招）。CI 是全新编译，不受影响。
