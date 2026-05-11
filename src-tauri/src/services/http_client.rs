//! 共享 HTTP Client 单例。
//!
//! reqwest::Client 内部维护连接池 + TLS 会话缓存，**必须复用才能避免**
//! 每次请求都重新建立 TCP/TLS 握手的开销。AI 流式回复、WebDAV 同步等
//! 热路径原先每次调用都 `Client::new()`，单次请求多出几百毫秒延迟。
//!
//! 用 `OnceLock` 做进程级单例：
//! - `shared()`：普通用途（OpenAI / Claude / WebDAV 等外网 HTTPS）
//! - `shared_no_proxy()`：本地 / 内网服务（Ollama），强制绕过系统代理

use std::sync::OnceLock;
use std::time::Duration;

use reqwest::Client;

static SHARED: OnceLock<Client> = OnceLock::new();
static SHARED_NO_PROXY: OnceLock<Client> = OnceLock::new();

/// Ollama 流式响应"两次读之间"的空闲超时。
///
/// 用 `read_timeout`（每收到一个 chunk 就重置）而非 `timeout`（整请求总时长）：
/// 流式回复本身可以很长，不能用总时长卡死它；但若 Ollama 卡在加载大模型 / 服务挂死、
/// 长时间一个字都不吐，就应让请求带错误返回，而不是让前端 `send_ai_message` 永不
/// resolve、UI 一直显示"生成中 / 停止"。
const OLLAMA_READ_TIMEOUT: Duration = Duration::from_secs(120);

/// 全局复用的 reqwest Client，自动走系统代理。
pub fn shared() -> &'static Client {
    SHARED.get_or_init(Client::new)
}

/// 不走系统代理的 Client，用于 Ollama 等本地/内网服务。
///
/// 带 120s `read_timeout`：避免 Ollama 加载大模型 / 服务挂死时流式请求永远 pending。
pub fn shared_no_proxy() -> &'static Client {
    SHARED_NO_PROXY.get_or_init(|| {
        Client::builder()
            .no_proxy()
            .read_timeout(OLLAMA_READ_TIMEOUT)
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}
