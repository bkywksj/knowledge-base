//! 共享 HTTP Client 单例。
//!
//! reqwest::Client 内部维护连接池 + TLS 会话缓存，**必须复用才能避免**
//! 每次请求都重新建立 TCP/TLS 握手的开销。AI 流式回复、WebDAV 同步等
//! 热路径原先每次调用都 `Client::new()`，单次请求多出几百毫秒延迟。
//!
//! 用 `OnceLock` 做进程级单例：
//! - `shared()`：普通用途（OpenAI / Claude / WebDAV 等外网 HTTPS），走系统代理（见 [`with_system_proxy`]）
//! - `shared_no_proxy()`：本地 / 内网服务（Ollama），强制绕过系统代理 + 带空闲读超时
//!
//! 🔴 新建 reqwest Client 一律套 [`with_system_proxy`]（或明确 `.no_proxy()`），不要直接
//! `Client::new()`：Cargo.toml 开了 hyper-util 的 `client-proxy-system`，feature 全局合并后
//! 裸 `Client::new()` 也会读系统代理，但**没有**内网直连保护，连 NAS / 本机服务会被发给代理。

use std::net::IpAddr;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use reqwest::{Client, ClientBuilder, Proxy, Url};

static SHARED: OnceLock<Client> = OnceLock::new();
static SHARED_NO_PROXY: OnceLock<Client> = OnceLock::new();
static SHARED_WEBDAV: OnceLock<Client> = OnceLock::new();
static SHARED_GUARDED: OnceLock<Client> = OnceLock::new();

/// 受控抓取（剪藏 / 外链图片）的连接超时。对方无响应时早点失败，别吊住用户。
const GUARDED_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

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

