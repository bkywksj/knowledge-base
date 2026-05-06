# Knowledge Base

> 本地优先的知识库桌面应用，支持全文搜索、双向链接、知识图谱与 AI 工作流扩展。

<p align="center">
  <a href="https://github.com/bkywksj/knowledge-base/stargazers"><img src="https://img.shields.io/github/stars/bkywksj/knowledge-base?style=flat-square" alt="GitHub stars" /></a>
  <a href="https://github.com/bkywksj/knowledge-base/commits/main"><img src="https://img.shields.io/github/last-commit/bkywksj/knowledge-base?style=flat-square" alt="Last commit" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square" alt="AGPL-3.0" /></a>
  <img src="https://img.shields.io/badge/Tauri-2.x-24c8db?style=flat-square" alt="Tauri 2.x" />
</p>

Knowledge Base 是一个基于 Tauri 2.x 构建的桌面知识管理应用，面向希望把笔记、知识链接、图谱关系和 AI 能力放在同一个本地工作台里的用户。

它适合个人知识沉淀、主题研究、文档整理，以及需要持续积累上下文的写作或开发场景。

## 目录
- [功能概览](#功能概览)
- [适用场景](#适用场景)
- [安装与运行](#安装与运行)
- [开发命令](#开发命令)
- [项目结构](#项目结构)
- [许可证与商业授权](#许可证与商业授权)
- [贡献方式](#贡献方式)
- [社区交流](#社区交流)
- [赞赏支持](#赞赏支持)

## 功能概览

- 全文搜索，快速定位本地知识内容
- 双向链接，构建笔记之间的关系网络
- 知识图谱，帮助理解主题之间的连接
- Tauri 桌面应用，兼顾本地性能与跨平台能力
- 预留 AI / MCP 扩展能力，适合继续演化工作流

## 适用场景

- 个人第二大脑
- 研究资料整理与长期追踪
- 写作项目的资料沉淀
- 本地优先的知识管理和关系可视化

## 安装与运行

### 环境要求
- Node.js 18+
- pnpm
- Rust 与 Tauri 2.x 开发环境

如果你是第一次配置 Tauri 环境，建议先确认本机已具备官方依赖。

### 安装依赖
```bash
pnpm install
```

### 启动桌面开发环境
```bash
pnpm tauri:dev
```

### 构建应用
```bash
pnpm tauri:build
```

### 仅运行前端开发服务器
```bash
pnpm dev
```

## 开发命令

```bash
pnpm dev           # 启动前端开发服务器
pnpm tauri:dev     # 启动 Tauri 桌面开发环境
pnpm build         # 构建前端
pnpm tauri:build   # 构建桌面应用
pnpm build:mcp     # 构建 MCP 相关产物
```

更多安装细节可参考 [INSTALL.md](./INSTALL.md)。

## 项目结构

```text
.
├── docs/                  # 文档与说明
├── public/                # 静态资源
├── src/                   # 前端应用代码
├── src-tauri/             # Tauri / Rust 代码
├── INSTALL.md             # 安装与配置说明
├── CONTRIBUTING.md        # 贡献指南
└── COMMERCIAL-LICENSE.md  # 商业授权说明
```

## 许可证与商业授权

本项目采用 **[GNU AGPL-3.0](LICENSE)** 协议开源，并提供商业授权。

| 使用场景 | 是否需要付费 | 要求 |
|---------|-------------|------|
| 个人学习、研究、非商业使用 | ✅ 免费 | 遵守 AGPL-3.0（修改后开源、保留版权声明） |
| 开源项目二次开发 | ✅ 免费 | 派生作品必须以 AGPL-3.0 协议开源 |
| 企业内部工具（不分发） | ✅ 免费 | 遵守 AGPL-3.0 |
| **闭源商用、打包销售** | ⚠️ 需商业授权 | AGPL-3.0 禁止闭源分发 |
| **SaaS / 网络服务部署**（不公开源码） | ⚠️ 需商业授权 | AGPL-3.0 要求向用户提供源码 |
| **集成进专有软件再分发** | ⚠️ 需商业授权 | 违反 AGPL-3.0 传染性条款 |

> 简单说，个人使用和开源二次开发免费；如果你要闭源商用或以 SaaS 方式提供服务，请联系作者获取商业授权。

如需商业授权，详见 [COMMERCIAL-LICENSE.md](./COMMERCIAL-LICENSE.md)。

## 贡献方式

欢迎贡献代码、反馈 Bug 和提出建议。提交 PR 前请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。

请特别留意：
- 本项目采用 **AGPL-3.0 + 商业授权** 双许可模式
- 所有外部 PR 必须同意 **CLA（贡献者许可协议）**
- 未勾选 CLA 同意的 PR 不会进入审核流程

快速入口：
- 🐛 [报告 Bug](../../issues/new?template=bug_report.md)
- ✨ [功能建议](../../issues/new?template=feature_request.md)
- 🔨 [提交 Pull Request](../../compare)
- 💼 [商业授权咨询](./COMMERCIAL-LICENSE.md)

## 社区交流

| 渠道 | 入口 |
|------|------|
| QQ 交流群（Bug 反馈 / 使用交流 / 新功能讨论） | 群号 `1090770702` |
| B 站作者主页（教程视频 / 功能演示） | <https://space.bilibili.com/520725002> |
| 知识星球（后端转 AI 实战派） | 星球号 `91839984` |
| 应用文档站点 | <https://kb.ruoyi.plus/> |

## 赞赏支持

本项目完全开源、免费、无会员订阅。如果它帮到了你，欢迎请作者喝杯咖啡：

<p align="center">
  <img src="public/donate-qr.png" alt="微信赞赏码" width="240" />
</p>

如果你暂时不方便赞赏，也可以通过下面这些方式支持项目：
- ⭐ 在 [GitHub](https://github.com/bkywksj/knowledge-base) / [Gitee](https://gitee.com/bkywksj/knowledge-base) 给项目点 Star
- 🎬 在 B 站关注作者主页
- 📣 推荐给身边需要的朋友
- 📋 提 Issue 反馈 Bug 或功能建议
