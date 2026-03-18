---
name: store-management
description: |
  Tauri 状态管理技能,覆盖 React 前端状态和 Rust 后端状态管理。

  触发场景:
  - 需要管理前端组件间共享状态
  - 需要在 Rust 后端管理应用状态
  - 需要持久化存储(tauri-plugin-store)
  - 需要设计全局状态架构

  触发词: 状态管理、state、store、全局状态、共享状态、Zustand、Context、持久化
---

# Tauri 状态管理

## 双层状态架构

```
┌──────────────────────────────────────────┐
│  前端状态 (React)                          │
│  ├── 组件内: useState                      │
│  ├── 全局状态: Zustand (src/store/index.ts)│
│  ├── API 封装: src/lib/api/index.ts        │
│  └── Hooks: src/hooks/useCommand.ts        │
├──────────────────────────────────────────┤
│  IPC 桥接 (invoke / listen)                │
├──────────────────────────────────────────┤
│  后端状态 (Rust - 三层架构)                 │
│  ├── 运行时: tauri::State<AppState>        │
│  │   (定义于 src-tauri/src/state.rs)       │
│  ├── 持久化: tauri-plugin-store            │
│  └── 数据库: rusqlite (SQLite)             │
│      (src-tauri/src/database/)             │
└──────────────────────────────────────────┘
```

### 关键文件位置

| 状态类型 | 文件 |
|---------|------|
| Rust AppState 定义 | `src-tauri/src/state.rs` |
| Database 结构体 | `src-tauri/src/database/mod.rs` |
| Schema 迁移 | `src-tauri/src/database/schema.rs` |
| 前端 Zustand Store | `src/store/index.ts` |
| API 类型安全封装 | `src/lib/api/index.ts` |
| invoke Hook 封装 | `src/hooks/useCommand.ts` |

---

## React 前端状态

### 方案 1: useState(组件内状态)

```tsx
function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(c => c + 1)}>Count: {count}</button>;
}
```

### 方案 2: React Context(跨组件共享)

```tsx
import { createContext, useContext, useState, ReactNode } from "react";

interface AppContextType {
  theme: "light" | "dark";
  setTheme: (theme: "light" | "dark") => void;
  user: string | null;
  setUser: (user: string | null) => void;
}

const AppContext = createContext<AppContextType | null>(null);

function AppProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [user, setUser] = useState<string | null>(null);

  return (
    <AppContext.Provider value={{ theme, setTheme, user, setUser }}>
      {children}
    </AppContext.Provider>
  );
}

function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
```

### 方案 3: Zustand(轻量全局状态,推荐)

```bash
pnpm add zustand
```

```tsx
import { create } from "zustand";

interface AppStore {
  count: number;
  increment: () => void;
  items: Item[];
  setItems: (items: Item[]) => void;
  loadItems: () => Promise<void>;
}

const useAppStore = create<AppStore>((set) => ({
  count: 0,
  increment: () => set((state) => ({ count: state.count + 1 })),
  items: [],
  setItems: (items) => set({ items }),
  loadItems: async () => {
    const items = await invoke<Item[]>("list_items");
    set({ items });
  },
}));

// 使用
function MyComponent() {
  const { items, loadItems } = useAppStore();
  useEffect(() => { loadItems(); }, []);
  return <div>{items.length} items</div>;
}
```

---

## Rust 后端状态

### tauri::State<T>(运行时状态)

```rust
use std::sync::Mutex;

struct AppState {
    counter: Mutex<u32>,
    config: Mutex<AppConfig>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            counter: Mutex::new(0),
            config: Mutex::new(AppConfig::default()),
        }
    }
}

// 注册
tauri::Builder::default()
    .manage(AppState::default())

// 使用
#[tauri::command]
fn increment(state: tauri::State<'_, AppState>) -> Result<u32, String> {
    let mut counter = state.counter.lock().map_err(|e| e.to_string())?;
    *counter += 1;
    Ok(*counter)
}
```

### tauri-plugin-store(键值持久化)

```bash
# Cargo.toml
tauri-plugin-store = "2"
# package.json
pnpm add @tauri-apps/plugin-store
```

```rust
// Rust 注册
tauri::Builder::default()
    .plugin(tauri_plugin_store::Builder::default().build())
```

```typescript
// TypeScript 使用
import { Store } from "@tauri-apps/plugin-store";

const store = await Store.load("settings.json");
await store.set("theme", "dark");
const theme = await store.get<string>("theme");
await store.save();  // 持久化到磁盘
```

---

## 选型建议

| 场景 | 推荐方案 | 文件位置 |
|------|---------|---------|
| 组件内简单状态 | `useState` | 组件内 |
| 全局 UI 状态(主题/侧边栏) | Zustand | `src/store/index.ts` |
| 需要持久化的设置 | tauri-plugin-store | 前端调用 + Rust 注册 |
| 业务数据(配置等) | Rust State + Command (三层架构) | `src-tauri/src/services/` |
| 大量结构化数据 | rusqlite (SQLite) | `src-tauri/src/database/` |
| API 调用封装 | 类型安全 invoke 封装 | `src/lib/api/index.ts` |

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 所有状态放前端 | 持久化和业务数据放 Rust 侧 |
| 过度使用全局状态 | 优先 useState,必要时才升级 |
| Mutex 不处理 PoisonError | 使用 `.map_err()` 处理 |
| 不序列化就存 store | 确保数据可 JSON 序列化 |
