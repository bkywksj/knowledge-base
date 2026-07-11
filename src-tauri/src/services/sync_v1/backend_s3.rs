//! S3 协议 V1 backend
//!
//! 一套代码覆盖：
//! - AWS S3（endpoint = `https://s3.<region>.amazonaws.com`）
//! - 阿里云 OSS（endpoint = `https://oss-<region>.aliyuncs.com`）
//! - 腾讯云 COS（endpoint = `https://cos.<region>.myqcloud.com`）
//! - Cloudflare R2（endpoint = `https://<account-id>.r2.cloudflarestorage.com`）
//! - MinIO（自部署 endpoint）
//!
//! 实现要点（T-M026 起，桌面/移动端统一）：
//! - 用 `rusty-s3` 只做 SigV4 **签名**（生成 presigned URL），自身零 HTTP/TLS 依赖；
//!   真正的 HTTP 由项目全局 `reqwest`（rustls，移动端已验证可用）执行 → 摆脱 rust-s3
//!   硬拉 openssl 导致 Android 编不过的问题，且与 WebDAV 共用一套 HTTP 栈。
//! - 走全局 sync_v1 runtime（`runtime::block_on`）把 async 调用包成同步（trait 是同步的）。
//! - object key = `<prefix>/manifest.json` 或 `<prefix>/notes/<sid>.md`
//!   prefix 为空 ⇒ 直接放在 bucket 根；用户可设 `kb/` 之类做隔离。
//! - path-style（`UrlStyle::Path`）：兼容 MinIO / R2 / 阿里云走自定义 endpoint 时的常见限制。

use std::time::Duration;

use reqwest::{StatusCode, Url};
use rusty_s3::actions::ListObjectsV2;
use rusty_s3::{Bucket, Credentials, S3Action, UrlStyle};

use crate::error::AppError;
use crate::models::SyncManifestV1;
use crate::services::sync_v1::runtime::block_on;

use super::backend::{cas_path, SyncBackendImpl, MANIFEST_FILENAME};

/// presigned URL 有效期：仅用于"签完立刻执行"，给足网络时延即可（不长期分发）。
const PRESIGN_TTL: Duration = Duration::from_secs(300);

pub struct S3Backend {
    bucket: Bucket,
    creds: Credentials,
    /// 复用全局 reqwest Client（连接池 + TLS 会话复用），与 WebDAV 同一套
    client: &'static reqwest::Client,
    /// 路径前缀（不含开头/末尾 /）
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
        let endpoint_url = Url::parse(endpoint.trim_end_matches('/'))
            .map_err(|e| AppError::Custom(format!("S3 endpoint 无效: {}", e)))?;
        let region = if region_name.is_empty() {
            "us-east-1"
        } else {
            region_name
        };
        // path-style：兼容 MinIO / R2 / 阿里云走自定义 endpoint 时的常见限制
        let bucket = Bucket::new(
            endpoint_url,
            UrlStyle::Path,
            bucket_name.to_string(),
            region.to_string(),
        )
        .map_err(|e| AppError::Custom(format!("S3 bucket 初始化失败: {}", e)))?;
        let creds = Credentials::new(access_key, secret_key);

        Ok(Self {
            bucket,
            creds,
            client: crate::services::http_client::shared(),
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

    // ── 私有 async 助手：签名（同步）→ reqwest 执行（async） ────────────────

    async fn put_bytes(
        &self,
        key: &str,
        bytes: Vec<u8>,
        content_type: &str,
    ) -> Result<(), AppError> {
        let url = self.bucket.put_object(Some(&self.creds), key).sign(PRESIGN_TTL);
        let resp = self
            .client
            .put(url)
            .header(reqwest::header::CONTENT_TYPE, content_type)
            .body(bytes)
            .send()
            .await
            .map_err(|e| AppError::Custom(format!("S3 网络错误: {}", e)))?;
        let st = resp.status();
        if !st.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Custom(format!(
                "S3 PUT 失败 {} ({}): {}",
                key,
                st,
                body.chars().take(200).collect::<String>()
            )));
        }
        Ok(())
    }

    /// 返回 None 表示对象不存在（404）
    async fn get_bytes(&self, key: &str) -> Result<Option<Vec<u8>>, AppError> {
        let url = self.bucket.get_object(Some(&self.creds), key).sign(PRESIGN_TTL);
        let resp = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| AppError::Custom(format!("S3 网络错误: {}", e)))?;
        let st = resp.status();
        if st == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !st.is_success() {
            return Err(AppError::Custom(format!("S3 GET 失败 {} ({})", key, st)));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| AppError::Custom(format!("S3 读取响应失败: {}", e)))?;
        Ok(Some(bytes.to_vec()))
    }

    async fn delete_key(&self, key: &str) -> Result<(), AppError> {
        let url = self
            .bucket
            .delete_object(Some(&self.creds), key)
            .sign(PRESIGN_TTL);
        let resp = self
            .client
            .delete(url)
            .send()
            .await
            .map_err(|e| AppError::Custom(format!("S3 网络错误: {}", e)))?;
        let st = resp.status();
        // DELETE 幂等：对象不存在（404）也当成功
        if st.is_success() || st == StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(AppError::Custom(format!("S3 DELETE 失败 {} ({})", key, st)))
        }
    }

    async fn head_status(&self, key: &str) -> Result<u16, AppError> {
        let url = self
            .bucket
            .head_object(Some(&self.creds), key)
            .sign(PRESIGN_TTL);
        let resp = self
            .client
            .head(url)
            .send()
            .await
            .map_err(|e| AppError::Custom(format!("S3 网络错误: {}", e)))?;
        Ok(resp.status().as_u16())
    }
}

