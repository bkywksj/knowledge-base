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
// rust-s3 0.34 强引入 openssl，移动端编译失败；S3 backend 仅桌面端启用
// 移动端按 T-M014 暂只支持 local + webdav backend
#[cfg(desktop)]
pub mod backend_s3;
pub mod backend_webdav;
pub mod manifest;
pub mod pull;
pub mod push;
pub mod runtime;

pub use manifest::compute_local_manifest;
