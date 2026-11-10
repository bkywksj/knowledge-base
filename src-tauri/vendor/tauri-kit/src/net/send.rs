//! 直连、按系统代理两个共享客户端，以及「先直连、连不上再走代理」。

use std::fmt;
use std::sync::OnceLock;
use std::time::Duration;

use super::logic::chain;

/// 直连时连接阶段的超时：只能经代理上网的环境里直连多半一直连不上，不能让它把整个请求超时等满
const DIRECT_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// 不读任何代理设置的客户端，连接阶段 5 秒超时。进程内共享（连接池 + TLS 会话复用）。
///
/// 返回 `None` 只在 TLS 后端初始化失败时出现（这时别的客户端也建不起来）。
pub fn direct_client() -> Option<&'static reqwest::Client> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| make(reqwest::Client::builder().no_proxy().connect_timeout(DIRECT_CONNECT_TIMEOUT), "直连"))
        .as_ref()
}

/// 按系统代理设置（`HTTPS_PROXY` / `ALL_PROXY` 等环境变量、系统代理）发请求的客户端，进程内共享。
pub fn system_proxy_client() -> Option<&'static reqwest::Client> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT.get_or_init(|| make(reqwest::Client::builder(), "系统代理")).as_ref()
}

// 不退回 Client::new()：它在同样的情况下会 panic
fn make(builder: reqwest::ClientBuilder, which: &str) -> Option<reqwest::Client> {
    builder
        .build()
        .map_err(|e| log::warn!("[net] {which}客户端构建失败: {}", describe(e)))
        .ok()
}

/// [`send_direct_first`] 的失败原因。
#[derive(Debug, Clone)]
pub struct SendError {
    /// 直连失败的原因（已展开 source 链）
    pub direct: String,
    /// 按系统代理重发失败的原因；`None` 表示没有重发：连上之后才失败，重发可能让请求被处理两次
    pub via_proxy: Option<String>,
}

impl fmt::Display for SendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.via_proxy {
            Some(p) => write!(f, "直连: {}；系统代理: {}", self.direct, p),
            None => write!(f, "直连: {}", self.direct),
        }
    }
}

impl std::error::Error for SendError {}

const NO_CLIENT: &str = "HTTP 客户端初始化失败";

/// 先直连；连接阶段失败（DNS / 拒绝连接 / 连接超时 / TLS 握手失败）再按系统代理重发一次。
///
/// 给授权这类国内服务用：绝大多数用户直连就通，代理设置却常和实际不符。只在连接阶段换路，
/// 这时请求还没发出去，下单之类的请求不会被处理两次；连上之后的失败（读响应超时等）直接返回。
/// 超时等请求参数在 `build` 里设，两次请求都会带上：
///
/// ```ignore
/// let resp = tauri_kit::net::send_direct_first(|c| c.post(&url).json(&body).timeout(timeout)).await?;
/// ```
pub async fn send_direct_first<F>(build: F) -> Result<reqwest::Response, SendError>
where
    F: Fn(&reqwest::Client) -> reqwest::RequestBuilder,
{
    let direct = match direct_client() {
        Some(c) => match build(c).send().await {
            Ok(resp) => return Ok(resp),
            Err(e) if e.is_connect() => describe(e),
            Err(e) => return Err(SendError { direct: describe(e), via_proxy: None }),
        },
        None => NO_CLIENT.to_string(),
    };
    let Some(c) = system_proxy_client() else {
        return Err(SendError { direct, via_proxy: Some(NO_CLIENT.to_string()) });
    };
    match build(c).send().await {
        Ok(resp) => {
            log::info!("[net] 直连失败，按系统代理设置重发成功。直连失败原因: {direct}");
            Ok(resp)
        }
        Err(e) => Err(SendError { direct, via_proxy: Some(describe(e)) }),
    }
}

/// reqwest 错误连同底层原因展开成一行，去掉 URL（URL 里可能带订单号之类的参数）。
pub fn describe(e: reqwest::Error) -> String {
    chain(&e.without_url())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本机一个没人监听的端口：请求在连接那一步就失败，不发任何外网请求
    fn closed_local_port() -> u16 {
        let l = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        l.local_addr().expect("addr").port()
    }

    /// 守护 Cargo.toml 里两个 reqwest 的 socks 特性。
    ///
    /// 不开时 socks5 代理被当成 HTTP 代理，报的是 `unsupported scheme` 一类；开了才会真去连 SOCKS 代理。
    /// 不能用 `Proxy::all("socks5://…").is_ok()` 判断：它不校验协议，开不开都返回 Ok。
    #[tokio::test]
    async fn socks5_proxy_is_actually_used() {
        let proxy = format!("socks5://127.0.0.1:{}", closed_local_port());

        let c = reqwest::Client::builder()
            .proxy(reqwest::Proxy::all(&proxy).expect("proxy"))
            .build()
            .expect("client");
        let msg = describe(c.get("http://127.0.0.1:9/").send().await.expect_err("应连不上"));
        assert!(msg.to_lowercase().contains("socks"), "reqwest 0.12 没开 socks 特性: {msg}");

        let c = reqwest013::Client::builder()
            .proxy(reqwest013::Proxy::all(&proxy).expect("proxy"))
            .build()
            .expect("client");
        let e = c.get("http://127.0.0.1:9/").send().await.expect_err("应连不上");
        let msg = chain(&e.without_url());
        assert!(msg.to_lowercase().contains("socks"), "reqwest 0.13 没开 socks 特性（检查更新会挂）: {msg}");
    }

    /// 直连连不上（端口没人监听）要按系统代理再发一次。重发的结果取决于本机代理设置，只断言重发了
    #[tokio::test]
    async fn connect_failure_is_retried_via_system_proxy() {
        let url = format!("http://127.0.0.1:{}/", closed_local_port());
        let r = send_direct_first(|c| c.get(&url).timeout(Duration::from_secs(10))).await;
        if let Err(e) = r {
            assert!(e.via_proxy.is_some(), "连接阶段失败应该重发: {e}");
        }
    }

    /// 连上之后才失败的不能重发：请求可能已被服务端处理，重发会让下单之类的操作做两次
    #[tokio::test]
    async fn failure_after_connecting_is_not_retried() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let url = format!("http://{}/", l.local_addr().expect("addr"));
        // 接受连接后立刻断开，不回任何响应
        let server = std::thread::spawn(move || {
            if let Ok((s, _)) = l.accept() {
                drop(s);
            }
        });
        let e = send_direct_first(|c| c.post(&url).body("order").timeout(Duration::from_secs(10)))
            .await
            .expect_err("服务端没有回响应");
        assert!(e.via_proxy.is_none(), "连上之后的失败不该重发: {e}");
        let _ = server.join();
    }
}
