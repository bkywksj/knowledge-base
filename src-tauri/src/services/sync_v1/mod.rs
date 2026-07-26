//! T-024 同步 V1 — 单笔记粒度的增量同步
//!
//! 模块结构：
//! - `backend.rs` — `SyncBackend` trait（抽象远端读写：list / get / put / delete + manifest）
//! - `backend_local.rs` — `LocalPathBackend`（写到用户磁盘上的某个目录；零网络风险，先证算法）
//! - `manifest.rs` — 从本地 notes 表计算 manifest；diff 两个 manifest
//! - `push.rs` — push_v1：把本地变更推到远端
//! - `pull.rs` — pull_v1：从远端拉取后 last-write-wins 应用到本地
//!
//! V1 阶段刻意**不动**老 `services/sync.rs`（V0 整库 ZIP）—— 老用户继续兼容；
//! 用户在设置里选 V1 后才走这里。

pub mod attachment_gc;
pub mod attachment_scan;
pub mod backend;
pub mod backend_local;
pub mod conflicts;
pub mod lock;
// S3 backend（T-M026 起桌面/移动端统一可用）：改用 rusty-s3 纯签名 + 全局 reqwest 执行，
// 不再依赖 rust-s3 的 openssl，Android 也能编译。
pub mod backend_s3;
pub mod backend_webdav;
pub mod manifest;
pub mod note_md;
pub mod pull;
pub mod push;
pub mod runtime;

pub use manifest::compute_local_manifest;

/// 截断 hash 用于日志 / 进度消息（前 8 位足以辨识）。
///
/// **必须按 `chars()` 而不是字节切片**：pull 端的 hash 来自**远端 manifest**（其他设备写的 JSON，
/// 不完全可信）。一旦远端被篡改 / 损坏，hash 里混进非 ASCII 字符，`&s[..8]` 就会切在 UTF-8
/// 字符中间直接 panic —— 而 Tauri Command 里的 panic 会让整个进程崩溃（表现为"同步时闪退"）。
/// 用 `chars().take(8)` 对任意输入都安全。
pub(crate) fn short_hash(hash: &str) -> String {
    hash.chars().take(8).collect()
}

#[cfg(test)]
mod short_hash_tests {
    use super::short_hash;

    #[test]
    fn truncates_ascii_hash() {
        assert_eq!(short_hash("0123456789abcdef"), "01234567");
    }

    #[test]
    fn keeps_short_input_as_is() {
        assert_eq!(short_hash("abc"), "abc");
        assert_eq!(short_hash(""), "");
    }

    /// 核心回归：非 ASCII 输入不得 panic（字节切片版本会在这里炸）
    #[test]
    fn does_not_panic_on_multibyte_input() {
        assert_eq!(short_hash("中文哈希值内容够长"), "中文哈希值内容够");
        assert_eq!(short_hash("中文"), "中文");
        // 混合：4 字节 emoji + ASCII
        assert_eq!(short_hash("🔒ab"), "🔒ab");
    }
}
