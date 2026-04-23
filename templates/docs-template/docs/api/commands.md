# Command 参考

<!-- 本章由 /docs 命令基于 src-tauri/src/commands/ 自动生成 -->
<!-- 每个 Command 一小节，包含：函数签名、参数、返回值、错误、前端 invoke 示例 -->

本章列出所有已注册的 Tauri Command（`#[tauri::command]` 标记，并在 `lib.rs` 的 `generate_handler!` 中注册）。

## 索引

<!-- /docs 命令会自动维护下面的索引表 -->

| Command | 模块 | 简述 |
|---------|------|------|
| _待自动生成_ | _—_ | _—_ |

## 调用约定

- 前端调用名与 Rust 函数名一致（snake_case）
- Rust 参数 `snake_case` ↔ TypeScript 参数 `camelCase`（Tauri 自动转换）
- 返回 `Result<T, CommandError>`，前端可用 `getErrorCode()` / `getErrorMessage()` 解析

## 前端封装

所有 Command 调用统一通过 `src/lib/api/` 封装，不要在页面组件中裸写 `invoke()`。

```typescript
// 正确
import { configApi } from "@/lib/api";
const data = await configApi.getAll();

// 错误
import { invoke } from "@tauri-apps/api/core";
const data = await invoke("get_all_config");
```
