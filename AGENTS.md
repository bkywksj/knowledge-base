# CLAUDE.md - Tauri Desktop App Framework

## 语言设置
**必须使用中文**与用户对话。

## 🔴 文件编码与注释规范（必须遵守）

### 1. 统一编码
- **所有源码与配置文件统一强制使用 UTF-8（无 BOM）**
- 包括但不限于：`.rs`、`.tsx`、`.ts`、`.js`、`.json`、`.toml`、`.html`、`.css`、`.md`
- **绝对禁止**：UTF-8 with BOM、GBK、GB2312、ANSI、ISO-8859-1 等混用
- 创建文件时必须强制使用 UTF-8（无 BOM）

### 2. 中文内容规范
- 中文注释、中文日志、中文文档必须可读，不允许乱码（如"鍥藉"）
- 发现乱码优先检查文件实际编码与 IDE 显示编码是否一致

### 3. 注释规范
- 保留已有业务注释，不随意删除历史说明和关键注释块
- 新增代码必须补充必要注释，说明"为什么这样做"，避免空泛注释

### 4. 变更原则
- 功能改动与注释改动尽量分开，便于回溯
- 修编码问题时不改业务逻辑，只做最小必要修改

---

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

## Skills 强制评估（必须遵守）

> **每次用户提问时，Hook 会注入技能评估提示。必须严格遵循！**

**流程**：
1. **评估**：根据注入的技能列表，列出匹配的技能及理由
2. **激活**：对每个匹配的技能调用 `Skill(技能名)`
3. **实现**：激活完成后开始实现

---

## 技能系统工作原理

本项目的技能文件存储在 `.codex/skills/[skill-name]/SKILL.md` 中。

**Codex 启动时**：自动加载所有技能的 `name` 和 `description`
**任务匹配时**：Codex 读取匹配技能的完整 SKILL.md 内容
**需要时**：Codex 可进一步读取技能目录下的 `references/`、`scripts/` 等文件

---

## 技能清单与触发条件

以下是本项目的技能列表。Codex 应根据 `description` 自动判断何时使用：

| 技能名称 | 触发条件（description） |
|---------|----------------------|
| `add-skill` | 添加技能、创建技能、新技能、技能开发、写技能、技能文档、skill 创建、修改技能、更新技能、同步技能 |
| `api-development` | Command、API、invoke、IPC、接口、通信、前后端 |
| `architecture-design` | 架构、设计、模块、拆分、重构、组织、结构 |
| `brainstorm` | 头脑风暴、方案、怎么设计、有什么办法、创意、讨论、探索、建议、怎么做、如何实现 |
| `bug-detective` | Bug、报错、不工作、调试、排查、为什么、出问题、失败、不生效、无效、找不到原因、定位问题 |
| `code-patterns` | 设计模式、编码规范、最佳实践、代码风格、重构 |
| `collaborating-with-codex` | Codex、协作、多模型、原型、Diff、算法分析、代码审查、codex协同 |
| `collaborating-with-gemini` | Gemini、协作、多模型、前端原型、UI设计、CSS、样式、gemini协同 |
| `database-ops` | 数据库、SQLite、SQL、持久化、存储、表、查询、CRUD、数据 |
| `docs-management` | 文档站点、VitePress、docs 站点、用户手册、更新文档、文档同步、.docs-meta.json、website 目录、文档仓库 |
| `error-handler` | 异常、错误处理、Error、Result、try-catch、panic、崩溃、错误边界 |
| `file-storage` | 文件、读写、保存、打开、目录、文件系统、fs、拖放、导入、导出 |
| `git-workflow` | Git、分支、提交、合并、版本发布 |
| `i18n-development` | 国际化、i18n、多语言、翻译、语言切换、本地化、l10n |
| `json-serialization` | JSON、序列化、serde、类型转换、数据传输、Serialize、Deserialize |
| `notification-system` | 通知、notification、提醒、消息、toast、系统通知、桌面通知 |
| `performance-doctor` | 性能、优化、慢、卡顿、编译时间、体积、内存、CPU、profiling、启动速度 |
| `project-init` | 新项目、创建项目、初始化项目、开新项目、项目初始化、new project、init project、新建项目 |
| `project-navigator` | 项目结构、在哪里、怎么找、代码位置、目录、文件、导航、定位 |
| `release-publish` | 发布、release、版本发布、推送、打Tag、update.json、签名构建 |
| `rust-fundamentals` | Rust、所有权、借用、生命周期、编译错误、borrow、move、lifetime、async、trait |
| `security-permissions` | 权限、Capabilities、安全、CSP、permission、安全策略、sandbox |
| `store-management` | 状态管理、state、store、全局状态、共享状态、Zustand、Context、持久化 |
| `task-tracker` | 任务、进度、待办、TODO、跟踪、继续任务、恢复上下文、方案讨论、技术调研、记录问题、归档任务、多步骤开发 |
| `tauri-capabilities` | Capabilities、权限配置、作用域、scope、精细权限、安全配置 |
| `tauri-commands` | Command、tauri::command、invoke、高级Command、async command、进度、stream |
| `tauri-events` | 事件、event、emit、listen、推送、实时更新、通知、窗口通信 |
| `tauri-packaging` | 打包、构建、build、发布、安装包、exe、dmg、deb、签名、分发、release |
| `tauri-plugins` | 插件、plugin、tauri-plugin、集成、扩展、第三方 |
| `tauri-updater` | 更新、update、自动更新、版本更新、升级、updater、OTA |
| `tauri-window-management` | 窗口、window、多窗口、无边框、标题栏、托盘、tray、最小化、最大化 |
| `tech-decision` | 技术选型、架构决策、ADR、方案对比、技术评估 |
| `test-development` | 测试、test、单元测试、集成测试、TDD、测试用例 |
| `theme-system` | 主题、theme、暗色、亮色、dark、light、CSS变量、设计令牌、配色、antdTheme |
| `ui-frontend` | UI、组件、页面、前端、界面、表单、表格、弹窗、布局、样式、React |
| `utils-toolkit` | 工具、工具函数、crate、工具类、日期处理、文件处理、字符串处理、通用 |

