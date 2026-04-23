# /command - 快速创建 Tauri Command

作为 Tauri Command 生成助手，快速创建完整的 Rust Command + 前端调用代码。

## 适用场景

### 适合使用 /command

- 需要创建一个新的 Rust Command（`#[tauri::command]` 函数）
- 前后端 IPC 通信功能（前端 `invoke()` 调用 Rust 函数）
- 系统 API 调用封装（文件操作、进程管理、硬件访问等）
- 数据处理和转换（JSON 解析、加解密、文本处理等）
- 需要注入 `AppHandle`、`Window`、`State` 等框架对象

### 不适合使用 /command

- 复杂业务功能（多个 Command + 完整 UI 页面） --> 使用 /dev
- 纯前端 UI 开发（不涉及 Rust 侧逻辑） --> 直接编码
- 插件集成（使用官方或第三方插件的功能） --> 参考 tauri-plugins 技能
- 窗口管理操作（创建/控制窗口） --> 参考 tauri-window-management 技能
- 事件系统（Rust 向前端推送事件） --> 参考 tauri-events 技能

### 支持的 Command 类型

| 类型 | 适用场景 | 特点 |
|------|---------|------|
| **同步 Command** | 纯计算、内存操作、简单转换 | 立即返回结果 |
| **异步 Command** | 文件 IO、网络请求、数据库操作 | 不阻塞 IPC 线程 |
| **带状态 Command** | 需要访问全局状态（计数器、缓存、数据库等） | 注入 `tauri::State<T>` |
| **带窗口 Command** | 需要操作当前窗口（标题、大小等） | 注入 `tauri::Window` |
| **带 AppHandle Command** | 需要访问应用路径、配置等 | 注入 `tauri::AppHandle` |
| **进度回报 Command** | 长时间任务（下载、处理） | 异步 + `window.emit()` |

---

## 执行流程

### 第一步：确认 Command 信息

使用 AskUserQuestion 向用户询问：

```
请提供 Command 的基本信息：

1. 功能描述？（如：读取配置文件、保存用户设置、调用系统命令）
2. 所属模块？（如：system、config、user、file 等）
3. 输入参数？（参数名 + 类型，如：path: String, content: String）
4. 返回值类型？（String / 自定义结构体 / Vec<T> / 无返回值）
5. 是否需要异步？（文件IO / 网络请求 / 数据库 --> 需要异步）
6. 是否需要注入框架对象？（AppHandle / Window / State）
```

#### Command 类型自动判断

根据用户描述自动判断 Command 类型：

| 关键词 | 判断为 | 原因 |
|--------|--------|------|
| 文件、读取、写入、保存 | 异步 Command | 涉及文件 IO |
| 网络、HTTP、下载、上传 | 异步 Command | 涉及网络请求 |
| 数据库、查询、SQL、配置 | 异步 Command + State | 需要访问数据库 |
| 计算、转换、格式化 | 同步 Command | 纯内存操作 |
| 窗口、标题、大小 | 带 Window 的 Command | 需要窗口操作 |
| 应用路径、数据目录 | 带 AppHandle 的 Command | 需要应用句柄 |
| 进度、下载、批量处理 | 异步 + 进度回报 | 长时间任务 |

---

### 第二步：读取现有代码（强制执行）

```bash
# 1. 了解现有模块结构
Read src-tauri/src/commands/mod.rs

# 2. 读取目标模块的现有 Commands（如 commands/config.rs）
Read src-tauri/src/commands/<module_name>.rs

# 3. 了解已有数据模型
Read src-tauri/src/models/mod.rs

# 4. 了解错误类型定义
Read src-tauri/src/error.rs

# 5. 了解 lib.rs 中的 Command 注册
Read src-tauri/src/lib.rs

# 6. 了解已有 Rust 依赖
Read src-tauri/Cargo.toml

# 7. 了解前端 API 封装模式
Read src/lib/api/index.ts

# 8. 了解前端类型定义
Read src/types/index.ts
```

