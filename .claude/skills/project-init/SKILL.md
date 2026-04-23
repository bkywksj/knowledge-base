---
name: project-init
description: |
  当用户需要基于本 Tauri 框架创建新项目时自动使用此 Skill。提供完整的交互式项目初始化流程：模板更新检测、项目信息收集、目录创建、标识符替换、Git 仓库创建、签名密钥生成、启动引导。

  触发场景：
  - 用户说"我要开发一个新项目"或"创建一个新项目"
  - 需要基于 Tauri 框架模板初始化新的桌面应用
  - 需要修改项目标识符、名称和配置
  - 需要为新项目创建 Git 仓库并推送代码

  触发词：新项目、创建项目、初始化项目、开新项目、项目初始化、new project、init project、新建项目、开发新项目
---

# 新项目初始化指南

## 概述

本技能用于基于 Tauri 桌面应用框架（模板仓库）创建全新的独立项目。**模板仓库始终保持不变**，所有操作在新目录中进行，支持反复创建新项目。

**核心理念**：模板仓库 = 只读源 → 复制到新目录 → 在新目录中初始化

**完整流程**：

```
阶段零：环境准备（交互式）
├── 0.1 检测模板仓库更新（git fetch）
├── 0.2 收集项目基本信息（名称/标识符/包名）
├── 0.3 收集发布配置（Git 仓库/更新地址）
└── 0.4 配置确认汇总

阶段一：创建新项目目录
├── 1.1 git archive 导出到新目录
├── 1.2 在新目录初始化 Git
└── 1.3 清理不需要的文件

阶段二：代码初始化（全局替换）
├── 2.1 替换产品名称（Agile Tauri → 新名称）
├── 2.2 替换应用标识符（com.agilefr.tauri → 新标识符）
├── 2.3 替换包名（tauri/tauri_lib → 新包名）
├── 2.4 替换作者和描述
├── 2.5 配置更新地址和签名
├── 2.6 更新框架文档中的引用
└── 2.7 验证替换结果

阶段三：Git 提交 & 推送
├── 3.1 初始提交
├── 3.2 关联远程仓库
└── 3.3 推送代码

阶段四：应用图标（可选）
├── 4.1 提示用户准备图标
└── 4.2 生成多尺寸图标

阶段五：启动引导
├── 5.1 安装依赖
├── 5.2 启动开发模式
└── 5.3 验证运行
```

---

## 阶段零：环境准备（交互式）

### Step 0.1：检测模板仓库更新

在模板仓库目录中执行：

```bash
# 拉取远程最新信息（仅元数据，不修改本地文件）
git fetch origin

# 检查与远程的差异
BEHIND=$(git rev-list HEAD..origin/master --count 2>/dev/null)
if [ "$BEHIND" -gt 0 ]; then
  echo "模板仓库有 $BEHIND 个新提交："
  git log HEAD..origin/master --oneline --no-merges
else
  echo "模板仓库已是最新"
fi
```

**展示更新摘要**：

```
模板仓库更新检测：

  master — 有 3 个新提交（最近：feat(rust): 添加文件管理模块...）

是否拉取最新代码？（推荐：是）
```

如果用户确认拉取：

```bash
git pull origin master
```

### Step 0.2：收集项目基本信息

**必须一次性询问用户以下信息**：

```
请提供新项目的基本信息：

1. 项目描述：开发什么应用？（简要描述业务场景）
2. 产品名称：应用窗口标题（英文，如 "Mall Admin"、"IoT Monitor"）
3. 产品名缩写：侧边栏折叠时显示（2-3 字母，如 "MA"、"IM"）
4. 应用标识符：反向域名格式（如 "com.mycompany.mall"）
5. 包名：用于 Cargo/npm（snake_case，如 "mall_admin"）
6. 作者：（如 "Zhang San"）

或者只告诉我项目名称，我来推荐配置。
```

**根据项目描述自动推荐**：

| 项目描述 | 推荐产品名 | 缩写 | 标识符 | 包名 |
|---------|-----------|------|--------|------|
| 电商管理系统 | Mall Admin | MA | com.company.mall | mall_admin |
| 物联网监控 | IoT Monitor | IM | com.company.iot | iot_monitor |
| CRM 客户管理 | CRM System | CS | com.company.crm | crm_system |
| 内部办公 | OA Office | OA | com.company.oa | oa_office |
| 博客管理 | Blog Admin | BA | com.company.blog | blog_admin |

**推荐话术示例**：

