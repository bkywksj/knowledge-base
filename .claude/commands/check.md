# /check - 全栈代码规范检查

作为代码规范检查助手,自动检测 Tauri 桌面应用项目代码是否符合全栈规范。

## 检查范围

支持三种检查模式:

1. **全量检查**: `/check` - 检查所有代码(Rust + React + Tauri 配置)
2. **后端检查**: `/check rust` - 仅检查 Rust 后端代码
3. **前端检查**: `/check react` - 仅检查 React/TypeScript 前端代码

---

## 检查清单总览

### Rust 后端检查(src-tauri/src/)

| 检查项 | 级别 | 说明 |
|--------|------|------|
| 三层架构 | 严重 | Commands 必须调用 Services,Services 调用 Database,禁止 Command 直接访问 DB |
| 错误类型 | 严重 | 必须使用 `AppError` 枚举(thiserror),禁止直接返回 `Result<T, String>` |
| unwrap 使用 | 严重 | Command 函数中禁止 unwrap(),必须用 `?` 或 `map_err` |
| panic 使用 | 严重 | Command 函数中禁止 panic!() / todo!() / unimplemented!(),必须用 Result 返回错误 |
| Command 注册 | 严重 | 所有 `#[tauri::command]` 函数必须在 `generate_handler![]` 中注册 |
| unsafe 代码 | 严重 | 禁止无注释的 unsafe 块,必须注明安全性理由 |
| serde derive | 警告 | 跨前后端传输的结构体必须 `#[derive(Serialize, Deserialize)]` |
| 阻塞操作 | 警告 | 同步 Command 中禁止长时间阻塞(文件 IO / 网络请求 / sleep),应使用 `async` Command |
| Clone 滥用 | 警告 | 避免对大型结构体不必要的 `.clone()`,优先使用引用 |
| 命名规范 | 建议 | 函数/变量 `snake_case`,结构体/枚举 `PascalCase`,常量 `SCREAMING_SNAKE_CASE` |
| 文档注释 | 建议 | 公共函数和结构体应有 `///` 文档注释 |

### React 前端检查(src/)

| 检查项 | 级别 | 说明 |
|--------|------|------|
| invoke 封装 | 严重 | invoke 调用必须封装在 `src/lib/api/*.ts` 中,禁止在组件中直接调用 |
| 路径别名 | 严重 | 必须使用 `@/` 路径别名,禁止相对路径 `../../` |
| UI 组件库 | 严重 | 必须使用 Ant Design 组件,禁止原生 HTML 元素(button/input/select 等) |
| 全局状态 | 严重 | 全局状态(主题/侧边栏等)必须使用 Zustand store,禁止 React Context |
| any 类型 | 严重 | 禁止使用 `any` 类型,必须定义明确的 TypeScript 接口 |
| class 组件 | 严重 | 禁止使用 class 组件,必须使用函数组件 + Hooks |
| Node.js API | 严重 | 禁止导入 Node.js 模块(fs/path/http/child_process),使用 Tauri API 替代 |
| 事件监听清理 | 警告 | `listen()` / `once()` 返回的 unlisten 函数必须在组件卸载时调用 |
| 硬编码路径 | 警告 | 禁止硬编码文件路径字符串,使用 `@tauri-apps/api/path` API |
| console.log 残留 | 警告 | 生产代码中不应残留 `console.log` 调试语句 |
| useEffect 依赖 | 警告 | useEffect 必须正确声明依赖数组,禁止空依赖但引用外部变量 |
| 组件文件命名 | 建议 | 组件文件使用 PascalCase(如 `UserProfile.tsx`) |
| 导入排序 | 建议 | 导入顺序: React → 第三方库 → @tauri-apps → 本地模块 → 样式 |

### Tauri 配置检查(src-tauri/)

