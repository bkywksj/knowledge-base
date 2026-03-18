# /progress - 项目进度报告

作为项目进度分析助手，综合分析 Tauri 桌面应用项目全貌后，输出结构化的全面进度报告。

> 与 /next 的区别：/progress 是全面的只读报告（当前状态的快照），/next 是精简的下一步建议。

---

## 第一步：收集项目全貌（并行执行）

### 1.1 Git 提交分析
```bash
git log -20 --format="%H|%an|%cn|%s" --no-merges
```

### 1.2 Rust 后端扫描（三层架构）
```
# Tauri Commands 层
Grep pattern: "#\[tauri::command\]" path: src-tauri/src/commands/ output_mode: content
Glob pattern: "src-tauri/src/commands/*.rs"

# Services 业务逻辑层
Glob pattern: "src-tauri/src/services/*.rs"

# Database 数据库层
Glob pattern: "src-tauri/src/database/*.rs"

# Models 数据模型
Glob pattern: "src-tauri/src/models/*.rs"

# 核心文件
Read src-tauri/src/lib.rs
Read src-tauri/src/main.rs

# 依赖
Read src-tauri/Cargo.toml
```

### 1.3 React 前端扫描（分层架构）
```
# 页面组件
Glob pattern: "src/pages/**/*.tsx"

# 可复用组件
Glob pattern: "src/components/**/*.tsx"

# API 调用层
Glob pattern: "src/lib/api/*.ts"

# 状态管理（Zustand）
Glob pattern: "src/store/*.ts"

# 自定义 Hooks
Glob pattern: "src/hooks/*.ts"

# 路由配置
Read src/main.tsx

# 依赖
Read package.json
```

### 1.4 Tauri 配置扫描
```
Read src-tauri/tauri.conf.json
Glob pattern: "src-tauri/capabilities/*.json"
```

### 1.5 代码待办扫描
```
Grep pattern: "FIXME|TODO|todo!" path: src-tauri/src/ glob: "*.rs" output_mode: count
Grep pattern: "FIXME|TODO" path: src/ glob: "*.{tsx,ts}" output_mode: count
```

### 1.6 架构合规检查
```
# 检查是否有 Command 直接包含业务逻辑（应该在 Services 层）
Grep pattern: "fn.*\{[\s\S]{100,}" path: src-tauri/src/commands/ glob: "*.rs" output_mode: count

# 检查前端是否直接使用 invoke（应该封装在 API 层）
Grep pattern: "invoke\(" path: src/pages/ glob: "*.tsx" output_mode: count
```

---

## 第二步：输出进度报告

