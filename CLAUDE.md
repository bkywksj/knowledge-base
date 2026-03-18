# CLAUDE.md - Tauri Desktop App Framework

## 语言设置
**必须使用中文**与用户对话。

## 术语约定
| 术语 | 含义 | 对应目录 |
|------|------|---------|
| **后端** | Rust Core（Tauri 后端进程） | `src-tauri/src/` |
| **前端** | React UI（WebView 进程） | `src/` |
| **配置** | Tauri 核心配置 | `src-tauri/tauri.conf.json` |
| **权限** | Capabilities 安全声明 | `src-tauri/capabilities/` |
| **Command** | Rust 侧可被前端调用的函数 | `#[tauri::command]` |
| **IPC** | 进程间通信（前端 ↔ Rust） | `invoke()` / `listen()` |

---

## 核心架构（必须牢记）

| 项目 | 规范 |
|------|------|
| **应用类型** | Tauri 2.x 桌面应用（双进程架构） |
| **后端语言** | Rust 2021 edition |
| **前端框架** | React 19 + TypeScript 5.8 |
| **UI 组件库** | Ant Design (v5+) + Lucide React 图标库 |
| **样式方案** | TailwindCSS 4 + CSS Variables 设计令牌 |
| **状态管理** | Zustand (v5+)（全局状态）+ React Hooks（局部状态） |
| **路由方案** | React Router 7（HashRouter） |
| **构建工具** | Vite 7 (前端) + Cargo (后端) |
| **通信机制** | Tauri IPC（`invoke` 调用 Rust Commands） |
| **序列化** | serde + serde_json（Rust ↔ JSON ↔ TypeScript） |
| **数据库** | SQLite（rusqlite，Rust 直接操作） |
| **错误处理** | thiserror（Rust）+ ErrorBoundary（React） |
| **安全模型** | Capabilities 细粒度权限声明 |
| **应用标识** | `com.agilefr.kb` |

### 双进程架构

```
┌───────────────────────────────────────────────────────┐
│                     Tauri 应用                         │
│                                                       │
│  ┌──────────────────┐  IPC (invoke)  ┌──────────────────┐
│  │   WebView 进程    │ ◄════════════► │   Rust Core 进程  │
│  │                  │                │                  │
│  │  React 19        │  Commands      │  commands/       │
│  │  Ant Design 5    │  Events        │  services/       │
│  │  TailwindCSS 4   │  ────────►     │  database/       │
│  │  Zustand         │                │  models/         │
│  │  React Router    │  ◄────────     │  error.rs        │
│  │                  │  返回值         │  state.rs        │
│  │  UI 渲染         │                │                  │
│  │  用户交互        │                │  系统 API        │
│  │  前端状态        │                │  文件操作        │
│  │                  │                │  SQLite 数据库   │
│  └──────────────────┘                └──────────────────┘
└───────────────────────────────────────────────────────┘
```

### 后端三层架构

```
Commands 层（IPC 入口）→ Services 层（业务逻辑）→ Database 层（数据访问）
```

### 分层职责

| 层级 | 职责 | 关键技术 |
|------|------|---------|
| **WebView 层** | UI 渲染、用户交互 | React 19 + Ant Design + TailwindCSS |
| **状态管理层** | 全局状态、设置管理 | Zustand（`src/store/`） |
| **API 封装层** | 统一 invoke 调用 | `src/lib/api/index.ts` |
| **IPC 桥接层** | 前后端通信 | `invoke()` / `listen()` |
| **Command 层** | IPC 接口定义 | `#[tauri::command]`（`src-tauri/src/commands/`） |
| **Service 层** | 业务逻辑 | `src-tauri/src/services/` |
| **Database 层** | 数据访问 DAO | `src-tauri/src/database/`（rusqlite） |
| **Plugin 层** | 功能扩展 | `tauri::Builder.plugin()` 注册 |
| **Capabilities 层** | 安全权限控制 | JSON 声明式权限 |

---

## 目录结构

