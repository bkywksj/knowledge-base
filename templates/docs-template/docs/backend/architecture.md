# 三层架构

<!-- 本章由 /docs 命令基于 src-tauri/src/ 实际代码自动更新 -->

{{PROJECT_NAME}} 的 Rust 后端采用三层架构，从 IPC 入口到数据访问层层分离：

```
Commands 层  →  Services 层  →  Database 层
  (IPC 入口)     (业务逻辑)      (SQL 操作)
```

## 各层职责

| 层级 | 目录 | 职责 | 关键技术 |
|------|------|------|---------|
| Commands | `src-tauri/src/commands/` | 薄 IPC 包装，参数校验后转发给 Service | `#[tauri::command]` |
| Services | `src-tauri/src/services/` | 业务逻辑、事务编排、跨表操作 | 纯 Rust 函数 |
| Database | `src-tauri/src/database/` | SQL 操作、连接管理、Schema 迁移 | rusqlite + `Mutex<Connection>` |

## 数据流示例

前端 `invoke("get_all_config")` 到返回值的完整链路：

```
1. 前端: configApi.getAll()           (src/lib/api/config.ts)
2. IPC:  invoke("get_all_config")
3. Rust Command: get_all_config()     (src-tauri/src/commands/config.rs)
4. Service:      ConfigService::get_all(db)  (src-tauri/src/services/config.rs)
5. Database:     db.get_all_config()  (src-tauri/src/database/mod.rs)
6. SQLite:       SELECT * FROM app_config
```

## 错误处理

- Database/Service 层返回 `Result<T, AppError>`（`src-tauri/src/error.rs`）
- Command 层把 `AppError` 转换为 `CommandError`（带结构化错误码）
- 前端通过 `getErrorCode()` / `getErrorMessage()` 解析（`src/lib/api/client.ts`）

## 下一步

- [API 参考](../api/commands.md) — 所有 Command 清单
