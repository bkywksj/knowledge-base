---
name: notification-system
description: |
  Tauri 系统通知技能，使用 tauri-plugin-notification 发送原生系统通知。

  触发场景：
  - 需要发送系统级通知
  - 需要在后台任务完成时提醒用户
  - 需要实现消息提示功能
  - 需要处理通知的点击和交互

  触发词：通知、notification、提醒、消息、toast、系统通知、桌面通知
---

# Tauri 系统通知

## 安装

```toml
# Cargo.toml
tauri-plugin-notification = "2"
```

```bash
pnpm add @tauri-apps/plugin-notification
```

## 注册插件

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_notification::init())
```

## Capabilities

```json
{ "permissions": ["notification:default"] }
```

---

## TypeScript 使用

### 基础通知

```typescript
import { sendNotification, isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";

async function notify(title: string, body: string) {
  let permissionGranted = await isPermissionGranted();
  if (!permissionGranted) {
    const permission = await requestPermission();
    permissionGranted = permission === "granted";
  }

  if (permissionGranted) {
    sendNotification({ title, body });
  }
}

// 使用
await notify("任务完成", "文件导出已完成！");
```

---

## Rust 侧发送通知

```rust
use tauri_plugin_notification::NotificationExt;

#[tauri::command]
fn send_notification(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| e.to_string())
}
```

---

## 应用内 Toast 提示

对于不需要系统级通知的简单提示，使用前端 Toast 组件：

```bash
pnpm add react-hot-toast
```

```tsx
import toast, { Toaster } from "react-hot-toast";

function App() {
  return (
    <div>
      <Toaster position="top-right" />
      <button onClick={() => toast.success("保存成功！")}>保存</button>
      <button onClick={() => toast.error("操作失败")}>测试错误</button>
    </div>
  );
}
```

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 不检查通知权限 | 先 `isPermissionGranted()` 再发送 |
| 频繁发送通知打扰用户 | 控制通知频率，重要事项才通知 |
| 用系统通知做简单提示 | 简单提示用 Toast，重要事项用系统通知 |
| 通知标题太长 | 标题简短，详情放 body |