**强制检查清单**:
- [ ] 确认 Command 名称不与已有 Command 冲突
- [ ] 确认目标模块文件是否存在，不存在则需创建
- [ ] 确认所需的 Cargo 依赖是否已存在
- [ ] 确认数据模型是否需要新增
- [ ] 确认前端 API 封装的命名模式

---

### 第三步：自动生成代码

## 🔴 新架构说明（必须遵守）

本项目采用**三层分离架构**：

```
Commands (src-tauri/src/commands/)    ← 接收前端请求，参数校验
    ↓
Services (src-tauri/src/services/)    ← 业务逻辑层
    ↓
Database (src-tauri/src/database/)    ← 数据持久化层
```

**架构要点**：
- **Commands** 只负责 IPC 接口定义，不写业务逻辑
- **Services** 负责核心业务逻辑
- **Database** 负责 SQL 操作
- **Models** (`src-tauri/src/models/mod.rs`) 定义数据结构
- **Error** (`src-tauri/src/error.rs`) 使用 `AppError` 枚举（thiserror）

---

#### 3.1 Rust 侧代码

##### 数据结构定义（在 models/mod.rs 中添加）

```rust
use serde::{Deserialize, Serialize};

/// 数据模型示例
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MyData {
    pub id: i64,
    pub name: String,
    pub value: String,
}
```

##### Command 文件（在 commands/ 目录下）

新建或编辑 `src-tauri/src/commands/<module_name>.rs`：

```rust
use crate::models::MyData;
use crate::services::<module_name>::<ServiceName>;
use crate::state::AppState;

/// [Command 功能描述]
#[tauri::command]
pub fn command_name(
    state: tauri::State<'_, AppState>,
    param: String,
) -> Result<MyData, String> {
    // 参数校验
    if param.is_empty() {
        return Err("参数不能为空".into());
    }

    // 调用 Service 层
    <ServiceName>::do_something(&state.db, &param).map_err(|e| e.to_string())
}
```

**不同类型的 Command 示例**：

##### 1. 同步 Command（纯计算）

```rust
/// 格式化文本
#[tauri::command]
pub fn format_text(text: String) -> Result<String, String> {
    if text.is_empty() {
        return Err("文本不能为空".into());
    }
    Ok(text.trim().to_uppercase())
}
```

##### 2. 异步 Command（文件 IO）

```rust
/// 读取文本文件
#[tauri::command]
pub async fn read_file(path: String) -> Result<String, String> {
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("读取文件失败: {}", e))
}
```

##### 3. 带 State 的 Command（数据库操作）

```rust
use crate::state::AppState;
use crate::services::config::ConfigService;

/// 获取配置
#[tauri::command]
pub fn get_config(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<String, String> {
    ConfigService::get(&state.db, &key).map_err(|e| e.to_string())
}
```

##### 4. 带 AppHandle 的 Command（获取应用路径）

```rust
use crate::models::SystemInfo;

/// 获取系统信息
#[tauri::command]
pub fn get_system_info(app: tauri::AppHandle) -> Result<SystemInfo, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "unknown".into());

    Ok(SystemInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        app_version: app.package_info().version.to_string(),
        data_dir,
    })
}
```

##### 5. 带 Window 的 Command（进度回报）

```rust
use tauri::Manager;

/// 批量处理任务（带进度回报）
#[tauri::command]
pub async fn batch_process(
    window: tauri::Window,
    items: Vec<String>,
) -> Result<String, String> {
    let total = items.len();

    for (i, item) in items.iter().enumerate() {
        // 处理每一项...
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // 发送进度事件
        let progress = ((i + 1) as f64 / total as f64 * 100.0) as u32;
        window.emit("batch_process_progress", progress)
            .map_err(|e| e.to_string())?;
    }

    Ok(format!("处理完成，共 {} 项", total))
}
```

##### 注册到 commands/mod.rs

```rust
// 在 src-tauri/src/commands/mod.rs 中添加模块导出
pub mod config;
pub mod system;
pub mod <new_module>;  // <-- 新增模块
```

##### 注册到 lib.rs 的 generate_handler![]