---

## 强制执行规则

### 规则 1：任务匹配时必须读取技能

当用户请求与上述任何技能的 `description` 匹配时，Codex **必须**：

1. 读取对应的 `SKILL.md` 文件
2. 按照技能中的指令执行
3. 如果技能目录有 `references/`，按需读取相关文件

### 规则 2：多技能组合

复杂任务可能匹配多个技能，Codex 应：

1. 识别所有相关技能
2. 按依赖顺序读取
3. 综合所有技能的规范执行

### 规则 3：响应中标注已使用技能

在涉及代码的响应中，简要说明使用了哪些技能：

```
已参考技能：tauri-commands, database-ops

[实现代码...]
```

---

## 技能文件位置（按优先级）

| 优先级 | 位置 | 说明 |
|-------|------|------|
| 1 | `.codex/skills/` | 项目级技能（本项目使用） |
| 2 | `~/.codex/skills/` | 用户级技能 |
| 3 | `/etc/codex/skills/` | 系统级技能 |

---

## 用户手动触发方式

用户可以通过以下方式显式调用技能：

1. **斜杠命令**：输入 `/skills` 打开技能选择器
2. **$ 前缀**：输入 `$skill-name` 直接触发（如 `$tauri-commands`）

---

## 示例：技能如何被触发

**示例 1：创建新的 Tauri Command**

> 用户：「帮我写一个获取系统磁盘信息的 Command」

Codex 自动匹配：`tauri-commands`（关键词"Command"）+ `api-development`（关键词"接口"）

```
已参考技能：tauri-commands, api-development

// 1. models/mod.rs - 定义数据结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskInfo { ... }

// 2. services/system.rs - 业务逻辑
// 3. commands/system.rs - Command 入口
// 4. src/lib/api/index.ts - 前端封装
```

**示例 2：处理 Rust 编译错误**

> 用户：「编译报错 cannot borrow as mutable，怎么办？」

Codex 自动匹配：`rust-fundamentals`（关键词"借用""编译错误"）+ `bug-detective`（关键词"报错"）

```
已参考技能：rust-fundamentals, bug-detective

这是 Rust 所有权系统中的可变借用冲突...
```

**示例 3：实现窗口间通信**

> 用户：「主窗口需要向设置窗口推送配置变更」

Codex 自动匹配：`tauri-events`（关键词"窗口通信""推送"）+ `tauri-window-management`（关键词"多窗口"）

```
已参考技能：tauri-events, tauri-window-management

// Rust 侧 emit 事件，React 侧 listen 接收...
```

---

## 禁止行为

| 禁止 | 原因 | 正确做法 |
|-----|------|---------|
| 任务匹配技能但不读取 SKILL.md | 代码风格不一致 | 自动读取匹配的技能文件 |
| 只读取部分匹配的技能 | 遗漏关键规范 | 读取所有匹配的技能 |
| 凭记忆编写代码 | 可能使用旧规范 | 每次都读取最新技能文件 |

---

## 自检清单

Codex 在回复代码前应确认：

- [ ] 是否识别了任务涉及的所有领域？
- [ ] 是否读取了所有匹配的 SKILL.md 文件？
- [ ] 代码是否符合技能文件中的规范？
- [ ] 是否在响应中简要说明了使用的技能？

---

## 核心原则

**技能系统的目标**：确保每一行代码都符合项目规范。

- **隐式触发**：Codex 根据任务自动匹配并读取技能（推荐）
- **显式触发**：用户用 `$skill-name` 或 `/skills` 手动调用
- **渐进加载**：只在需要时读取完整内容，保持上下文精简

---

## 文档生成规范

**绝不主动生成文档**: AI 绝对禁止主动创建任何文档文件（*.md、README等），除非用户明确要求。

**文档存放位置**: 即使用户明确要求生成文档，所有文档都**必须**生成到项目根目录的 `docs/` 目录下，而不是其他位置。

---

## 开发强制要求

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

## 绝对禁止的写法

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

// 使用 AppError 枚举
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

## 开发前检查清单

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
