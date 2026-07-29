//! MCP HTTP 服务 —— 把自家知识库以 Streamable HTTP 暴露给外部 agent
//!
//! 用户反馈：软件已支持「调用别人的 MCP」，但自己这套工具只能靠 stdio
//! （对方必须能 spawn 进程）。Web 端 / 局域网里的 agent 连不上。
//!
//! 架构：
//! ```text
//!   知识库.exe
//!     ├─ 主窗口 (WebView)
//!     ├─ in-memory MCP（已有，自家 AI 用）
//!     └─ HTTP MCP  ← 本模块
//!          axum Router
//!            └─ /mcp  →  auth 中间件  →  rmcp StreamableHttpService
//!                                          └─ KbServer（与 stdio 同一份实现）
//! ```
//!
//! **安全**（这是对外暴露面，下面每一条都不能省）：
//! 1. 默认关闭，用户显式开启
//! 2. 默认只读；写工具要再勾一次（沿用 kb-mcp 的 `--writable` 语义）
//! 3. 强制 Bearer Token —— 没配 token 直接拒绝启动，不给"裸奔"的机会
//! 4. 绑定地址默认 127.0.0.1；切 0.0.0.0 由前端给醒目警告
//! 5. DNS rebinding 防护：rmcp 自带 `allowed_hosts` 校验 Host 头，
//!    避免浏览器页面用 DNS rebinding 打本机端口
//! 6. 复用工具白名单（`read_tool_whitelist`），与 stdio / in-memory 共用裁剪逻辑

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::Request,
    http::{header, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    Router,
};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::error::AppError;

/// 配置键（存 app_config，与其它偏好同一个路子）
pub const KEY_ENABLED: &str = "mcp_http_enabled";
pub const KEY_PORT: &str = "mcp_http_port";
pub const KEY_TOKEN: &str = "mcp_http_token";
pub const KEY_WRITABLE: &str = "mcp_http_writable";
pub const KEY_BIND_LAN: &str = "mcp_http_bind_lan";

pub const DEFAULT_PORT: u16 = 8765;

/// 运行中的 HTTP 服务句柄。停机靠 CancellationToken，不 abort task ——
/// 让 axum 把手上的请求处理完再退出。
#[derive(Default)]
pub struct McpHttpState {
    inner: Mutex<Option<RunningServer>>,
}

struct RunningServer {
    addr: SocketAddr,
    cancel: CancellationToken,
}

/// 对前端暴露的运行状态
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHttpStatus {
    pub running: bool,
    /// 形如 "127.0.0.1:8765"；未运行时为 None
    pub addr: Option<String>,
    /// 客户端该填的完整端点
    pub endpoint: Option<String>,
}

impl McpHttpState {
    pub async fn status(&self) -> McpHttpStatus {
        let guard = self.inner.lock().await;
        match guard.as_ref() {
            Some(s) => McpHttpStatus {
                running: true,
                addr: Some(s.addr.to_string()),
                endpoint: Some(format!("http://{}/mcp", s.addr)),
            },
            None => McpHttpStatus {
                running: false,
                addr: None,
                endpoint: None,
            },
        }
    }

    /// 停掉正在运行的服务；没在跑就是 no-op
    pub async fn stop(&self) {
        let mut guard = self.inner.lock().await;
        if let Some(s) = guard.take() {
            log::info!("[mcp-http] 停止服务 {}", s.addr);
            s.cancel.cancel();
        }
    }
}

/// Bearer Token 鉴权中间件。
///
/// 常数时间比较：token 比对若用 `==` 会短路，理论上能被计时攻击逐字节猜出来。
/// 局域网暴露场景下这不是纯理论风险，所以老老实实全量比。
async fn auth_middleware(
    axum::extract::State(expected): axum::extract::State<Arc<String>>,
    req: Request,
    next: Next,
) -> Response {
    let raw = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let provided = raw.strip_prefix("Bearer ").unwrap_or("");

    if !constant_time_eq(provided.as_bytes(), expected.as_bytes()) {
        // 区分"没带"和"带错了"：两者的处置完全不同（去复制 token vs 换一个 token），
        // 但客户端只看得到状态码，所以必须写进响应体。
        let reason = if raw.is_empty() {
            "missing_token"
        } else if provided.is_empty() {
            "malformed_header"
        } else {
            "invalid_token"
        };
        log::warn!("[mcp-http] 鉴权失败（{reason}）");
        return unauthorized(reason);
    }
    next.run(req).await
}