```
tauri/
├── index.html                    # HTML 入口（SPA 挂载点）
├── package.json                  # Node.js 依赖和脚本
├── tsconfig.json                 # TypeScript 配置（含 @/ 路径别名）
├── vite.config.ts                # Vite 构建配置（TailwindCSS + 路径别名）
│
├── src/                          # ★ 前端源码（React + TypeScript）
│   ├── main.tsx                  # 前端入口（ReactDOM.createRoot）
│   ├── App.tsx                   # 主组件（ConfigProvider + 主题 + ErrorBoundary）
│   ├── Router.tsx                # 路由配置（React Router）
│   ├── vite-env.d.ts             # Vite 类型声明
│   ├── theme/                    # 主题配置
│   │   └── antdTheme.ts          # Ant Design 暗色/亮色主题
│   ├── styles/                   # 样式系统
│   │   ├── variables.css         # CSS 设计令牌（颜色/间距/圆角）
│   │   └── global.css            # TailwindCSS + 全局样式
│   ├── store/
│   │   └── index.ts              # Zustand 全局状态（主题/侧边栏）
│   ├── types/
│   │   └── index.ts              # TypeScript 类型定义（与 Rust 对齐）
│   ├── hooks/
│   │   └── useCommand.ts         # useCommand Hook + safeInvoke 工具
│   ├── lib/
│   │   └── api/
│   │       └── index.ts          # API 调用封装（systemApi / configApi）
│   ├── components/
│   │   ├── ui/
│   │   │   └── ErrorBoundary.tsx  # 错误边界组件
│   │   └── layout/
│   │       ├── AppLayout.tsx      # 应用布局（Sider + Header + Content）
│   │       └── Sidebar.tsx        # 侧边栏导航
│   └── pages/
│       ├── home/
│       │   └── index.tsx          # 首页
│       ├── settings/
│       │   └── index.tsx          # 设置页（配置管理）
│       └── about/
│           └── index.tsx          # 关于页（系统信息）
│
├── src-tauri/                    # ★ Rust 后端（Tauri Core）
│   ├── Cargo.toml                # Rust 依赖配置
│   ├── build.rs                  # Tauri 构建脚本
│   ├── tauri.conf.json           # ★ Tauri 核心配置
│   ├── capabilities/             # ★ 权限声明
│   │   └── default.json
│   ├── icons/                    # 应用图标
│   └── src/
│       ├── main.rs               # Rust 进程入口
│       ├── lib.rs                # ★ 核心入口（Builder + 插件 + Command 注册）
│       ├── error.rs              # ★ 统一错误类型（AppError + thiserror）
│       ├── state.rs              # ★ 应用状态（AppState + Database）
│       ├── models/
│       │   └── mod.rs            # 数据模型（AppConfig / SystemInfo）
│       ├── database/
│       │   ├── mod.rs            # 数据库操作（Database struct + DAO）
│       │   └── schema.rs         # 表结构迁移（PRAGMA user_version）
│       ├── services/
│       │   ├── mod.rs            # 服务层入口
│       │   └── config.rs         # 配置业务逻辑
│       └── commands/
│           ├── mod.rs            # Command 模块入口
│           ├── system.rs         # 系统 Commands（greet / get_system_info）
│           └── config.rs         # 配置 Commands（CRUD）
│
├── public/                       # 静态资源
└── docs/                         # 项目文档
```

---

## 🔴 Skills 强制评估（必须遵守）

> **每次用户提问时，Hook 会注入技能评估提示。必须严格遵循！**

**流程**：
1. **评估**：根据注入的技能列表，列出匹配的技能及理由
2. **激活**：对每个匹配的技能调用 `Skill(技能名)`
3. **实现**：激活完成后开始实现

---

## ⚠️ 开发强制要求

**开发前必须：先读参考代码 → 了解现有模式 → 按相同风格编写**

### 参考代码位置

| 开发类型 | 参考代码 |
|---------|---------|
| **Rust Command** | `src-tauri/src/commands/*.rs`（三层架构：Command → Service → Database） |
| **Rust 数据模型** | `src-tauri/src/models/mod.rs` |
| **Rust 错误处理** | `src-tauri/src/error.rs`（AppError 枚举） |
| **Rust 服务层** | `src-tauri/src/services/*.rs` |
| **Rust 数据库层** | `src-tauri/src/database/mod.rs` |
| **前端页面组件** | `src/pages/*/index.tsx`（Ant Design + TailwindCSS） |
| **前端布局** | `src/components/layout/AppLayout.tsx` |
| **前端 API 封装** | `src/lib/api/index.ts`（invoke 调用封装） |
| **前端状态管理** | `src/store/index.ts`（Zustand store） |
| **前端类型定义** | `src/types/index.ts` |
| **Tauri 配置** | `src-tauri/tauri.conf.json` |
| **权限声明** | `src-tauri/capabilities/default.json` |

---

## 🔴 绝对禁止的写法

### Rust 后端

