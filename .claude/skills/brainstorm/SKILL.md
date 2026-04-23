---
name: brainstorm
description: |
  当需要探索方案、头脑风暴、创意思维时自动使用此 Skill。

  触发场景：
  - 不知道怎么设计
  - 需要多种方案
  - 架构讨论
  - 功能规划

  触发词：头脑风暴、方案、怎么设计、有什么办法、创意、讨论、探索、建议、怎么做、如何实现
---

# 头脑风暴框架

## 本项目技术约束

> 所有方案必须在以下技术栈约束内思考

### 技术边界

- **后端架构**: 三层架构（Commands → Services → Database）
- **后端语言**: Rust 2021 edition + Tauri 2.x（不是 Java/Python/Node.js）
- **前端框架**: React 19 + TypeScript 5.8 + Vite 7（不是 Vue/Angular）
- **UI 组件库**: Ant Design 5 + TailwindCSS 4（不是 Material-UI/Chakra UI）
- **状态管理**: Zustand（不是 Redux/MobX）
- **路由**: React Router v7（不是 Next.js/Remix）
- **通信**: Tauri IPC `invoke()` / `listen()`（不是 HTTP REST API）
- **安全**: Capabilities 权限声明（不是 RBAC/JWT）
- **数据库**: rusqlite (Rust 侧 `Mutex<Connection>`)（不是 tauri-plugin-sql）
- **数据存储**: 本地文件 / SQLite（不是 MySQL/PostgreSQL 服务器）
- **部署**: 桌面安装包 .exe/.dmg/.deb（不是服务器部署）
- **依赖管理**: Cargo (Rust) + pnpm (Node.js)

---

## 思维模式

### 发散思维
1. **不评判**: 先不考虑可行性
2. **联想**: 从一个想法延伸
3. **Rust 生态**: 能否用现有 crate 解决？
4. **Tauri 插件**: 有没有现成的插件？
5. **Ant Design 组件**: UI 能否复用现有组件？
6. **跨界借鉴**: Electron/Flutter 怎么做的？
7. **反向思考**: 反过来就是解决方案

### 收敛思维
1. **复用优先**: 能否复用现有 crate 或 npm 包？
2. **可行性**: 在 Rust + React 技术栈内能否实现？
3. **三层架构**: 这个逻辑应该放在哪一层？
4. **前后端分工**: 这个逻辑应该放在 Rust 侧还是 React 侧？
5. **权限**: 是否需要声明额外的 Capabilities？
6. **成本**: 开发时间和复杂度
7. **跨平台**: 方案在 Windows/macOS/Linux 上是否都能工作？
8. **UI 一致性**: 是否符合 Ant Design 设计规范？

---

## 方案评估矩阵

```markdown
| 方案 | 复用度(15%) | 可行性(20%) | 开发量(20%) | 跨平台(15%) | 安全性(15%) | UI一致性(15%) | 总分 |
|------|-------------|------------|-------------|-------------|-------------|--------------|------|
| 方案A | ? | ? | ? | ? | ? | ? | ? |
| 方案B | ? | ? | ? | ? | ? | ? | ? |
```

### 评分标准

| 维度 | 1 分 | 2 分 | 3 分 | 4 分 | 5 分 |
|------|------|------|------|------|------|
| **复用度** | 全新开发 | 少量复用 | 部分复用 | 大量复用 | 完全复用 |
| **可行性** | 不可行 | 技术风险高 | 需要探索 | 可行 | 完全可行 |
| **开发量** | >5天 | 3-5天 | 1-3天 | 0.5-1天 | <0.5天 |
| **跨平台** | 不跨平台 | 需要适配 | 部分兼容 | 基本兼容 | 完全兼容 |
| **安全性** | 存在风险 | 需要加固 | 一般 | 安全 | 非常安全 |
| **UI一致性** | 不一致 | 需要定制 | 基本一致 | 一致 | 完美一致 |

---

## 方案探索模板

```markdown
## 问题描述
- 是什么: [功能描述]
- 为什么重要: [业务价值]
- 当前状态: [现有能力]

## 可能方案

### 方案 A: [名称]
- **描述**: ...
- **架构设计**:
  - Database 层工作: ...
  - Service 层工作: ...
  - Command 层工作: ...
  - React 侧工作: ...
- **UI 组件**: [使用的 Ant Design 组件]
- **状态管理**: [Zustand store 设计]
- **数据库变更**: [需要添加的表/字段]
- **需要的 Capabilities**: ...
- **优点**: ...
- **缺点**: ...
- **评分**:
  - 复用度: ?/5
  - 可行性: ?/5
  - 开发量: ?/5
  - 跨平台: ?/5
  - 安全性: ?/5
  - UI一致性: ?/5
  - **总分**: ?/30

### 方案 B: [名称]
- **描述**: ...
- **架构设计**:
  - Database 层工作: ...
  - Service 层工作: ...
  - Command 层工作: ...
  - React 侧工作: ...
- **UI 组件**: [使用的 Ant Design 组件]
- **状态管理**: [Zustand store 设计]
- **数据库变更**: [需要添加的表/字段]
- **需要的 Capabilities**: ...
- **优点**: ...
- **缺点**: ...
- **评分**:
  - 复用度: ?/5
  - 可行性: ?/5
  - 开发量: ?/5
  - 跨平台: ?/5
  - 安全性: ?/5
  - UI一致性: ?/5
  - **总分**: ?/30

## 推荐方案
方案 [X] - [理由]

## 实施计划
1. [第一步]
2. [第二步]
3. [第三步]
```

