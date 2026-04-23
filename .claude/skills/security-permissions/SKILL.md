---
name: security-permissions
description: |
  Tauri 安全与权限管理技能,指导 Capabilities 配置和安全最佳实践。

  触发场景:
  - 需要配置 Capabilities 权限
  - 需要理解 Tauri 安全模型
  - 需要处理 CSP(内容安全策略)
  - 功能不可用可能是权限问题

  触发词: 权限、Capabilities、安全、CSP、permission、安全策略、sandbox
---

# Tauri 安全与权限管理

## Tauri 2.x 安全模型

Tauri 2.x 引入了 **Capabilities** 系统,取代了 v1 的 allowlist。每个 API 和插件功能都需要**显式声明权限**。

```
capabilities/
└── default.json          # 主窗口默认权限
```

---

## 当前项目权限配置

### 基础结构

```json
// src-tauri/capabilities/default.json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "主窗口默认权限",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:default",
    "store:default",
    "log:default"
  ]
}
```

### 当前已启用的权限

| 插件 | 权限 ID | 说明 | 用途 |
|------|---------|------|------|
| **Core** | `core:default` | 核心默认权限 | 基础应用功能 |
| **Opener** | `opener:default` | 打开 URL/文件 | 在浏览器中打开链接 |
| **Store** | `store:default` | 键值存储 | 持久化应用配置 |
| **Log** | `log:default` | 日志系统 | 应用日志记录 |

### 推荐权限配置（按需启用）

以下是常见桌面应用的推荐权限组合，根据项目需要选择性启用：

| 插件 | 权限 ID | 说明 | 典型场景 |
|------|---------|------|---------|
| **Core Window** | `core:window:allow-start-dragging` | 窗口拖拽 | 无边框窗口必须 |
| **Core Window** | `core:window:allow-minimize` | 最小化 | 无边框窗口必须 |
| **Core Window** | `core:window:allow-maximize` | 最大化 | 无边框窗口必须 |
| **Core Window** | `core:window:allow-toggle-maximize` | 切换最大化 | 无边框窗口必须 |
| **Core Window** | `core:window:allow-close` | 关闭窗口 | 无边框窗口必须 |
| **Core Window** | `core:window:allow-destroy` | 销毁窗口 | 多窗口管理 |
| **Core Window** | `core:window:allow-set-icon` | 设置窗口图标 | 自定义窗口图标 |
| **Core Window** | `core:window:allow-set-title` | 设置窗口标题 | 动态标题 |
| **Core Window** | `core:window:allow-set-always-on-top` | 置顶窗口 | 悬浮窗 |
| **Core Window** | `core:window:allow-show` / `allow-hide` | 显示/隐藏窗口 | 托盘应用 |
| **Core Window** | `core:window:allow-outer-position` / `allow-outer-size` / `allow-inner-size` | 获取窗口位置与大小 | 窗口布局 |
| **Core Window** | `core:window:allow-set-size` / `allow-set-position` | 设置窗口大小与位置 | 窗口布局 |
| **Core Window** | `core:window:allow-scale-factor` | 获取缩放因子 | DPI 适配 |
| **Core Window** | `core:window:allow-is-always-on-top` | 查询是否置顶 | 状态查询 |
| **Core WebView** | `core:webview:allow-create-webview-window` | 创建 WebView 窗口 | 多窗口/预览窗口 |
| **Core Menu** | `core:menu:default` | 菜单权限 | 上下文菜单/应用菜单 |
| **Core Tray** | `core:tray:default` | 托盘权限 | 系统托盘图标 |
| **Opener** | `opener:allow-open-path`（带 scope） | 打开本地路径 | 在资源管理器中打开文件 |
| **Shell** | `shell:default` | 执行系统命令 | 子进程管理 |
| **OS** | `os:default` | 操作系统信息 | 平台检测（Windows/macOS/Linux） |
| **PTY** | `pty:default` | 伪终端 | 终端模拟器 |
| **Dialog** | `dialog:default` | 文件对话框 | 文件选择/保存 |
| **Notification** | `notification:default` | 系统通知 | 桌面通知 |
| **Updater** | `updater:default` | 应用更新 | 自动更新检查与安装 |
| **Process** | `process:default` | 进程管理 | 应用退出/重启 |

---

## 完整权限清单（按需添加）

### 核心权限