| 错误做法 | 正确做法 | 原因 |
|---------|---------|------|
| `unwrap()` 处理可能失败的操作 | `Result<T, String>` + `?` 运算符 | `unwrap` 会导致 panic 崩溃 |
| Command 中 `panic!()` | 返回 `Err(AppError::...)` | panic 会崩溃整个应用 |
| 不加 `#[tauri::command]` 就期望前端调用 | 必须标记 `#[tauri::command]` 并在 `generate_handler!` 注册 | 否则前端 invoke 找不到 |
| 直接在 Command 中做长时间阻塞操作 | 使用 `async` Command 或 `tokio::spawn` | 阻塞会冻结 IPC 响应 |
| 不声明 Capabilities 就使用插件 API | 在 `capabilities/*.json` 中显式声明权限 | Tauri 2.x 强制权限检查 |
| 使用 `std::thread::sleep` 阻塞主线程 | 使用 `tokio::time::sleep` 异步等待 | 阻塞主线程冻结应用 |
| Command 直接操作数据库 | Command → Service → Database 三层 | 保持架构分层清晰 |

### TypeScript 前端

| 错误做法 | 正确做法 | 原因 |
|---------|---------|------|
| `fetch("http://...")` 直接请求外部 API | 通过 Rust Command 代理请求 | 安全限制 + 跨域问题 |
| 硬编码文件系统路径 `"C:\\Users\\..."` | 使用 Tauri path API（`appDataDir()` 等） | 跨平台路径不同 |
| 使用 `class` 组件 | 使用函数组件 + Hooks（ErrorBoundary 除外） | React 19 推荐模式 |
| `any` 类型 | 定义明确的 TypeScript 接口 | strict 模式要求 |
| `invoke` 不处理错误 | `try-catch` 包裹或使用 `safeInvoke` | Command 可能返回错误 |
| 直接 `import` Node.js 模块 | 使用 `@tauri-apps/api/*` 或 Rust Command | WebView 中无 Node.js |
| 裸写 `invoke()` 调用 | 封装到 `src/lib/api/` 中统一管理 | 便于维护和类型安全 |

---

## Tauri Command 开发规范（三层架构）

### 新增功能的标准流程

```
1. 在 models/ 定义数据结构（derive Serialize/Deserialize）
2. 在 database/ 实现 DAO 方法（SQL 操作）
3. 在 services/ 实现业务逻辑
4. 在 commands/ 实现 Command 入口（调用 Service）
5. 在 lib.rs 的 generate_handler![] 注册
6. 在 src/types/ 定义对应 TypeScript 接口
7. 在 src/lib/api/ 封装 invoke 调用
8. 在 src/pages/ 实现 UI 页面
9. 更新 capabilities（如使用新插件）
```

### Rust 三层架构示例

```rust
// ─── models/mod.rs ───
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub key: String,
    pub value: String,
}

// ─── database/mod.rs ───
impl Database {
    pub fn get_all_config(&self) -> Result<Vec<AppConfig>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        // SQL 查询...
    }
}

// ─── services/config.rs ───
pub struct ConfigService;
impl ConfigService {
    pub fn get_all(db: &Database) -> Result<Vec<AppConfig>, AppError> {
        db.get_all_config()
    }
}

// ─── commands/config.rs ───
#[tauri::command]
pub fn get_all_config(state: tauri::State<'_, AppState>) -> Result<Vec<AppConfig>, String> {
    services::config::ConfigService::get_all(&state.db).map_err(|e| e.into())
}
```

### TypeScript 侧调用

```typescript
// ─── src/lib/api/index.ts ───
export const configApi = {
  getAll: () => invoke<AppConfig[]>("get_all_config"),
  get: (key: string) => invoke<string | null>("get_config", { key }),
  set: (key: string, value: string) => invoke<void>("set_config", { key, value }),
};

// ─── src/pages/settings/index.tsx ───
const data = await configApi.getAll();
```

### Command 命名规范

| 维度 | 规范 | 示例 |
|------|------|------|
| Rust 函数名 | snake_case | `fn get_all_config()` |
| invoke 调用名 | 与 Rust 函数名一致 | `invoke("get_all_config")` |
| 参数名 | Rust: snake_case, TS: camelCase | Tauri 自动转换 |
| 返回类型 | `Result<T, String>` | `-> Result<Vec<AppConfig>, String>` |

---

## 前端核心规范 (src/)

### 技术栈

