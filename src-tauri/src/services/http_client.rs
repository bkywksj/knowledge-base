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

use reqwest::Client;

static SHARED: OnceLock<Client> = OnceLock::new();
static SHARED_NO_PROXY: OnceLock<Client> = OnceLock::new();

/// 全局复用的 reqwest Client，自动走系统代理。
pub fn shared() -> &'static Client {
    SHARED.get_or_init(Client::new)
}

/// 不走系统代理的 Client，用于 Ollama 等本地/内网服务。
pub fn shared_no_proxy() -> &'static Client {
    SHARED_NO_PROXY.get_or_init(|| {
        Client::builder()
            .no_proxy()
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}