```
根据您的项目「电商管理系统」，建议配置：

- 产品名称：Mall Admin
- 产品名缩写：MA
- 应用标识符：com.company.mall
- 包名：mall_admin
- 作者：you

请确认或自定义。
```

**标识符/包名规则**：
- 应用标识符：反向域名格式，仅英文字母和点，全小写
- 包名：仅英文字母和下划线，全小写，不超过 20 字符
- 包名同时也是新项目的**目录名**

### Step 0.3：收集发布配置

**必须询问用户**：

```
请选择 Git 仓库方式：
1. 提供已有的仓库地址（Gitee/GitHub）
2. 稍后手动创建

更新服务配置（用于应用自动更新）：
1. 提供 release 仓库地址（如 https://gitee.com/user/myapp-release）
2. 稍后配置（更新功能暂不可用）
```

> **说明**：本框架使用 Gitee/GitHub 静态文件托管 update.json 作为更新端点。
> release 仓库是独立的仓库，CI 构建完成后自动推送安装包和 update.json 到该仓库。

### Step 0.4：配置确认汇总

在开始执行前，向用户展示完整的配置汇总：

```
━━━━━━━━━━ 项目初始化配置确认 ━━━━━━━━━━

  产品名称：Mall Admin
  产品名缩写：MA
  应用标识符：com.company.mall
  包名：mall_admin
  Cargo lib 名：mall_admin_lib
  作者：Zhang San

  新目录：{模板仓库同级}/mall_admin
  Git 仓库：https://gitee.com/user/mall_admin.git
  Release 仓库：https://gitee.com/user/mall_admin-release.git

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

确认无误后开始初始化？(Y/n)
```

---

## 阶段一：创建新项目目录

### Step 1.1：使用 git archive 导出到新目录

**核心命令**：`git archive` 从当前分支导出文件，**无需切换分支**，自动排除 `.git/` 和未跟踪文件。

```bash
TEMPLATE_DIR="$(pwd)"
PARENT_DIR="$(dirname "$TEMPLATE_DIR")"
NEW_DIR="$PARENT_DIR/{包名}"

# 检查新目录是否已存在
if [ -d "$NEW_DIR" ]; then
  echo "目录 $NEW_DIR 已存在！请确认是否覆盖。"
  exit 1
fi

# 创建新目录并导出
mkdir -p "$NEW_DIR"
cd "$TEMPLATE_DIR"
git archive HEAD | tar -x -C "$NEW_DIR"
```

**git archive 的优势**：

| 对比项 | git archive | 手动复制 |
|--------|-------------|---------|
| 是否需要切换分支 | 不需要 | 不需要 |
| 是否排除 .git/ | 自动排除 | 需手动排除 |
| 是否排除 node_modules/ | 自动排除（未跟踪） | 需手动排除 |
| 是否排除 .claude/projects/ | 自动排除（未跟踪） | 需手动排除 |
| Windows 兼容性 | Git Bash 自带 | 需要 robocopy |
| 模板仓库是否受影响 | 完全不受影响 | 完全不受影响 |

**自动排除的内容**（未被 git 跟踪）：

| 排除项 | 原因 |
|--------|------|
| `.git/` | git archive 不导出 .git 目录 |
| `node_modules/` | 在 .gitignore 中 |
| `src-tauri/target/` | 在 .gitignore 中 |
| `.claude/projects/` | 个人 memory 数据，未跟踪 |
| `dist/` | 构建产物，未跟踪 |

**自动包含的内容**（已被 git 跟踪）：

| 保留项 | 原因 |
|--------|------|
| `.claude/skills/` | 项目级技能，新项目同样需要 |
| `.claude/commands/` | 项目级命令 |
| `.claude/hooks/` | Hook 配置 |
| `CLAUDE.md` | 项目规范文档 |
| `.github/workflows/` | CI 配置 |

### Step 1.2：在新目录初始化 Git 并关联模板仓库

```bash
cd "$NEW_DIR"
git init
git checkout -b master

# 将模板仓库设置为 upstream remote，方便后续对比框架更新
# 获取模板仓库的 remote URL（自动检测）
TEMPLATE_REMOTE=$(cd "$TEMPLATE_DIR" && git remote get-url origin 2>/dev/null)
if [ -n "$TEMPLATE_REMOTE" ]; then
  git remote add upstream "$TEMPLATE_REMOTE"
  echo "已设置 upstream: $TEMPLATE_REMOTE"
fi
```