```rust
// 在 src-tauri/src/lib.rs 中注册新 Command
tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
        // 系统模块
        commands::system::greet,
        commands::system::get_system_info,
        // 配置模块
        commands::config::get_all_config,
        commands::config::get_config,
        commands::config::set_config,
        commands::config::delete_config,
        // 新模块
        commands::<new_module>::<command_name>,  // <-- 新增
    ])
```

---

#### 3.2 Service 层代码（如需要）

如果 Command 需要复杂业务逻辑，应在 `src-tauri/src/services/` 中创建对应的 Service：

```rust
// src-tauri/src/services/<module_name>.rs
use crate::database::Database;
use crate::error::AppError;
use crate::models::MyData;

pub struct MyService;

impl MyService {
    /// 业务逻辑方法
    pub fn do_something(db: &Database, param: &str) -> Result<MyData, AppError> {
        // 参数验证
        if param.is_empty() {
            return Err(AppError::InvalidInput("参数不能为空".into()));
        }

        // 数据库操作
        let conn = db.connection.lock().unwrap();
        let mut stmt = conn.prepare("SELECT * FROM table WHERE key = ?")?;
        let data = stmt.query_row([param], |row| {
            Ok(MyData {
                id: row.get(0)?,
                name: row.get(1)?,
                value: row.get(2)?,
            })
        })?;

        Ok(data)
    }
}
```

然后在 `src-tauri/src/services/mod.rs` 中导出：

```rust
pub mod config;
pub mod <new_module>;  // <-- 新增
```

---

#### 3.3 前端代码

##### 类型定义（在 src/types/index.ts 中添加）

```typescript
/** [数据模型描述] */
export interface MyData {
  id: number;
  name: string;
  value: string;
}
```

**注意**：Rust 的 `snake_case` 字段会自动转为 TypeScript 的 `camelCase`。

##### API 封装（在 src/lib/api/index.ts 中添加）

```typescript
import { invoke } from "@tauri-apps/api/core";
import type { MyData } from "@/types";

/** [模块名] API */
export const myApi = {
  /** [Command 功能描述] */
  commandName: (param: string) => invoke<MyData>("command_name", { param }),

  /** 批量处理（带进度监听） */
  batchProcess: (
    items: string[],
    onProgress: (progress: number) => void
  ): Promise<string> => {
    return new Promise((resolve, reject) => {
      // 监听进度事件
      listen<number>("batch_process_progress", (event) => {
        onProgress(event.payload);
      });

      // 调用 Command
      invoke<string>("batch_process", { items })
        .then(resolve)
        .catch(reject);
    });
  },
};
```

**API 命名规范**：
- Rust 函数名：`get_user_list` (snake_case)
- TypeScript 方法名：`getUserList` (camelCase)
- invoke 调用名：`"get_user_list"` (与 Rust 一致)

##### React 组件中使用（Ant Design 5）

```tsx
import { useState } from "react";
import { Button, message, Card } from "antd";
import { myApi } from "@/lib/api";
import type { MyData } from "@/types";

function MyComponent() {
  const [data, setData] = useState<MyData | null>(null);
  const [loading, setLoading] = useState(false);

  const handleFetch = async () => {
    setLoading(true);
    try {
      const result = await myApi.commandName("参数值");
      setData(result);
      message.success("获取成功");
    } catch (error) {
      message.error(`操作失败: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card title="功能模块">
      <Button type="primary" loading={loading} onClick={handleFetch}>
        执行操作
      </Button>
      {data && <pre>{JSON.stringify(data, null, 2)}</pre>}
    </Card>
  );
}

export default MyComponent;
```

---

#### 3.4 新增数据模型（如需要）

在 `src-tauri/src/models/mod.rs` 中添加：

```rust
use serde::{Deserialize, Serialize};

/// [数据模型描述]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MyData {
    pub id: i64,
    pub name: String,
    pub value: String,
}
```

---

#### 3.5 新增错误类型（如需要）

在 `src-tauri/src/error.rs` 中的 `AppError` 枚举中添加：

```rust
#[derive(Debug, Error)]
pub enum AppError {
    // ... 已有错误类型 ...

