//! Sync backend 抽象 trait
//!
//! 任意远端（本地路径 / WebDAV / S3 / Git）只要实现这套接口就能接入。
//!
//! 接口刻意 **同步阻塞**（不是 async）—— 因为：
//! 1. 上层调用方在 tauri 异步 Command 里跑（已经在 Tokio runtime），
//!    backend 内部如果需要 async（如 reqwest）可以 block_on
//! 2. 不同 backend 的"async 模式"差异大（rust-s3 / git2 是同步，reqwest 是 async）
//!    统一成同步接口降低 trait 心智负担

use std::collections::HashMap;

use crate::error::AppError;
use crate::models::SyncManifestV1;

/// backend 凭据（从 sync_backends.config_json 解析后传给具体 impl）
///
/// 各变体字段除 Local 外，T-024b/c/d 阶段才被实际读，先标 dead_code 不污染警告
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum BackendAuth {
    /// 本地路径：写到磁盘
    Local { root: String },
    /// WebDAV：现有 webdav.rs 客户端可复用（T-024c 阶段做平迁）
    Webdav {
        url: String,
        username: String,
        password: String,
    },
    /// S3 兼容（T-024b 实现）
    S3 {
        endpoint: String,
        region: String,
        bucket: String,
        access_key: String,
        secret_key: String,
        prefix: String,
    },
}

/// Manifest 在远端的标准位置（所有 backend 共用此约定）
pub const MANIFEST_FILENAME: &str = "manifest.json";

/// 笔记在远端的目录约定
///
/// 笔记按 `notes/<stable_id>.md` 存（不嵌套子目录，平铺最简单；
/// 文件夹层级用 manifest entry 的 folder_path 字段表达，重建时 ensure_folder_path）
#[allow(dead_code)]
pub const NOTES_DIR: &str = "notes";

/// T-S023：附件在远端的 CAS 路径布局
///
/// 远端路径 = `attachments/<aa>/<bb>/<hash>`（不带扩展名，纯 CAS）
/// - `<aa>` = hash 前 2 位（256 个一级桶）
/// - `<bb>` = hash 第 3-4 位（256 个二级桶 / 一级桶）
/// - `<hash>` = 完整 sha256 hex
///
/// 不带扩展名：hash 是文件内容的唯一标识，扩展名是元数据（manifest entry.ext 携带）。
/// 防止单目录文件过多：分桶后单目录约 (n / 65536) 个文件，对 FAT/exFAT/Nextcloud 都友好。
pub fn cas_path(hash: &str) -> String {
    if hash.len() < 4 {
        // 防御性兜底：异常短的 hash 仍能落到一个固定目录（不应进入这分支）
        format!("attachments/_/_/{}", hash)
    } else {
        format!(
            "attachments/{}/{}/{}",
            &hash[..2],
            &hash[2..4],
            hash
        )
    }
}

/// 远端字节级 IO 抽象
pub trait SyncBackendImpl {
    /// backend 类型名（仅用于日志 / 错误信息）
    #[allow(dead_code)]
    fn name(&self) -> &'static str;

    /// 测试连接：成功返回 Ok(())，失败返回错误描述
    fn test_connection(&self) -> Result<(), AppError>;

    /// 读取远端 manifest.json；不存在返回 Ok(None)
    fn read_manifest(&self) -> Result<Option<SyncManifestV1>, AppError>;

    /// 写入远端 manifest.json（覆盖）
    fn write_manifest(&self, manifest: &SyncManifestV1) -> Result<(), AppError>;

    /// 上传一条笔记的 .md 文本到远端 `path`（path 是相对 vault 根的 posix 路径）
    fn put_note(&self, path: &str, content: &str) -> Result<(), AppError>;

    /// T-S030: 批量上传笔记 `.md` 文本
    ///
    /// 返回值通常与入参一一对应（第 i 个结果对应第 i 个 item）；但实现允许在"整批
    /// 致命错误"（如远端目录创建失败）时**提前中止**并返回更短的 Vec（甚至 1 个元素 = 那条错误），
    /// 调用方需按 `min(results.len(), items.len())` 处理，并把"返回长度 < 入参长度"理解为"已中止"。
    ///
    /// `max_concurrency`：建议并发数（仅对支持并发的 backend 有意义；默认串行实现忽略它）。
    /// 调用方可据此做自适应限流（撞限流就调小、顺畅就调大）。
    ///
    /// 性能 backend 可 override（如 WebDAV 用 Semaphore 并发上传 + 退避重试）。
    fn batch_put_notes(
        &self,
        items: &[(String, String)],
        _max_concurrency: usize,
    ) -> Vec<Result<(), AppError>> {
        items
            .iter()
            .map(|(path, content)| self.put_note(path, content))
            .collect()
    }