> **默认使用全新 Git 历史**：新项目不需要框架的开发历史，一个干净的初始提交更合理。
>
> **upstream 的作用**：新项目通过 `upstream` remote 关联模板仓库，日后可以方便地对比框架更新：
> ```bash
> # 查看模板仓库有哪些新提交
> git fetch upstream
> git log master..upstream/master --oneline
>
> # 对比具体差异
> git diff master...upstream/master
>
> # 选择性合并框架更新（谨慎操作）
> git cherry-pick <commit-hash>
> ```

### Step 1.3：清理不需要的文件

```bash
cd "$NEW_DIR"

# 删除 Cargo.lock（新包名后需要重新生成）
rm -f src-tauri/Cargo.lock

# 删除模板仓库的 CI 发布配置（如果 release 仓库不同需要重新配置）
# 注意：.github/workflows/release.yml 保留，但需要在阶段二中更新配置
```

---

## 阶段二：代码初始化（在新目录中执行）

> **以下所有操作都在新目录 `{NEW_DIR}` 中执行，不要在模板目录中操作！**

### 旧值映射表

| 属性 | 旧值 | 说明 |
|------|------|------|
| **产品名称** | `Agile Tauri` | 窗口标题、托盘提示、页面标题 |
| **产品名缩写** | `AT` | 侧边栏折叠时显示 |
| **应用标识符** | `com.agilefr.tauri` | Tauri identifier |
| **Cargo 包名** | `tauri` | Cargo.toml [package].name |
| **Cargo lib 名** | `tauri_lib` | Cargo.toml [lib].name |
| **npm 包名** | `tauri` | package.json name |
| **作者** | `you` | Cargo.toml authors |
| **描述** | `A Tauri App` | Cargo.toml description |
| **更新地址** | `https://gitee.com/<用户名>/<项目名>-release/raw/master/update.json` | 更新端点占位符 |
| **签名公钥** | `YOUR_UPDATER_PUBKEY_HERE` | 更新签名占位符 |

### Step 2.1：替换产品名称

将 `Agile Tauri` → `{新产品名}`

**精确文件列表**：

| 文件 | 替换内容 | 说明 |
|------|---------|------|
| `src-tauri/tauri.conf.json` | `"productName": "Agile Tauri"` → `"productName": "{新产品名}"` | 安装包名称 |
| `src-tauri/tauri.conf.json` | `"title": "Agile Tauri"` → `"title": "{新产品名}"` | 窗口标题 |
| `src-tauri/src/tray.rs` | `.tooltip("Agile Tauri")` → `.tooltip("{新产品名}")` | 托盘提示文字 |
| `index.html` | `<title>Agile Tauri</title>` → `<title>{新产品名}</title>` | 页面标题 |
| `src/components/layout/Sidebar.tsx` | `"Agile Tauri"` → `"{新产品名}"` | 侧边栏展开时名称 |
| `src/pages/home/index.tsx` | `Agile Tauri` 相关描述文字 | 首页欢迎语 |

**替换产品名缩写**：

| 文件 | 替换内容 | 说明 |
|------|---------|------|
| `src/components/layout/Sidebar.tsx` | `"AT"` → `"{新缩写}"` | 侧边栏折叠时显示 |

### Step 2.2：替换应用标识符

将 `com.agilefr.tauri` → `{新标识符}`

**精确文件列表**：

| 文件 | 替换内容 | 说明 |
|------|---------|------|
| `src-tauri/tauri.conf.json` | `"identifier": "com.agilefr.tauri"` → `"identifier": "{新标识符}"` | 应用唯一标识 |
| `CLAUDE.md` | `com.agilefr.tauri` → `{新标识符}` | 文档中的引用 |
| `.claude/commands/progress.md` | `com.agilefr.tauri` → `{新标识符}` | 进度报告模板 |
| `.claude/commands/start.md` | `com.agilefr.tauri` → `{新标识符}` | 项目介绍模板 |

> **注意**：`.claude/skills/` 中的技能文档如果包含 `com.agilefr.tauri` 作为示例引用，**不需要替换**。

### Step 2.3：替换包名

将 `tauri` / `tauri_lib` → `{新包名}` / `{新包名}_lib`

**精确文件列表**：

| 文件 | 旧值 | 新值 | 说明 |
|------|------|------|------|
| `src-tauri/Cargo.toml` | `name = "tauri"` | `name = "{新包名}"` | Cargo 包名 |
| `src-tauri/Cargo.toml` | `name = "tauri_lib"` | `name = "{新包名}_lib"` | Cargo lib 名 |
| `src-tauri/src/main.rs` | `tauri_lib::run()` | `{新包名}_lib::run()` | lib 调用 |
| `package.json` | `"name": "tauri"` | `"name": "{新包名}"` | npm 包名 |

