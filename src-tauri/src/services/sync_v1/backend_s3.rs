//! S3 协议 V1 backend
//!
//! 一套代码覆盖：
//! - AWS S3（endpoint = `https://s3.<region>.amazonaws.com`）
//! - 阿里云 OSS（endpoint = `https://oss-<region>.aliyuncs.com`）
//! - 腾讯云 COS（endpoint = `https://cos.<region>.myqcloud.com`）
//! - Cloudflare R2（endpoint = `https://<account-id>.r2.cloudflarestorage.com`）
//! - MinIO（自部署 endpoint）
//!
//! 实现要点：
//! - 用 `rust-s3` crate（v0.34，pure Rust + rustls，零 C 依赖）
//! - 走全局 sync_v1 runtime（`runtime::block_on`）把 async 调用包成同步
//! - object key = `<prefix>/manifest.json` 或 `<prefix>/notes/<sid>.md`
//!   prefix 为空 ⇒ 直接放在 bucket 根；用户可设 `kb/` 之类做隔离

use s3::bucket::Bucket;
use s3::creds::Credentials;
use s3::region::Region;

use crate::error::AppError;
use crate::models::SyncManifestV1;
use crate::services::sync_v1::runtime::block_on;

use super::backend::{SyncBackendImpl, MANIFEST_FILENAME};

pub struct S3Backend {
    bucket: Bucket,
    /// 路径前缀（不含开头 / ；末尾不加 /）
    prefix: String,
}

impl S3Backend {
    pub fn new(
        endpoint: &str,
        region_name: &str,
        bucket_name: &str,
        access_key: &str,
        secret_key: &str,
        prefix: &str,
    ) -> Result<Self, AppError> {
        let region = Region::Custom {
            region: if region_name.is_empty() {
                "us-east-1".into()
            } else {
                region_name.into()
            },
            endpoint: endpoint.trim_end_matches('/').to_string(),
        };

        let creds = Credentials::new(Some(access_key), Some(secret_key), None, None, None)
            .map_err(|e| AppError::Custom(format!("S3 凭据格式错误: {}", e)))?;

        // path-style 而非 virtual-hosted-style：兼容 MinIO / R2 / 阿里云走自定义 endpoint 时的常见限制
        let bucket = Bucket::new(bucket_name, region, creds)
            .map_err(|e| AppError::Custom(format!("S3 bucket 初始化失败: {}", e)))?
            .with_path_style();

        Ok(Self {
            bucket,
            prefix: prefix.trim_matches('/').to_string(),
        })
    }

    /// 把相对路径转成 bucket 内 key（带 prefix）
    fn key(&self, rel: &str) -> String {
        if self.prefix.is_empty() {
            rel.to_string()
        } else {
            format!("{}/{}", self.prefix, rel)
        }
    }
}