---

## 架构决策要点

### 数据存储位置

| 场景 | 推荐方案 | 理由 |
|------|---------|------|
| 持久化业务数据 | SQLite (rusqlite) | 关系型数据、事务支持 |
| 简单键值配置 | SQLite app_config 表 | 统一管理、易于查询 |
| 临时会话数据 | Zustand store | 无需持久化 |
| 大文件 | 文件系统 + DB 存路径 | 性能更好 |

### 业务逻辑位置

| 场景 | 推荐层级 | 理由 |
|------|---------|------|
| 数据验证 | Service 层 | 业务逻辑集中 |
| 复杂计算 | Rust Service 层 | 性能更好 |
| UI 交互逻辑 | React 组件 | 用户体验更好 |
| 数据库查询 | Database 层 | 职责单一 |
| 权限检查 | Service 层 | 业务逻辑 |

### UI 组件选择

| 需求 | 推荐组件 | 说明 |
|------|---------|------|
| 表单 | Ant Design Form | 完整的表单方案 |
| 表格 | Ant Design Table | 功能强大 |
| 弹窗 | Ant Design Modal | 标准弹窗 |
| 消息提示 | Ant Design message | 轻量级提示 |
| 通知 | Ant Design notification | 复杂通知 |
| 布局 | TailwindCSS | 灵活的工具类 |
| 图标 | @ant-design/icons | 官方图标库 |

---

## 常见场景方案库

### 场景 1：用户认证

**方案对比**:

| 方案 | 实现 | 优点 | 缺点 |
|------|------|------|------|
| 本地密码 | SQLite 存储哈希 | 简单、离线可用 | 无云同步 |
| OAuth2 | 调用外部 API | 专业、安全 | 需要网络 |
| 生物识别 | Windows Hello API | 用户体验好 | 平台限制 |

### 场景 2：数据同步

**方案对比**:

| 方案 | 实现 | 优点 | 缺点 |
|------|------|------|------|
| 文件导出/导入 | SQLite dump | 简单 | 手动操作 |
| WebSocket | 实时同步 | 实时性好 | 复杂度高 |
| REST API | 定期拉取 | 简单可靠 | 非实时 |

### 场景 3：大文件处理

**方案对比**:

| 方案 | 实现 | 优点 | 缺点 |
|------|------|------|------|
| 流式处理 | Rust async + chunk | 内存占用小 | 复杂度高 |
| 分片上传 | 分块处理 | 可断点续传 | 实现复杂 |
| Worker 线程 | tokio::spawn | 不阻塞主线程 | 进度回报复杂 |

---

## 决策树示例

```
需要持久化数据？
├─ 是 → 数据类型？
│   ├─ 结构化数据 → SQLite (rusqlite)
│   ├─ 大文件 → 文件系统 + DB 存路径
│   └─ 简单配置 → SQLite app_config 表
└─ 否 → 数据作用域？
    ├─ 全局共享 → Zustand store
    ├─ 组件内 → useState
    └─ URL 参数 → React Router params
```

---

## 常见陷阱

| 错误思路 | 正确思路 |
|---------|---------|
| 用 tauri-plugin-sql 从前端操作数据库 | 用 rusqlite 在 Rust 侧操作 |
| 把所有逻辑放在 Command 层 | 使用三层架构拆分职责 |
| 前端直接调用 Rust 业务逻辑 | 通过 Command 暴露 API |
| 混用多种状态管理方案 | 统一使用 Zustand |
| 不使用 Ant Design 重复造轮子 | 优先使用 Ant Design 组件 |
| 内联样式或 CSS-in-JS | 优先使用 TailwindCSS |
| HTTP 请求直接在前端 | 通过 Rust Command 代理 |

---

## 技术选型参考

### Rust Crate 推荐

| 需求 | 推荐 Crate | 说明 |
|------|-----------|------|
| 数据库 | rusqlite | SQLite 绑定 |
| 错误处理 | thiserror | 自定义错误类型 |
| 序列化 | serde + serde_json | JSON 序列化 |
| HTTP 请求 | reqwest | 异步 HTTP 客户端 |
| 日期时间 | chrono | 日期时间处理 |
| 加密 | sha2, bcrypt | 密码哈希 |
| 日志 | log, env_logger | 日志记录 |

### NPM 包推荐

| 需求 | 推荐包 | 说明 |
|------|-------|------|
| UI 组件 | antd | Ant Design |
| 样式 | tailwindcss | TailwindCSS |
| 状态管理 | zustand | 轻量级状态管理 |
| 路由 | react-router | React Router |
| 图标 | @ant-design/icons | Ant Design 图标 |
| 表单验证 | (内置在 antd) | Form 组件内置 |
| 日期选择 | (内置在 antd) | DatePicker 组件 |

---

## 检查清单

- [ ] 方案符合三层架构
- [ ] 数据库操作在 Database 层
- [ ] 业务逻辑在 Service 层（或 Command 层简单逻辑）
- [ ] IPC 接口在 Command 层
- [ ] UI 优先使用 Ant Design 组件
- [ ] 样式优先使用 TailwindCSS
- [ ] 全局状态使用 Zustand
- [ ] 需要的 Capabilities 已列出
- [ ] 跨平台兼容性已考虑
- [ ] 安全性已评估
