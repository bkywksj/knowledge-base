//! kb-mcp · Knowledge Base MCP Server + CLI (stdio binary)
//!
//! 两种用法：
//! 1. **MCP server**（默认，无子命令）：`kb-mcp --db-path X [--writable]`
//!    → 委托给 kb_core::KbServer 跑 stdio JSON-RPC，供 Claude Desktop / Cursor 等连。
//! 2. **CLI 查询**（#6，子命令）：`kb-mcp --db-path X search "关键词"` 等
//!    → 直接打印 JSON 到 stdout，省去走 MCP 协议的 token，命令行/脚本可直接用。
//!
//! 业务（KbDb / KbServer / 27 工具 / SQL）全部在 kb-core crate，
//! 主应用 (knowledge_base) 也通过同一份 kb-core 跑 in-memory MCP server。

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use kb_core::{CliQuery, KbDb, KbServer};
use rmcp::{transport::stdio, ServiceExt};

#[derive(Debug, Parser)]
#[command(
    name = "kb-mcp",
    version,
    about = "Knowledge Base MCP Server + CLI - 把本地知识库以 MCP 协议 / 命令行暴露给 LLM 客户端"
)]
struct Cli {
    /// 知识库 SQLite 文件路径（必填）。通常是主应用的 app.db。
    /// 例：Windows 下 C:\Users\<name>\AppData\Roaming\com.agilefr.kb\app.db
    #[arg(long, env = "KB_MCP_DB_PATH")]
    db_path: PathBuf,

    /// 启用写工具（create_note / update_note / add_tag_to_note 等）。
    /// 默认关闭 = 完全只读，更安全；显式打开后 LLM 可创建/修改你的笔记。
    /// 仅对 MCP server 模式有意义；CLI 查询子命令一律只读。
    #[arg(long, default_value_t = false)]
    writable: bool,

    /// 子命令。缺省（不带任何子命令）= 以 stdio MCP server 运行（向后兼容旧客户端配置）。
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// 以 stdio MCP server 运行（与不带子命令等价）
    Serve,
    /// 全文搜索笔记（FTS5 + LIKE），打印命中列表 JSON
    Search {
        /// 搜索关键词
        query: String,
        /// 返回上限，默认 20
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// 按 id 取单篇笔记全文，打印 JSON
    Get {
        /// 笔记 id
        id: i64,
    },
    /// 列出所有标签，打印 JSON
    Tags,
    /// 最近更新的笔记，打印 JSON
    Recent {
        /// 返回上限，默认 20
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// 按标签名筛选笔记，打印 JSON
    Tag {
        /// 标签名（精确匹配）
        tag: String,
        /// 返回上限，默认 30
        #[arg(long, default_value_t = 30)]
        limit: usize,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    // clap 自己处理 --help / --version（写 stdout 后 exit），先解析再打日志
    let cli = Cli::parse();

    if !cli.db_path.exists() {
        anyhow::bail!("db 文件不存在: {}", cli.db_path.display());
    }

    // ── CLI 查询模式（子命令，非 Serve）：只读查询 → 打印 JSON → 退出 ──
    if let Some(cmd) = cli.command.as_ref() {
        if !matches!(cmd, Command::Serve) {
            // CLI 一律只读打开（查询不改库）；直调工具方法不经 router，不受白名单影响
            let db = KbDb::open(&cli.db_path, /* writable */ false)?;
            let server = KbServer::new(db, /* writable */ false);
            let query = match cmd {
                Command::Search { query, limit } => CliQuery::Search {
                    query: query.clone(),
                    limit: *limit,
                },
                Command::Get { id } => CliQuery::Get { id: *id },
                Command::Tags => CliQuery::Tags,
                Command::Recent { limit } => CliQuery::Recent { limit: *limit },
                Command::Tag { tag, limit } => CliQuery::SearchByTag {
                    tag: tag.clone(),
                    limit: *limit,
                },
                Command::Serve => unreachable!("Serve 已在外层排除"),
            };
            match server.cli_run(&query) {
                Ok(json) => {
                    println!("{json}");
                    return Ok(());
                }
                Err(e) => {
                    eprintln!("[kb-mcp] 查询失败: {e}");
                    std::process::exit(1);
                }
            }
        }
    }

    // ── MCP server 模式（默认 / Serve 子命令）──
    // 关键：日志走 stderr，stdout 是 JSON-RPC 通道，绝对不能污染
    eprintln!(
        "[kb-mcp] starting v{}, db = {}, mode = {}",
        env!("CARGO_PKG_VERSION"),
        cli.db_path.display(),
        if cli.writable {
            "READ-WRITE"
        } else {
            "READ-ONLY"
        }
    );

    let db = KbDb::open(&cli.db_path, cli.writable)?;
    // 工具白名单（#5）：从主应用 app_config 读「保留哪些工具」，裁剪掉其余的省 token。
    // 主应用设置页改白名单后，外部客户端重连本 sidecar 即生效（无需改 Claude Desktop 配置）。
    let keep = db.read_tool_whitelist();
    if let Some(ref k) = keep {
        eprintln!("[kb-mcp] tool whitelist active: keep {} tools (+ping)", k.len());
    }
    let server = KbServer::new_filtered(db, cli.writable, keep);

    // serve(stdio()) 接管 stdin/stdout，按 JSON-RPC 帧收发
    let service = server
        .serve(stdio())
        .await
        .with_context(|| "rmcp serve(stdio) 启动失败")?;

    eprintln!("[kb-mcp] ready");
    service.waiting().await?;
    eprintln!("[kb-mcp] shutdown");
    Ok(())
}