| 权限 | 说明 |
|------|------|
| `core:default` | 核心默认权限（包含 `core:window:default`） |
| `core:window:default` | 窗口基础权限（**不含** `allow-start-dragging`） |
| `core:window:allow-start-dragging` | 窗口拖拽（无边框窗口必须显式声明） |
| `core:window:allow-minimize` | 最小化窗口 |
| `core:window:allow-maximize` | 最大化窗口 |
| `core:window:allow-toggle-maximize` | 切换最大化状态 |
| `core:window:allow-close` | 关闭窗口 |
| `core:window:allow-destroy` | 销毁窗口 |
| `core:window:allow-set-icon` | 设置窗口图标 |
| `core:window:allow-set-title` | 设置窗口标题 |
| `core:window:allow-set-always-on-top` | 设置窗口置顶 |
| `core:window:allow-show` | 显示窗口 |
| `core:window:allow-hide` | 隐藏窗口 |
| `core:window:allow-outer-position` | 获取窗口外部位置 |
| `core:window:allow-outer-size` | 获取窗口外部大小 |
| `core:window:allow-inner-size` | 获取窗口内部大小 |
| `core:window:allow-set-size` | 设置窗口大小 |
| `core:window:allow-set-position` | 设置窗口位置 |
| `core:window:allow-scale-factor` | 获取缩放因子 |
| `core:window:allow-is-always-on-top` | 查询是否置顶 |
| `core:webview:allow-create-webview-window` | 创建 WebView 窗口 |
| `core:menu:default` | 菜单默认权限 |
| `core:tray:default` | 系统托盘默认权限 |

### 文件系统

| 权限 | 说明 |
|------|------|
| `fs:default` | 文件系统基础 |
| `fs:allow-read-text-file` | 读取文本文件 |
| `fs:allow-write-text-file` | 写入文本文件 |
| `fs:allow-exists` | 检查文件存在 |
| `fs:allow-mkdir` | 创建目录 |

### 对话框

| 权限 | 说明 |
|------|------|
| `dialog:default` | 文件对话框 |
| `dialog:allow-open` | 打开文件对话框 |
| `dialog:allow-save` | 保存文件对话框 |

### 系统交互

| 权限 | 说明 |
|------|------|
| `notification:default` | 系统通知 |
| `shell:default` | 执行系统命令（子进程） |
| `shell:allow-open` | 打开 URL |
| `os:default` | 操作系统信息（平台/架构/版本） |
| `pty:default` | 伪终端（终端模拟器） |
| `clipboard-manager:default` | 剪贴板 |
| `process:default` | 进程管理（退出/重启） |

### Opener

| 权限 | 说明 |
|------|------|
| `opener:default` | 打开 URL/文件（默认） |
| `opener:allow-open-path` | 打开本地路径（需 scope 限制） |

### 网络与更新

| 权限 | 说明 |
|------|------|
| `http:default` | HTTP 请求 |
| `updater:default` | 应用更新 |

### 存储与日志

| 权限 | 说明 |
|------|------|
| `store:default` | 键值存储 |
| `log:default` | 日志系统 |

---

## 项目权限添加指南

当需要新功能时，按以下步骤添加权限：

### 1. 安装对应插件

```toml
# src-tauri/Cargo.toml
[dependencies]
tauri-plugin-fs = "2"
```

```bash
pnpm add @tauri-apps/plugin-fs
```

### 2. 注册插件

