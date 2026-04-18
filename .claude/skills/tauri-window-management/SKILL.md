---
name: tauri-window-management
description: |
  Tauri 窗口管理技能，覆盖多窗口、无边框窗口、系统托盘等桌面应用窗口功能。

  触发场景：
  - 需要创建多窗口应用
  - 需要自定义窗口标题栏
  - 需要实现无边框窗口
  - 需要使用系统托盘
  - 需要控制窗口大小/位置

  触发词：窗口、window、多窗口、无边框、标题栏、托盘、tray、最小化、最大化
---

# Tauri 窗口管理

## 窗口配置

### tauri.conf.json 窗口配置

```json
{
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "我的应用",
        "width": 1024,
        "height": 768,
        "minWidth": 800,
        "minHeight": 600,
        "resizable": true,
        "center": true,
        "decorations": true,
        "transparent": false,
        "fullscreen": false,
        "alwaysOnTop": false,
        "dragDropEnabled": false
      }
    ]
  }
}
```

---

## ⚠️ dragDropEnabled（页内拖拽必关）

Tauri 2.x 窗口默认 `dragDropEnabled: true`——WebView 层启用 **OS 原生文件拖入识别**，拦截所有 `dragover/drop` 事件。后果：

- antd Tree / react-dnd / HTML5 原生拖拽 **全部失效**
- 页内拖拽时光标显示 🚫 禁止图标
- `onDrop` 回调永远不触发

**修复**：窗口配置显式设 `"dragDropEnabled": false`（改后必须重启 `pnpm tauri dev`，前端 HMR 不会重载 Rust 配置）。

**副作用**：无法"从文件管理器把文件拖进应用"。若必须保留该能力，改用 Dialog 选文件（`tauri-plugin-dialog`），或在 Rust 侧监听 Tauri 的 `on_drag_drop_event` 接管文件投递。两者不可兼得。

**判断该不该关**：项目里是否有任何组件需要页内拖拽（Tree 排序、看板卡片、列表 reorder、分栏 resize、富文本拖图片……）？有就关。

---

## 多窗口

### Rust 创建新窗口

```rust
use tauri::Manager;
use tauri::WebviewWindowBuilder;
use tauri::WebviewUrl;

#[tauri::command]
fn open_settings(app: tauri::AppHandle) -> Result<(), String> {
    let _window = WebviewWindowBuilder::new(
        &app,
        "settings",
        WebviewUrl::App("index.html".into()),
    )
    .title("设置")
    .inner_size(600.0, 400.0)
    .center()
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}
```

### TypeScript 创建新窗口

```typescript
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

const settingsWindow = new WebviewWindow("settings", {
  url: "/settings",
  title: "设置",
  width: 600,
  height: 400,
  center: true,
});

settingsWindow.once("tauri://created", () => {
  console.log("设置窗口已创建");
});
```

---

## 无边框窗口 + 自定义标题栏

### 配置

```json
{
  "app": {
    "windows": [{
      "decorations": false,
      "transparent": true
    }]
  }
}
```

### 自定义标题栏组件

```tsx
function TitleBar() {
  return (
    <div
      data-tauri-drag-region
      style={{
        height: 30,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        background: "#1a1a2e",
        color: "white",
        padding: "0 8px",
        userSelect: "none",
      }}
    >
      <span>我的应用</span>
      <div>
        <button onClick={() => appWindow.minimize()}>—</button>
        <button onClick={() => appWindow.toggleMaximize()}>□</button>
        <button onClick={() => appWindow.close()}>✕</button>
      </div>
    </div>
  );
}
```

> `data-tauri-drag-region` 使该区域可拖拽移动窗口。

---

## 窗口控制 API

```typescript
import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();

await appWindow.minimize();          // 最小化
await appWindow.maximize();          // 最大化
await appWindow.unmaximize();        // 还原
await appWindow.toggleMaximize();    // 切换最大化
await appWindow.close();             // 关闭
await appWindow.hide();              // 隐藏
await appWindow.show();              // 显示
await appWindow.setTitle("新标题");   // 设置标题
await appWindow.setSize(new LogicalSize(800, 600));  // 设置大小
await appWindow.center();            // 居中
await appWindow.setAlwaysOnTop(true); // 置顶
```

---

## 系统托盘

```rust
use tauri::tray::{TrayIconBuilder, MouseButton, MouseButtonState};
use tauri::menu::{Menu, MenuItem};

pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::new()
        .menu(&menu)
        .on_menu_event(|app, event| {
            match event.id.as_ref() {
                "quit" => app.exit(0),
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}
```

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 多窗口用同一个 label | 每个窗口 label 必须唯一 |
| 无边框窗口不加拖拽区域 | 添加 `data-tauri-drag-region` |
| 关闭窗口不清理资源 | 监听 close-requested 事件清理 |
| 不处理窗口创建失败 | 窗口可能已存在，需 catch 错误 |
| 页内 antd Tree/react-dnd 拖拽无反应、光标 🚫 | 窗口配置设 `dragDropEnabled: false`，重启 dev server |