    #[error("新错误类型: {0}")]
    NewError(String),
}
```

---

#### 3.6 新增 Cargo 依赖（如需要）

根据 Command 功能自动判断是否需要新增依赖：

| 功能 | 需要的 Cargo 依赖 | 添加方式 |
|------|-------------------|---------|
| HTTP 请求 | `reqwest = { version = "0.12", features = ["json"] }` | Cargo.toml [dependencies] |
| 日期时间 | `chrono = { version = "0.4", features = ["serde"] }` | Cargo.toml [dependencies] |
| UUID 生成 | `uuid = { version = "1", features = ["v4", "serde"] }` | Cargo.toml [dependencies] |
| 正则表达式 | `regex = "1"` | Cargo.toml [dependencies] |
| 加密/哈希 | `sha2 = "0.10"` 或 `bcrypt = "0.15"` | Cargo.toml [dependencies] |
| 命令执行 | `std::process::Command` | 标准库，无需额外依赖 |

**注意**：本项目已内置以下依赖，无需重复添加：
- `serde`, `serde_json` - JSON 序列化
- `thiserror` - 错误处理
- `rusqlite` - SQLite 数据库
- `tokio` - 异步运行时

---

#### 3.7 Capabilities 权限更新（如需要）

如果新 Command 使用了 Tauri 插件 API，需要更新权限声明：

```json
// src-tauri/capabilities/default.json
{
  "permissions": [
    "core:default",
    // ... 已有权限 ...
    "new-permission:here"  // <-- 新增
  ]
}
```

---

### 第四步：输出文件清单

```markdown
## Command 生成完成！

### 已修改/创建的文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `src-tauri/src/commands/<module>.rs` | 修改/创建 | 新增 Command 函数 |
| `src-tauri/src/commands/mod.rs` | 修改 | 导出新模块（如需） |
| `src-tauri/src/lib.rs` | 修改 | 注册到 generate_handler |
| `src-tauri/src/models/mod.rs` | 修改 | 新增数据模型（如需） |
| `src-tauri/src/services/<module>.rs` | 创建 | Service 层业务逻辑（如需） |
| `src-tauri/src/services/mod.rs` | 修改 | 导出新 Service（如需） |
| `src/lib/api/index.ts` | 修改 | 新增 API 封装 |
| `src/types/index.ts` | 修改 | 新增 TypeScript 类型 |
| `src-tauri/Cargo.toml` | 修改（如需） | 新增依赖 |
| `src-tauri/capabilities/default.json` | 修改（如需） | 新增权限声明 |

### 验证步骤

1. **编译检查**: `cd src-tauri && cargo check`
2. **启动开发**: `pnpm tauri dev`
3. **在前端调用**: 导入并调用 API 函数
4. **检查控制台**: 确认无 "Command not found" 错误

### 后续操作建议

