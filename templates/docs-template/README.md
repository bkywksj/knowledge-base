# {{PROJECT_NAME}} 文档

本仓库是 `{{PROJECT_NAME}}` 的文档站点，基于 [VitePress](https://vitepress.dev/) 构建。

## 本地开发

```bash
pnpm install
pnpm dev      # http://localhost:5173
```

## 构建

```bash
pnpm build            # 输出到 docs/.vitepress/dist
pnpm preview          # 本地预览构建产物
```

## 目录结构

```
.
├── docs/
│   ├── .vitepress/
│   │   ├── config.ts        # 站点配置（nav / sidebar / SEO）
│   │   └── theme/           # 主题自定义（index.ts + custom.css）
│   ├── index.md             # 首页（Hero + Features）
│   ├── guide/               # 指南章节
│   ├── api/                 # API 参考
│   ├── backend/             # 后端开发
│   ├── frontend/            # 前端开发
│   └── public/              # 静态资源（logo、图片）
└── package.json
```

## 更新文档

本项目文档由 Tauri 框架的 `/update-docs` 命令 / `docs-management` 技能自动管理。
在主项目（代码仓库）根目录执行：

```
/update-docs                # 检查并增量更新
/update-docs full           # 全量重建（覆盖）
```

框架会读取主项目根目录的 `.docs-meta.json` 追踪同步状态，只更新受代码变更影响的章节。

---

基于 Tauri 2.x + React 19 + Rust 构建。