    /// 下载一条笔记的 .md 文本；不存在返回 Ok(None)
    fn get_note(&self, path: &str) -> Result<Option<String>, AppError>;

    /// 删除远端笔记（T-S012 起被 push tombstone 流程调用）
    fn delete_note(&self, path: &str) -> Result<(), AppError>;

    /// T-S023：上传附件（按 hash 路径，CAS 布局）
    ///
    /// 路径 = `attachments/<aa>/<bb>/<hash>`（见 [`cas_path`]）。
    /// 上传同样 hash 视为幂等：内容相同 → 写入或覆盖都无所谓。
    fn put_attachment(&self, hash: &str, bytes: &[u8]) -> Result<(), AppError>;

    /// T-S023：下载附件；不存在返回 Ok(None)
    fn get_attachment(&self, hash: &str) -> Result<Option<Vec<u8>>, AppError>;

    /// T-S023：检查远端是否已有该 hash 的附件
    ///
    /// 用于 push 前的差集计算（避免重复上传）。性能关键：尽量用 HEAD/HeadObject 等
    /// 不传输数据的探测方式。
    fn has_attachment(&self, hash: &str) -> Result<bool, AppError>;

    /// T-S025：列出远端 `attachments/` 目录下所有附件文件名（即 hash）
    ///
    /// 用于 GC：远端有但 manifest 没引用的 hash = 孤儿。
    /// Local / S3 / WebDAV 均已实现；默认实现返回空（不支持递归列举的 backend 不报错，只是 GC no-op）。
    ///
    /// 实现约定：必须过滤掉以 `_` 开头的特殊文件（如 `_gc_marks.json`）。
    fn list_attachment_hashes(&self) -> Result<Vec<String>, AppError> {
        Ok(vec![])
    }
}

/// 从 sync_backends.config_json 解析为 BackendAuth
///
/// 简单 JSON 反序列化；字段缺失会带具体错误提示。后续 webdav/s3 接入时按 kind 分支扩展。
pub fn parse_auth(
    kind: crate::models::SyncBackendKind,
    config_json: &str,
) -> Result<BackendAuth, AppError> {
    use crate::models::SyncBackendKind as K;
    let v: serde_json::Value = serde_json::from_str(config_json)
        .map_err(|e| AppError::Custom(format!("config_json 解析失败: {}", e)))?;
    let get_str = |k: &str| -> Result<String, AppError> {
        v.get(k)
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| AppError::InvalidInput(format!("config_json 缺字段: {}", k)))
    };
    let get_str_or = |k: &str, default: &str| -> String {
        v.get(k)
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| default.into())
    };

    match kind {
        K::Local => Ok(BackendAuth::Local {
            root: get_str("path")?,
        }),
        K::Webdav => Ok(BackendAuth::Webdav {
            url: get_str("url")?,
            username: get_str("username")?,
            password: get_str("password")?,
        }),
        K::S3 => Ok(BackendAuth::S3 {
            endpoint: get_str("endpoint")?,
            region: get_str_or("region", "auto"),
            bucket: get_str("bucket")?,
            access_key: get_str("accessKey")?,
            secret_key: get_str("secretKey")?,
            prefix: get_str_or("prefix", ""),
        }),
    }
}

/// 工厂：根据 BackendAuth 实例化具体 backend
pub fn create_backend(auth: BackendAuth) -> Result<Box<dyn SyncBackendImpl>, AppError> {
    match auth {
        BackendAuth::Local { root } => {
            Ok(Box::new(super::backend_local::LocalPathBackend::new(&root)))
        }
        BackendAuth::Webdav {
            url,
            username,
            password,
        } => Ok(Box::new(super::backend_webdav::WebdavBackend::new(
            &url, &username, &password,
        ))),
        // S3 backend（T-M026 起桌面/移动端统一：rusty-s3 签名 + 全局 reqwest 执行）
        BackendAuth::S3 {
            endpoint,
            region,
            bucket,
            access_key,
            secret_key,
            prefix,
        } => Ok(Box::new(super::backend_s3::S3Backend::new(
            &endpoint,
            &region,
            &bucket,
            &access_key,
            &secret_key,
            &prefix,
        )?)),
    }
}

/// 让 unused HashMap 不警告（预留给将来批量上传/校验用）
#[allow(dead_code)]
fn _hashmap_marker() -> HashMap<String, String> {
    HashMap::new()
}
