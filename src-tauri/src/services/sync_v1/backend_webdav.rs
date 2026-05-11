//! WebDAV V1 backend：复用现有 `services::webdav::WebDavClient`
//!
//! 远端目录结构（与 LocalPathBackend 一致）：
//!   <base_url>/manifest.json
//!   <base_url>/notes/<stable_id>.md
//!
//! 注意：
//! - 用户应该在 WebDAV server 端先建好"基目录"（坚果云 / Cloudreve / Nextcloud 都允许在 UI 创建）
//! - 子目录 `notes/` 在首次 put 时自动 MKCOL

use crate::error::AppError;
use crate::models::SyncManifestV1;
use crate::services::sync_v1::runtime::block_on;
use crate::services::webdav::WebDavClient;

use super::backend::{SyncBackendImpl, MANIFEST_FILENAME};

pub struct WebdavBackend {
    client: WebDavClient,
}

impl WebdavBackend {
    pub fn new(url: &str, username: &str, password: &str) -> Self {
        Self {
            client: WebDavClient::new(url, username, password),
        }
    }
}

impl SyncBackendImpl for WebdavBackend {
    fn name(&self) -> &'static str {
        "webdav"
    }

    fn test_connection(&self) -> Result<(), AppError> {
        block_on(self.client.test_connection())
    }

    fn read_manifest(&self) -> Result<Option<SyncManifestV1>, AppError> {
        let bytes_opt = block_on(self.client.download_bytes_optional(MANIFEST_FILENAME))?;
        match bytes_opt {
            None => Ok(None),
            Some(bytes) => {
                let m: SyncManifestV1 = serde_json::from_slice(&bytes)
                    .map_err(|e| AppError::Custom(format!("远端 manifest 解析失败: {}", e)))?;
                Ok(Some(m))
            }
        }
    }

    fn write_manifest(&self, manifest: &SyncManifestV1) -> Result<(), AppError> {
        let bytes = serde_json::to_vec_pretty(manifest)
            .map_err(|e| AppError::Custom(format!("manifest 序列化失败: {}", e)))?;
        block_on(self.client.upload_bytes(MANIFEST_FILENAME, bytes))
    }

    fn put_note(&self, path: &str, content: &str) -> Result<(), AppError> {
        block_on(self.client.upload_bytes(path, content.as_bytes().to_vec()))
    }

    fn get_note(&self, path: &str) -> Result<Option<String>, AppError> {
        let bytes_opt = block_on(self.client.download_bytes_optional(path))?;
        Ok(bytes_opt.map(|b| String::from_utf8_lossy(&b).into_owned()))
    }

    fn delete_note(&self, path: &str) -> Result<(), AppError> {
        block_on(self.client.delete_file(path))
    }

    fn put_attachment(&self, hash: &str, bytes: &[u8]) -> Result<(), AppError> {
        let path = super::backend::cas_path(hash);
        block_on(self.client.upload_bytes(&path, bytes.to_vec()))
    }

    fn get_attachment(&self, hash: &str) -> Result<Option<Vec<u8>>, AppError> {
        let path = super::backend::cas_path(hash);
        block_on(self.client.download_bytes_optional(&path))
    }

    fn has_attachment(&self, hash: &str) -> Result<bool, AppError> {
        // TODO 性能优化：用 HEAD 请求探测，不传输 body
        // 当前用 download_bytes_optional 是正确但浪费带宽（附件可能 MB 级）
        let path = super::backend::cas_path(hash);
        let exists = block_on(self.client.download_bytes_optional(&path))?.is_some();
        Ok(exists)
    }
}