- 如需添加更多 Command，再次使用 `/command`
- 如需完整功能页面（UI + 多个 Command），使用 `/dev`
- 如需单元测试，参考 test-development 技能
```

---

## 与 /dev 的区别

| 对比项 | /command | /dev |
|--------|----------|------|
| **适用场景** | 单个 Command（1 个 Rust 函数 + 1 个 API 封装） | 完整功能（多个 Command + UI 页面 + 状态管理） |
| **UI 生成** | 仅生成 API 封装和使用示例 | 完整 React 页面组件（Ant Design） |
| **权限配置** | 按需提示 | 完整检查并配置 |
| **状态管理** | 按需（注入 State 或不注入） | 完整设计（Rust State + React State） |
| **代码组织** | 单个模块文件 | 完整模块结构（Commands + Services + Models） |
| **执行速度** | 快速（1-2 分钟） | 较完整（5-10 分钟） |

**选择建议**:
- 快速添加一个 IPC 功能 --> `/command`
- 开发一个完整的功能模块 --> `/dev`
- 先用 `/command` 验证可行性，再用 `/dev` 补全 --> 渐进式开发

---

## AI 强制规则

### Rust 侧规则

1. **Command 必须返回 `Result<T, String>`** -- 不允许 `panic!` 或 `unwrap()` 可能失败的操作
2. **必须在 `generate_handler![]` 注册** -- 否则前端 `invoke()` 会报 "Command not found"
3. **异步操作必须用 `async` Command** -- 文件IO、网络请求、数据库等绝不能用同步 Command
4. **Rust 参数使用 `snake_case`** -- Tauri 自动将前端的 `camelCase` 转为 `snake_case`
5. **错误处理使用 `AppError`** -- 业务逻辑用 `AppError`，Command 用 `.map_err(|e| e.to_string())`
6. **禁止 `std::thread::sleep`** -- 使用 `tokio::time::sleep` 异步等待
7. **Commands 只做参数校验和调用 Service** -- 业务逻辑放在 Service 层
8. **数据模型统一定义在 models/mod.rs** -- 不在 Command 文件中定义结构体

### TypeScript 侧规则

1. **必须在 `src/lib/api/index.ts` 封装 API** -- 不允许在组件中直接裸写 `invoke()`
2. **类型定义在 `src/types/index.ts`** -- 不在组件或 API 文件中定义接口
3. **使用 `@/` 路径别名** -- `import { myApi } from "@/lib/api"`
4. **TypeScript 参数使用 `camelCase`** -- Tauri 自动转换为 Rust 的 `snake_case`
5. **`invoke` 调用必须 `try-catch` 包裹** -- Command 可能返回错误
6. **命令名使用 `snake_case` 字符串** -- `invoke("command_name")`，与 Rust 函数名一致
7. **UI 组件使用 Ant Design 5** -- `import { Button, message } from "antd"`
8. **React 组件使用函数组件 + Hooks** -- 不使用 class 组件

### 架构规则

1. **三层分离**: Commands → Services → Database
2. **Commands 层**: 只做参数校验、调用 Service、返回结果
3. **Services 层**: 核心业务逻辑、数据转换
4. **Database 层**: SQL 操作、数据持久化
5. **Models 统一管理**: 所有数据结构在 `models/mod.rs`
6. **错误统一处理**: 使用 `AppError` 枚举（thiserror）

### 通用规则

1. **生成前必须读取现有代码** -- 了解代码结构和命名模式
2. **Command 名称不得与已有 Command 冲突** -- 检查 `generate_handler![]` 列表
3. **新增 Cargo 依赖必须告知用户** -- 说明为什么需要以及版本号
4. **如使用插件 API 必须检查 Capabilities** -- 缺少权限声明会导致运行时报错

---

## 示例对话

### 用户输入

```
/command
```

### AI 响应

```
好的！我将帮您快速创建一个 Tauri Command。

请提供 Command 的基本信息：

1. 功能描述？（如：读取配置文件、保存用户设置、调用系统命令）
2. 所属模块？（如：system、config、user、file 等）
3. 输入参数？（参数名 + 类型，如：path: String, content: String）
4. 返回值类型？（String / 自定义结构体 / Vec<T> / 无返回值）
5. 是否需要异步？（文件IO / 网络请求 / 数据库 --> 需要异步）
6. 是否需要注入框架对象？（AppHandle / Window / State）
```

### 用户输入

```
获取用户列表，属于 user 模块，需要从数据库读取，返回用户列表
```

### AI 响应

```
好的！根据您的描述，我将创建一个异步 Command 来获取用户列表。

分析：
- 功能：获取用户列表
- 模块：user
- 类型：异步 Command（数据库操作）+ State（需要数据库连接）
- 返回：Vec<User>

让我先读取现有代码...

[AI 内部：Read 相关文件]

## Command 生成方案

- 模块: user (新建 commands/user.rs)
- Command 名称: get_user_list
- Service: UserService::get_all
- 数据模型: User (需新增到 models/mod.rs)