> **替换顺序**：**先替换 `tauri_lib`（长）再替换包名级别的 `tauri`（短）**，避免 `tauri_lib` 被部分匹配为 `{新包名}_lib`。
>
> **特别注意**：`Cargo.toml` 中的 `tauri = { version = "2" }` 是依赖声明，**绝对不能替换**！只替换 `[package]` 下的 `name` 和 `[lib]` 下的 `name`。使用精确匹配（如 `name = "tauri"` 而非全局替换 `tauri`）。

### Step 2.4：替换作者和描述

| 文件 | 旧值 | 新值 | 说明 |
|------|------|------|------|
| `src-tauri/Cargo.toml` | `authors = ["you"]` | `authors = ["{新作者}"]` | 开发者 |
| `src-tauri/Cargo.toml` | `description = "A Tauri App"` | `description = "{新描述}"` | 项目描述 |

### Step 2.5：配置更新地址和签名

#### 更新地址

| 文件 | 替换内容 | 说明 |
|------|---------|------|
| `src-tauri/tauri.conf.json` | `updater.endpoints` 数组 | 替换为实际 release 仓库的 raw 地址 |

**根据用户提供的 release 仓库生成地址**：

| 平台 | URL 格式 |
|------|---------|
| Gitee | `https://gitee.com/{user}/{repo}/raw/master/update.json` |
| GitHub | `https://raw.githubusercontent.com/{user}/{repo}/master/update.json` |

**如果用户选择"稍后配置"**，保留占位符不替换。

#### 签名密钥

**询问用户是否现在生成签名密钥对**：

```
是否现在生成更新签名密钥对？
1. 是（推荐，自动生成并配置）
2. 稍后手动生成

注意：签名密钥用于验证应用更新包的安全性。
私钥需妥善保管，不可提交到代码仓库。
```

**如果用户选择生成**：

```bash
cd "$NEW_DIR"

# 生成密钥对（保存到用户目录）
pnpm tauri signer generate -w ~/.tauri/{新包名}.key

# 输出的公钥需要填入 tauri.conf.json 的 updater.pubkey
```

将生成的公钥写入 `tauri.conf.json` 的 `updater.pubkey`。

**如果用户选择稍后**，保留 `YOUR_UPDATER_PUBKEY_HERE` 占位符。

### Step 2.6：更新框架文档中的引用

以下文件需要更新项目名称和标识符引用：

| 文件 | 需要更新的内容 |
|------|--------------|
| `CLAUDE.md` | 应用标识 `com.agilefr.tauri` → 新标识符 |
| `.claude/commands/progress.md` | 应用标识引用 |
| `.claude/commands/start.md` | 应用标识引用 |

> **注意**：CLAUDE.md 中大量内容是通用的架构文档，只需要替换具体的标识符值，不要改动架构说明。

### Step 2.7：验证替换结果

```bash
cd "$NEW_DIR"

# 验证旧产品名已全部替换
grep -rn "Agile Tauri" \
  --include="*.json" --include="*.ts" --include="*.tsx" --include="*.rs" \
  --include="*.html" --include="*.css" --include="*.md" \
  --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=target .

# 验证旧标识符已全部替换
grep -rn "com\.agilefr\.tauri" \
  --include="*.json" --include="*.ts" --include="*.tsx" --include="*.rs" \
  --include="*.html" --include="*.md" \
  --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=target .

# 验证包名替换（精确匹配，排除依赖声明）
# 检查 main.rs 中的 lib 调用
grep -n "tauri_lib" src-tauri/src/main.rs

# 检查 Cargo.toml 的 [package] name
head -5 src-tauri/Cargo.toml
```

**允许残留的位置**（不需要替换）：
- `.claude/skills/*/SKILL.md` — 技能文档中的示例引用
- `Cargo.toml` 的 `[dependencies]` — `tauri = { version = "2" }` 是依赖名
- `Cargo.lock` — 已在 Step 1.3 删除，会自动重新生成

**如果还有残留**，需要补充替换。

---

## 阶段三：Git 提交 & 推送

### Step 3.1：初始提交

```bash
cd "$NEW_DIR"

git add -A
git commit -m "init: 基于 Tauri 桌面应用框架初始化 {产品名称}"
```

### Step 3.2：关联远程仓库并推送