| 技术 | 用途 | 导入方式 |
|------|------|---------|
| **Ant Design 5** | UI 组件库（Button/Table/Card/Form 等） | `import { Button } from "antd"` |
| **Ant Design Icons** | 图标 | `import { SettingOutlined } from "@ant-design/icons"` |
| **Lucide React** | 补充图标 | `import { Home } from "lucide-react"` |
| **TailwindCSS 4** | 原子化样式 | `className="flex items-center gap-2"` |
| **Zustand** | 全局状态管理 | `import { useAppStore } from "@/store"` |
| **React Router** | 路由导航 | `import { useNavigate } from "react-router-dom"` |

### 组件开发模式

```tsx
// 使用 Ant Design + TailwindCSS + invoke 封装
import { Card, Table, message } from "antd";
import { configApi } from "@/lib/api";

export default function SettingsPage() {
  const [data, setData] = useState<AppConfig[]>([]);
  const [loading, setLoading] = useState(false);

  async function loadData() {
    setLoading(true);
    try {
      const configs = await configApi.getAll();
      setData(configs);
    } catch (e) {
      message.error(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); }, []);

  return (
    <div className="max-w-2xl mx-auto">
      <Card title="配置列表">
        <Table dataSource={data} loading={loading} rowKey="key" />
      </Card>
    </div>
  );
}
```

### 状态管理

| 场景 | 方案 | 示例 |
|------|------|------|
| 组件内状态 | `useState` | `const [count, setCount] = useState(0)` |
| 全局 UI 状态（主题/侧边栏） | Zustand | `useAppStore((s) => s.theme)` |
| 后端持久数据 | Rust SQLite + Command | 通过 `configApi.getAll()` 获取 |
| 键值持久化（轻量设置） | tauri-plugin-store | `Store.load("settings.json")` |

### 路径别名

所有前端导入使用 `@/` 别名：
```typescript
import { useAppStore } from "@/store";
import { configApi } from "@/lib/api";
import type { AppConfig } from "@/types";
```

---

## Capabilities 权限配置

### 当前已声明权限

```json
{
  "permissions": [
    "core:default",
    "opener:default",
    "store:default",
    "log:default"
  ]
}
```

### 常用权限列表

| 插件 | 权限 | 说明 |
|------|------|------|
| core | `core:default` | 核心默认权限 |
| opener | `opener:default` | 打开 URL/文件 |
| store | `store:default` | 键值存储 |
| log | `log:default` | 日志系统 |
| fs | `fs:default` | 文件系统基础 |
| dialog | `dialog:default` | 文件选择对话框 |
| notification | `notification:default` | 系统通知 |
| sql | `sql:default` | 数据库操作 |

> **重要**: 每个使用的插件 API 都必须在 capabilities 中声明权限，否则运行时会报错。

---

## Rust 编码规范

### 错误处理（使用 AppError）

```rust
use crate::error::AppError;

// ✅ 使用 AppError 枚举
#[tauri::command]
pub fn read_config(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<String, String> {
    services::config::ConfigService::get(&state.db, &key)
        .map_err(|e| e.into())
}

// AppError 自动转换为 String
// 支持 ?  运算符：IoError / DatabaseError / JsonError 等自动转换
```

### 数据库操作（rusqlite）

```rust
// 所有 SQL 操作在 database/ 层
impl Database {
    pub fn get_config(&self, key: &str) -> Result<Option<String>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare("SELECT value FROM app_config WHERE key = ?1")?;
        let result = stmt.query_row(params![key], |row| row.get(0)).optional()?;
        Ok(result)
    }
}
```

### Schema 迁移

使用 `PRAGMA user_version` 管理数据库版本：

```rust
// database/schema.rs
pub fn run_migrations(conn: &Connection) -> Result<(), AppError> {
    let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version < 1 {
        // 创建表...
        conn.pragma_update(None, "user_version", 1)?;
    }
    // 后续版本迁移...
}
```

---

## 常见错误速查

### Rust 后端

| 错误写法 | 正确写法 |
|---------|---------|
| `state.lock().unwrap()` | `state.lock().map_err(\|e\| AppError::Custom(e.to_string()))?` |
| Command 直接写 SQL | Command → Service → Database 三层 |
| 忘记在 `generate_handler![]` 注册 | 每个新 Command 必须注册 |
| 返回 `String` 而非 `Result` | 返回 `Result<T, String>` |

### TypeScript 前端

