#!/usr/bin/env node
/**
 * UserPromptSubmit Hook - 强制技能评估 (Tauri 项目)
 * 功能: 开发场景下，将 Skills 激活率从约 25% 提升到 90% 以上
 */

const fs = require('fs');

// 从 stdin 读取用户输入
let inputData = '';
try {
  inputData = fs.readFileSync(0, 'utf8');
} catch {
  process.exit(0);
}

let input;
try {
  input = JSON.parse(inputData);
} catch {
  process.exit(0);
}

const prompt = (input.prompt || '').trim();

// 检测是否是恢复会话（防止上下文溢出死循环）
const skipPatterns = [
  'continued from a previous conversation',
  'ran out of context',
  'No code restore',
  'Conversation compacted',
  'commands restored',
  'context window',
  'session is being continued'
];

const isRecoverySession = skipPatterns.some(pattern =>
  prompt.toLowerCase().includes(pattern.toLowerCase())
);

if (isRecoverySession) {
  process.exit(0);
}

// 检测是否是斜杠命令
const isSlashCommand = /^\/[^\/\s]+$/.test(prompt.split(/\s/)[0]);

if (isSlashCommand) {
  process.exit(0);
}

const instructions = `## 强制技能激活流程（必须执行）

### 步骤 1 - 评估（必须在响应中明确展示）

针对用户问题，列出匹配的技能：\`技能名: 理由\`，无匹配则写"无匹配技能"

可用技能：

**L1 通用技能：**
- brainstorm: 头脑风暴/创意/方案设计/功能设计
- project-init: 新项目/创建项目/初始化项目/开新项目/项目初始化
- task-tracker: 任务跟踪/记录进度/继续任务/恢复上下文/多步骤开发
- git-workflow: Git/提交/commit/分支/合并
- code-patterns: 规范/禁止/命名/编码规范/Rust规范/TypeScript规范
- tech-decision: 技术选型/选择方案/框架对比/库对比/Rust crate/npm包
- bug-detective: Bug排查/报错/异常/错误/panic/调试/排错
- collaborating-with-codex: Codex/CLI协作/代码审查/多AI
- collaborating-with-gemini: Gemini/CLI协作/多AI协作

**L3 深度定制：**
- project-navigator: 项目结构/文件在哪/定位/代码位置/目录结构
- error-handler: 异常处理/Result/错误传播/?运算符/thiserror/日志
- api-development: API设计/Command设计/IPC接口/invoke路径
- architecture-design: 架构/分层/双进程/模块划分/设计/配置
- json-serialization: JSON/序列化/serde/Serialize/Deserialize/类型转换
- utils-toolkit: 工具/工具函数/utils/日期/加密/文件/路径/Rust标准库
- test-development: 测试/test/cargo test/单元测试/集成测试/Mock
- ui-frontend: React组件/UI/表单/列表/布局/样式/CSS/useState/useEffect
- store-management: 状态管理/Context/Zustand/React状态/全局状态
- file-storage: 文件操作/文件读写/fs/对话框/文件选择/保存文件
- security-permissions: 权限/Capabilities/安全/权限声明/CSP/沙箱
- database-ops: 数据库/SQLite/sql插件/本地存储/Store/持久化
- i18n-development: 国际化/i18n/多语言/翻译/locale/语言切换
- notification-system: 通知/notification/系统通知/托盘通知/消息提醒
- performance-doctor: 性能/优化/内存/渲染/打包体积/Rust性能/WebView优化

**L4 框架专属：**
- tauri-commands: Tauri Command/IPC通信/#[tauri::command]/invoke/generate_handler
- tauri-plugins: 插件/plugin/tauri-plugin/fs/dialog/store/http/shell
- tauri-window-management: 窗口/多窗口/WebviewWindow/无边框/系统托盘/窗口事件
- tauri-capabilities: Capabilities/权限配置/安全策略/permissions/identifier/scope
- tauri-packaging: 打包/构建/发布/安装包/MSI/DMG/AppImage/bundle/签名
- rust-fundamentals: Rust/所有权/借用/生命周期/trait/泛型/并发/Mutex/Arc
- tauri-events: 事件/emit/listen/前后端事件/EventTarget/Emitter/全局事件
- tauri-updater: 更新/自动更新/updater/版本检查/增量更新/签名验证
- release-publish: 发布版本/发布更新/release/推送Gitee/签名构建/update.json/版本发布

### 步骤 2 - 激活（逐个调用，等待每个完成）

⚠️ **必须逐个调用 Skill() 工具，每次调用后等待返回再调用下一个**
- 有 N 个匹配技能 → 逐个发起 N 次 Skill() 调用（不要并行！）
- 无匹配技能 → 写"无匹配技能"

**调用顺序**：按列出顺序，先调用第一个，等返回后再调用第二个...

### 步骤 3 - 实现

只有在步骤 2 的所有 Skill() 调用完成后，才能开始实现。

---

**关键规则（违反将导致任务失败）**：
1. ⛔ 禁止：评估后跳过 Skill() 直接实现
2. ⛔ 禁止：只调用部分技能（必须全部调用）
3. ⛔ 禁止：并行调用多个 Skill()（必须串行，一个一个来）
4. ✅ 正确：评估 → 逐个调用 Skill() → 全部完成后实现

**正确示例**：
用户问："帮我实现一个文件管理功能"

匹配技能：
- tauri-commands: 涉及 Tauri Command 定义和 IPC 通信
- file-storage: 涉及文件读写和对话框操作
- tauri-plugins: 需要 fs 和 dialog 插件

激活技能：
> Skill(tauri-commands)
> Skill(file-storage)
> Skill(tauri-plugins)

[所有技能激活完成后开始实现...]

**错误示例（禁止）**：
❌ 只调用部分技能
❌ 列出技能但不调用 Skill()
❌ 并行调用（会导致只有一个生效）`;

console.log(instructions);
process.exit(0);