```markdown
# 项目进度报告 - Tauri Desktop App

生成时间: YYYY-MM-DD HH:MM

---

## 📊 开发活动概览
最近 20 次提交分析：
- 主要贡献者: [列出提交者]
- 开发重点: [总结最近提交的关键词]
- 活跃度: [最近 7 天/最近 30 天提交数]

---

## 🏗️ 代码模块进度

### Rust 后端（src-tauri/src/）- 三层架构

#### Commands 层（src-tauri/src/commands/）
| 指标 | 数量 | 说明 |
|------|------|------|
| Tauri Commands | X 个 | 前端可调用的 IPC 接口 |
| Command 模块文件 | X 个 | *.rs 文件数量 |
| 架构合规性 | ✅/⚠️ | Command 是否仅做参数处理（不包含业务逻辑） |

**已实现的 Commands**:
- [列出所有 #[tauri::command] 函数名]

#### Services 层（src-tauri/src/services/）
| 指标 | 数量 | 说明 |
|------|------|------|
| Service 模块 | X 个 | 业务逻辑模块 |
| 代码行数 | ~X 行 | 业务逻辑复杂度 |

**Service 模块列表**:
- [列出 services/*.rs 文件名]

#### Database 层（src-tauri/src/database/）
| 指标 | 数量 | 说明 |
|------|------|------|
| Database 模块 | X 个 | 数据库操作模块 |
| SQLite 表数量 | X 个 | 通过代码分析推断 |

#### Models 层（src-tauri/src/models/）
| 指标 | 数量 | 说明 |
|------|------|------|
| 数据模型 | X 个 | Rust struct 定义 |
| Serde 支持 | X 个 | 支持序列化的模型 |

#### 依赖与插件
| 类型 | 数量/状态 |
|------|-----------|
| Cargo 依赖 | X 个 |
| Tauri 官方插件 | X 个 (列出名称) |
| 第三方 crate | X 个 (关键 crate) |

---

### React 前端（src/）- 分层架构

#### Pages 层（src/pages/）
| 指标 | 数量 | 说明 |
|------|------|------|
| 页面组件 | X 个 | 路由级别组件 |
| React Router 路由 | X 个 | 路由配置数量 |

**页面列表**:
- [列出 pages/**/*.tsx 文件路径]

#### Components 层（src/components/）
| 指标 | 数量 | 说明 |
|------|------|------|
| 可复用组件 | X 个 | 通用 UI 组件 |
| Ant Design 组件使用 | X 种 | 使用的 antd 组件类型 |

**组件列表**:
- [列出 components/**/*.tsx 文件名]

#### API 层（src/lib/api/）
| 指标 | 数量 | 说明 |
|------|------|------|
| API 封装模块 | X 个 | Tauri invoke 封装 |
| 架构合规性 | ✅/⚠️ | 页面组件是否直接调用 invoke |

**API 模块**:
- [列出 lib/api/*.ts 文件名]

#### 状态管理（src/store/）
| 指标 | 数量 | 说明 |
|------|------|------|
| Zustand Store | X 个 | 全局状态存储 |
| 状态切片 | X 个 | Store slice 数量 |

**Store 列表**:
- [列出 store/*.ts 文件名]

#### 自定义 Hooks（src/hooks/）
| 指标 | 数量 | 说明 |
|------|------|------|
| 自定义 Hook | X 个 | 可复用逻辑 Hook |

**Hook 列表**:
- [列出 hooks/*.ts 文件名]

#### 依赖与技术栈
| 技术 | 版本/状态 |
|------|-----------|
| React | 19.x |
| TypeScript | 5.8.x |
| Ant Design | 5.x (使用 X 种组件) |
| TailwindCSS | 4.x |
| Zustand | X.x |
| React Router | v7 |
| Vite | 7.x |
| 总依赖数 | X 个 |

---

### Tauri 配置

#### Capabilities 权限声明
| 指标 | 状态/数量 |
|------|-----------|
| Capabilities 文件 | X 个 |
| 已声明权限总数 | X 项 |
| 核心权限 | [core:default, opener:default, etc.] |
| 文件系统权限 | X 项 |
| 数据库权限 | X 项 |

#### 应用配置
| 配置项 | 值 |
|--------|-----|
| 应用标识 | com.agilefr.kb |
| 应用名称 | [从 tauri.conf.json 读取] |
| 开发端口 | 1420 |
| 窗口数量 | X 个 |

---

## 🎯 架构合规性评估

| 检查项 | 状态 | 说明 |
|--------|------|------|
| Rust 三层分离 | ✅/⚠️/❌ | Commands/Services/Database 职责分离 |
| 前端分层清晰 | ✅/⚠️/❌ | Pages/Components/API/Store 分层 |
| IPC 调用封装 | ✅/⚠️/❌ | 页面组件是否通过 API 层调用 invoke |
| 权限声明完整 | ✅/⚠️/❌ | Capabilities 是否覆盖所有插件使用 |
| 类型安全 | ✅/⚠️/❌ | TypeScript strict 模式 + Rust Result |

**问题详情**:
- [如果有架构违规，列出具体位置和建议]

---

## 📝 代码质量指标

| 指标 | Rust 后端 | TypeScript 前端 | 说明 |
|------|-----------|----------------|------|
| FIXME | X 处 | X 处 | 需要修复的问题 |
| TODO | X 处 | X 处 | 待实现功能 |
| 总源文件 | X 个 | X 个 | .rs 和 .tsx/.ts 文件 |
| 代码密度 | 低/中/高 | 低/中/高 | 基于文件数和代码行数评估 |

**待办分布**:
- Rust: [列出关键 TODO/FIXME 位置]
- TypeScript: [列出关键 TODO/FIXME 位置]

---

## 🏥 综合健康度评估

### 架构健康度: ⭐⭐⭐⭐⭐ (X/5)
- [根据三层架构合规性、分层清晰度评分]

### 代码完整度: X%
- [基于 TODO/FIXME 数量、已实现功能比例评估]

### 开发活跃度: 高/中/低
- [基于最近提交频率评估]

### 技术栈现代性: ⭐⭐⭐⭐⭐ (5/5)
- React 19 + TypeScript 5.8
- Ant Design 5 + TailwindCSS 4
- Zustand + React Router v7
- Tauri 2.x + Rust 2021

### 潜在风险
- [列出发现的架构问题、安全隐患、性能瓶颈]

---

## 🚀 关键特性完成度

| 功能模块 | 状态 | 说明 |
|---------|------|------|
| [根据实际 Commands 分析] | ✅/🚧/📋 | 已完成/开发中/未开始 |

---

## 📌 下一步建议

> **详细的下一步开发建议，请运行 `/next` 命令获取**

**快速建议**:
1. [基于待办事项给出 1-2 条优先建议]
2. [基于架构合规性给出优化建议]

---

**报告生成说明**:
- ✅ 表示良好
- ⚠️ 表示需要关注
- ❌ 表示有问题需要修复
- 🚧 表示开发中
- 📋 表示未开始
```

---

## 强制规则
| 规则 | 说明 |
|------|------|
| 不预估时间 | 禁止输出"预计 X 小时/天" |
| 只读不写 | /progress 只分析不修改文件 |
| 客观评估 | 给出客观的进度评估，基于代码扫描结果 |
| 架构优先 | 重点关注三层架构合规性 |
| 结尾联动 | 报告末尾推荐运行 /next 获取具体下一步 |
| 数据驱动 | 所有数字和评估都必须基于实际扫描结果 |
