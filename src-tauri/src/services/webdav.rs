//! WebDAV 客户端：用于云同步 ZIP 上传/下载
//!
//! 密码存储走 OS keyring（避免 DB 明文），详见 services::sync::get_webdav_password

use base64::Engine;
use reqwest::header::{HeaderMap, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, Method, StatusCode};

use crate::error::AppError;

pub struct WebDavClient {
    client: Client,
    base_url: String,
    auth_header: String,
}

impl WebDavClient {
    pub fn new(url: &str, username: &str, password: &str) -> Self {
        let auth = base64::engine::general_purpose::STANDARD
            .encode(format!("{}:{}", username, password));
        Self {
            client: Client::new(),
            base_url: url.trim_end_matches('/').to_string(),
            auth_header: format!("Basic {}", auth),
        }
    }

    fn file_url(&self, filename: &str) -> String {
        format!("{}/{}", self.base_url, filename)
    }

    fn headers(&self) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(AUTHORIZATION, self.auth_header.parse().unwrap());
        h
    }

    /// 测试连接：PROPFIND 根目录
    pub async fn test_connection(&self) -> Result<(), AppError> {
        let resp = self
            .client
            .request(Method::from_bytes(b"PROPFIND").unwrap(), &self.base_url)
            .headers(self.headers())
            .header("Depth", "0")
            .send()
            .await
            .map_err(|e| AppError::Custom(format!("网络错误: {}", e)))?;

        let status = resp.status();
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err(AppError::Custom("认证失败，请检查用户名/密码".into()));
        }
        if status == StatusCode::NOT_FOUND {
            return Err(AppError::Custom(
                "云端文件夹不存在，请先在 WebDAV 服务端创建该文件夹".into(),
            ));
        }
        if !status.is_success() && status != StatusCode::MULTI_STATUS {
            return Err(AppError::Custom(format!("连接失败，服务器返回 {}", status)));
        }
        Ok(())
    }

    /// 上传二进制数据（大文件支持）
    pub async fn upload_bytes(&self, filename: &str, bytes: Vec<u8>) -> Result<(), AppError> {
        let resp = self
            .client
            .put(self.file_url(filename))
            .headers(self.headers())
            .header(CONTENT_TYPE, "application/octet-stream")
            .body(bytes)
            .send()
            .await
            .map_err(|e| AppError::Custom(format!("上传失败: {}", e)))?;

        let status = resp.status();
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err(AppError::Custom("认证失败，请检查用户名/密码".into()));
        }
        if status == StatusCode::NOT_FOUND || status == StatusCode::CONFLICT {
            return Err(AppError::Custom(
                "云端文件夹不存在，请先在 WebDAV 服务端创建".into(),
            ));
        }
        if !status.is_success()
            && status != StatusCode::CREATED
            && status != StatusCode::NO_CONTENT
        {
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Custom(format!("上传失败 ({}): {}", status, body)));
        }
        Ok(())
    }

    /// 下载二进制数据
    pub async fn download_bytes(&self, filename: &str) -> Result<Vec<u8>, AppError> {
        let resp = self
            .client
            .get(self.file_url(filename))
            .headers(self.headers())
            .send()
            .await
            .map_err(|e| AppError::Custom(format!("下载失败: {}", e)))?;

        let status = resp.status();
        if status == StatusCode::NOT_FOUND {
            return Err(AppError::NotFound("云端暂无同步数据，请先推送".into()));
        }
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err(AppError::Custom("认证失败，请检查用户名/密码".into()));
        }
        if !status.is_success() {
            return Err(AppError::Custom(format!("下载失败，服务器返回 {}", status)));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| AppError::Custom(format!("读取响应失败: {}", e)))?;
        Ok(bytes.to_vec())
    }
}