```bash
# 添加用户自己的远程仓库（origin）
git remote add origin {用户提供的仓库地址}

# 推送到远程
git push -u origin master
```

> **Remote 命名约定**：
> - `origin` — 用户自己的项目仓库（推送代码用）
> - `upstream` — 模板框架仓库（对比更新用，已在 Step 1.2 自动设置）
>
> 可通过 `git remote -v` 确认两个 remote 都已正确配置。

> **如果用户选择"稍后手动创建"**，跳过推送步骤，提示：
> ```
> Git 仓库已本地初始化。创建远程仓库后，执行：
> cd {NEW_DIR}
> git remote add origin {仓库地址}
> git push -u origin master
>
> 模板仓库已关联为 upstream，可随时对比框架更新：
> git fetch upstream && git log master..upstream/master --oneline
> ```

---

## 阶段四：应用图标（可选）

### Step 4.1：提示用户准备图标

```
应用图标配置（可稍后处理）：

当前使用默认 Tauri 图标。如需自定义：

1. 准备一张 1024x1024 的 PNG 图片（方形，透明背景推荐）
2. 执行以下命令自动生成所有尺寸：

   cd {NEW_DIR}
   pnpm tauri icon path/to/icon-1024x1024.png

3. 图标会自动生成到 src-tauri/icons/ 目录

生成的图标：
  - icon.ico      (Windows)
  - icon.icns     (macOS)
  - 32x32.png     (通用)
  - 128x128.png   (通用)
  - 128x128@2x.png (HiDPI)
```

---

## 阶段五：启动引导

### Step 5.1：提示启动步骤

```
项目初始化完成！按以下步骤启动：

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  项目目录：{NEW_DIR}

  1. 安装依赖
     cd {NEW_DIR}
     pnpm install

  2. 启动开发模式（前端 HMR + Rust 热编译）
     pnpm tauri dev

  3. 访问应用
     应用窗口会自动打开
     前端开发地址：http://localhost:1420

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  后续常用命令：
  - pnpm tauri dev      — 开发模式
  - pnpm tauri build    — 构建安装包
  - npx tsc --noEmit    — TypeScript 类型检查
  - cd src-tauri && cargo clippy  — Rust 代码检查

  环境要求：
  - Node.js 18+
  - pnpm 8+
  - Rust (rustup)
  - 系统 WebView2 (Windows 自带)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 完整替换清单（精确文件 + 位置）

### 产品名称替换（Agile Tauri → {新产品名}）

```
src-tauri/tauri.conf.json:3     → "productName": "{新产品名}"
src-tauri/tauri.conf.json:15    → "title": "{新产品名}"
src-tauri/src/tray.rs:18        → .tooltip("{新产品名}")
index.html:7                    → <title>{新产品名}</title>
src/components/layout/Sidebar.tsx:34  → "{新产品名}"（展开时）
src/pages/home/index.tsx:28     → 欢迎语中的产品名
```

### 产品名缩写替换（AT → {新缩写}）

```
src/components/layout/Sidebar.tsx:34  → "{新缩写}"（折叠时）
```

### 应用标识符替换（com.agilefr.tauri → {新标识符}）

```
src-tauri/tauri.conf.json:5     → "identifier": "{新标识符}"
CLAUDE.md:35                    → 应用标识表格
.claude/commands/progress.md:221 → 应用标识引用
.claude/commands/start.md:70    → 应用标识引用
```

### 包名替换

> **必须精确匹配，不可全局替换 `tauri` 一词！**

```
# 先替换长的（tauri_lib → {包名}_lib）
src-tauri/Cargo.toml:14         → name = "{包名}_lib"
src-tauri/src/main.rs:5         → {包名}_lib::run()

