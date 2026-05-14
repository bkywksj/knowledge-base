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

/// WebDAV 客户端
///
/// `Clone` 派生：方便 sync_v1 并发上传时给每个 tokio task 拷贝一份（T-S031）。
/// 字段都廉价克隆：`client` 是 `&'static`（Copy），其余两个 String（Clone）。
#[derive(Clone)]
pub struct WebDavClient {
    client: &'static Client,
    base_url: String,
    auth_header: String,
}

impl WebDavClient {
    pub fn new(url: &str, username: &str, password: &str) -> Self {
        let auth =
            base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", username, password));
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
        // 坚果云对不存在的路径返回 400（不是 404），所以 400/404/409 一并按
        // "路径不存在/无效"友好提示，避免给用户看到生硬的 "400 Bad Request"
        if status == StatusCode::NOT_FOUND
            || status == StatusCode::BAD_REQUEST
            || status == StatusCode::CONFLICT
        {
            return Err(AppError::Custom(format!(
                "云端文件夹不存在或路径无效（{}）。请先登录 WebDAV 服务端（如坚果云网页版），手动创建配置中填写的目录后重试",
                status.as_u16()
            )));
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
        if !status.is_success() && status != StatusCode::CREATED && status != StatusCode::NO_CONTENT
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
    pub async fn download_to_file(&self, filename: &str, dest_path: &Path) -> Result<(), AppError> {
        let resp = Self::send_get(&self.client, &self.file_url(filename), &self.headers()).await?;
        let mut file = tokio::fs::File::create(dest_path)
            .await
            .map_err(|e| AppError::Custom(format!("创建本地文件失败: {}", e)))?;

        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| AppError::Custom(format!("下载过程中断: {}", e)))?;
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

    /// T-024c: 上传内存字节流到指定相对路径（不需要先落盘文件）
    ///
    /// 路径里的目录不存在时，会先 MKCOL 递归创建。
    pub async fn upload_bytes(&self, path: &str, bytes: Vec<u8>) -> Result<(), AppError> {
        // 先确保父目录存在（WebDAV 要求 PUT 前父目录已存在）
        if let Some(parent) = path.rsplit_once('/').map(|(p, _)| p) {
            if !parent.is_empty() {
                self.ensure_dir(parent).await?;
            }
        }
        self.put_into_existing_dir(path, bytes).await
    }

    /// 把内存字节流 PUT 到指定路径，**不** MKCOL 父目录（调用方需保证父目录已存在）。
    ///
    /// 用于 `batch_put_notes`：一次性把目录 MKCOL 好后，逐条 PUT 不再重复 MKCOL，
    /// 请求数砍一半 —— 少触发服务器（nginx）的 `limit_req` 限流（限流时 nginx 返回 503）。
    pub async fn put_into_existing_dir(&self, path: &str, bytes: Vec<u8>) -> Result<(), AppError> {
        let resp = self
            .client
            .put(self.file_url(path))
            .headers(self.headers())
            .header(CONTENT_TYPE, "application/octet-stream")
            .header(CONTENT_LENGTH, bytes.len() as u64)
            .body(bytes)
            .send()
            .await
            .map_err(|e| AppError::Custom(format!("上传失败: {}", e)))?;

        Self::check_put_status(resp).await
    }

    /// T-024c: 递归创建 WebDAV 目录（MKCOL）
    ///
    /// 已存在时返回 405 Method Not Allowed，按成功处理。
    pub async fn ensure_dir(&self, path: &str) -> Result<(), AppError> {
        let path = path.trim_matches('/');
        if path.is_empty() {
            return Ok(());
        }
        // 自顶向下逐级 MKCOL，已存在的层会返回 405，忽略即可
        let mut acc = String::new();
        for seg in path.split('/').filter(|s| !s.is_empty()) {
            if !acc.is_empty() {
                acc.push('/');
            }
            acc.push_str(seg);
            let url = format!("{}/{}", self.base_url, acc);
            let resp = self
                .client
                .request(Method::from_bytes(b"MKCOL").unwrap(), &url)
                .headers(self.headers())
                .send()
                .await
                .map_err(|e| AppError::Custom(format!("创建目录失败: {}", e)))?;
            let status = resp.status();
            // 201 Created 或 405（已存在）都视为成功
            if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
                return Err(AppError::Custom("认证失败，请检查用户名/密码".into()));
            }
            // 415 / 409 等，告诉用户具体错误
            if !status.is_success() && status != StatusCode::METHOD_NOT_ALLOWED {
                let body = resp.text().await.unwrap_or_default();
                return Err(AppError::Custom(format!(
                    "MKCOL {} 失败 ({}): {}",
                    acc, status, body
                )));
            }
        }
        Ok(())
    }

    /// T-024c: 删除远端文件（404 视为成功）
    ///
    /// 给 WebdavBackend 的 SyncBackendImpl::delete_note 用；后者目前还没被调用（tombstone push 留给后续阶段）
    #[allow(dead_code)]
    pub async fn delete_file(&self, path: &str) -> Result<(), AppError> {
        let resp = self
            .client
            .delete(self.file_url(path))
            .headers(self.headers())
            .send()
            .await
            .map_err(|e| AppError::Custom(format!("删除失败: {}", e)))?;

        let status = resp.status();
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err(AppError::Custom("认证失败，请检查用户名/密码".into()));
        }
        if status == StatusCode::NOT_FOUND {
            // 已经不在了，幂等
            return Ok(());
        }
        if !status.is_success() && status != StatusCode::NO_CONTENT {
            return Err(AppError::Custom(format!("删除失败 ({})", status)));
        }
        Ok(())
    }