| 检查项 | 级别 | 说明 |
|--------|------|------|
| capabilities 完整性 | 严重 | 代码中使用的 Tauri 插件 API 必须在 capabilities 中声明权限 |
| allowlist 最小化 | 严重 | 不使用的 API 权限不应开启,遵循最小权限原则 |
| identifier 格式 | 警告 | `tauri.conf.json` 中 identifier 必须是反向域名格式(如 `com.example.app`) |
| CSP 配置 | 警告 | 生产环境必须配置 Content Security Policy |
| 版本号格式 | 建议 | version 应使用语义化版本号(semver) |
| 图标完整性 | 建议 | icons 目录应包含所有平台所需图标 |

---

## Rust 检查详情

### 1. 三层架构检查 [严重]

```bash
# 检查 Command 中是否直接访问数据库
Grep pattern: "use crate::database::|Database::" path: src-tauri/src/commands/ output_mode: content -n

# 检查 Services 是否被 Commands 正确调用
Grep pattern: "use crate::services::" path: src-tauri/src/commands/ output_mode: content -n
```

```rust
// 错误: Command 直接访问数据库
#[tauri::command]
async fn get_user(db: State<'_, Database>, id: i32) -> Result<User, AppError> {
    db.query_user(id).await  // 违反三层架构
}

// 正确: Command 调用 Service,Service 调用 Database
// commands/user.rs
#[tauri::command]
async fn get_user(id: i32) -> Result<User, AppError> {
    UserService::get_user(id).await
}

// services/user_service.rs
impl UserService {
    pub async fn get_user(id: i32) -> Result<User, AppError> {
        Database::query_user(id).await
    }
}

// database/user_db.rs
impl Database {
    pub async fn query_user(&self, id: i32) -> Result<User, AppError> {
        // 数据库操作
    }
}
```

**架构要求**:
- `commands/*.rs` → 调用 `services/*.rs`
- `services/*.rs` → 调用 `database/mod.rs` 或 `database/*_db.rs`
- `database/*.rs` → 执行具体数据操作

### 2. 错误类型检查 [严重]

```bash
# 检查是否使用 AppError 枚举
Grep pattern: "Result<.*,\s*String>" path: src-tauri/src/ output_mode: content -n

# 检查 AppError 定义
Grep pattern: "#\[derive.*Error" path: src-tauri/src/error.rs output_mode: content -A 10
```

```rust
// 错误: 直接返回 String 错误
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read: {}", e))
}

// 正确: 使用 AppError 枚举
// error.rs
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Database error: {0}")]
    Database(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Invalid input: {0}")]
    InvalidInput(String),
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

// commands/file.rs
#[tauri::command]
fn read_file(path: String) -> Result<String, AppError> {
    Ok(std::fs::read_to_string(path)?)  // 自动转换为 AppError::Io
}
```

### 3. unwrap 使用检查 [严重]

```bash
Grep pattern: "\.unwrap()" path: src-tauri/src/ output_mode: content -n
```

```rust
// 错误
let config = std::fs::read_to_string("config.json").unwrap();
let state = app_state.lock().unwrap();

// 正确
let config = std::fs::read_to_string("config.json")?;  // 使用 AppError::Io 自动转换
let state = app_state.lock()
    .map_err(|e| AppError::Database(format!("Lock failed: {}", e)))?;
```

**豁免**: 测试代码(`#[cfg(test)]` 块内)和 `main()` 函数中允许使用 `unwrap()`。

### 4. panic 使用检查 [严重]

```bash
Grep pattern: "panic!\|todo!\|unimplemented!" path: src-tauri/src/ output_mode: content -n
```

```rust
// 错误
fn process_data(data: &str) -> String {
    if data.is_empty() {
        panic!("Data cannot be empty");
    }
    todo!()
}

// 正确
fn process_data(data: &str) -> Result<String, AppError> {
    if data.is_empty() {
        return Err(AppError::InvalidInput("Data cannot be empty".to_string()));
    }
    Ok(data.to_uppercase())
}
```

**豁免**: `unreachable!()` 在已穷举的 match 分支中允许使用。

### 5. Command 注册检查 [严重]

