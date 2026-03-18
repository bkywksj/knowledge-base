# /next - 下一步建议

作为项目开发顾问,综合分析 Tauri 桌面应用项目全貌后,推荐一个最优下一步和备选方向。

---

## 第一步:收集项目全貌(并行执行)

### 1.1 Git 提交分析
```bash
git log -10 --format="%H|%an|%cn|%s" --no-merges
```

### 1.2 代码模块现状

#### Rust 后端三层架构
```
# Commands 层
Grep pattern: "#\[tauri::command\]" path: src-tauri/src/commands/ output_mode: content

# Services 层
Glob pattern: "src-tauri/src/services/*.rs"

# Database 层
Glob pattern: "src-tauri/src/database/*.rs"
```

#### React 前端分层
```
# 页面组件
Glob pattern: "src/pages/**/*.tsx"

# 布局组件
Glob pattern: "src/components/layout/*.tsx"

# API 封装
Glob pattern: "src/lib/api/*.ts"

# Zustand Stores
Glob pattern: "src/store/*.ts"
```

### 1.3 代码待办
```
Grep pattern: "FIXME|todo!" path: src-tauri/src/ glob: "*.rs" output_mode: content
Grep pattern: "TODO" path: src-tauri/src/ glob: "*.rs" output_mode: count
Grep pattern: "FIXME|TODO" path: src/ glob: "*.{tsx,ts}" output_mode: count
```

---

## 第二步:智能分析与排序

### 优先级排序规则
1. **FIXME/todo!() 注释**(紧急问题)
2. **架构违规**(Command 直接访问数据库,绕过 Services 层)
3. **缺失的 API 封装**(前端直接 invoke 而非通过 API wrapper)
4. **缺失 Ant Design 组件**(前端组件未使用 Ant Design)
5. **未完成的功能**(有 Command 但缺前端调用,或反之)
6. **TODO 注释中的高优先级项**
7. **自然延续**(最近提交方向的下一步)
8. **新功能建议**(基于项目缺少的桌面应用常见功能)

### 连贯性判断
- 最近在做 Rust 后端 -> 优先建议相关前端页面(使用 Ant Design)
- 最近在做 React UI -> 建议对应 Services/Commands 或新功能
- Services 层缺失 -> 建议为现有 Commands 添加 Services 层
- 缺少 API 封装 -> 建议在 `src/lib/api/` 中添加 TypeScript wrapper
- 缺少数据持久化 -> 建议添加 Database 层和 migrations
- 基础功能完善 -> 建议进阶功能(多窗口/系统托盘/自动更新)

### 架构健康度检查
- Command 是否直接调用 `sqlx::query` 而非 Services? -> 重构优先
- Services 是否调用了其他 Services 的私有方法? -> 接口设计问题
- 前端是否直接 `invoke()` 而非通过 `src/lib/api/*`? -> 封装缺失
- 页面是否使用 Ant Design 组件? -> UI 规范一致性

---

## 第三步:输出建议

```markdown
# 下一步建议

## 当前状态
最近开发活动...
模块概览...
FIXME/TODO 统计...
架构健康度...

## 推荐下一步
具体任务名称、来源、原因、位置、步骤...

## 备选方向
1. ...
2. ...
3. ...
```

---

## 强制规则
| 规则 | 说明 |
|------|------|
| 不预估时间 | 禁止输出"预计 X 小时/天" |
| 不给空泛建议 | 每条建议必须具体到文件/操作 |
| 一个推荐 + 备选 | 推荐区域只放一个最优建议 |
| 连贯性优先 | 未完成 > 架构问题 > 新任务 |
| 标注来源 | 每条建议标注数据来源(Git/TODO/架构分析) |
| 架构优先 | 架构违规问题比新功能优先级更高 |

## 与其他命令的关系
| 命令 | 关系 |
|------|------|
| /progress | 全面进度报告,/next 是精简的下一步建议 |
| /dev | 开始开发,/next 告诉你该开发什么 |
| /check | 代码检查,/next 可能推荐先修复问题 |
| /arch | 架构分析,/next 基于架构健康度给出建议 |

## 建议类型示例

### 新功能建议
- 新增 Ant Design 页面:`src/pages/Settings.tsx`
- 新增数据库表:在 `src-tauri/src/database/migrations/` 中添加迁移
- 新增 Zustand Store:`src/store/settingsStore.ts`
- 新增 Services 模块:`src-tauri/src/services/notification_service.rs`

### 架构优化建议
- 重构 Command:将直接数据库访问移至 Services 层
- 添加 API 封装:为 `user_login` command 创建 `src/lib/api/auth.ts`
- 统一 UI 组件:将自定义按钮替换为 `<Button>` from antd
- 添加事务支持:在 Services 层使用 `begin_transaction`
