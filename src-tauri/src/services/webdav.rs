//! WebDAV 客户端：用于云同步 ZIP 上传/下载
//!
//! 密码存储走 OS keyring（避免 DB 明文），详见 services::sync::get_webdav_password

use std::path::Path;

use base64::Engine;
use futures::StreamExt;
use reqwest::header::{HeaderMap, AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE};
use reqwest::{Client, Method, StatusCode};
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

use crate::error::AppError;

pub struct WebDavClient {
    client: &'static Client,
    base_url: String,
    auth_header: String,
}

impl WebDavClient {
    pub fn new(url: &str, username: &str, password: &str) -> Self {
        let auth = base64::engine::general_purpose::STANDARD
            .encode(format!("{}:{}", username, password));
        Self {
            // 复用全局 reqwest Client，避免每次 push/pull 都重建连接池 + TLS 会话
            client: crate::services::http_client::shared(),
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

    /// 流式上传本地文件：通过 `ReaderStream` 把文件逐块喂给 reqwest，
    /// 全程不把整份 ZIP 载入内存。适合 WebDAV 同步大快照。
    pub async fn upload_file(&self, filename: &str, local_path: &Path) -> Result<(), AppError> {
        let file = tokio::fs::File::open(local_path)
            .await
            .map_err(|e| AppError::Custom(format!("打开待上传文件失败: {}", e)))?;
        // 提前拿到文件大小用作 Content-Length，方便服务端记录进度（没拿到也不致命）
        let content_length = file.metadata().await.ok().map(|m| m.len());
        let stream = ReaderStream::new(file);
        let body = reqwest::Body::wrap_stream(stream);

        let mut req = self
            .client
            .put(self.file_url(filename))
            .headers(self.headers())
            .header(CONTENT_TYPE, "application/octet-stream");
        if let Some(len) = content_length {
            req = req.header(CONTENT_LENGTH, len);
        }

        let resp = req
            .body(body)
            .send()
            .await
            .map_err(|e| AppError::Custom(format!("上传失败: {}", e)))?;

        Self::check_put_status(resp).await
    }

    /// 统一处理 PUT 响应状态
    async fn check_put_status(resp: reqwest::Response) -> Result<(), AppError> {
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
        let resp = Self::send_get(&self.client, &self.file_url(filename), &self.headers()).await?;
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| AppError::Custom(format!("读取响应失败: {}", e)))?;
        Ok(bytes.to_vec())
    }

    /// 流式下载到本地文件：逐块把响应体写入目标文件，
    /// 全程不把整份 ZIP 载入内存。上层调用方应确保目标目录存在且可写。
    pub async fn download_to_file(
        &self,
        filename: &str,
        dest_path: &Path,
    ) -> Result<(), AppError> {
        let resp = Self::send_get(&self.client, &self.file_url(filename), &self.headers()).await?;
        let mut file = tokio::fs::File::create(dest_path)
            .await
            .map_err(|e| AppError::Custom(format!("创建本地文件失败: {}", e)))?;

        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk
                .map_err(|e| AppError::Custom(format!("下载过程中断: {}", e)))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| AppError::Custom(format!("写入本地文件失败: {}", e)))?;
        }
        file.flush()
            .await
            .map_err(|e| AppError::Custom(format!("落盘失败: {}", e)))?;
        Ok(())
    }

    /// 共用的 GET 请求 + 状态码检查（download_bytes / download_to_file 共用）
    async fn send_get(
        client: &Client,
        url: &str,
        headers: &HeaderMap,
    ) -> Result<reqwest::Response, AppError> {
        let resp = client
            .get(url)
            .headers(headers.clone())
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
        Ok(resp)
    }

    /// 列出目录下的文件名（PROPFIND Depth:1，用正则抽取 <d:href>）
    /// 返回的是基础文件名（不含路径），按字母序
    pub async fn list_files(&self) -> Result<Vec<String>, AppError> {
        let resp = self
            .client
            .request(Method::from_bytes(b"PROPFIND").unwrap(), &self.base_url)
            .headers(self.headers())
            .header("Depth", "1")
            .header(CONTENT_TYPE, "application/xml")
            .send()
            .await
            .map_err(|e| AppError::Custom(format!("列目录失败: {}", e)))?;

        let status = resp.status();
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err(AppError::Custom("认证失败，请检查用户名/密码".into()));
        }
        if status == StatusCode::NOT_FOUND {
            return Err(AppError::Custom("云端文件夹不存在".into()));
        }
        if !status.is_success() && status != StatusCode::MULTI_STATUS {
            return Err(AppError::Custom(format!("列目录失败，服务器返回 {}", status)));
        }

        let body = resp
            .text()
            .await
            .map_err(|e| AppError::Custom(format!("读取响应失败: {}", e)))?;

        // 扫描所有 href 标签的内容（大小写 + 命名空间不敏感）
        // 常见格式：<D:href>/dav/folder/kb-sync-ye.zip</D:href>
        let mut files = Vec::new();
        let lower = body.to_lowercase();
        let bytes = body.as_bytes();
        let mut i = 0;
        while let Some(open) = lower[i..].find("href>") {
            let content_start = i + open + 5; // 跳过 "href>"
            // 找对应的 </...href>
            let close_rel = match lower[content_start..].find("</") {
                Some(p) => p,
                None => break,
            };
            let content_end = content_start + close_rel;
            let raw = std::str::from_utf8(&bytes[content_start..content_end])
                .unwrap_or("")
                .trim();
            i = content_end + 2;
            if raw.is_empty() || raw.ends_with('/') {
                // 空的或以 / 结尾（通常是目录自身），跳过
                continue;
            }
            // 取路径最后一段作为文件名
            let name = raw.rsplit('/').next().unwrap_or("");
            if name.is_empty() {
                continue;
            }
            // URL decode（文件名可能含 URL 编码，比如空格/中文）
            let decoded = urlencoding::decode(name)
                .map(|c| c.into_owned())
                .unwrap_or_else(|_| name.to_string());
            files.push(decoded);
        }

        files.sort();
        files.dedup();
        Ok(files)
    }
}
