//! 出网 URL 安全校验（SSRF 防护）。
//!
//! # 威胁模型
//!
//! 应用里有两类"URL 不完全受用户控制"的出网路径：
//!
//! 1. **网页剪藏**（[`crate::services::web_clip`]）：用户粘贴的 URL 本身可信度存疑，
//!    且短链 / 跳转页的**重定向目标**完全由对方服务器决定；
//! 2. **外链图片本地化**（[`crate::services::image_download`]）：URL 来自**笔记正文** ——
//!    可能是导入的第三方 `.md`、剪藏回来的页面、别人分享的文件。用户往往根本没看过这些 URL，
//!    却会在打开笔记时被自动请求。
//!
//! 攻击者只要让上面任一路径请求 `http://127.0.0.1:8080/admin/shutdown`、
//! `http://192.168.1.1/…` 或云环境的 `http://169.254.169.254/latest/meta-data/`，
//! 就能借本应用之手探测 / 操作用户内网 —— 这就是 SSRF。
//!
//! # 不适用范围（重要）
//!
//! 本模块**只**用于上述两条路径。AI 模型（Ollama）、WebDAV、S3、ASR 等走的是
//! **用户自己在设置里填的地址**，`localhost:11434` / `192.168.x.x` 正是合法用法 ——
//! 给它们加同样的拦截等于把用户的本地与内网服务全部打死。
//!
//! # 防护点
//!
//! | 面 | 做法 |
//! |---|---|
//! | 协议 | 仅 http / https |
//! | userinfo | URL 里含 `user@host` 直接拒（`http://evil@127.0.0.1/` 这类混淆） |
//! | 主机名 | 拒 `localhost` 及其子域；host 为空拒 |
//! | IP 段 | 解析出的**每个** A/AAAA 都必须是公网地址，任一不合格整体拒 |
//! | IPv4-mapped IPv6 | 递归解包后再判（`::ffff:127.0.0.1` 不能绕过） |
//! | 重定向 | 由调用方逐跳复校验（见 `web_clip::fetch_html`） |
//!
//! 判定采取**白名单思维的反面** —— 宁可多拦一个冷门公网段，也不放过一个内网段：
//! 误拦的代价是"这个网页剪藏不了"，漏拦的代价是内网被探测。

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use crate::error::AppError;

/// DNS 解析超时。解析不该很慢；卡住多半是网络异常，早失败比吊死好。
const DNS_TIMEOUT_SECS: u64 = 5;

/// 该 IPv4 是否**不可**出网（内网 / 保留 / 特殊用途）。
///
/// 等价于稳定版还没有的 `Ipv4Addr::is_global()` 取反。逐段列出而不是调用
/// nightly API，是为了能在稳定工具链编译，同时把"为什么拦"写在代码里。
fn is_blocked_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, d] = ip.octets();
    // 0.0.0.0/8 "本网络"，含 is_unspecified
    if a == 0
        // 10/8、172.16/12、192.168/16 私有网段
        || ip.is_private()
        // 127/8 环回 —— SSRF 的头号目标
        || ip.is_loopback()
        // 169.254/16 链路本地。**云元数据服务 169.254.169.254 就在这段**
        || ip.is_link_local()
        // 224/4 组播 + 255.255.255.255 广播
        || ip.is_multicast()
        || ip.is_broadcast()
        // 192.0.2/24、198.51.100/24、203.0.113/24 文档示例段
        || ip.is_documentation()
        // 100.64/10 运营商级 NAT（共享地址空间）
        || (a == 100 && (64..128).contains(&b))
        // 192.0.0/24 IETF 协议分配
        || (a == 192 && b == 0 && c == 0)
        // 192.88.99/24 已废弃的 6to4 中继
        || (a == 192 && b == 88 && c == 99)
        // 198.18/15 基准测试段
        || (a == 198 && (b == 18 || b == 19))
        // 240/4 保留（含 255.255.255.255，前面已单独拦）
        || a >= 240
    {
        return true;
    }
    let _ = d;
    false
}

/// 该 IPv6 是否**不可**出网。
///
/// IPv4-mapped（`::ffff:a.b.c.d`）与 IPv4-compatible 会**递归**回到 v4 判定 ——
/// 否则 `http://[::ffff:127.0.0.1]/` 就能绕过全部 v4 规则。
fn is_blocked_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_blocked_v4(v4);
    }
    // to_ipv4() 还会匹配已废弃的 IPv4-compatible（::a.b.c.d），一并解包
    if let Some(v4) = ip.to_ipv4() {
        return is_blocked_v4(v4);
    }
    let seg = ip.segments();
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        // fc00::/7 唯一本地地址（IPv6 版的"内网"）
        || (seg[0] & 0xfe00) == 0xfc00
        // fe80::/10 链路本地
        || (seg[0] & 0xffc0) == 0xfe80
        // 2001:db8::/32 文档示例段
        || (seg[0] == 0x2001 && seg[1] == 0x0db8)
        // 100::/64 丢弃前缀
        || (seg[0] == 0x0100 && seg[1] == 0 && seg[2] == 0 && seg[3] == 0)
}

