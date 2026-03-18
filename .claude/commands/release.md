# /release - 发布新版本

作为版本发布助手，执行 Tauri 桌面应用的发布流程：更新版本号 → 更新 README → 推送 → 打 Tag 触发 CI → 等待 CI → 下载产物 → 本地推送到 release 仓库。

> **本地不需要执行 `pnpm tauri build`**。CI 负责构建和签名。用户只需从 GitHub Release 下载产物。

## 执行流程

### 第一步：读取当前版本和发布配置

```bash
Read src-tauri/tauri.conf.json  # 读取当前 version 和 productName
```

检查是否存在发布配置文件 `.claude/release-config.json`：
- **存在**：读取配置，跳到第三步
- **不存在**：进入第二步（首次配置）

### 第二步：首次配置（仅首次执行）

使用 AskUserQuestion 询问以下信息：

**问题1**：源码仓库的 GitHub remote 名称是什么？
- 选项：`github`、`origin`、自定义

**问题2**：需要支持哪些平台？
- 选项（多选）：`Windows`、`macOS`、`Linux`
- 默认推荐：Windows + macOS（Linux AppImage 体积大约 80MB）

**问题3**：请提供以下信息（自由文本）：
- 源码仓库 GitHub URL（如 `https://github.com/user/my-app`）
- Release 仓库 Gitee URL（如 `https://gitee.com/user/my-app-release`）
- Release 仓库 GitHub URL（如 `https://github.com/user/my-app-release`）
- 本地 Release 仓库（Gitee）路径
- 本地 Release 仓库（GitHub）路径
- 主分支名（master/main）

将信息保存到 `.claude/release-config.json`：

```json
{
  "appName": "<从 tauri.conf.json 的 productName 读取>",
  "githubRemote": "github",
  "platforms": ["windows", "macos"],
  "sourceRepoUrl": "https://github.com/user/my-app",
  "releaseRepoGiteeUrl": "https://gitee.com/user/my-app-release",
  "releaseRepoGithubUrl": "https://github.com/user/my-app-release",
  "localReleaseGiteePath": "<绝对路径>",
  "localReleaseGithubPath": "<绝对路径>",
  "mainBranch": "master"
}
```

> **平台配置说明**：`platforms` 数组决定 CI 构建矩阵、README 下载表格、产物清单和 update.json 内容。
> 修改平台配置后，需同步更新 `.github/workflows/release.yml` 的构建矩阵。

### 第三步：询问发布信息

使用 AskUserQuestion 询问：

**问题1**：新版本号是什么？（当前: {当前版本}）
- 选项：patch（x.y.Z+1）、minor（x.Y+1.0）、major（X+1.0.0）、自定义

**问题2**：更新说明（将写入 README.md 版本历史）

### 第四步：激活 release-publish 技能

```
Skill(release-publish)
```

### 第五步：按技能中的步骤执行发布前半段

1. 更新三处版本号（tauri.conf.json / Cargo.toml / package.json）
2. 更新两个 release 仓库的 README.md（下载链接 + 版本历史 + 项目结构树，**仅包含已配置的平台**）
3. 提交 + pull rebase + 推送 release 仓库 README 变更（Gitee 先推，GitHub 后推）
4. 提交源码仓库 + 推送到 GitHub
5. 打 Tag + 推送（触发 CI）

### 第六步：输出等待提示和文件清单

CI 触发后，**根据 platforms 配置**输出对应平台的文件清单：

```
CI 已触发，请等待构建完成。

构建进度：<源码仓库 GitHub URL>/actions
下载地址：<源码仓库 GitHub URL>/releases

需要下载的文件：
  [仅列出已配置平台的文件]

下载完成后请告诉我文件所在目录。
```

**各平台对应的文件**：
- Windows (2 个): `*.exe` + `*.exe.sig`
- macOS ARM (3 个): `*aarch64.dmg` + `*aarch64.app.tar.gz` + `*aarch64.app.tar.gz.sig`
- macOS Intel (3 个): `*x64.dmg` + `*x64.app.tar.gz` + `*x64.app.tar.gz.sig`
- Linux (3 个): `*.AppImage` + `*.AppImage.sig` + `*.deb`

使用 AskUserQuestion 询问：**文件下载到了哪个目录？**

### 第七步：执行发布后半段（本地处理）

用户提供下载目录后：

1. 复制所有产物到两个 release 仓库的 `releases/vX.Y.Z/` 目录
2. 读取 `.sig` 文件生成 `update.json`（**仅包含已配置平台**，Gitee 版 + GitHub 版）
3. 提交 + pull rebase + 推送 release 仓库（Gitee 先推，GitHub 后推）
4. 输出完成报告

---

## AI 执行规则

### 配置管理
1. **首次自动配置**：首次执行时询问仓库信息和平台偏好，保存到 `.claude/release-config.json`
2. **后续自动读取**：后续发布直接读取配置，不再重复询问
3. **平台偏好持久化**：`platforms` 字段记录支持的平台，影响 CI 矩阵、产物清单、README 和 update.json

### 版本号
4. **全自动执行**：除询问版本号、更新说明和下载目录外，不再中途询问确认
5. **三处同步**：tauri.conf.json / Cargo.toml / package.json 版本号必须一致

### README 更新
6. **三处更新**：下载链接表格 + 版本历史条目 + 项目结构树
7. **两个仓库同步**：Gitee 和 GitHub release 仓库的 README.md 内容一致
8. **CI 产物文件名**：使用 `<productName>_` 作为前缀（从 tauri.conf.json 读取）
9. **按平台过滤**：下载表格和项目结构树只包含 `platforms` 配置中的平台

### 推送相关
10. **推送前先拉取**：release 仓库 push 前必须 `git pull --rebase origin master`
11. **Gitee 优先推送**：release 仓库先推 Gitee（主更新端点），后推 GitHub（备份）
12. **Git remote 名**：从 release-config.json 读取
13. **打 Tag 触发 CI**：`git tag vX.Y.Z && git push <remote> vX.Y.Z`

### CI 与产物处理
14. **不需要本地构建**：`pnpm tauri build` 由 CI 执行
15. **签名由 CI 完成**：`.sig` 文件已包含在 CI 产物中，用户只需下载
16. **Claude 生成 update.json**：读取 `.sig` 文件内容写入 update.json（仅包含已配置平台）
17. **Claude 推送 release 仓库**：复制产物 + update.json 后本地推送到 Gitee/GitHub