# 再替换短的（仅 [package].name 和 package.json name）
src-tauri/Cargo.toml:2          → name = "{包名}"
package.json:2                  → "name": "{包名}"
```

### 作者和描述替换

```
src-tauri/Cargo.toml:4          → description = "{新描述}"
src-tauri/Cargo.toml:5          → authors = ["{新作者}"]
```

### 更新配置替换

```
src-tauri/tauri.conf.json:30    → "endpoints": ["{新更新地址}"]
src-tauri/tauri.conf.json:31    → "pubkey": "{新公钥}"（或保留占位符）
```

### 不需要替换的文件

以下文件包含旧值但**不应替换**：

```
.claude/skills/*/SKILL.md              — 技能文档中的示例引用
src-tauri/Cargo.toml [dependencies]    — tauri = { version = "2" } 是依赖名
src-tauri/Cargo.lock                   — 已删除，自动重新生成
```

---

## 注意事项

### 1. 模板仓库保持不变 & upstream 关联

所有修改操作都在新目录中进行，模板仓库仅作为只读源。好处：
- 可反复创建新项目，无需重新克隆
- 模板仓库可随时拉取上游更新
- 多个新项目可共用同一个模板

**新项目的 remote 布局**：
```
origin   → 用户自己的项目仓库（日常推送）
upstream → 模板框架仓库（对比框架更新）
```

**框架更新对比工作流**：
```bash
# 1. 拉取模板仓库最新变更
git fetch upstream

# 2. 查看框架有哪些新提交
git log master..upstream/master --oneline

# 3. 查看具体文件差异
git diff master...upstream/master -- src-tauri/src/

# 4. 选择性合并（推荐 cherry-pick 而非 merge，避免冲突）
git cherry-pick <commit-hash>
```

> **注意**：由于新项目做了标识符替换，直接 `git merge upstream/master` 会产生大量冲突。推荐用 `cherry-pick` 或手动对比后逐个应用。

### 2. 包名替换的陷阱

`tauri` 这个词在项目中有两种含义：
- **包名**（`Cargo.toml [package].name`、`package.json name`）→ 需要替换
- **框架依赖名**（`tauri = { version = "2" }`、`use tauri::`、`@tauri-apps/`）→ **绝对不能替换**

因此**禁止全局替换 `tauri` 一词**，必须使用精确匹配：
- `name = "tauri"` → `name = "{包名}"`（只匹配 Cargo.toml 的 name 字段）
- `"name": "tauri"` → `"name": "{包名}"`（只匹配 package.json 的 name 字段）
- `tauri_lib` → `{包名}_lib`（这个可以全局替换，因为是自定义的 lib 名）

### 3. Cargo.lock 处理

删除旧的 `Cargo.lock`，首次 `cargo build` 或 `pnpm tauri dev` 时会自动重新生成，包含正确的新包名。

### 4. 替换顺序（先长后短）

```
1. tauri_lib    → {包名}_lib      （最长，先替换）
2. Agile Tauri  → {新产品名}       （含空格的完整名称）
3. com.agilefr.tauri → {新标识符}  （应用标识符）
4. name = "tauri" → name = "{包名}" （精确匹配包名）
5. AT           → {新缩写}         （最短，最后替换）
```

### 5. 签名密钥安全

- **私钥（.key 文件）**：保存在 `~/.tauri/` 目录，**绝对不可提交到 Git**
- **公钥**：写入 `tauri.conf.json`，可以公开
- CI 构建时通过 `TAURI_SIGNING_PRIVATE_KEY` 环境变量传入私钥

### 6. Windows 兼容性

- 使用 `git archive` 导出文件，Git Bash 自带 tar
- 路径使用正斜杠 `/`（Git Bash 环境）
- 不使用 `> nul`，使用 `> /dev/null 2>&1`

### 7. SQLite 数据库无需手动初始化

与 ruoyi-plus-uniapp 不同，本框架的 SQLite 数据库由 `database/schema.rs` 中的迁移逻辑在首次启动时**自动创建**，无需手动导入 SQL 文件。

---

## 常见问题

### Q1: 标识符可以包含横线吗？

**A:** 应用标识符（`com.company.app`）只能用点分隔。包名建议用下划线 `_`，横线在 Rust crate 名中会自动转为下划线。

### Q2: 模板仓库有本地修改怎么办？

**A:** `git archive` 从 Git 仓库中导出已提交的文件，不受工作区修改影响，模板仓库完全不会被改动。

### Q3: 替换后 Cargo 编译报错？

**A:** 最常见原因：
1. 包名替换不完整 — 检查 `main.rs` 中的 lib 调用是否已更新
2. 全局替换了依赖名 — `tauri = { version = "2" }` 中的 `tauri` 不能改
3. Cargo.lock 未删除 — 删除后重新编译

### Q4: 新目录已存在怎么办？

**A:** Step 1.1 会检测目标目录是否存在。如果已存在，提示用户确认是否覆盖或使用其他包名。

### Q5: 可以同时创建多个项目吗？

**A:** 可以。每次运行初始化流程都会创建一个新的同级目录，互不影响。模板仓库始终不变。

### Q6: 更新功能可以后续再配置吗？

**A:** 可以。保留 `YOUR_UPDATER_PUBKEY_HERE` 占位符，应用仍可正常运行，只是自动更新功能暂不可用。后续生成密钥并配置即可。