/// 该地址是否**不可**出网
pub fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_v4(v4),
        IpAddr::V6(v6) => is_blocked_v6(v6),
    }
}

/// 主机名是否指向本机（不做 DNS 就能判掉的明显情况）。
///
/// `*.localhost` 按 RFC 6761 同样必须解析到环回地址，一并拦掉。
fn is_local_hostname(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    h == "localhost" || h.ends_with(".localhost")
}

/// 把 `Url::host_str()` 的结果按 IP 解析（域名则返回 None）。
///
/// **必须剥方括号**：`host_str()` 对 IPv6 字面量返回的是带括号的 `"[::1]"`，
/// 而 `"[::1]".parse::<IpAddr>()` 会失败 —— 直接 parse 会让 `http://[::1]:3000/`
/// 静默跳过全部 IP 校验（单测 `rejects_literal_private_ip_urls` 钉住了这个绕过）。
fn host_as_ip(host: &str) -> Option<IpAddr> {
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
        .ok()
}

/// 校验 URL 的静态部分（不做 DNS）。
///
/// 返回解析后的 `Url`，供调用方复用（避免重复 parse，也保证后续用的就是校验过的那个）。
pub fn validate_url(raw: &str) -> Result<reqwest::Url, AppError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(AppError::InvalidInput("URL 不能为空".into()));
    }

    let url = reqwest::Url::parse(raw)
        .map_err(|e| AppError::InvalidInput(format!("URL 无效：{}", e)))?;

    match url.scheme() {
        "http" | "https" => {}
        other => {
            return Err(AppError::InvalidInput(format!(
                "只支持 http / https，不支持 {}：{}",
                other, raw
            )))
        }
    }

    // `http://evil@127.0.0.1/` —— 肉眼看着像访问 evil，实际连的是环回地址。
    // 正经网页链接不会带 userinfo，直接拒掉这类混淆。
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::InvalidInput(
            "URL 不能包含用户名 / 密码部分".into(),
        ));
    }

    let host = url
        .host_str()
        .ok_or_else(|| AppError::InvalidInput(format!("URL 缺少主机名：{}", raw)))?;

    if is_local_hostname(host) {
        return Err(AppError::InvalidInput(
            "出于安全考虑，不允许访问本机地址".into(),
        ));
    }

    // 主机位直接写 IP 的情况这里就能判掉，省一次 DNS
    if let Some(ip) = host_as_ip(host) {
        if is_blocked_ip(ip) {
            return Err(AppError::InvalidInput(
                "出于安全考虑，不允许访问内网 / 本机地址".into(),
            ));
        }
    }

    Ok(url)
}