| 错误写法 | 正确写法 |
|---------|---------|
| `invoke("getUser")` | `invoke("get_user")`（snake_case） |
| 裸写 `invoke()` | 封装到 `src/lib/api/` |
| 不用 Ant Design 组件 | 优先使用 antd 组件（Table/Card/Form 等） |
| 不用 `@/` 别名 | `import { X } from "@/types"` |

---

## 构建与运行

### 常用命令

```bash
# 开发模式（前端 HMR + Rust 热编译）
pnpm tauri dev

# 生产构建（生成安装包）
pnpm tauri build

# 仅构建前端
pnpm build

# TypeScript 类型检查
npx tsc --noEmit

# Rust 代码检查
cd src-tauri && cargo clippy

# Rust 编译检查
cd src-tauri && cargo check

# Rust 测试
cd src-tauri && cargo test
```

### 开发服务器

| 项目 | 值 |
|------|-----|
| **前端开发地址** | `http://localhost:1420` |
| **MCP chrome-devtools** | 使用 `http://localhost:1420` 访问应用页面 |

> **注意**：使用 chrome-devtools MCP 工具时，`navigate_page` / `new_page` 等操作的 URL 应指向 `http://localhost:1420`（Tauri 开发模式下的 Vite 前端服务端口）。

### 当前已安装的 Rust 依赖

| Crate | 版本 | 用途 |
|-------|------|------|
| `tauri` | 2.x | Tauri 核心 |
| `tauri-plugin-opener` | 2 | 打开 URL/文件 |
| `tauri-plugin-store` | 2 | 键值存储 |
| `tauri-plugin-log` | 2 | 日志系统 |
| `thiserror` | 2 | 错误类型派生 |
| `rusqlite` | 0.31 (bundled) | SQLite 数据库 |
| `serde` / `serde_json` | 1 | JSON 序列化 |
| `log` | 0.4 | 日志门面 |
| `chrono` | 0.4 (serde) | 日期时间 |

### 当前已安装的前端依赖

| 包 | 用途 |
|----|------|
| `antd` | Ant Design UI 组件库 |
| `@ant-design/icons` | Ant Design 图标 |
| `react-router-dom` | 路由 |
| `zustand` | 状态管理 |
| `lucide-react` | 图标补充 |
| `tailwindcss` + `@tailwindcss/vite` | 原子化 CSS |
| `@tauri-apps/plugin-store` | 键值存储（前端 SDK） |
| `@tauri-apps/plugin-log` | 日志（前端 SDK） |

---

## 快速命令

| 命令 | 用途 |
|------|------|
| `/dev` | 开发新功能（三层架构全栈代码生成） |
| `/command` | 快速创建 Tauri Command |
| `/check` | 代码规范检查（Rust + TypeScript） |
| `/start` | 项目快速了解 |
| `/progress` | 项目进度报告 |
| `/next` | 下一步建议 |
| `/release` | 发布新版本（CI 全自动构建 + 推送） |

---

## Tauri 核心类型速查

| 类型 | 用途 | 使用场景 |
|------|------|---------|
| `tauri::Builder` | 应用构建器 | 注册插件、Commands、状态、事件 |
| `tauri::AppHandle` | 应用句柄 | 在 Command 中访问应用实例 |
| `tauri::Window` | 窗口句柄 | 操作窗口（大小/位置/标题） |
| `tauri::State<T>` | 全局状态 | Command 中注入共享状态 |
| `tauri::Manager` | 管理 trait | 获取窗口、发送事件 |
| `tauri::Emitter` | 事件发送 trait | 向前端发送事件 |
| `tauri::Listener` | 事件监听 trait | 监听前端事件 |

---

## 🔴 开发前检查清单

- [ ] **已读参考代码** — `src-tauri/src/commands/*.rs` 和 `src/pages/*/index.tsx`
- [ ] **遵循三层架构** — Command → Service → Database
- [ ] **已了解双进程架构** — 前端（WebView）和后端（Rust）通过 IPC 通信
- [ ] **使用 Ant Design** — UI 组件优先使用 antd
- [ ] **使用 TailwindCSS** — 布局样式使用 Tailwind 类
- [ ] **API 统一封装** — invoke 调用封装到 `src/lib/api/`
- [ ] **类型对齐** — Rust struct 和 TypeScript interface 保持一致
- [ ] **已确认 Capabilities** — 使用的插件 API 都已在 capabilities 中声明
- [ ] **错误处理正确** — Rust 用 `AppError`/`Result<T, String>`，前端用 `try-catch`
- [ ] **不违反禁止项** — 检查上方禁止表格