```rust
// src-tauri/src/lib.rs
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())    // 添加这行
        .invoke_handler(tauri::generate_handler![...])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 3. 声明权限

```json
// src-tauri/capabilities/default.json
{
  "permissions": [
    "core:default",
    "opener:default",
    "store:default",
    "log:default",
    "fs:default",              // 新增
    "fs:allow-read-text-file"  // 新增
  ]
}
```

---

## 高级权限: 作用域控制

当需要限制文件访问范围时：

```json
{
  "identifier": "fs-scoped",
  "permissions": [
    {
      "identifier": "fs:allow-read-text-file",
      "allow": [{ "path": "$APPDATA/**" }]
    },
    {
      "identifier": "fs:allow-write-text-file",
      "allow": [{ "path": "$APPDATA/**" }]
    }
  ]
}
```

### Opener 路径作用域

打开本地路径时，建议使用 scope 限制可访问范围：

```json
{
  "identifier": "opener:allow-open-path",
  "allow": [{ "path": "**" }]
}
```

> **注意**：`"path": "**"` 允许打开任意路径。生产环境应限制为 `$APPDATA/**` 或特定目录。

### 路径变量

| 变量 | 说明 |
|------|------|
| `$APPDATA` | 应用数据目录 |
| `$APPCONFIG` | 应用配置目录 |
| `$APPLOG` | 应用日志目录 |
| `$HOME` | 用户主目录 |
| `$TEMP` | 临时目录 |

---

## 多窗口差异化权限

如果应用有多个窗口，可以为不同窗口配置不同权限。

### 通配符匹配动态窗口

`windows` 字段支持通配符 `*`，适用于动态创建的窗口：

```json
// default.json - 覆盖所有窗口
{
  "identifier": "default",
  "windows": ["main", "editor-*", "viewer-*"],
  "permissions": [
    "core:default",
    "core:window:allow-start-dragging",
    "core:window:allow-minimize",
    "core:window:allow-maximize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
    "opener:default",
    "store:default",
    "log:default"
  ]
}
```

> **说明**：`"editor-*"` 会匹配所有以 `editor-` 开头的窗口标签（如 `editor-1`、`editor-abc`），适用于运行时通过 `WebviewWindowBuilder` 动态创建的窗口。

### 按窗口角色配置不同权限

```json
// admin-capability.json - 管理窗口（高权限）
{
  "identifier": "admin",
  "windows": ["admin-*"],
  "permissions": [
    "core:default",
    "fs:default",
    "shell:default",
    "dialog:default"
  ]
}

// viewer-capability.json - 查看窗口（低权限）
{
  "identifier": "viewer",
  "windows": ["viewer-*"],
  "permissions": [
    "core:default"
  ]
}
```

### 典型多窗口权限组合

| 窗口类型 | 通配符模式 | 推荐权限 |
|---------|-----------|---------|
| 主窗口 | `main` | 完整权限 |
| 编辑器窗口 | `editor-*` | core + fs + dialog |
| 预览窗口 | `viewer-*` / `preview-*` | core（只读） |
| 设置窗口 | `settings` | core + store |

---

## CSP(内容安全策略)

```json
// tauri.conf.json
{
  "app": {
    "security": {
      "csp": "default-src 'self'; img-src 'self' asset: https://asset.localhost; style-src 'unsafe-inline' 'self'"
    }
  }
}
```

| 策略 | 说明 |
|------|------|
| `default-src 'self'` | 默认只允许加载本地资源 |
| `img-src 'self' asset:` | 允许本地和 asset 协议图片 |
| `script-src 'self'` | 只允许本地脚本 |
| `connect-src 'self' ipc:` | 允许 IPC 连接 |

---

## 安全最佳实践

### 1. 最小权限原则
只声明实际需要的权限，不要添加"可能用到"的权限。

```json
// ❌ 不好：添加不需要的权限
{
  "permissions": ["core:default", "fs:default", "http:default", "websocket:default"]
}

// ✅ 好：只添加当前需要的权限
{
  "permissions": [
    "core:default",
    "opener:default",
    "store:default",
    "log:default"
  ]
}
```

### 2. 无边框窗口权限
`core:default` 包含 `core:window:default`，但**不含** `core:window:allow-start-dragging`。无边框窗口必须显式声明：

```json
{
  "permissions": [
    "core:default",
    "core:window:allow-start-dragging",
    "core:window:allow-minimize",
    "core:window:allow-maximize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close"
  ]
}
```

### 3. 作用域限制
文件操作限制在特定目录：

```json
{
  "identifier": "fs:allow-read-text-file",
  "allow": [{ "path": "$APPDATA/**" }]
}
```

### 4. 不暴露敏感操作
加密/密钥等放在 Rust 侧，不要通过 Command 暴露给前端。

### 5. Command 验证
在 Rust Command 中验证输入参数：

```rust
#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    // 验证路径安全性
    if path.contains("..") {
        return Err("不允许访问父目录".into());
    }
    // ...
}
```

### 6. 不信任前端数据
前端发来的数据在 Rust 侧重新验证：

```rust
#[tauri::command]
pub fn delete_user(id: i64) -> Result<(), String> {
    // 验证 ID 有效性
    if id <= 0 {
        return Err("无效的用户 ID".into());
    }
    // 检查权限
    // ...
}
```

---

## 排查权限问题

| 症状 | 可能原因 | 解决方法 |
|------|---------|---------|
| "Permission denied" | Capabilities 未声明 | 添加权限到 capabilities/default.json |
| API 调用无响应 | 插件未注册 | 检查 lib.rs 中的 .plugin() |
| 编译错误 | 插件版本不兼容 | Cargo.toml 和 package.json 版本对齐 |
| 运行时报错 | CSP 阻止资源加载 | 检查 tauri.conf.json 中的 CSP 配置 |
| 窗口拖拽无效 | 缺少 `allow-start-dragging` | `core:default` 不含此权限，需显式声明 |
| 动态窗口无权限 | `windows` 未包含通配符 | 使用 `"窗口前缀-*"` 通配符匹配 |

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| CSP 设为 null(禁用) | 生产环境配置合适的 CSP |
| 所有权限都声明 | 只声明需要的权限 |
| 文件权限不限制路径 | 使用 scope 限制为 $APPDATA |
| 密钥放在前端代码中 | 密钥只在 Rust 侧处理 |
| 不区分窗口权限 | 不同窗口给不同权限 |
| 添加权限不测试 | 添加权限后验证功能是否正常 |
| 以为 `core:default` 包含所有窗口操作 | 无边框窗口的拖拽/最大化等需显式声明 |
| 动态窗口只写固定标签名 | 使用 `窗口前缀-*` 通配符覆盖动态窗口 |
