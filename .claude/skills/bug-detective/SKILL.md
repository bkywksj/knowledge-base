---
name: bug-detective
description: |
  排查已发生的问题、定位 Bug 原因。

  触发场景：
  - 代码运行报错，需要定位原因
  - 功能不正常，需要排查
  - Tauri Command 返回错误，需要分析
  - 日志分析、调试代码

  触发词：Bug、报错、不工作、调试、排查、为什么、出问题、失败、不生效、无效、找不到原因、定位问题
---

# Bug 排查指南

## 排查方法论

### 1. 复现问题
- 确认问题的具体表现
- 收集错误信息（终端日志、浏览器控制台、Rust panic 信息）
- 确认问题的触发条件
- 确认问题出现在哪个平台（Windows/macOS/Linux）

### 2. 缩小范围
- 前端 (React) or 后端 (Rust)？
- IPC 通信层的问题？
- 权限 (Capabilities) 不足？
- 哪个 Command/组件？
- 什么时候开始出现？

### 3. 定位根因
- 阅读相关 Rust/TypeScript 代码
- 检查终端日志（Rust println!/log）
- 检查浏览器 DevTools 控制台
- 添加 `dbg!()` 宏（Rust）或 `console.log`（TS）
- 对比正常 vs 异常的数据

### 4. 验证修复
- 修复后验证问题已解决
- 在所有目标平台上测试
- 确认没有引入新问题

---

## 常见问题分类

### Rust 后端常见问题

| 症状 | 可能原因 | 排查方法 |
|------|---------|---------|
| Command 调用无响应 | 函数名未在 `generate_handler!` 注册 | 检查 `lib.rs` 的 handler 列表 |
| `invoke` 返回错误 | Rust 侧 panic 或返回 Err | 检查终端 Rust 错误输出 |
| 类型序列化失败 | struct 缺少 Serialize/Deserialize derive | 添加 `#[derive(Serialize, Deserialize)]` |
| State 获取失败 | 未在 Builder 中 `.manage()` 注册 | 检查 Builder 链式调用 |
| 编译错误 | 所有权/借用/生命周期问题 | 阅读 Rust 编译器错误提示 |
| 插件功能不可用 | Capabilities 未声明权限 | 检查 `capabilities/default.json` |

### React 前端常见问题

| 症状 | 可能原因 | 排查方法 |
|------|---------|---------|
| 页面空白 | JS 错误 | 打开 DevTools 控制台 (F12) |
| invoke 调用报错 | Command 名称拼写错误 | 确认 snake_case 函数名 |
| 状态不更新 | useState 闭包陷阱 | 使用函数式更新 `setState(prev => ...)` |
| 事件监听不生效 | 未清理旧监听器 | 在 useEffect 中返回 unlisten |
| 样式不生效 | CSS 冲突或选择器错误 | 使用 DevTools Elements 面板 |
| 页内拖拽光标显示 🚫、onDrop 不触发（antd Tree/react-dnd 等） | Tauri 窗口 `dragDropEnabled` 默认 true，WebView 吞掉 HTML5 dragover/drop | `tauri.conf.json` 窗口配置加 `"dragDropEnabled": false`，重启 dev |
| 右键菜单 Dropdown（`trigger={['contextMenu']}`）包裹节点后 antd Tree 拖不动 | rc-trigger ref 转发 + mousedown 拦截破坏原生 drag 绑定 | 改用 Tree 级 `onRightClick` + 全局定位 Dropdown（幻影锚点） |

### IPC 通信常见问题

| 症状 | 可能原因 | 排查方法 |
|------|---------|---------|
| invoke 超时 | Rust 侧阻塞主线程 | 改用 async Command |
| 参数传递失败 | 参数类型不匹配 (camelCase vs snake_case) | 检查前后端参数名映射 |
| 返回值为空 | Rust 函数签名返回 `()` | 确认返回 `Result<T, String>` |

---

## 调试工具

### Rust 调试
```rust
// println! 输出到终端
println!("Debug: {:?}", variable);

// dbg! 宏（输出文件名/行号/值）
dbg!(&my_variable);

// 使用 log crate
log::info!("Processing: {}", data);
log::error!("Failed: {}", err);
```

### TypeScript 调试
```typescript
// 浏览器控制台
console.log("invoke result:", result);
console.error("invoke failed:", error);

// 检查 invoke 调用
try {
  const result = await invoke("my_command", { arg1 });
  console.log("Success:", result);
} catch (e) {
  console.error("Failed:", e);
}
```

### DevTools 开启
```
// 开发模式自动开启 DevTools
// 生产模式可通过配置开启:
// tauri.conf.json → app.windows[0].devtools = true
```

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 不看 Rust 编译器错误提示 | Rust 编译器提示非常详细，先仔细阅读 |
| 不区分前端/后端/IPC 问题 | 先确定问题在哪个层，再深入排查 |
| 不检查 Capabilities | 插件功能不可用时首先检查权限声明 |
| 只在一个平台测试 | 跨平台问题需在所有目标平台验证 |
