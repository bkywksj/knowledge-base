# kb-mcp · 把知识库接到 Claude Desktop / Cursor

`kb-mcp` 是一个独立的 MCP（Model Context Protocol）Server sidecar。它把本地知识库以 stdio MCP 协议暴露出来，让 Claude Desktop / Cursor / Cherry Studio 等任何兼容 MCP 的 LLM 客户端都能直接搜索、读取你的笔记。

## 它是什么

- **完全独立的 binary** —— 不是 Tauri 主应用的一部分；编译后是单文件 `kb-mcp.exe`（Windows）/ `kb-mcp`（macOS/Linux）
- **只读 SQLite** —— 直接打开主应用的 `app.db`，不写入，不抢锁；与主应用同时运行无冲突（依赖 WAL 模式）
- **隐私默认安全** —— 自动过滤回收站 / 隐藏 / 加密笔记，不会把这些内容暴露给 LLM

## 当前已暴露的工具（v0.2）

### 读工具（默认可用）

| 工具 | 说明 |
|---|---|
| `ping` | 健康检查，返回 sidecar 版本 |
| `search_notes(query, limit?)` | 全文搜索（FTS5 + LIKE 兜底） |
| `get_note(id)` | 按 id 读全文。加密笔记返回占位符 |
| `list_tags` | 所有标签 + 笔记数（按数降序） |
| `search_by_tag(tag, limit?)` | 按标签名筛选笔记 |
| `get_backlinks(id)` | 反向链接：哪些笔记 [[...]] 到了它 |
| `list_daily_notes(days?, limit?)` | 最近 N 天日记（默认 7 天） |
| `list_tasks(status?, keyword?, limit?)` | 主任务列表（按 priority/due_date 排序） |
| `get_prompt(id?, builtin_code?)` | 取一条 Prompt 模板 |

### 写工具（需 `--writable` 启动开关，默认禁用）

| 工具 | 说明 |
|---|---|
| `create_note(title, content, folder_id?)` | 创建新笔记。自动维护 title_normalized + content_hash + FTS5 索引 |
| `update_note(id, title?, content?, folder_id?)` | 改字段。拒绝改加密笔记。三个字段都是可选，只更新传入的 |
| `add_tag_to_note(note_id, tag)` | 给笔记加标签。tag 不存在自动创建 |

> ⚠️ 写工具默认不会被启用。在客户端配置的 `args` 里加 `"--writable"` 才能让 LLM 修改你的知识库。
> 不加这个开关时，sidecar 用 SQLITE_OPEN_READ_ONLY 打开 db，从内核层面禁止任何写入。

## 编译

```bash
# 项目根目录运行（一键完成 cargo build + 复制到 binaries/）
pnpm build:mcp           # release 模式（推荐）
pnpm build:mcp:debug     # debug 模式（编译快）
```

产物路径：`src-tauri/binaries/kb-mcp-<host-triple>.exe`

例如 Windows x64 上是 `src-tauri/binaries/kb-mcp-x86_64-pc-windows-msvc.exe`。

> ⚠️ 直接 `cargo build -p kb-mcp` 也行，但产物在 `target/release/kb-mcp.exe`，
> Tauri 打包不会自动带上。`pnpm build:mcp` 会同时复制到 `binaries/` 让 Tauri externalBin
> 在下次 `pnpm tauri build` 时把它带进安装包。

## 找到知识库 db 路径

| 平台 | 路径 |
|---|---|
| Windows | `%APPDATA%\com.agilefr.kb\app.db` |
| macOS | `~/Library/Application Support/com.agilefr.kb/app.db` |
| Linux | `~/.local/share/com.agilefr.kb/app.db` |

> 多开实例：默认实例在 `app.db`；第 N 个实例在 `instance-N/app.db`。

## 接入 Claude Desktop

打开 `%APPDATA%\Claude\claude_desktop_config.json`（macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`），加入：

```json
{
  "mcpServers": {
    "knowledge-base": {
      "command": "C:\\full\\path\\to\\kb-mcp.exe",
      "args": [
        "--db-path",
        "C:\\Users\\YOUR_NAME\\AppData\\Roaming\\com.agilefr.kb\\app.db"
      ]
    }
  }
}
```

> 🔓 **想让 LLM 真能写笔记**：在 `args` 里追加 `"--writable"`：
> ```json
> "args": ["--db-path", "...", "--writable"]
> ```

重启 Claude Desktop。在对话框里看到「🔌 knowledge-base」图标即接入成功，可直接说「帮我搜知识库里关于 XXX 的笔记」。开了 `--writable` 还能说「帮我把这段总结成笔记保存到知识库，加上 ai 标签」。

## 接入 Cursor

`~/.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "knowledge-base": {
      "command": "C:/full/path/to/kb-mcp.exe",
      "args": ["--db-path", "C:/Users/YOUR_NAME/AppData/Roaming/com.agilefr.kb/app.db"]
    }
  }
}
```

## 接入 Cherry Studio

设置 → MCP 服务器 → 添加 → 选 stdio → 命令填 `kb-mcp.exe` 全路径，参数填 `--db-path <db 全路径>`。

## 自检 / 调试

仓库自带一个握手脚本：

```bash
bash src-tauri/mcp/test-handshake.sh
```

它会喂入 `initialize` + `tools/list` + `ping` + `search_notes` 四个 JSON-RPC 帧，把 stdout 打到终端。看到每条都有 `result` 字段即正常。

## 常见问题

### Claude Desktop 一加 server 就闪断

历史上 Claude Desktop on Windows 对 Rust MCP server 有 init 后立即 disconnect 的兼容问题。本项目用的 `rmcp 1.5` 已修复。如果仍有问题：

1. 看 Claude Desktop 的 MCP 日志：`%APPDATA%\Claude\logs\mcp-server-knowledge-base.log`
2. 检查 db 路径是否包含中文或空格（建议先用纯英文路径排除）
3. 手动用 `test-handshake.sh` 验证 binary 本身没问题
4. 兜底方案：在中间套一层 Node.js wrapper（待补 npm 包）

### sidecar 会写数据吗

不会。`kb-mcp` 用 `SQLITE_OPEN_READ_ONLY` 打开数据库，从代码层面禁止任何 INSERT/UPDATE/DELETE。

### 加密笔记的内容会被泄露吗

不会。`get_note` 检测到 `is_encrypted=1` 时直接返回占位符，密文从不出库。同时 `search_notes` 在 SQL 层就过滤了加密笔记。

### 性能怎么样

stdio + 直连 SQLite，单次 search_notes 在 1 万条笔记规模下 < 50ms。FTS5 索引由主应用维护，sidecar 直接复用。