```bash
# 步骤 1: 找出所有标记为 command 的函数名
Grep pattern: "#\[tauri::command\]" path: src-tauri/src/commands/ output_mode: content -A 2

# 步骤 2: 找出 generate_handler 中的注册列表
Grep pattern: "generate_handler" path: src-tauri/src/lib.rs output_mode: content -A 20
```

**检查方法**: 对比两个列表,确保每个 `#[tauri::command]` 函数都出现在 `generate_handler![]` 中。遗漏注册的 Command 前端调用时会返回 "command not found" 错误。

### 6. unsafe 代码检查 [严重]

```bash
Grep pattern: "unsafe " path: src-tauri/src/ output_mode: content -B 2 -A 5
```

每个 `unsafe` 块必须有 `// SAFETY:` 注释说明安全性理由。

### 7. serde derive 检查 [警告]

```bash
# 找出 Command 参数和返回值中使用的结构体
Grep pattern: "struct " path: src-tauri/src/ output_mode: content -B 3
```

```rust
// 错误: 缺少 serde derive
struct FileInfo {
    name: String,
    size: u64,
}

// 正确
#[derive(Debug, Serialize, Deserialize)]
struct FileInfo {
    name: String,
    size: u64,
}
```

### 8. 阻塞操作检查 [警告]

```bash
# 检查同步 Command 中的阻塞调用
Grep pattern: "std::fs::|std::thread::sleep|std::net::|reqwest::blocking" path: src-tauri/src/commands/ output_mode: content -B 5
```

```rust
// 错误: 同步 Command 中执行阻塞 IO
#[tauri::command]
fn download_file(url: String) -> Result<Vec<u8>, AppError> {
    let resp = reqwest::blocking::get(&url)?;
    Ok(resp.bytes()?.to_vec())
}

// 正确: 使用 async Command
#[tauri::command]
async fn download_file(url: String) -> Result<Vec<u8>, AppError> {
    let resp = reqwest::get(&url).await?;
    Ok(resp.bytes().await?.to_vec())
}
```

---

## React 检查详情

### 1. invoke 封装检查 [严重]

```bash
# 检查组件中是否直接调用 invoke
Grep pattern: "import.*invoke.*from.*@tauri-apps" path: src/components/ output_mode: files_with_matches
Grep pattern: "invoke\(" path: src/components/ glob: "*.{tsx,ts}" output_mode: content -n
```

```typescript
// 错误: 组件中直接调用 invoke
// src/components/UserList.tsx
import { invoke } from "@tauri-apps/api/core";

function UserList() {
  const loadUsers = async () => {
    const users = await invoke<User[]>("get_users");  // 违反架构
    setUsers(users);
  };
}

// 正确: 封装在 API 层
// src/lib/api/user.ts
import { invoke } from "@tauri-apps/api/core";

export interface User {
  id: number;
  name: string;
  email: string;
}

export async function getUsers(): Promise<User[]> {
  try {
    return await invoke<User[]>("get_users");
  } catch (error) {
    console.error("Failed to get users:", error);
    throw error;
  }
}

// src/components/UserList.tsx
import { getUsers, type User } from "@/lib/api/user";

function UserList() {
  const loadUsers = async () => {
    const users = await getUsers();
    setUsers(users);
  };
}
```

### 2. 路径别名检查 [严重]

```bash
# 检查是否使用相对路径导入
Grep pattern: "from ['\"]\.\./" path: src/ glob: "*.{tsx,ts}" output_mode: content -n
```

```typescript
// 错误: 使用相对路径
import { getUsers } from "../../lib/api/user";
import { Button } from "../../../components/Button";

// 正确: 使用 @/ 别名
import { getUsers } from "@/lib/api/user";
import { Button } from "@/components/Button";
```

### 3. UI 组件库检查 [严重]

```bash
# 检查是否使用原生 HTML 元素
Grep pattern: "<button|<input|<select|<textarea|<table" path: src/components/ glob: "*.tsx" output_mode: content -n
```