/// 完整校验：静态校验 + DNS 解析后逐个 IP 校验。
///
/// **任一** 解析结果落在内网段就整体拒绝：域名可以同时给出公网和内网 A 记录，
/// 只看第一条等于给攻击者留了一半概率。
///
/// 返回校验通过的地址列表 —— 调用方若要做 IP pinning 可直接用；不用也无妨，
/// 至少已经确认"这个域名此刻不指向内网"。
pub async fn validate_url_with_dns(raw: &str) -> Result<(reqwest::Url, Vec<IpAddr>), AppError> {
    let url = validate_url(raw)?;
    let host = url
        .host_str()
        .ok_or_else(|| AppError::InvalidInput("URL 缺少主机名".into()))?
        .to_string();

    // 主机位本身就是 IP：validate_url 已校验过，无需再解析
    if let Some(ip) = host_as_ip(&host) {
        return Ok((url, vec![ip]));
    }

    let port = url.port_or_known_default().unwrap_or(80);
    let lookup = tokio::time::timeout(
        std::time::Duration::from_secs(DNS_TIMEOUT_SECS),
        tokio::net::lookup_host((host.as_str(), port)),
    )
    .await
    .map_err(|_| AppError::Custom(format!("解析域名超时：{}", host)))?
    .map_err(|e| AppError::Custom(format!("无法解析域名 {}：{}", host, e)))?;

    let ips: Vec<IpAddr> = lookup.map(|addr| addr.ip()).collect();
    if ips.is_empty() {
        return Err(AppError::Custom(format!("域名没有解析结果：{}", host)));
    }
    if let Some(bad) = ips.iter().find(|ip| is_blocked_ip(**ip)) {
        log::warn!("[url_safety] 拒绝访问 {} —— 解析到内网地址 {}", host, bad);
        return Err(AppError::InvalidInput(
            "出于安全考虑，不允许访问内网 / 本机地址".into(),
        ));
    }

    Ok((url, ips))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocked(s: &str) -> bool {
        is_blocked_ip(s.parse().unwrap())
    }

    #[test]
    fn blocks_loopback_and_private_v4() {
        for ip in [
            "127.0.0.1",
            "127.1.2.3",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "0.0.0.0",
            "255.255.255.255",
        ] {
            assert!(blocked(ip), "{} 应被拦截", ip);
        }
    }

    #[test]
    fn blocks_cloud_metadata_endpoint() {
        // 169.254.169.254 —— AWS / 阿里云 / GCP 元数据服务，SSRF 的经典目标
        assert!(blocked("169.254.169.254"), "云元数据地址必须拦截");
        assert!(blocked("169.254.0.1"));
    }

    #[test]
    fn blocks_special_ranges_v4() {
        for ip in [
            "100.64.0.1",     // 运营商 NAT
            "192.0.0.1",      // IETF 协议分配
            "192.0.2.1",      // 文档段
            "198.18.0.1",     // 基准测试
            "198.51.100.1",   // 文档段
            "203.0.113.1",    // 文档段
            "192.88.99.1",    // 废弃 6to4
            "240.0.0.1",      // 保留
            "224.0.0.1",      // 组播
        ] {
            assert!(blocked(ip), "{} 应被拦截", ip);
        }
    }

    #[test]
    fn allows_normal_public_v4() {
        for ip in ["1.1.1.1", "8.8.8.8", "114.114.114.114", "223.5.5.5"] {
            assert!(!blocked(ip), "{} 是公网地址，不该被拦", ip);
        }
        // 100.64/10 之外的 100.x 是正常公网
        assert!(!blocked("100.63.255.255"));
        assert!(!blocked("100.128.0.1"));
    }

    #[test]
    fn blocks_v6_local_and_mapped() {
        for ip in [
            "::1",                 // 环回
            "::",                  // 未指定
            "fc00::1",             // 唯一本地
            "fd12:3456::1",        // 唯一本地
            "fe80::1",             // 链路本地
            "2001:db8::1",         // 文档段
            "::ffff:127.0.0.1",    // IPv4-mapped 环回：绕过尝试
            "::ffff:192.168.1.1",  // IPv4-mapped 私网
        ] {
            assert!(blocked(ip), "{} 应被拦截", ip);
        }
    }

    #[test]
    fn allows_public_v6() {
        assert!(!blocked("2400:3200::1")); // 阿里云 DNS
        assert!(!blocked("2001:4860:4860::8888")); // Google DNS
    }

    #[test]
    fn rejects_non_http_scheme() {
        for u in [
            "ftp://example.com/a",
            "file:///etc/passwd",
            "data:text/html,<script>",
            "javascript:alert(1)",
        ] {
            assert!(validate_url(u).is_err(), "{} 应被拒", u);
        }
    }

    #[test]
    fn rejects_userinfo_obfuscation() {
        // 肉眼像访问 example.com，实际连 127.0.0.1
        assert!(validate_url("http://example.com@127.0.0.1/").is_err());
        assert!(validate_url("http://user:pass@example.com/").is_err());
    }

    #[test]
    fn rejects_localhost_forms() {
        for u in [
            "http://localhost/",
            "http://localhost:8080/admin",
            "http://LocalHost/",
            "http://api.localhost/",
            "http://localhost./",
        ] {
            assert!(validate_url(u).is_err(), "{} 应被拒", u);
        }
    }

    #[test]
    fn rejects_literal_private_ip_urls() {
        for u in [
            "http://127.0.0.1:8080/admin",
            "http://192.168.1.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]:3000/",
            "http://[::ffff:127.0.0.1]/",
        ] {
            assert!(validate_url(u).is_err(), "{} 应被拒", u);
        }
    }

    #[test]
    fn accepts_normal_pages() {
        for u in [
            "https://example.com/article/1",
            "http://example.com:8080/p?a=1#x",
            "https://mp.weixin.qq.com/s/abc",
            "https://8.8.8.8/x",
        ] {
            assert!(validate_url(u).is_ok(), "{} 应通过", u);
        }
    }

    #[test]
    fn rejects_empty_and_malformed() {
        assert!(validate_url("").is_err());
        assert!(validate_url("   ").is_err());
        assert!(validate_url("not a url").is_err());
        assert!(validate_url("http://").is_err());
    }

    #[tokio::test]
    async fn dns_path_rejects_literal_private() {
        assert!(validate_url_with_dns("http://127.0.0.1/x").await.is_err());
    }

    #[tokio::test]
    async fn dns_path_accepts_literal_public_without_lookup() {
        // 主机位是公网 IP 字面量 → 不该走 DNS，直接放行（离线也能过这条断言）
        let (url, ips) = validate_url_with_dns("https://1.1.1.1/x").await.unwrap();
        assert_eq!(url.host_str(), Some("1.1.1.1"));
        assert_eq!(ips.len(), 1);
    }
}