/// 带人话说明的 401。
///
/// 用户反馈里两个浏览器插件都只显示一句 "MCP server returned HTTP 401."，
/// 因为原来直接返回 `StatusCode::UNAUTHORIZED`（空响应体）——客户端拿不到任何
/// 可操作信息，用户只能猜。现在把「哪里错了 + 去哪儿拿 token + 正确的头长什么样」
/// 都写进 body，顺带按 RFC 6750 补 `WWW-Authenticate`，让规范些的客户端能自动提示。
fn unauthorized(reason: &str) -> Response {
    let hint = match reason {
        "missing_token" => {
            "请求缺少 Authorization 头。在知识库「设置 → MCP 服务器 → HTTP 服务」复制 Token，             在客户端加请求头：Authorization: Bearer <token>"
        }
        "malformed_header" => {
            "Authorization 头格式不对，必须是 `Bearer <token>`（注意 Bearer 后有一个空格）"
        }
        _ => "Token 不匹配。请在知识库「设置 → MCP 服务器 → HTTP 服务」重新复制当前 Token",
    };
    // 手写 JSON：就三个固定字段，不值得为它引 serde_json 到这一层
    let body = format!(
        r#"{{"error":"{reason}","hint":"{hint}","protocol":"MCP Streamable HTTP（不是思源 API / Obsidian Local REST API，那些协议接不上）"}}"#
    );
    let mut resp = (StatusCode::UNAUTHORIZED, body).into_response();
    resp.headers_mut().insert(
        header::WWW_AUTHENTICATE,
        HeaderValue::from_static(r#"Bearer realm="knowledge-base-mcp""#),
    );
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    resp
}

/// 常数时间字节比较（不短路），避免用响应时间侧信道猜 token
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// 启动 HTTP MCP 服务。
///
/// 已在运行时先停旧的再起新的（改端口 / 改只读开关后重启即可生效）。
pub async fn start(
    state: &McpHttpState,
    db_path: std::path::PathBuf,
    port: u16,
    token: String,
    writable: bool,
    bind_lan: bool,
) -> Result<McpHttpStatus, AppError> {
    if token.trim().is_empty() {
        // 没 token 就不给起 —— 局域网下裸奔等于把整个知识库敞开
        return Err(AppError::InvalidInput(
            "未设置访问 Token，拒绝启动（没有 Token 等于把知识库对整个网络敞开）".into(),
        ));
    }

    // 先停旧实例，保证端口不冲突
    state.stop().await;

    let host = if bind_lan { "0.0.0.0" } else { "127.0.0.1" };
    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .map_err(|e| AppError::InvalidInput(format!("非法的监听地址 {host}:{port}: {e}")))?;

    // rmcp 的 Host 头白名单（DNS rebinding 防护）。绑局域网时得把本机各种可能的
    // 访问方式都放进来，否则客户端用 IP 访问会被 rmcp 拒掉。
    let mut allowed_hosts = vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        format!("localhost:{port}"),
        format!("127.0.0.1:{port}"),
    ];
    if bind_lan {
        // 局域网：允许任意 Host。DNS rebinding 的防线此时改由 Bearer Token 承担
        //（攻击者的页面拿不到 token，即使 rebind 成功也过不了鉴权）。
        allowed_hosts.clear();
    }

    let cancel = CancellationToken::new();
    // StreamableHttpServerConfig 是 #[non_exhaustive]，不能用结构体字面量构造，
    // 只能先 default 再逐字段改
    let mut cfg = StreamableHttpServerConfig::default();
    cfg.stateful_mode = true;
    cfg.json_response = false;
    cfg.cancellation_token = cancel.clone();
    cfg.allowed_hosts = allowed_hosts;

    // 每个会话新开一个 KbServer：各自独立 SQLite 连接（WAL + busy_timeout 保证并发安全），
    // 与 stdio / in-memory 用的是同一份 KbServer 实现和同一套工具白名单。
    let mcp_service = StreamableHttpService::new(
        move || {
            let db = kb_core::KbDb::open(&db_path, writable)
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            let keep = db.read_tool_whitelist();
            Ok(kb_core::KbServer::new_filtered(db, writable, keep))
        },
        Arc::new(LocalSessionManager::default()),
        cfg,
    );

    let app = Router::new().nest_service("/mcp", mcp_service).layer(
        middleware::from_fn_with_state(Arc::new(token), auth_middleware),
    );

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| AppError::Custom(format!("端口 {port} 监听失败（可能已被占用）: {e}")))?;
    let bound = listener
        .local_addr()
        .map_err(|e| AppError::Custom(e.to_string()))?;

    let cancel_for_task = cancel.clone();
    tauri::async_runtime::spawn(async move {
        let server = axum::serve(listener, app.into_make_service())
            .with_graceful_shutdown(async move { cancel_for_task.cancelled().await });
        if let Err(e) = server.await {
            log::warn!("[mcp-http] 服务异常退出: {e}");
        } else {
            log::info!("[mcp-http] 服务已停止");
        }
    });

    log::info!(
        "[mcp-http] 已启动 http://{bound}/mcp（{}，{}）",
        if writable { "读写" } else { "只读" },
        if bind_lan { "局域网可访问" } else { "仅本机" }
    );

    {
        let mut guard = state.inner.lock().await;
        *guard = Some(RunningServer { addr: bound, cancel });
    }
    Ok(state.status().await)
}

