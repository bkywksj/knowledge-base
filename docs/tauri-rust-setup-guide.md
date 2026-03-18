# Tauri + Rust 完整初始化指南

> 本文档提供从零开始搭建 Tauri 桌面应用开发环境的完整步骤

📅 **更新时间**: 2025-03-05  
⏱️ **预计时长**: 30-60 分钟（首次安装）  
💻 **支持平台**: Windows / macOS / Linux

---

## 📋 目录

1. [系统要求](#系统要求)
2. [安装 Rust](#安装-rust)
3. [安装系统依赖](#安装系统依赖)
4. [安装 Node.js](#安装-nodejs)
5. [创建第一个 Tauri 项目](#创建第一个-tauri-项目)
6. [项目结构说明](#项目结构说明)
7. [运行开发服务器](#运行开发服务器)
8. [修改代码](#修改代码)
9. [打包应用](#打包应用)
10. [常见问题](#常见问题)
11. [下一步学习](#下一步学习)

---

## 系统要求

### 最低配置
- **CPU**: 双核处理器
- **内存**: 4GB RAM（推荐 8GB）
- **磁盘**: 至少 5GB 可用空间
- **操作系统**:
  - Windows 10/11 (64-bit)
  - macOS 10.15+ (Catalina 或更高)
  - Linux (主流发行版)

---

## 安装 Rust

Rust 是 Tauri 的核心依赖，必须首先安装。

### Windows 安装

#### 步骤 1: 下载 Rust 安装器

访问 [https://rustup.rs/](https://rustup.rs/) 或直接下载:
```
https://win.rustup.rs/x86_64
```

#### 步骤 2: 运行安装器

双击下载的 `rustup-init.exe`，会看到以下提示:

```
Welcome to Rust!

This will download and install the official compiler for the Rust
programming language, and its package manager, Cargo.

...

1) Proceed with installation (default)
2) Customize installation
3) Cancel installation
```

**选择 `1` 并按 Enter**（使用默认安装）

#### 步骤 3: 等待安装完成

安装过程需要 5-10 分钟，完成后会显示:
```
Rust is installed now. Great!
```

#### 步骤 4: 重启终端并验证

打开新的 **命令提示符** 或 **PowerShell**:

```bash
rustc --version
# 输出示例: rustc 1.76.0 (07dca489a 2024-02-04)

cargo --version
# 输出示例: cargo 1.76.0 (c84b36747 2024-01-18)
```

---

### macOS 安装

#### 步骤 1: 打开终端

按 `Cmd + Space` 搜索 "Terminal" 并打开

#### 步骤 2: 运行安装命令

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

#### 步骤 3: 选择安装选项

```
1) Proceed with installation (default)
2) Customize installation
3) Cancel installation
```

**输入 `1` 并按 Enter**

#### 步骤 4: 配置环境变量

安装完成后，运行:
```bash
source $HOME/.cargo/env
```

或关闭终端重新打开。

#### 步骤 5: 验证安装

```bash
rustc --version
cargo --version
```

---

### Linux 安装 (Ubuntu/Debian 示例)

#### 步骤 1: 安装 Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

#### 步骤 2: 配置环境

```bash
source $HOME/.cargo/env
```

#### 步骤 3: 验证

```bash
rustc --version
cargo --version
```

---

## 安装系统依赖

不同操作系统需要不同的依赖库。

### Windows 依赖

#### 1. 安装 Microsoft Visual Studio C++ Build Tools

**下载地址**: [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)

**安装步骤**:
1. 运行下载的安装器
2. 选择 **"Desktop development with C++"** (桌面 C++ 开发)
3. 点击 "Install" 并等待完成（约 6GB，需 20-30 分钟）

#### 2. 安装 WebView2

Windows 10/11 通常已预装，如果没有:
- **下载地址**: [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)
- 下载 "Evergreen Standalone Installer" 并安装

#### 验证依赖

打开新的命令提示符，运行:
```bash
# 检查 C++ 编译器
cl
# 应该显示 Microsoft C/C++ 编译器信息
```

---

### macOS 依赖

#### 安装 Xcode Command Line Tools

```bash
xcode-select --install
```

会弹出安装对话框，点击 "Install" 并等待完成。

#### 验证

```bash
xcode-select -p
# 输出示例: /Library/Developer/CommandLineTools
```

---

### Linux 依赖 (Ubuntu/Debian)

#### 安装必需库

```bash
sudo apt update

sudo apt install -y \
    libwebkit2gtk-4.0-dev \
    build-essential \
    curl \
    wget \
    file \
    libssl-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev
```

#### Fedora/RHEL

```bash
sudo dnf install -y \
    webkit2gtk4.0-devel \
    openssl-devel \
    curl \
    wget \
    file \
    gtk3-devel \
    librsvg2-devel
```

#### Arch Linux

```bash
sudo pacman -Syu
sudo pacman -S --needed \
    webkit2gtk \
    base-devel \
    curl \
    wget \
    file \
    openssl \
    gtk3 \
    librsvg
```

---

## 安装 Node.js

Tauri 的前端部分需要 Node.js。

### 方式 1: 官方安装包（推荐新手）

访问 [https://nodejs.org/](https://nodejs.org/)

下载并安装 **LTS 版本**（长期支持版）

### 方式 2: 使用 nvm（推荐开发者）

**Windows (nvm-windows)**:
```bash
# 下载安装器: https://github.com/coreybutler/nvm-windows/releases
# 安装后运行:
nvm install 20
nvm use 20
```

**macOS/Linux**:
```bash
# 安装 nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

# 重启终端，然后:
nvm install 20
nvm use 20
```

### 验证安装

```bash
node --version
# 输出示例: v20.11.0

npm --version
# 输出示例: 10.2.4
```

---

## 创建第一个 Tauri 项目

现在所有依赖都已安装，开始创建项目！

### 方式 1: 使用官方脚手架（推荐）

```bash
# 运行创建命令
npm create tauri-app@latest
```

### 交互式配置

你会看到一系列问题:

```
✔ Project name · my-tauri-app
✔ Choose which language to use for your frontend · TypeScript
✔ Choose your package manager · npm
✔ Choose your UI template · React
✔ Choose your UI flavor · TypeScript
```

**推荐配置**:
- **Project name**: `my-tauri-app`（你的项目名）
- **Frontend language**: `TypeScript`（类型安全）
- **Package manager**: `npm`（最通用）
- **UI template**: `React` 或 `Vue`（看你喜好）
- **UI flavor**: `TypeScript`

### 进入项目目录

```bash
cd my-tauri-app
```

### 安装依赖

```bash
npm install
```

---

### 方式 2: 手动创建（学习用）

#### 1. 创建前端项目

```bash
# 使用 Vite 创建 React 项目
npm create vite@latest my-tauri-app -- --template react-ts
cd my-tauri-app
npm install
```

#### 2. 添加 Tauri

```bash
# 安装 Tauri CLI
npm install -D @tauri-apps/cli

# 安装 Tauri API
npm install @tauri-apps/api
```

#### 3. 初始化 Tauri

```bash
npm run tauri init
```

**配置问题回答**:
```
✔ What is your app name? · my-tauri-app
✔ What should the window title be? · My Tauri App
✔ Where are your web assets located? · ../dist
✔ What is the url of your dev server? · http://localhost:5173
✔ What is your frontend dev command? · npm run dev
✔ What is your frontend build command? · npm run build
```

---

## 项目结构说明

创建完成后，项目结构如下:

```
my-tauri-app/
│
├── src/                          # 前端源码目录
│   ├── App.tsx                   # React 主组件
│   ├── App.css                   # 样式文件
│   ├── main.tsx                  # 前端入口
│   └── assets/                   # 静态资源
│
├── src-tauri/                    # Tauri 后端目录 ⭐
│   ├── src/
│   │   └── main.rs              # Rust 主文件 ⭐⭐⭐
│   ├── Cargo.toml               # Rust 依赖配置
│   ├── Cargo.lock               # 依赖锁定文件
│   ├── tauri.conf.json          # Tauri 配置 ⭐⭐
│   ├── build.rs                 # 构建脚本
│   └── icons/                   # 应用图标
│       ├── icon.icns            # macOS 图标
│       ├── icon.ico             # Windows 图标
│       └── *.png                # 各种尺寸 PNG
│
├── public/                       # 公共资源
├── index.html                    # HTML 入口
├── package.json                  # Node.js 配置
├── tsconfig.json                 # TypeScript 配置
├── vite.config.ts                # Vite 配置
└── README.md                     # 项目说明
```

### 重要文件说明

#### `src-tauri/src/main.rs` (Rust 后端核心)

```rust
// 阻止在 Windows release 模式下显示控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// 定义一个可以被前端调用的命令
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

#### `src-tauri/tauri.conf.json` (Tauri 配置)

```json
{
  "build": {
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build",
    "devPath": "http://localhost:5173",
    "distDir": "../dist"
  },
  "package": {
    "productName": "my-tauri-app",
    "version": "0.0.0"
  },
  "tauri": {
    "allowlist": {
      "all": false,
      "shell": {
        "all": false,
        "open": true
      }
    },
    "windows": [
      {
        "fullscreen": false,
        "resizable": true,
        "title": "My Tauri App",
        "width": 800,
        "height": 600
      }
    ]
  }
}
```

#### `src/App.tsx` (前端主组件)

```tsx
import { useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import "./App.css";

function App() {
  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");

  async function greet() {
    // 调用 Rust 后端的 greet 函数
    setGreetMsg(await invoke("greet", { name }));
  }

  return (
    <div className="container">
      <h1>Welcome to Tauri!</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          greet();
        }}
      >
        <input
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="Enter a name..."
        />
        <button type="submit">Greet</button>
      </form>
      <p>{greetMsg}</p>
    </div>
  );
}

export default App;
```

---

## 运行开发服务器

### 启动开发模式

```bash
npm run tauri dev
```

### 首次运行

**第一次运行会比较慢（2-5 分钟）**，因为需要编译 Rust 代码:

```
   Compiling proc-macro2 v1.0.76
   Compiling quote v1.0.35
   Compiling unicode-ident v1.0.12
   ...
   Compiling tauri v1.5.4
   Compiling my-tauri-app v0.0.0
    Finished dev [unoptimized + debuginfo] target(s) in 3m 45s
```

**后续运行会很快（5-30 秒）**，只会编译修改的部分。

### 成功标志

看到以下输出表示成功:

```
> vite

  VITE v5.0.11  ready in 823 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
  ➜  press h + enter to show help
```

**应用窗口会自动弹出！** 🎉

### 热重载

开发模式支持热重载:
- **修改前端代码** (src/\*.tsx) → 窗口自动刷新
- **修改 Rust 代码** (src-tauri/src/\*.rs) → 自动重新编译

---

## 修改代码

### 示例 1: 修改窗口标题

编辑 `src-tauri/tauri.conf.json`:

```json
{
  "tauri": {
    "windows": [
      {
        "title": "我的第一个 Tauri 应用",  // 修改这里
        "width": 1000,                     // 调整宽度
        "height": 700                      // 调整高度
      }
    ]
  }
}
```

保存后，窗口会自动刷新并应用新标题。

---

### 示例 2: 添加新的 Rust 命令

编辑 `src-tauri/src/main.rs`:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// 新增：计算两个数的和
#[tauri::command]
fn add_numbers(a: i32, b: i32) -> i32 {
    a + b
}

// 新增：获取系统信息
#[tauri::command]
fn get_system_info() -> String {
    format!("运行在 {} 操作系统上", std::env::consts::OS)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            greet,
            add_numbers,      // 注册新命令
            get_system_info   // 注册新命令
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

---

### 示例 3: 在前端调用新命令

编辑 `src/App.tsx`:

```tsx
import { useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import "./App.css";

function App() {
  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");
  const [sum, setSum] = useState<number | null>(null);
  const [systemInfo, setSystemInfo] = useState("");

  async function greet() {
    setGreetMsg(await invoke("greet", { name }));
  }

  async function calculate() {
    const result = await invoke<number>("add_numbers", { a: 10, b: 20 });
    setSum(result);
  }

  async function fetchSystemInfo() {
    const info = await invoke<string>("get_system_info");
    setSystemInfo(info);
  }

  return (
    <div className="container">
      <h1>Welcome to Tauri!</h1>

      {/* 原有的问候功能 */}
      <div className="section">
        <h2>问候功能</h2>
        <form onSubmit={(e) => { e.preventDefault(); greet(); }}>
          <input
            onChange={(e) => setName(e.currentTarget.value)}
            placeholder="输入名字..."
          />
          <button type="submit">问候</button>
        </form>
        <p>{greetMsg}</p>
      </div>

      {/* 新增：计算功能 */}
      <div className="section">
        <h2>计算功能</h2>
        <button onClick={calculate}>计算 10 + 20</button>
        {sum !== null && <p>结果: {sum}</p>}
      </div>

      {/* 新增：系统信息 */}
      <div className="section">
        <h2>系统信息</h2>
        <button onClick={fetchSystemInfo}>获取系统信息</button>
        <p>{systemInfo}</p>
      </div>
    </div>
  );
}

export default App;
```

保存后，窗口会自动刷新，你可以测试新功能！

---

### 示例 4: 使用 Tauri 内置 API

编辑 `src/App.tsx`，添加文件操作功能:

```tsx
import { useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { open, save } from "@tauri-apps/api/dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/api/fs";
import "./App.css";

function App() {
  const [fileContent, setFileContent] = useState("");

  // 打开文件
  async function openFile() {
    const selected = await open({
      multiple: false,
      filters: [{
        name: "Text",
        extensions: ["txt"]
      }]
    });

    if (selected && typeof selected === 'string') {
      const content = await readTextFile(selected);
      setFileContent(content);
    }
  }

  // 保存文件
  async function saveFile() {
    const path = await save({
      filters: [{
        name: "Text",
        extensions: ["txt"]
      }]
    });

    if (path) {
      await writeTextFile(path, fileContent);
      alert("文件已保存！");
    }
  }

  return (
    <div className="container">
      <h1>文件编辑器</h1>
      
      <div className="buttons">
        <button onClick={openFile}>打开文件</button>
        <button onClick={saveFile}>保存文件</button>
      </div>

      <textarea
        value={fileContent}
        onChange={(e) => setFileContent(e.target.value)}
        placeholder="在这里编辑文本..."
        rows={20}
        cols={80}
      />
    </div>
  );
}

export default App;
```

**重要**: 需要在 `src-tauri/tauri.conf.json` 中启用权限:

```json
{
  "tauri": {
    "allowlist": {
      "all": false,
      "fs": {
        "all": true,
        "readTextFile": true,
        "writeTextFile": true,
        "scope": ["$APPDATA/*", "$HOME/*", "$DESKTOP/*"]
      },
      "dialog": {
        "all": true,
        "open": true,
        "save": true
      }
    }
  }
}
```

---

## 打包应用

准备好发布应用了吗？让我们打包！

### 构建生产版本

```bash
npm run tauri build
```

### 打包过程

**首次打包会比较慢（5-15 分钟）**:

```
    Updating crates.io index
  Downloaded ...
   Compiling ...
   Compiling my-tauri-app v0.0.0
    Finished release [optimized] target(s) in 8m 32s
    Bundling my-tauri-app.app (/path/to/src-tauri/target/release/bundle/macos)
    Bundling my-tauri-app_0.0.0_x64.dmg (/path/to/src-tauri/target/release/bundle/dmg)
       Done 🎉
```

### 输出文件位置

```
src-tauri/target/release/bundle/
```

### 各平台输出

#### Windows
```
bundle/
├── msi/
│   └── my-tauri-app_0.0.0_x64_en-US.msi    (安装包)
└── nsis/
    └── my-tauri-app_0.0.0_x64-setup.exe    (安装程序)
```

**文件大小**: 约 3-5 MB

#### macOS
```
bundle/
├── macos/
│   └── my-tauri-app.app                    (应用包)
└── dmg/
    └── my-tauri-app_0.0.0_x64.dmg         (磁盘镜像)
```

**文件大小**: 约 5-8 MB

#### Linux
```
bundle/
├── deb/
│   └── my-tauri-app_0.0.0_amd64.deb       (Debian/Ubuntu)
└── appimage/
    └── my-tauri-app_0.0.0_amd64.AppImage  (通用格式)
```

**文件大小**: 约 4-6 MB

### 分发给用户

将对应平台的安装包发送给用户:
- ✅ 用户双击安装即可
- ✅ 不需要 Rust 环境
- ✅ 不需要 Node.js
- ✅ 开箱即用！

---

## 常见问题

### Q1: 首次编译太慢怎么办？

**A**: 这是正常的，Rust 需要编译所有依赖库。

**加速方法（使用国内镜像）**:

编辑或创建文件 `~/.cargo/config.toml`:

```toml
[source.crates-io]
replace-with = 'ustc'

[source.ustc]
registry = "https://mirrors.ustc.edu.cn/crates.io-index"

# 或使用字节跳动镜像
[source.rsproxy]
registry = "https://rsproxy.cn/crates.io-index"

[registries.rsproxy]
index = "https://rsproxy.cn/crates.io-index"

[net]
git-fetch-with-cli = true
```

Windows 路径: `C:\Users\你的用户名\.cargo\config.toml`

---

### Q2: Windows 缺少 WebView2

**错误信息**:
```
Error: WebView2 Runtime is not installed
```

**解决方法**:
1. 下载 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)
2. 安装 "Evergreen Standalone Installer"

或在 `tauri.conf.json` 中配置自动下载:

```json
{
  "tauri": {
    "bundle": {
      "windows": {
        "webviewInstallMode": {
          "type": "downloadBootstrapper"
        }
      }
    }
  }
}
```

---

### Q3: 端口 5173 被占用

**错误信息**:
```
Error: Port 5173 is already in use
```

**解决方法**:

编辑 `vite.config.ts`:

```typescript
export default defineConfig({
  server: {
    port: 3000  // 改成其他端口
  }
})
```

同时修改 `src-tauri/tauri.conf.json`:

```json
{
  "build": {
    "devPath": "http://localhost:3000"
  }
}
```

---

### Q4: 修改 Rust 代码后不生效

**原因**: 可能需要完全重新编译。

**解决方法**:

```bash
# 停止开发服务器 (Ctrl+C)

# 清理构建缓存
cd src-tauri
cargo clean
cd ..

# 重新运行
npm run tauri dev
```

---

### Q5: Linux 上缺少依赖库

**错误示例**:
```
error: failed to run custom build command for `webkit2gtk-sys`
```

**解决方法**:

确保安装了所有必需的依赖（见 [安装系统依赖](#安装系统依赖)）。

Ubuntu/Debian:
```bash
sudo apt install libwebkit2gtk-4.0-dev \
    build-essential \
    libssl-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev
```

---

### Q6: macOS 代码签名问题

**错误信息**:
```
Error: Failed to sign application
```

**临时解决**（开发阶段）:

在 `src-tauri/tauri.conf.json` 中禁用代码签名:

```json
{
  "tauri": {
    "bundle": {
      "macOS": {
        "signingIdentity": null
      }
    }
  }
}
```

**生产环境**: 需要 Apple Developer 证书进行签名。

---

### Q7: 打包后体积太大

**问题**: 打包后超过 50MB

**可能原因**:
- 包含了过多的前端依赖
- 包含了开发依赖

**优化方法**:

1. 检查 `package.json`，确保开发依赖在 `devDependencies`
2. 压缩前端资源:

编辑 `vite.config.ts`:

```typescript
export default defineConfig({
  build: {
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true  // 移除 console.log
      }
    }
  }
})
```

3. 启用 Rust 优化（已默认启用）

---

### Q8: 如何调试 Rust 代码？

**方法 1**: 使用 `println!` 宏

```rust
#[tauri::command]
fn my_command(data: String) -> String {
    println!("收到数据: {}", data);  // 会在终端显示
    data
}
```

**方法 2**: 使用 `dbg!` 宏

```rust
#[tauri::command]
fn calculate(a: i32, b: i32) -> i32 {
    let sum = a + b;
    dbg!(&sum);  // 打印调试信息
    sum
}
```

**方法 3**: VS Code 调试器

安装 `rust-analyzer` 扩展，设置断点后按 F5 调试。

---

## 下一步学习

### 📚 官方文档

- **Tauri 官网**: [https://tauri.app/](https://tauri.app/)
- **API 文档**: [https://tauri.app/v1/api/](https://tauri.app/v1/api/)
- **示例项目**: [https://github.com/tauri-apps/tauri/tree/dev/examples](https://github.com/tauri-apps/tauri/tree/dev/examples)

### 🎓 Rust 学习资源

- **Rust 程序设计语言（中文）**: [https://kaisery.github.io/trpl-zh-cn/](https://kaisery.github.io/trpl-zh-cn/)
- **Rust by Example**: [https://rustwiki.org/zh-CN/rust-by-example/](https://rustwiki.org/zh-CN/rust-by-example/)
- **Rust 语言圣经**: [https://course.rs/](https://course.rs/)

### 🛠️ 进阶主题

1. **使用插件系统**
   - [官方插件列表](https://github.com/tauri-apps/plugins-workspace)
   - SQL 数据库 (tauri-plugin-sql)
   - 文件系统扩展 (tauri-plugin-fs-extra)
   - 通知 (tauri-plugin-notification)

2. **自定义窗口**
   - 无边框窗口
   - 自定义标题栏
   - 系统托盘

3. **多窗口应用**
   ```rust
   use tauri::{Manager, WindowBuilder};
   
   #[tauri::command]
   fn open_new_window(app: tauri::AppHandle) {
       WindowBuilder::new(
           &app,
           "new-window",
           tauri::WindowUrl::App("index.html".into())
       )
       .title("新窗口")
       .build()
       .unwrap();
   }
   ```

4. **应用更新**
   - 使用 `tauri-plugin-updater`
   - 实现自动更新功能

5. **性能优化**
   - 代码分割
   - 懒加载
   - WebAssembly 集成

### 🎯 实战项目建议

- **入门**: Todo List 应用
- **进阶**: Markdown 编辑器
- **高级**: 文件管理器
- **专家**: 音视频播放器

### 💬 社区支持

- **Discord**: [https://discord.gg/tauri](https://discord.gg/tauri)
- **GitHub Discussions**: [https://github.com/tauri-apps/tauri/discussions](https://github.com/tauri-apps/tauri/discussions)
- **Stack Overflow**: 搜索 `[tauri]` 标签

---

## 🎉 总结

恭喜你完成了 Tauri + Rust 的初始化！

现在你已经:
- ✅ 安装了 Rust 开发环境
- ✅ 配置了所有必需的系统依赖
- ✅ 创建了第一个 Tauri 项目
- ✅ 理解了项目结构
- ✅ 学会了前后端通信
- ✅ 能够打包发布应用

**下一步**:
1. 修改示例代码，尝试不同功能
2. 阅读 Tauri 官方文档
3. 学习 Rust 基础语法
4. 构建你的第一个真实应用！

---

## 📝 快速参考

### 常用命令

```bash
# 开发模式
npm run tauri dev

# 打包应用
npm run tauri build

# 更新依赖
cargo update          # Rust 依赖
npm update            # Node.js 依赖

# 清理缓存
cargo clean           # 清理 Rust 编译缓存
npm run clean         # 清理 Node.js 缓存
```

### 项目模板

```bash
# React + TypeScript
npm create tauri-app -- --template react-ts

# Vue + TypeScript  
npm create tauri-app -- --template vue-ts

# Svelte + TypeScript
npm create tauri-app -- --template svelte-ts

# Vanilla JS
npm create tauri-app -- --template vanilla
```

### 有用的 Rust Crates

```toml
# 在 src-tauri/Cargo.toml 中添加

[dependencies]
serde = { version = "1.0", features = ["derive"] }  # 序列化
serde_json = "1.0"                                   # JSON 处理
tokio = { version = "1", features = ["full"] }       # 异步运行时
reqwest = "0.11"                                     # HTTP 客户端
sqlx = "0.7"                                         # 数据库
```

---

**文档版本**: v1.0.0  
**最后更新**: 2025-03-05  
**适用于**: Tauri v1.5+, Rust 1.70+

如有问题或建议，欢迎在 GitHub 上提交 Issue！
