//! 共享 HTTP Client 单例。
//!
//! reqwest::Client 内部维护连接池 + TLS 会话缓存，**必须复用才能避免**
//! 每次请求都重新建立 TCP/TLS 握手的开销。AI 流式回复、WebDAV 同步等
//! 热路径原先每次调用都 `Client::new()`，单次请求多出几百毫秒延迟。
//!
//! 用 `OnceLock` 做进程级单例：
//! - `shared()`：普通用途（OpenAI / Claude / WebDAV 等外网 HTTPS），自动走系统代理（环境变量）
//! - `shared_no_proxy()`：本地 / 内网服务（Ollama），强制绕过系统代理 + 带空闲读超时

use std::sync::OnceLock;
use std::time::Duration;

use reqwest::Client;

static SHARED: OnceLock<Client> = OnceLock::new();
static SHARED_NO_PROXY: OnceLock<Client> = OnceLock::new();
static SHARED_WEBDAV: OnceLock<Client> = OnceLock::new();

/// WebDAV 连接（TCP + TLS 握手）超时。移动网络切换 / 半开连接下，若不设此值，
/// reqwest 默认**无限等待**建连，整个同步 command 永不返回、前端一直卡"同步中"。
const WEBDAV_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// WebDAV "两次读之间"的空闲超时（每收到一段响应体就重置）。
///
/// 用 `read_timeout` 而非整请求 `timeout`：附件上传/下载可能是几十 MB、本身耗时很长，
/// 用总时长会误杀正常的大文件传输；而 `read_timeout` 只在"连接卡死、长时间一个字节都不动"
/// 时才触发 → 既能识别死连接，又不打断"慢但活着"的大文件传输。移动端弱网必备。
const WEBDAV_READ_TIMEOUT: Duration = Duration::from_secs(60);

/// Ollama 流式响应"两次读之间"的空闲超时。
///
/// 用 `read_timeout`（每收到一个 chunk 就重置）而非 `timeout`（整请求总时长）：流式回复
/// 本身可以很长，不能用总时长卡死它；但若 Ollama 卡死 / 服务挂掉、长时间一个字都不吐，
/// 就应让请求带错误返回，而不是让前端 `send_ai_message` 永不 resolve、UI 一直"生成中"。
///
/// **为什么是 600s 而不是更短**：智能模式会把几十个工具 schema（内置 + 所有 MCP 工具）
/// 塞进请求，Ollama 上的小模型（如 7B）光是 prompt-eval 这一大段就可能要好几分钟（尤其
/// 冷启动 + CPU 推理 + 远程网络），期间一个 token 都不会吐。120s 太短会把"其实在干活、
/// 只是慢"的请求误掐断。前端始终有"停止"按钮，所以这里取宁可等久点也别误杀。
const OLLAMA_READ_TIMEOUT: Duration = Duration::from_secs(600);

/// 全局复用的 reqwest Client，自动走系统代理（reqwest 默认读 `HTTP_PROXY` 等环境变量）。
pub fn shared() -> &'static Client {
    SHARED.get_or_init(Client::new)
}

/// WebDAV 同步专用 Client：带 connect / read 空闲超时，避免移动端弱网下同步请求永久挂起。
///
/// 独立于 `shared()`：`shared()` 供 AI 流式回复等场景用（那里不能设总超时、也不该被 WebDAV 的
/// 超时策略影响），故 WebDAV 单开一个池。自动走系统代理（reqwest 默认读环境变量），
/// 与 `shared()` 行为一致，只是多了超时约束。构建失败时降级回退到无超时 Client（不至于让同步不可用）。
pub fn shared_webdav() -> &'static Client {
    SHARED_WEBDAV.get_or_init(|| {
        Client::builder()
            .connect_timeout(WEBDAV_CONNECT_TIMEOUT)
            .read_timeout(WEBDAV_READ_TIMEOUT)
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}

/// 不走系统代理的 Client，用于 Ollama 等本地/内网服务。
///
/// Ollama 通常是 localhost / 内网 / Tailscale / 自建 overlay 等地址，走 Clash 等系统 HTTP
/// 代理只会被劫持；带 600s `read_timeout`：避免服务挂死时流式请求永远 pending，又给慢模型
/// （智能模式 + 大量工具的 prompt-eval）留足时间。
pub fn shared_no_proxy() -> &'static Client {
    SHARED_NO_PROXY.get_or_init(|| {
        Client::builder()
            .no_proxy()
            .read_timeout(OLLAMA_READ_TIMEOUT)
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}