```typescript
// 错误: 使用原生 HTML 元素
function UserForm() {
  return (
    <div>
      <input type="text" placeholder="Name" />
      <button onClick={handleSubmit}>Submit</button>
      <select>
        <option>Option 1</option>
      </select>
    </div>
  );
}

// 正确: 使用 Ant Design 组件
import { Input, Button, Select } from "antd";

function UserForm() {
  return (
    <div>
      <Input placeholder="Name" />
      <Button type="primary" onClick={handleSubmit}>Submit</Button>
      <Select>
        <Select.Option value="1">Option 1</Select.Option>
      </Select>
    </div>
  );
}
```

**豁免**: `<div>`, `<span>`, `<p>`, `<h1>-<h6>`, `<img>`, `<a>` 等布局和内容元素允许使用。

### 4. 全局状态检查 [严重]

```bash
# 检查是否使用 React Context 管理全局状态
Grep pattern: "createContext|Context\.Provider" path: src/ glob: "*.{tsx,ts}" output_mode: content -B 2 -A 5
```

```typescript
// 错误: 使用 React Context 管理主题状态
import { createContext } from "react";

const ThemeContext = createContext({ theme: "light" });

function App() {
  return (
    <ThemeContext.Provider value={{ theme: "dark" }}>
      <Layout />
    </ThemeContext.Provider>
  );
}

// 正确: 使用 Zustand 管理全局状态
// src/stores/theme.ts
import { create } from "zustand";

interface ThemeStore {
  theme: "light" | "dark";
  setTheme: (theme: "light" | "dark") => void;
}

export const useThemeStore = create<ThemeStore>((set) => ({
  theme: "light",
  setTheme: (theme) => set({ theme }),
}));

// src/components/Layout.tsx
import { useThemeStore } from "@/stores/theme";

function Layout() {
  const theme = useThemeStore((state) => state.theme);
  const setTheme = useThemeStore((state) => state.setTheme);

  return <div className={theme}>...</div>;
}
```

**允许场景**: Context 仅用于依赖注入或库内部使用(如 Ant Design 的 ConfigProvider)。

### 5. any 类型检查 [严重]

```bash
Grep pattern: ": any\b|as any\b|<any>" path: src/ glob: "*.{tsx,ts}" output_mode: content -n
```

```typescript
// 错误
const handleData = (data: any) => { ... }
const result = response as any;

// 正确
interface FileData {
  name: string;
  size: number;
  content: string;
}
const handleData = (data: FileData) => { ... }
const result = response as FileData;
```

### 6. class 组件检查 [严重]

```bash
Grep pattern: "class .* extends (React\.)?Component" path: src/ glob: "*.{tsx,ts}" output_mode: files_with_matches
```

```typescript
// 错误
class UserProfile extends React.Component { ... }

// 正确
function UserProfile() { ... }
// 或
const UserProfile: React.FC = () => { ... }
```

### 7. Node.js API 检查 [严重]

```bash
Grep pattern: "from ['\"]fs['\"]|from ['\"]path['\"]|from ['\"]http['\"]|from ['\"]child_process['\"]|require\(['\"]fs|require\(['\"]path" path: src/ glob: "*.{tsx,ts}" output_mode: content -n
```

```typescript
// 错误: 使用 Node.js 模块
import fs from "fs";
import path from "path";
const data = fs.readFileSync("config.json");

// 正确: 使用 Tauri API
import { readTextFile } from "@tauri-apps/plugin-fs";
import { join, appDataDir } from "@tauri-apps/api/path";
const appDir = await appDataDir();
const configPath = await join(appDir, "config.json");
const data = await readTextFile(configPath);
```

### 8. 事件监听清理 [警告]

```bash
# 检查 listen 调用是否有对应的 unlisten
Grep pattern: "listen\(|once\(" path: src/ glob: "*.{tsx,ts}" output_mode: content -B 2 -A 10
```

