---
name: tauri-events
description: |
  Tauri 事件系统技能,实现前后端双向事件通信。

  触发场景:
  - 需要从 Rust 向前端推送数据
  - 需要实现实时数据更新
  - 需要窗口间通信
  - 需要监听系统事件

  触发词: 事件、event、emit、listen、推送、实时更新、通知、窗口通信
---

# Tauri 事件系统

## 事件 vs Command

| 特性 | Command (invoke) | Event (emit/listen) |
|------|-----------------|-------------------|
| 方向 | 前端 → Rust | 双向(Rust ↔ 前端) |
| 模式 | 请求-响应 | 发布-订阅 |
| 场景 | 主动查询/操作 | 被动通知/推送 |
| 返回值 | 有 | 无(单向广播) |

---

## Rust → 前端(推送数据)

### Rust 发送事件

```rust
use tauri::Emitter;

// 在 Command 中发送事件
#[tauri::command]
async fn start_monitoring(window: tauri::Window) -> Result<(), String> {
    tokio::spawn(async move {
        loop {
            let cpu_usage = get_cpu_usage();
            window.emit("system-stats", cpu_usage).unwrap();
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    });
    Ok(())
}

// 在 setup 中发送事件
fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    handle.emit("heartbeat", "alive").unwrap();
                    std::thread::sleep(std::time::Duration::from_secs(5));
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 前端监听事件

```typescript
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

function SystemMonitor() {
  const [cpuUsage, setCpuUsage] = useState(0);

  useEffect(() => {
    const setupListener = async () => {
      const unlisten = await listen<number>("system-stats", (event) => {
        setCpuUsage(event.payload);
      });

      // 清理监听器
      return unlisten;
    };

    let cleanup: (() => void) | undefined;
    setupListener().then(fn => { cleanup = fn; });

    return () => { cleanup?.(); };
  }, []);

  return <div>CPU: {cpuUsage}%</div>;
}
```

---

## 前端 → Rust(发送事件)

```typescript
import { emit } from "@tauri-apps/api/event";

// 前端发送
await emit("user-action", { action: "click", target: "button" });
```

```rust
use tauri::Listener;

// Rust 监听
fn main() {
    tauri::Builder::default()
        .setup(|app| {
            app.listen("user-action", |event| {
                println!("收到前端事件: {:?}", event.payload());
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error");
}
```

---

## 窗口间通信

```typescript
// 窗口 A 发送
import { emit } from "@tauri-apps/api/event";
await emit("data-updated", { id: 1, name: "new" });

// 窗口 B 监听
import { listen } from "@tauri-apps/api/event";
const unlisten = await listen("data-updated", (event) => {
  console.log("数据更新:", event.payload);
  refreshData();
});
```

---

## 进度回报模式

```rust
#[tauri::command]
async fn process_files(window: tauri::Window, paths: Vec<String>) -> Result<(), String> {
    let total = paths.len();
    for (i, path) in paths.iter().enumerate() {
        // 处理文件...
        process_file(path).map_err(|e| e.to_string())?;

        // 回报进度
        window.emit("progress", serde_json::json!({
            "current": i + 1,
            "total": total,
            "file": path,
        })).map_err(|e| e.to_string())?;
    }
    Ok(())
}
```

```tsx
function FileProcessor() {
  const [progress, setProgress] = useState({ current: 0, total: 0, file: "" });

  async function startProcessing(paths: string[]) {
    const unlisten = await listen<{ current: number; total: number; file: string }>(
      "progress", (e) => setProgress(e.payload)
    );

    try {
      await invoke("process_files", { paths });
    } finally {
      unlisten();
    }
  }

  return (
    <div>
      <progress value={progress.current} max={progress.total} />
      <p>{progress.current}/{progress.total} - {progress.file}</p>
    </div>
  );
}
```

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 不清理事件监听器 | 在 useEffect cleanup 中调用 unlisten |
| 用 Command 轮询数据 | 用事件从 Rust 推送数据 |
| 事件名拼写不一致 | 定义常量统一管理事件名 |
| 不处理事件 payload 类型 | 使用泛型 `listen<T>()` 声明类型 |