/// 生成一个新的随机 Token（32 字节 → 64 位十六进制）
///
/// 用 `thread_rng`（OS 熵源播种的 CSPRNG），不是 `rand::random` 那种可预测的弱随机 ——
/// 这个 token 是局域网下的唯一防线。
pub fn generate_token() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_eq_matches_semantics_of_normal_eq() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(!constant_time_eq(b"", b"x"));
        assert!(constant_time_eq(b"", b""));
    }

    /// 401 必须带可操作信息 —— 用户反馈里插件只显示一句 "HTTP 401."，
    /// 拿不到"去哪儿复制 token"的线索。这条锁住三种失败原因各自的提示。
    #[test]
    fn unauthorized_response_carries_actionable_hint() {
        use axum::body::to_bytes;

        for (reason, expect_in_hint) in [
            ("missing_token", "Authorization"),
            ("malformed_header", "Bearer"),
            ("invalid_token", "重新复制"),
        ] {
            let resp = unauthorized(reason);
            assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
            // RFC 6750：规范些的客户端会读它自动提示要 Bearer 凭据
            assert!(
                resp.headers().contains_key(header::WWW_AUTHENTICATE),
                "{reason}: 应带 WWW-Authenticate"
            );

            let body = tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap()
                .block_on(async { to_bytes(resp.into_body(), 64 * 1024).await.unwrap() });
            let text = String::from_utf8(body.to_vec()).unwrap();
            assert!(text.contains(reason), "{reason}: body 应写明 error 字段");
            assert!(
                text.contains(expect_in_hint),
                "{reason}: hint 里应出现「{expect_in_hint}」，实际：{text}"
            );
            // 明确告诉用户这是 MCP 协议，避免再拿思源 API 那套来接
            assert!(text.contains("MCP"), "{reason}: 应写明协议类型");
        }
    }

    #[test]
    fn generated_token_is_64_hex_chars_and_unique() {
        let a = generate_token();
        let b = generate_token();
        assert_eq!(a.len(), 64, "32 字节应编码成 64 个十六进制字符");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "两次生成不应相同（随机源坏了会退化成固定值）");
    }
}
