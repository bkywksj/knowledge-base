---
name: git-workflow
description: |
  Git 工作流与版本管理技能，规范分支策略、提交信息和发布流程。

  触发场景：
  - 用户需要创建分支或合并代码
  - 用户需要规范提交信息格式
  - 用户需要管理版本发布流程

  触发词：Git、分支、提交、合并、版本发布
---

# Git 工作流与版本管理

## 概述

Tauri Desktop App 的 Git 工作流与版本管理技能，规范分支命名、提交信息格式和发布流程。

---

## 🔴 双远端架构（knowledge_base 项目）

本项目有三个远端（`git remote -v`）：

| remote | 角色 | 定位 |
|--------|------|------|
| **`origin`** | **Gitee (`gitee.com/bkywksj/knowledge-base`)** | 国内主仓 |
| **`github`** | **GitHub (`github.com/bkywksj/knowledge-base`)** | CI 构建源 + 海外开源镜像 |
| `upstream` | 原 tauri 框架模板 | 极少用，仅在同步模板时拉取 |

### 历史已对齐（v1.3.0 起）

v1.3.0 发布时（2026-04-26）已经把 GitHub 历史 force-sync 到 Gitee，**两端 commit hash 完全一致、共享 git 祖先**，从此可以走标准 git workflow，**不再需要 cherry-pick 同步**。

> 备份分支 `backup-before-gh-sync-v1.3.0` 还留在 Gitee 上，万一以后发现丢了什么内容可以从这里救回来。

---

## 🔴 提交推送规则（knowledge_base 项目）

### 「日常 commit」— 用户说"提交推送"时

**默认两端都推**（两端历史已统一，没有任何冲突风险）：

```bash
git push origin master       # Gitee 主仓
git push github master       # GitHub（CI 触发源 + 海外镜像）
```

如果用户只说"推 Gitee"，按字面只推 origin。

### 「发布版本」— 调 /release 时

走下方"发布流程"章节；tag 同时推两端，CI 会从 GitHub 端打 tag 触发构建。

### ⛔ 注意事项

1. **不要在 master 上直接 force push**（除非你像 v1.3.0 那种明确做"两端历史合并"，且已备份）
2. 推送前 fetch 双端确认本地是最新的，避免覆盖另一端有但本地没有的 commit

---

## 分支策略

### 分支命名规范

| 分支类型 | 命名格式 | 示例 |
|---------|---------|------|
| 主分支 | `master` / `main` | `master` |
| 开发分支 | `dev` | `dev` |
| 功能分支 | `feature/{功能名}` | `feature/file-manager` |
| 修复分支 | `fix/{问题描述}` | `fix/window-resize-crash` |
| 发布分支 | `release/v{版本}` | `release/v0.2.0` |

---

## 提交信息规范

### Conventional Commits

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Type 定义

| Type | 说明 | 示例 |
|------|------|------|
| `feat` | 新功能 | `feat(rust): 添加文件读写 Command` |
| `fix` | 修复 Bug | `fix(react): 修复状态更新不生效` |
| `refactor` | 重构 | `refactor(rust): 重构错误处理为 thiserror` |
| `docs` | 文档 | `docs: 更新 README` |
| `style` | 格式 | `style(rust): cargo fmt 格式化` |
| `test` | 测试 | `test(rust): 添加 Command 单元测试` |
| `chore` | 杂务 | `chore: 更新 Cargo.toml 依赖` |
| `build` | 构建 | `build: 配置 Tauri 打包参数` |

### Scope 建议

| Scope | 说明 |
|-------|------|
| `rust` | Rust 后端代码 |
| `react` | React 前端代码 |
| `tauri` | Tauri 配置 (tauri.conf.json) |
| `caps` | Capabilities 权限配置 |
| `deps` | 依赖更新 |

---

## 发布流程（CI 全自动模式）

> 项目已配置 GitHub Actions CI，**本地不需要执行 `pnpm tauri build`**。
> 使用 `/release` 命令可自动完成全部发布流程。

```
1. 更新版本号（三处同步）
   - package.json: version
   - src-tauri/Cargo.toml: version
   - src-tauri/tauri.conf.json: version
2. 更新 release 仓库 README.md（下载链接 + 版本历史）
3. 提交并推送 release 仓库 README 变更
4. 提交源码仓库 + 推送到 GitHub
5. 打 Git Tag（v*.*.* 格式）并推送
   → 自动触发 GitHub Actions CI
   → CI 构建 Windows/macOS/Linux 三平台安装包
   → CI 自动推送产物 + update.json 到 release 仓库
```

### 快速发布

```bash
# 使用 /release 命令一键发布
/release
```

### 手动发布（备用）

```bash
# 1. 更新版本号后提交
git add src-tauri/tauri.conf.json src-tauri/Cargo.toml package.json
git commit -m "release: vX.Y.Z"

# 2. 推送到 GitHub
git push <github_remote> <主分支>

# 3. 打 Tag 触发 CI
git tag vX.Y.Z
git push <github_remote> vX.Y.Z
```

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 直接在 master 上开发 | 创建功能分支开发 |
| 提交信息写"修改代码" | 按 Conventional Commits 规范编写 |
| 版本号只改 package.json | 同步修改 Cargo.toml 和 tauri.conf.json |
| 提交 target/ 编译产物 | 确保 .gitignore 正确配置 |