```typescript
// 错误: 未清理事件监听
useEffect(() => {
  listen("download-progress", (event) => {
    setProgress(event.payload as number);
  });
}, []);

// 正确: 在 cleanup 中调用 unlisten
useEffect(() => {
  let unlisten: (() => void) | undefined;

  const setupListener = async () => {
    unlisten = await listen<number>("download-progress", (event) => {
      setProgress(event.payload);
    });
  };
  setupListener();

  return () => {
    unlisten?.();
  };
}, []);
```

### 9. 硬编码路径检查 [警告]

```bash
Grep pattern: "C:\\\\|D:\\\\|/home/|/Users/|/tmp/|/var/" path: src/ glob: "*.{tsx,ts}" output_mode: content -n
```

```typescript
// 错误: 硬编码绝对路径
const configPath = "C:\\Users\\admin\\AppData\\config.json";
const logPath = "/home/user/.app/logs";

// 正确: 使用 Tauri path API
import { appDataDir, appLogDir } from "@tauri-apps/api/path";
const dataDir = await appDataDir();
const logDir = await appLogDir();
```

### 10. console.log 残留 [警告]

```bash
Grep pattern: "console\.(log|debug|info|warn)\(" path: src/ glob: "*.{tsx,ts}" output_mode: content -n
```

**豁免**: `console.error` 用于错误日志记录允许保留。

### 11. useEffect 依赖检查 [警告]

```bash
# 检查空依赖数组的 useEffect
Grep pattern: "useEffect\(" path: src/ glob: "*.{tsx,ts}" output_mode: content -A 10
```

手动审查每个 `useEffect`:
- 空依赖 `[]` 但回调中引用了 state/props → 错误
- 缺少依赖数组 → 可能导致无限循环

---

## Tauri 配置检查详情

### 1. capabilities 完整性 [严重]

```bash
# 步骤 1: 找出代码中使用的 Tauri 插件 API
Grep pattern: "@tauri-apps/plugin-|@tauri-apps/api" path: src/ glob: "*.{tsx,ts}" output_mode: content

# 步骤 2: 检查 capabilities 配置
Glob pattern: "src-tauri/capabilities/*.json"
```

**检查方法**: 代码中 import 了 `@tauri-apps/plugin-fs` 则 capabilities 中必须包含 `fs:default` 或具体的 `fs:allow-read` 等权限。

当前项目权限配置:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:default",
    "store:default",
    "log:default"
  ]
}
```

常见插件与权限对照:

| 插件导入 | 所需 capability |
|---------|----------------|
| `@tauri-apps/api/core` | `core:default` |
| `@tauri-apps/plugin-opener` | `opener:default` |
| `@tauri-apps/plugin-store` | `store:default` |
| `@tauri-apps/plugin-log` | `log:default` |
| `@tauri-apps/plugin-fs` | `fs:default` 或细粒度权限 |
| `@tauri-apps/plugin-dialog` | `dialog:default` |
| `@tauri-apps/plugin-shell` | `shell:default` |
| `@tauri-apps/plugin-http` | `http:default` |
| `@tauri-apps/plugin-notification` | `notification:default` |
| `@tauri-apps/plugin-clipboard-manager` | `clipboard-manager:default` |
| `@tauri-apps/plugin-os` | `os:default` |
| `@tauri-apps/plugin-process` | `process:default` |
| `@tauri-apps/plugin-updater` | `updater:default` |

### 2. allowlist 最小化 [严重]

```bash
# 检查 capabilities 中声明的权限
Grep pattern: "\"permissions\"" path: src-tauri/capabilities/ output_mode: content -A 20
```

对比代码实际使用的 API 和声明的权限,移除未使用的权限。

### 3. identifier 格式 [警告]

```bash
Grep pattern: "\"identifier\"" path: src-tauri/tauri.conf.json output_mode: content
```

```json
// 错误
"identifier": "my-app"
"identifier": "MyApp"

// 正确
"identifier": "com.example.myapp"
"identifier": "io.github.user.appname"
```

### 4. CSP 配置 [警告]

```bash
Grep pattern: "\"csp\"" path: src-tauri/tauri.conf.json output_mode: content
```

```json
// 建议的 CSP 配置
"security": {
  "csp": "default-src 'self'; img-src 'self' asset: https://asset.localhost; style-src 'self' 'unsafe-inline'"
}
```

如果未配置 CSP,报出警告。

---

## 输出格式

```markdown
# 代码规范检查报告

