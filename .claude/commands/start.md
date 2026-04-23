# /start - 新窗口快速了解项目

作为项目引导助手,帮我快速了解 Tauri 桌面应用项目的当前状态。

## 你需要做的:

1. 项目基本信息
   - 识别项目类型(Tauri 2.x + Rust + React 19 + TypeScript 5.8)
   - 查看最近 5 条 Git 提交
   ```bash
   git log -5 --format="%H|%an|%cn|%s" --no-merges
   ```

2. 智能检测项目状态

   第一步: 检测 Rust 三层架构
   ```
   # Commands 层
   Glob pattern: "src-tauri/src/commands/**/*.rs"
   Grep pattern: "#\[tauri::command\]" path: src-tauri/src/commands/ output_mode: count

   # Services 层
   Glob pattern: "src-tauri/src/services/**/*.rs"

   # Database 层
   Glob pattern: "src-tauri/src/database/**/*.rs"

   # 其他模块
   Glob pattern: "src-tauri/src/**/*.rs"
   ```

   第二步: 检查前端三层结构
   ```
   # Pages 层
   Glob pattern: "src/pages/**/*.tsx"

   # Components 层
   Glob pattern: "src/components/**/*.tsx"

   # API 层
   Glob pattern: "src/lib/api/**/*.ts"

   # 其他前端文件
   Glob pattern: "src/**/*.tsx"
   Glob pattern: "src/**/*.ts"
   ```

   第三步: 检查 Tauri 配置
   ```
   Read src-tauri/tauri.conf.json
   Glob pattern: "src-tauri/capabilities/*.json"
   ```

   第四步: 检查 Git 状态
   ```bash
   git status --short
   ```

3. 输出简洁报告

   ```markdown
   # 欢迎回到 Tauri 桌面应用项目

   ## 项目信息
   - 项目名称: Tauri Desktop App
   - 技术栈: Rust 2021 + React 19 + TypeScript 5.8 + Tauri 2.x
   - UI 框架: Ant Design 5 + TailwindCSS 4
   - 状态管理: Zustand + React Router v7
   - 数据库: SQLite (rusqlite)
   - 应用标识: com.agilefr.kb

   ## 最近动态
   [最近提交信息]

   ## 当前状态

   ### Rust 后端 (src-tauri/src/) - 三层架构
   | 层级 | 指标 | 数量 |
   |------|------|------|
   | Commands | Commands 文件 | X |
   | Commands | Tauri Commands | X |
   | Services | Services 文件 | X |
   | Database | Database 文件 | X |
   | 总计 | Rust 源文件 | X |

   ### React 前端 (src/) - 三层结构
   | 层级 | 指标 | 数量 |
   |------|------|------|
   | Pages | 页面组件 | X |
   | Components | 通用组件 | X |
   | API | API 接口 | X |
   | 总计 | TypeScript 文件 | X |

   ### Tauri 配置
   - 应用标题: ...
   - 窗口大小: ... x ...
   - 权限文件: X 个

   ## 技术亮点
   - 采用三层架构设计(Commands-Services-Database)
   - 使用 Ant Design 5 组件库 + TailwindCSS 4 样式
   - Zustand 状态管理 + React Router v7 路由
   - SQLite 本地数据库存储

   ## 你可以:
   1. /next - 获取下一步开发建议(推荐)
   2. /progress - 查看详细进度报告
   3. /dev - 开发新功能(Rust Command + React UI)
   4. /command - 快速创建 Tauri Command
   5. /check - 代码规范检查

   ## 快速开始:
   - "帮我创建一个用户管理功能"
   - "添加系统托盘支持"
   - "检查代码规范"
   - "优化数据库查询"
   ```

## 注意事项:
- 输出要简洁,一屏内能看完
- 明确展示三层架构(Rust 后端 + React 前端)
- 突出显示技术栈特色(Ant Design + TailwindCSS + Zustand + SQLite)
- 语气友好、轻松
- 不预估时间