/// 全局复用的 reqwest Client，走系统代理（内网 / 本机直连，见 [`with_system_proxy`]）。
pub fn shared() -> &'static Client {
    SHARED.get_or_init(|| {
        with_system_proxy(Client::builder())
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}

/// WebDAV 同步专用 Client：带 connect / read 空闲超时，避免移动端弱网下同步请求永久挂起。
///
/// 独立于 `shared()`：`shared()` 供 AI 流式回复等场景用（那里不能设总超时、也不该被 WebDAV 的
/// 超时策略影响），故 WebDAV 单开一个池。代理规则与 `shared()` 一致（系统代理 + 内网直连，
/// 群晖 / 威联通等内网 NAS 靠后者保证不被发给代理），只是多了超时约束。构建失败时降级回退到无超时 Client（不至于让同步不可用）。
pub fn shared_webdav() -> &'static Client {
    SHARED_WEBDAV.get_or_init(|| {
        with_system_proxy(Client::builder())
            .connect_timeout(WEBDAV_CONNECT_TIMEOUT)
            .read_timeout(WEBDAV_READ_TIMEOUT)
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}

/// 受控抓取专用 Client：**禁用自动重定向**。
///
/// 供网页剪藏与外链图片下载使用 —— 这两条路径的 URL 不完全受用户控制
/// （剪藏的重定向目标由对方服务器决定；图片 URL 来自笔记正文，可能是导入的第三方内容）。
///
/// 为什么必须禁用自动重定向：`shared()` 默认最多跟随 10 跳，而**中间每一跳都不经过
/// 我们的 SSRF 校验** —— 攻击者只要给一个公网短链，302 到 `http://127.0.0.1:8080/…`
/// 就绕过了全部防护。禁用后由调用方逐跳 `url_safety::validate_url_with_dns` 复校验。
///
/// 见 [`crate::services::url_safety`]。
pub fn shared_guarded() -> &'static Client {
    SHARED_GUARDED.get_or_init(|| {
        with_system_proxy(Client::builder())
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(GUARDED_CONNECT_TIMEOUT)
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

// ─── 系统代理 + 内网直连 ────────────────────────────────────────────────────────────────────

/// 系统代理设置的重新读取间隔。
///
/// 客户端是进程级单例，如果只在构建时读一次，用户启动应用后再开 / 关 Clash 就必须重启应用才生效。
/// 30 秒重读一次：读取本身只是查注册表 / SCDynamicStore，很轻；又不至于每个请求都查。
const SYSTEM_PROXY_REFRESH: Duration = Duration::from_secs(30);

static SYSTEM_PROXY: OnceLock<Mutex<(Instant, hyper_util::client::proxy::matcher::Matcher)>> =
    OnceLock::new();

/// 给 ClientBuilder 装上「系统代理 + 内网 / 本机直连」规则。新建的 reqwest Client 都应套这一层。
///
/// 代理来源（优先级从高到低）：`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 环境变量 →
/// Windows 注册表 / macOS 网络设置里的系统代理。`NO_PROXY` 环境变量、Windows 代理例外里的域名
/// 照常生效。
///
/// 为什么不直接用 reqwest 的自动系统代理：底层 hyper-util **没有任何默认直连规则**—— Mac 上
/// 不读系统例外列表，Windows 上 `192.168.*` 这种常见例外写法也匹配不上。结果是连局域网 NAS、
/// 本机 LM Studio 也被发给 Clash；用户退出 Clash 但系统代理设置残留时，连内网都不通。
/// 所以这里先按目标地址判断 [`is_local_destination`]，是内网 / 本机就直连，其余交给系统代理。
///
/// 注：调用 `.proxy()` 会关掉 reqwest 的自动系统代理，所以不会出现两套规则叠加。
pub fn with_system_proxy(builder: ClientBuilder) -> ClientBuilder {
    builder.proxy(Proxy::custom(system_proxy_for))
}

/// 为一个请求目标选代理：`None` = 直连。
fn system_proxy_for(url: &Url) -> Option<Url> {
    let host = url.host_str()?;
    if is_local_destination(host) {
        return None;
    }
    let uri: http::Uri = url.as_str().parse().ok()?;

    let cell = SYSTEM_PROXY.get_or_init(|| {
        Mutex::new((
            Instant::now(),
            hyper_util::client::proxy::matcher::Matcher::from_system(),
        ))
    });
    // 锁中毒只可能来自别处 panic；里面只是一份可重建的代理快照，继续用无害
    let mut guard = cell.lock().unwrap_or_else(|p| p.into_inner());
    if guard.0.elapsed() >= SYSTEM_PROXY_REFRESH {
        *guard = (
            Instant::now(),
            hyper_util::client::proxy::matcher::Matcher::from_system(),
        );
    }
    let hit = guard.1.intercept(&uri)?;
    drop(guard);

    let mut proxy = Url::parse(&hit.uri().to_string()).ok()?;
    // hyper-util 把代理 URL 里的账号密码拆成了 Basic 头（只会出现在环境变量代理里），
    // 拼回 URL 交给 reqwest，否则带认证的代理会 407
    if let Some((user, pass)) = hit.basic_auth().and_then(decode_basic_auth) {
        let _ = proxy.set_username(&user);
        let _ = proxy.set_password(Some(&pass));
    }
    Some(proxy)
}

/// `Basic base64(user:pass)` → (user, pass)
fn decode_basic_auth(header: &http::HeaderValue) -> Option<(String, String)> {
    let encoded = header.to_str().ok()?.strip_prefix("Basic ")?;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .ok()?;
    let text = String::from_utf8(raw).ok()?;
    let (user, pass) = text.split_once(':')?;
    Some((user.to_string(), pass.to_string()))
}

/// 目标是否为本机 / 局域网地址 —— 是则必须直连，不走代理。
///
/// - IP：回环、私有网段（10/8、172.16/12、192.168/16）、链路本地、CGNAT 100.64/10
///   （Tailscale 等 overlay 网络用这段）、IPv6 ULA fc00::/7 与链路本地 fe80::/10
/// - 域名：`localhost`、单段主机名（如 `nas`，对应 Windows 的 `<local>`）以及
///   `.local` / `.lan` / `.home.arpa` / `.internal` / `.localhost` 等内网专用后缀
///
/// 局限：解析到内网 IP 的普通域名（如自建 DNS 的 `nas.example.com`）判断不出来，仍会走代理；
/// 这类可在系统代理例外（Windows）或 `NO_PROXY` 环境变量里加上。
pub(crate) fn is_local_destination(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host.parse::<IpAddr>() {
        return is_local_ip(ip);
    }
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    if h.is_empty() || h == "localhost" || !h.contains('.') {
        return true;
    }
    [".localhost", ".local", ".lan", ".home.arpa", ".internal"]
        .iter()
        .any(|suffix| h.ends_with(suffix))
}

fn is_local_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                // CGNAT 100.64.0.0/10（Tailscale）
                || (o[0] == 100 && (o[1] & 0xc0) == 64)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_local_ip(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            v6.is_loopback()
                || v6.is_unspecified()
                || (first & 0xfe00) == 0xfc00 // ULA fc00::/7
                || (first & 0xffc0) == 0xfe80 // 链路本地 fe80::/10
        }
    }
}

/// 把 reqwest 错误展开成「顶层信息 → 底层原因链」，并在能判断时附一句可操作的提示。
///
/// 为什么需要：reqwest 的 `Display` 只给顶层 `error sending request for url (...)`，
/// 真正的原因（连接被拒 / 超时 / 证书 / `No route to host`）藏在 `source()` 链里。
/// 2026-10 Mac 用户 WebDAV 同步失败时日志只有这一行，无法区分是服务端、网络还是本机权限，
/// 排查绕了一大圈 —— 根因其实是 macOS「本地网络」权限拦截（底层 os error 65）。
///
/// 输出示例：`error sending request for url (http://…) → client error (Connect) → No route to host (os error 65)。
/// macOS 可能拦截了…`。链上与前文重复的消息会被去重，避免一句话说三遍。
///
/// 只用于展示 / 日志，不要拿返回值做逻辑分支（措辞随 reqwest/hyper 版本可能变化）。
pub fn describe_error(e: &reqwest::Error) -> String {
    use std::error::Error as _;

    let mut parts: Vec<String> = vec![e.to_string()];
    let mut src = e.source();
    while let Some(s) = src {
        let msg = s.to_string();
        if !msg.is_empty() && !parts.iter().any(|p| p.contains(&msg)) {
            parts.push(msg);
        }
        src = s.source();
    }
    let mut out = parts.join(" → ");
    if let Some(hint) = error_hint(e, &out.to_lowercase()) {
        out.push('。');
        out.push_str(hint);
    }
    out
}

/// 按错误类型给一句用户能照着做的提示；判断不出就不加（宁缺毋滥，别误导）。
fn error_hint(e: &reqwest::Error, chain_lower: &str) -> Option<&'static str> {
    if e.is_timeout() {
        return Some("连接或读取超时，请确认服务器在线、网络通畅");
    }
    // os error 65 = macOS 的 EHOSTUNREACH。macOS 15+ 未授权「本地网络」时访问局域网就是这个错误，
    // 且是瞬间返回（不等超时）—— 与真正的网络不可达表现不同，单独提示
    if chain_lower.contains("no route to host") || chain_lower.contains("os error 65") {
        return Some(if cfg!(target_os = "macos") {
            "目标主机不可达。若地址是局域网设备（NAS 等），macOS 可能拦截了本应用访问本地网络：\
             请到「系统设置 → 隐私与安全性 → 本地网络」允许「Knowledge Base」后重试"
        } else {
            "目标主机不可达，请确认本机与服务器在同一网络、地址正确"
        });
    }
    if chain_lower.contains("connection refused") {
        return Some("目标端口拒绝连接，请确认服务已开启、端口号正确");
    }
    if chain_lower.contains("certificate") || chain_lower.contains("unknownissuer") {
        return Some("TLS 证书不受信任：自签证书需先在系统中设为信任，或改用受信证书");
    }
    if chain_lower.contains("dns error") || chain_lower.contains("failed to lookup address") {
        return Some("域名解析失败，请检查地址拼写与 DNS");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lan_and_loopback_go_direct() {
        for h in [
            "127.0.0.1",
            "localhost",
            "LOCALHOST.",
            "192.168.3.16", // 诊断报告里的群晖 NAS
            "10.0.0.5",
            "172.16.1.1",
            "172.31.255.255",
            "169.254.10.1",
            "100.100.1.1", // Tailscale CGNAT
            "[::1]",
            "::1",
            "fd12:3456::1",
            "fe80::1",
            "::ffff:192.168.1.2",
            "nas",
            "my-nas.local",
            "router.lan",
            "box.home.arpa",
            "svc.internal",
        ] {
            assert!(is_local_destination(h), "{h} 应直连");
        }
    }

    #[test]
    fn public_hosts_use_proxy_rules() {
        for h in [
            "api.openai.com",
            "dav.jianguoyun.com",
            "8.8.8.8",
            "172.32.0.1", // 172.16/12 之外
            "100.128.0.1", // CGNAT 之外
            "2001:4860::8888",
            "local.example.com", // 只是前缀像，不是 .local 后缀
        ] {
            assert!(!is_local_destination(h), "{h} 不应被当成内网");
        }
    }

    #[test]
    fn local_targets_never_proxied_even_with_proxy_configured() {
        // 不依赖本机实际代理设置：内网目标在读系统代理之前就已返回直连
        let url = Url::parse("http://192.168.3.16:5005/webdav_sync/manifest.json").unwrap();
        assert!(system_proxy_for(&url).is_none());
    }

    /// 真机诊断：打印本机当前实际生效的代理选择（依赖本机设置，故默认不跑）。
    /// 用法：`cargo test --lib http_client::tests::print_effective_proxy -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn print_effective_proxy() {
        for u in [
            "https://api.openai.com/v1/models",
            "http://example.com/",
            "http://192.168.3.16:5005/webdav_sync/",
            "http://localhost:11434/",
        ] {
            let url = Url::parse(u).unwrap();
            println!("{u}  =>  {:?}", system_proxy_for(&url).map(|p| p.to_string()));
        }
    }

    #[test]
    fn basic_auth_roundtrip() {
        let v = http::HeaderValue::from_static("Basic dXNlcjpwQHNzOndvcmQ="); // user:p@ss:word
        assert_eq!(
            decode_basic_auth(&v),
            Some(("user".to_string(), "p@ss:word".to_string()))
        );
        assert_eq!(decode_basic_auth(&http::HeaderValue::from_static("Bearer x")), None);
    }
}
