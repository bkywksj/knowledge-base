//! 局域网同步：服务端（桌面）与客户端（手机 / 桌面）共用的协议约定。
//!
//! 设计（见 docs/tasks/lan-sync-tasks.md）：
//! - 电脑端把笔记照常同步进本机一个「局域网库目录」（LocalPathBackend），
//!   再起一个 HTTPS 小服务把这个目录按 [`SyncBackendImpl`](super::backend::SyncBackendImpl)
//!   的方法一一暴露出去；手机端 `LanBackend` 实现同一套接口 —— 冲突处理 / 附件去重全复用
//! - 只暴露同步接口这几个操作，不是通用文件服务；所有路径在服务端二次校验
//! - 安全：自签证书 + 客户端按证书指纹固定校验（配对时拿到）+ Bearer 令牌；
//!   写操作必须持有库级租约，防止手机和电脑同时写 manifest 互相覆盖
// 服务端专用的常量 / 校验只在桌面端用（手机只做客户端），手机端编译时放行未使用警告
#![cfg_attr(mobile, allow(dead_code))]

/// 所有接口的前缀（带版本，以后协议不兼容时换 v2）
pub const API_PREFIX: &str = "/kb-lan/v1";

/// 写操作携带的租约 id 头
pub const LEASE_HEADER: &str = "x-kb-lease";

/// 租约多久没续就自动失效：手机同步中途断网 / 被杀，不至于把库锁死
pub const LEASE_TTL_SECS: u64 = 120;

/// 单个请求体上限：附件按 CAS 整个上传，给足 512MB
pub const MAX_BODY_BYTES: usize = 512 * 1024 * 1024;

/// 租约申请响应
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LeaseResponse {
    pub lease_id: String,
    pub ttl_secs: u64,
}

/// 服务端信息（配对后用来确认连对了机器）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ServerInfo {
    pub device_name: String,
    pub protocol: u32,
}

/// 校验客户端传来的相对路径：只允许 `a/b/c.ext` 这种纯相对 posix 路径。
///
/// 拒绝：空段、`.` / `..`、反斜杠、冒号（Windows 盘符 `C:` 会让 `PathBuf::push` 换掉整个根，
/// 写到库目录外）、NUL、开头的 `/`、过长路径。服务端在把路径交给 LocalPathBackend 之前必须过这一关。
pub fn validate_rel_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 512 {
        return Err("路径为空或过长".into());
    }
    if path.starts_with('/') {
        return Err("不允许绝对路径".into());
    }
    if path.contains('\\') || path.contains(':') || path.contains('\0') {
        return Err("路径含非法字符".into());
    }
    for seg in path.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return Err("路径含非法段".into());
        }
    }
    Ok(())
}

/// 附件 hash 必须是 64 位小写十六进制（sha256），挡掉拿 hash 当路径注入
pub fn validate_hash(hash: &str) -> Result<(), String> {
    if hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        Ok(())
    } else {
        Err("附件 hash 格式不对".into())
    }
}

/// 证书指纹：DER 的 sha256，十六进制大写、冒号分隔（配对二维码里带这个，客户端按它固定校验）
pub fn cert_fingerprint(der: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(der)
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join(":")
}

/// 常量时间比较令牌，避免按响应时间逐字节猜
pub fn token_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rel_path_accepts_sync_layout() {
        for ok in ["notes/abc.md", "attachments/_gc_marks.json", "cards/x/y.json"] {
            assert!(validate_rel_path(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn rel_path_rejects_escapes() {
        for bad in [
            "",
            "/etc/passwd",
            "../x",
            "notes/../../x",
            "notes/./a",
            "notes//a",
            "C:/Windows/x",
            "notes/C:x",
            "notes\\..\\x",
            "a\0b",
        ] {
            assert!(validate_rel_path(bad).is_err(), "{bad:?}");
        }
        assert!(validate_rel_path(&"a/".repeat(300)).is_err());
    }

    #[test]
    fn hash_must_be_sha256_hex() {
        assert!(validate_hash(&"a".repeat(64)).is_ok());
        assert!(validate_hash(&"A".repeat(64)).is_err());
        assert!(validate_hash("../../etc").is_err());
        assert!(validate_hash(&"a".repeat(63)).is_err());
    }

    #[test]
    fn token_compare() {
        assert!(token_eq("abc", "abc"));
        assert!(!token_eq("abc", "abd"));
        assert!(!token_eq("abc", "abcd"));
    }

    #[test]
    fn fingerprint_format() {
        let fp = cert_fingerprint(b"x");
        assert_eq!(fp.split(':').count(), 32);
        assert!(fp.chars().all(|c| c == ':' || c.is_ascii_hexdigit()));
    }
}