impl SyncBackendImpl for S3Backend {
    fn name(&self) -> &'static str {
        "s3"
    }

    fn test_connection(&self) -> Result<(), AppError> {
        // S3 协议没有"ping"，用 list_objects 探针（list 1 个对象 + prefix）
        // 失败的话 list 会返回错误
        let probe_key = self.key("__kb_sync_probe__.txt");
        // 写一个临时小对象再删掉，确认有 PUT/DELETE 权限
        let bucket = &self.bucket;
        let prefix = self.prefix.clone();
        block_on(async move {
            // 写
            bucket
                .put_object(&probe_key, b"ok")
                .await
                .map_err(|e| AppError::Custom(format!("S3 写入测试失败: {}", e)))?;
            // 删
            bucket
                .delete_object(&probe_key)
                .await
                .map_err(|e| AppError::Custom(format!("S3 删除测试失败: {}", e)))?;
            log::info!("[s3] connection test OK (prefix={})", prefix);
            Ok::<_, AppError>(())
        })
    }

    fn read_manifest(&self) -> Result<Option<SyncManifestV1>, AppError> {
        let key = self.key(MANIFEST_FILENAME);
        let bucket = &self.bucket;
        let resp = block_on(async move { bucket.get_object(&key).await });
        match resp {
            Ok(r) => {
                if r.status_code() == 404 {
                    return Ok(None);
                }
                if r.status_code() < 200 || r.status_code() >= 300 {
                    return Err(AppError::Custom(format!(
                        "S3 读 manifest 失败 ({})",
                        r.status_code()
                    )));
                }
                let m: SyncManifestV1 = serde_json::from_slice(r.bytes())
                    .map_err(|e| AppError::Custom(format!("远端 manifest 解析失败: {}", e)))?;
                Ok(Some(m))
            }
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("404") || msg.to_lowercase().contains("not found") {
                    return Ok(None);
                }
                Err(AppError::Custom(format!("S3 读 manifest 失败: {}", e)))
            }
        }
    }

    fn write_manifest(&self, manifest: &SyncManifestV1) -> Result<(), AppError> {
        let bytes = serde_json::to_vec_pretty(manifest)
            .map_err(|e| AppError::Custom(format!("manifest 序列化失败: {}", e)))?;
        let key = self.key(MANIFEST_FILENAME);
        let bucket = &self.bucket;
        block_on(async move {
            bucket
                .put_object_with_content_type(&key, &bytes, "application/json")
                .await
                .map_err(|e| AppError::Custom(format!("S3 写 manifest 失败: {}", e)))?;
            Ok(())
        })
    }

    fn put_note(&self, path: &str, content: &str) -> Result<(), AppError> {
        let key = self.key(path);
        let bytes = content.as_bytes().to_vec();
        let bucket = &self.bucket;
        block_on(async move {
            bucket
                .put_object_with_content_type(&key, &bytes, "text/markdown; charset=utf-8")
                .await
                .map_err(|e| AppError::Custom(format!("S3 上传笔记失败 {}: {}", key, e)))?;
            Ok(())
        })
    }

    fn get_note(&self, path: &str) -> Result<Option<String>, AppError> {
        let key = self.key(path);
        let bucket = &self.bucket;
        let resp = block_on(async move { bucket.get_object(&key).await });
        match resp {
            Ok(r) => {
                if r.status_code() == 404 {
                    return Ok(None);
                }
                if r.status_code() < 200 || r.status_code() >= 300 {
                    return Err(AppError::Custom(format!(
                        "S3 读笔记失败 ({})",
                        r.status_code()
                    )));
                }
                Ok(Some(String::from_utf8_lossy(r.bytes()).into_owned()))
            }
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("404") || msg.to_lowercase().contains("not found") {
                    return Ok(None);
                }
                Err(AppError::Custom(format!("S3 读笔记失败: {}", e)))
            }
        }
    }

    fn delete_note(&self, path: &str) -> Result<(), AppError> {
        let key = self.key(path);
        let bucket = &self.bucket;
        block_on(async move {
            bucket
                .delete_object(&key)
                .await
                .map_err(|e| AppError::Custom(format!("S3 删除失败 {}: {}", key, e)))?;
            Ok(())
        })
    }

    fn put_attachment(&self, hash: &str, bytes: &[u8]) -> Result<(), AppError> {
        let key = self.key(&super::backend::cas_path(hash));
        let body = bytes.to_vec();
        let bucket = &self.bucket;
        block_on(async move {
            bucket
                .put_object_with_content_type(&key, &body, "application/octet-stream")
                .await
                .map_err(|e| AppError::Custom(format!("S3 上传附件失败 {}: {}", key, e)))?;
            Ok(())
        })
    }

    fn get_attachment(&self, hash: &str) -> Result<Option<Vec<u8>>, AppError> {
        let key = self.key(&super::backend::cas_path(hash));
        let bucket = &self.bucket;
        let resp = block_on(async move { bucket.get_object(&key).await });
        match resp {
            Ok(r) => {
                if r.status_code() == 404 {
                    return Ok(None);
                }
                if r.status_code() < 200 || r.status_code() >= 300 {
                    return Err(AppError::Custom(format!(
                        "S3 读附件失败 ({})",
                        r.status_code()
                    )));
                }
                Ok(Some(r.bytes().to_vec()))
            }
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("404") || msg.to_lowercase().contains("not found") {
                    return Ok(None);
                }
                Err(AppError::Custom(format!("S3 读附件失败: {}", e)))
            }
        }
    }

    fn has_attachment(&self, hash: &str) -> Result<bool, AppError> {
        let key = self.key(&super::backend::cas_path(hash));
        let bucket = &self.bucket;
        // S3 HeadObject 是轻量探测，不返回 body
        let resp = block_on(async move { bucket.head_object(&key).await });
        match resp {
            Ok((_, status)) if status >= 200 && status < 300 => Ok(true),
            Ok((_, 404)) => Ok(false),
            Ok((_, status)) => Err(AppError::Custom(format!("S3 HEAD 失败 ({})", status))),
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("404") || msg.to_lowercase().contains("not found") {
                    return Ok(false);
                }
                Err(AppError::Custom(format!("S3 HEAD 失败: {}", e)))
            }
        }
    }
}
