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