**检查时间**: YYYY-MM-DD HH:mm
**检查范围**: [全量 / rust / react]

---

## 检查结果汇总

| 类别 | 通过 | 警告 | 错误 |
|------|------|------|------|
| Rust 后端 | X | X | X |
| React 前端 | X | X | X |
| Tauri 配置 | X | X | X |
| **合计** | **X** | **X** | **X** |

---

## 严重问题(必须修复)

### 1. [问题类型] - [级别]
**文件**: `src-tauri/src/commands/file.rs:42`
**问题**: Command 函数中使用了 unwrap()
**当前代码**:
```rust
let content = std::fs::read_to_string(path).unwrap();
```
**修复建议**:
```rust
let content = std::fs::read_to_string(path)?;
```

---

## 警告(建议修复)

### 1. [问题类型] - [级别]
**文件**: `src/components/FileViewer.tsx:15`
**问题**: ...
**修复建议**: ...

---

## 检查通过项

- [x] 三层架构 - 无违规
- [x] 错误类型 - 全部使用 AppError
- [x] unwrap 使用 - 无违规
- [x] panic 使用 - 无违规
- [x] Command 注册 - 全部已注册(N 个)
- [x] invoke 封装 - 全部在 API 层
- [x] 路径别名 - 全部使用 @/
- [x] UI 组件库 - 全部使用 Ant Design
- [x] 全局状态 - 全部使用 Zustand
- ...

---

## 相关规范
- 后端规范: `.claude/skills/crud-development/SKILL.md`
- 前端规范: `.claude/skills/ui-frontend/SKILL.md`
- Tauri 规范: `.claude/skills/tauri-integration/SKILL.md`
```

---

## 检查优先级

### 开发完成后必查(按优先级排序)

1. **三层架构是否正确**
   - Commands 不能直接访问 Database,必须通过 Services
   - 这是架构的基础,违反会导致代码难以维护

2. **错误类型是否统一使用 AppError**
   - 禁止使用 `Result<T, String>`,必须使用 `AppError` 枚举
   - 统一的错误类型便于错误处理和日志记录

3. **invoke 调用是否封装在 API 层**
   - 组件中不能直接调用 invoke,必须封装在 `src/lib/api/` 中
   - 便于统一错误处理和类型定义

4. **是否使用路径别名 @/**
   - 禁止使用相对路径 `../../`,必须使用 `@/` 别名
   - 提高代码可读性和重构安全性

5. **是否使用 Ant Design 组件**
   - 禁止使用原生 HTML 表单元素,必须使用 Ant Design
   - 保持 UI 一致性和可维护性

6. **全局状态是否使用 Zustand**
   - 禁止使用 React Context 管理全局状态,必须使用 Zustand
   - 更好的性能和更简洁的 API

7. **Rust 中是否有 unwrap() 和 panic!()**
   - 这是最常见且最危险的问题,会导致程序崩溃

8. **Command 是否全部注册到 generate_handler![]**
   - 遗漏注册会导致前端调用失败,且错误信息不直观

9. **capabilities 权限是否完整且最小化**
   - 权限缺失导致 API 调用被拒绝;权限过多产生安全风险

10. **是否使用了 any 类型**
    - 破坏 TypeScript 类型安全,隐藏潜在的类型错误

11. **事件监听是否正确清理**
    - 未清理的监听器导致内存泄漏和重复回调

12. **是否存在 Node.js API 调用**
    - Tauri 前端运行在 WebView 中,无 Node.js 运行时

13. **async Command 中是否有阻塞操作**
    - 阻塞主线程会导致界面卡顿无响应

14. **serde derive 是否完整**
    - 缺少序列化 derive 会导致编译错误或运行时序列化失败

15. **unsafe 代码是否有安全性注释**
    - 无注释的 unsafe 代码难以审查和维护