impl SyncBackendImpl for S3Backend {
    fn name(&self) -> &'static str {
        "s3"
    }

    fn test_connection(&self) -> Result<(), AppError> {
        // S3 协议没有 "ping"：写一个临时小对象再删掉，确认有 PUT/DELETE 权限
        let probe_key = self.key("__kb_sync_probe__.txt");
        block_on(async {
            self.put_bytes(&probe_key, b"ok".to_vec(), "text/plain")
                .await
                .map_err(|e| AppError::Custom(format!("S3 写入测试失败: {}", e)))?;
            self.delete_key(&probe_key)
                .await
                .map_err(|e| AppError::Custom(format!("S3 删除测试失败: {}", e)))?;
            log::info!("[s3] connection test OK (prefix={})", self.prefix);
            Ok::<_, AppError>(())
        })
    }

    fn read_manifest(&self) -> Result<Option<SyncManifestV1>, AppError> {
        let key = self.key(MANIFEST_FILENAME);
        let bytes = block_on(self.get_bytes(&key))?;
        match bytes {
            None => Ok(None),
            Some(b) => {
                let m: SyncManifestV1 = serde_json::from_slice(&b)
                    .map_err(|e| AppError::Custom(format!("远端 manifest 解析失败: {}", e)))?;
                Ok(Some(m))
            }
        }
    }

    fn write_manifest(&self, manifest: &SyncManifestV1) -> Result<(), AppError> {
        let bytes = serde_json::to_vec_pretty(manifest)
            .map_err(|e| AppError::Custom(format!("manifest 序列化失败: {}", e)))?;
        let key = self.key(MANIFEST_FILENAME);
        block_on(self.put_bytes(&key, bytes, "application/json"))
    }

    fn put_note(&self, path: &str, content: &str) -> Result<(), AppError> {
        let key = self.key(path);
        block_on(self.put_bytes(
            &key,
            content.as_bytes().to_vec(),
            "text/markdown; charset=utf-8",
        ))
    }

    fn get_note(&self, path: &str) -> Result<Option<String>, AppError> {
        let key = self.key(path);
        let bytes = block_on(self.get_bytes(&key))?;
        Ok(bytes.map(|b| String::from_utf8_lossy(&b).into_owned()))
    }

    fn delete_note(&self, path: &str) -> Result<(), AppError> {
        let key = self.key(path);
        block_on(self.delete_key(&key))
    }

    fn put_attachment(&self, hash: &str, bytes: &[u8]) -> Result<(), AppError> {
        let key = self.key(&cas_path(hash));
        block_on(self.put_bytes(&key, bytes.to_vec(), "application/octet-stream"))
    }

    fn get_attachment(&self, hash: &str) -> Result<Option<Vec<u8>>, AppError> {
        let key = self.key(&cas_path(hash));
        block_on(self.get_bytes(&key))
    }

    fn has_attachment(&self, hash: &str) -> Result<bool, AppError> {
        let key = self.key(&cas_path(hash));
        let status = block_on(self.head_status(&key))?;
        match status {
            200..=299 => Ok(true),
            404 => Ok(false),
            other => Err(AppError::Custom(format!("S3 HEAD 失败 ({})", other))),
        }
    }

    fn list_attachment_hashes(&self) -> Result<Vec<String>, AppError> {
        let list_prefix = self.key("attachments/");
        let mut hashes = Vec::new();
        let mut token: Option<String> = None;

        loop {
            let cont = token.clone();
            // 签名 + 拉取一页 XML
            let text = block_on(async {
                let mut action = self.bucket.list_objects_v2(Some(&self.creds));
                action.with_prefix(&list_prefix);
                if let Some(t) = &cont {
                    action.with_continuation_token(t);
                }
                let url = action.sign(PRESIGN_TTL);
                let resp = self
                    .client
                    .get(url)
                    .send()
                    .await
                    .map_err(|e| AppError::Custom(format!("S3 list 网络错误: {}", e)))?;
                let st = resp.status();
                if !st.is_success() {
                    return Err(AppError::Custom(format!("S3 list 失败 ({})", st)));
                }
                resp.text()
                    .await
                    .map_err(|e| AppError::Custom(format!("S3 list 读取失败: {}", e)))
            })?;

            let parsed = ListObjectsV2::parse_response(&text)
                .map_err(|e| AppError::Custom(format!("S3 list 解析失败: {}", e)))?;
            for obj in parsed.contents {
                // obj.key = "<prefix>attachments/aa/bb/<hash>" → 取最后一段
                if let Some(name) = obj.key.rsplit('/').next() {
                    if name.is_empty() || name.starts_with('_') {
                        continue;
                    }
                    hashes.push(name.to_string());
                }
            }

            match parsed.next_continuation_token {
                Some(t) => token = Some(t),
                None => break,
            }
        }
        Ok(hashes)
    }
}