[生成完整的三层代码 + 前端封装]
```

---

## 完整示例：创建用户管理 Command

假设用户要求："创建一个获取所有用户的 Command"

### 生成的文件结构

```
src-tauri/src/
├── commands/
│   ├── mod.rs          (新增 pub mod user;)
│   └── user.rs         (新建，包含 get_user_list Command)
├── services/
│   ├── mod.rs          (新增 pub mod user;)
│   └── user.rs         (新建，包含 UserService)
├── models/
│   └── mod.rs          (新增 User 结构体)
└── lib.rs              (注册 commands::user::get_user_list)

src/
├── lib/api/
│   └── index.ts        (新增 userApi.getList)
└── types/
    └── index.ts        (新增 User 接口)
```

### 1. 数据模型 (models/mod.rs)

```rust
// 新增到 src-tauri/src/models/mod.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub email: String,
}
```

### 2. Service 层 (services/user.rs)

```rust
// src-tauri/src/services/user.rs
use crate::database::Database;
use crate::error::AppError;
use crate::models::User;

pub struct UserService;

impl UserService {
    pub fn get_all(db: &Database) -> Result<Vec<User>, AppError> {
        let conn = db.connection.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, username, email FROM users")?;

        let users = stmt
            .query_map([], |row| {
                Ok(User {
                    id: row.get(0)?,
                    username: row.get(1)?,
                    email: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(users)
    }
}
```

### 3. Command 层 (commands/user.rs)

```rust
// src-tauri/src/commands/user.rs
use crate::models::User;
use crate::services::user::UserService;
use crate::state::AppState;

/// 获取所有用户
#[tauri::command]
pub fn get_user_list(state: tauri::State<'_, AppState>) -> Result<Vec<User>, String> {
    UserService::get_all(&state.db).map_err(|e| e.to_string())
}
```

### 4. 注册 (commands/mod.rs)

```rust
// src-tauri/src/commands/mod.rs
pub mod config;
pub mod system;
pub mod user;  // <-- 新增
```

### 5. 注册 (services/mod.rs)

```rust
// src-tauri/src/services/mod.rs
pub mod config;
pub mod user;  // <-- 新增
```

### 6. 注册到 Builder (lib.rs)

```rust
// src-tauri/src/lib.rs
.invoke_handler(tauri::generate_handler![
    // ... 已有 commands ...
    commands::user::get_user_list,  // <-- 新增
])
```

### 7. 前端类型 (types/index.ts)

```typescript
// src/types/index.ts
export interface User {
  id: number;
  username: string;
  email: string;
}
```

### 8. 前端 API (lib/api/index.ts)

```typescript
// src/lib/api/index.ts
import type { User } from "@/types";

export const userApi = {
  /** 获取所有用户 */
  getList: () => invoke<User[]>("get_user_list"),
};
```

### 9. 使用示例 (React 组件)

```tsx
import { useState, useEffect } from "react";
import { Card, Table, message } from "antd";
import { userApi } from "@/lib/api";
import type { User } from "@/types";

function UserList() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadUsers();
  }, []);

  const loadUsers = async () => {
    setLoading(true);
    try {
      const data = await userApi.getList();
      setUsers(data);
    } catch (error) {
      message.error(`加载失败: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  const columns = [
    { title: "ID", dataIndex: "id", key: "id" },
    { title: "用户名", dataIndex: "username", key: "username" },
    { title: "邮箱", dataIndex: "email", key: "email" },
  ];

  return (
    <Card title="用户列表">
      <Table
        dataSource={users}
        columns={columns}
        loading={loading}
        rowKey="id"
      />
    </Card>
  );
}

export default UserList;
```

---

## 总结

使用 `/command` 快速创建 Tauri Command，遵循以下原则：

1. **三层分离**：Commands → Services → Database
2. **统一管理**：Models、Error、API 封装集中管理
3. **类型安全**：Rust 和 TypeScript 双端类型定义
4. **错误处理**：使用 `AppError` + `.map_err()`
5. **命名规范**：Rust 用 snake_case，TypeScript 用 camelCase
6. **UI 组件**：使用 Ant Design 5 + React Hooks

通过 `/command` 可以快速生成标准化的 Command 代码，保持项目架构一致性。