    /// WebDAV `MOVE`：把 `from` 重命名为 `to`（同 server 内移动，**单一原子操作**）。
    ///
    /// 用于 manifest 原子写：先 PUT 到 `manifest.json.tmp.<uuid>`、再 MOVE 到 `manifest.json`，
    /// 中途断网最多留一个 .tmp.* 文件，永远不会出现"半截 manifest.json"。
    /// 主流 WebDAV server（坚果云/Nextcloud/Cloudreve/Apache mod_dav）都支持。
    ///
    /// `Overwrite: T` 让目标已存在时直接覆盖（manifest 这场景就是要覆盖）。
    pub async fn move_file(&self, from: &str, to: &str) -> Result<(), AppError> {
        let dest_url = self.file_url(to);
        let resp = self
            .client
            .request(Method::from_bytes(b"MOVE").unwrap(), self.file_url(from))
            .headers(self.headers())
            .header("Destination", &dest_url)
            .header("Overwrite", "T")
            .send()
            .await
            .map_err(|e| AppError::Custom(format!("MOVE 失败: {}", e)))?;
        let status = resp.status();
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err(AppError::Custom("认证失败，请检查用户名/密码".into()));
        }
        // 201 Created（目标新建）/ 204 No Content（目标已存在被覆盖）都是成功
        if status.is_success() {
            return Ok(());
        }
        let body = resp.text().await.unwrap_or_default();
        Err(AppError::Custom(format!(
            "MOVE {} -> {} 失败 ({}): {}",
            from,
            to,
            status,
            body.lines().next().unwrap_or("")
        )))
    }

    /// T-024c: 下载文件，404 时返回 None（用于"远端没有 manifest 时安全返回 None"）
    pub async fn download_bytes_optional(&self, path: &str) -> Result<Option<Vec<u8>>, AppError> {
        let resp = self
            .client
            .get(self.file_url(path))
            .headers(self.headers())
            .send()
            .await
            .map_err(|e| AppError::Custom(format!("下载失败: {}", e)))?;
        let status = resp.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(None);
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
        Ok(Some(bytes.to_vec()))
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
            return Err(AppError::Custom(format!(
                "列目录失败，服务器返回 {}",
                status
            )));
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

    /// T-S025: PROPFIND 列出指定相对路径下的所有 href（保留 href 完整路径，不只文件名）
    ///
    /// `rel_path` 相对 base_url（如 `"attachments"`）；`depth` = `"1"` 单层 / `"infinity"` 递归全部。
    ///
    /// 行为：
    /// - 路径不存在（404）→ 返回空 Vec（不当错误）
    /// - 403（可能服务器禁用 depth:infinity）→ 返回 Err，调用方应降级处理
    /// - 返回的 href 保留原始路径（可能是绝对 URL 或 `/dav/...` 相对路径），目录以 `/` 结尾
    pub async fn list_hrefs_under(
        &self,
        rel_path: &str,
        depth: &str,
    ) -> Result<Vec<String>, AppError> {
        let url = if rel_path.is_empty() {
            self.base_url.clone()
        } else {
            format!("{}/{}", self.base_url, rel_path.trim_start_matches('/'))
        };
        let resp = self
            .client
            .request(Method::from_bytes(b"PROPFIND").unwrap(), &url)
            .headers(self.headers())
            .header("Depth", depth)
            .header(CONTENT_TYPE, "application/xml")
            .send()
            .await
            .map_err(|e| AppError::Custom(format!("PROPFIND {} 失败: {}", rel_path, e)))?;

        let status = resp.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(vec![]); // 目录不存在 → 空
        }
        if status == StatusCode::UNAUTHORIZED {
            return Err(AppError::Custom("认证失败，请检查用户名/密码".into()));
        }
        if status == StatusCode::FORBIDDEN {
            return Err(AppError::Custom(
                "PROPFIND 被拒绝（部分服务器禁用 Depth:infinity）".into(),
            ));
        }
        if !status.is_success() && status != StatusCode::MULTI_STATUS {
            return Err(AppError::Custom(format!(
                "PROPFIND {} 返回 {}",
                rel_path, status
            )));
        }

        let body = resp
            .text()
            .await
            .map_err(|e| AppError::Custom(format!("读取响应失败: {}", e)))?;

        // 扫描所有 <...href>...</...href>，保留 raw（含完整路径），URL decode
        let mut hrefs = Vec::new();
        let lower = body.to_lowercase();
        let bytes = body.as_bytes();
        let mut i = 0;
        while let Some(open) = lower[i..].find("href>") {
            let content_start = i + open + 5;
            let close_rel = match lower[content_start..].find("</") {
                Some(p) => p,
                None => break,
            };
            let content_end = content_start + close_rel;
            let raw = std::str::from_utf8(&bytes[content_start..content_end])
                .unwrap_or("")
                .trim();
            i = content_end + 2;
            if raw.is_empty() {
                continue;
            }
            let decoded = urlencoding::decode(raw)
                .map(|c| c.into_owned())
                .unwrap_or_else(|_| raw.to_string());
            hrefs.push(decoded);
        }
        hrefs.sort();
        hrefs.dedup();
        Ok(hrefs)
    }
}
