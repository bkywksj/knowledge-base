//! 局域网同步客户端：通过 HTTPS 访问电脑端的局域网同步服务（见 lan_protocol.rs）。
//!
//! - 证书：电脑端是自签证书，不走 CA 校验；只认配对时拿到的证书指纹（sha256），
//!   指纹对不上直接断开 —— 局域网里被人冒充成「电脑」也拿不到数据
//! - 鉴权：每个请求带 Bearer 令牌（配对时拿到）
//! - 写操作要先 [`LanBackend::begin_session`] 拿库级租约，结束后 [`LanBackend::end_session`]；
//!   电脑端同一时刻只允许一方写，避免两边交错写 manifest 互相覆盖
// 手机端「局域网」同步方式（第 4 步）接入前，本模块只被单测调用；接入后去掉这行
#![allow(dead_code)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::{Method, StatusCode};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};

use crate::error::AppError;
use crate::models::SyncManifestV1;
use crate::services::sync_v1::runtime::block_on;

use super::backend::SyncBackendImpl;
use super::lan_protocol::{cert_fingerprint, LeaseResponse, API_PREFIX, LEASE_HEADER};

/// 只认指定指纹的证书校验器。签名仍按 rustls 正常校验（保证握手确实由持有该证书私钥的一方完成）
#[derive(Debug)]
struct PinnedCertVerifier {
    fingerprint: String,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinnedCertVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if cert_fingerprint(end_entity.as_ref()).eq_ignore_ascii_case(&self.fingerprint) {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General("电脑端证书指纹与配对时不一致".into()))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

/// hash 直接拼进 URL 路径：先在客户端校验。否则像 `../..` 会被 URL 规范化折叠，
/// 请求打到别的路径上（服务端虽然也校验，但客户端不该发出这种请求，错误也更好懂）
fn attachment_path(hash: &str) -> Result<String, AppError> {
    super::lan_protocol::validate_hash(hash).map_err(AppError::Custom)?;
    Ok(format!("/attachment/{hash}"))
}

pub struct LanBackend {
    /// 形如 `https://192.168.1.8:47321`
    base_url: String,
    token: String,
    client: reqwest::Client,
    lease: Mutex<Option<String>>,
}

impl LanBackend {
    pub fn new(base_url: &str, token: &str, fingerprint: &str) -> Result<Self, AppError> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let tls = rustls::ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .map_err(|e| AppError::Custom(format!("TLS 初始化失败: {e}")))?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(PinnedCertVerifier {
                fingerprint: fingerprint.to_string(),
                provider,
            }))
            .with_no_client_auth();
        let client = reqwest::Client::builder()
            .use_preconfigured_tls(tls)
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(300))
            // 局域网直连，不走系统代理（代理多半连不到内网地址）
            .no_proxy()
            .build()
            .map_err(|e| AppError::Custom(format!("局域网客户端初始化失败: {e}")))?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            token: token.to_string(),
            client,
            lease: Mutex::new(None),
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}{}", self.base_url, API_PREFIX, path)
    }

    /// 发请求并把常见状态码翻成用户看得懂的错误；`allow_404` 时 404 返回 Ok(None)
    async fn send(
        &self,
        method: Method,
        path: &str,
        query: Option<(&str, &str)>,
        body: Option<Vec<u8>>,
        allow_404: bool,
    ) -> Result<Option<reqwest::Response>, AppError> {
        let mut req = self.client.request(method, self.url(path)).bearer_auth(&self.token);
        if let Some((k, v)) = query {
            req = req.query(&[(k, v)]);
        }
        if let Some(id) = self.lease.lock().map_err(|e| AppError::Custom(e.to_string()))?.clone() {
            req = req.header(LEASE_HEADER, id);
        }
        if let Some(b) = body {
            req = req.body(b);
        }
        let resp = req.send().await.map_err(|e| {
            AppError::Custom(format!("连不上电脑端（确认电脑开着知识库、两台设备在同一局域网）: {e}"))
        })?;
        match resp.status() {
            s if s.is_success() => Ok(Some(resp)),
            StatusCode::NOT_FOUND if allow_404 => Ok(None),
            StatusCode::UNAUTHORIZED => Err(AppError::Custom("配对已失效，请在电脑端重新配对".into())),
            StatusCode::CONFLICT => Err(AppError::Custom("电脑端正在同步，请稍后再试".into())),
            StatusCode::LOCKED => Err(AppError::Custom("同步会话已过期，请重新同步".into())),
            s => {
                let text = resp.text().await.unwrap_or_default();
                Err(AppError::Custom(format!("电脑端返回错误 {s}: {text}")))
            }
        }
    }

    async fn get_bytes(&self, path: &str, query: Option<(&str, &str)>) -> Result<Option<Vec<u8>>, AppError> {
        match self.send(Method::GET, path, query, None, true).await? {
            None => Ok(None),
            Some(r) => Ok(Some(
                r.bytes().await.map_err(|e| AppError::Custom(format!("读取响应失败: {e}")))?.to_vec(),
            )),
        }
    }

    /// 开始一次写同步：向电脑端申请库级租约。电脑端或别的设备正在同步时返回错误
    pub fn begin_session(&self) -> Result<(), AppError> {
        let resp = block_on(self.send(Method::POST, "/lease", None, None, false))?
            .ok_or_else(|| AppError::Custom("申请同步会话失败".into()))?;
        let lease: LeaseResponse = block_on(resp.json())
            .map_err(|e| AppError::Custom(format!("同步会话响应解析失败: {e}")))?;
        *self.lease.lock().map_err(|e| AppError::Custom(e.to_string()))? = Some(lease.lease_id);
        Ok(())
    }

    /// 结束写同步、释放租约。失败只记日志：租约到期会自动释放
    pub fn end_session(&self) {
        let id = match self.lease.lock() {
            Ok(mut g) => g.take(),
            Err(_) => None,
        };
        if let Some(id) = id {
            let path = format!("/lease/{id}");
            if let Err(e) = block_on(self.send(Method::DELETE, &path, None, None, true)) {
                log::warn!("[lan-sync] 释放同步会话失败（到期会自动释放）: {e}");
            }
        }
    }

    /// 电脑端信息（配对后确认连对了机器）
    pub fn server_info(&self) -> Result<super::lan_protocol::ServerInfo, AppError> {
        let resp = block_on(self.send(Method::GET, "/info", None, None, false))?
            .ok_or_else(|| AppError::Custom("读取电脑端信息失败".into()))?;
        block_on(resp.json()).map_err(|e| AppError::Custom(format!("电脑端信息解析失败: {e}")))
    }
}

impl SyncBackendImpl for LanBackend {
    fn name(&self) -> &'static str {
        "lan"
    }

    fn test_connection(&self) -> Result<(), AppError> {
        block_on(self.send(Method::GET, "/ping", None, None, false)).map(|_| ())
    }

    fn read_manifest(&self) -> Result<Option<SyncManifestV1>, AppError> {
        match block_on(self.get_bytes("/manifest", None))? {
            None => Ok(None),
            Some(b) => serde_json::from_slice(&b)
                .map(Some)
                .map_err(|e| AppError::Custom(format!("远端 manifest 解析失败: {e}"))),
        }
    }

    fn write_manifest(&self, manifest: &SyncManifestV1) -> Result<(), AppError> {
        let body = serde_json::to_vec_pretty(manifest)
            .map_err(|e| AppError::Custom(format!("manifest 序列化失败: {e}")))?;
        block_on(self.send(Method::PUT, "/manifest", None, Some(body), false)).map(|_| ())
    }

    fn put_note(&self, path: &str, content: &str) -> Result<(), AppError> {
        block_on(self.send(Method::PUT, "/note", Some(("path", path)), Some(content.as_bytes().to_vec()), false))
            .map(|_| ())
    }

    fn get_note(&self, path: &str) -> Result<Option<String>, AppError> {
        match block_on(self.get_bytes("/note", Some(("path", path))))? {
            None => Ok(None),
            Some(b) => String::from_utf8(b)
                .map(Some)
                .map_err(|e| AppError::Custom(format!("笔记不是 UTF-8: {e}"))),
        }
    }

    fn delete_note(&self, path: &str) -> Result<(), AppError> {
        block_on(self.send(Method::DELETE, "/note", Some(("path", path)), None, true)).map(|_| ())
    }

    fn put_attachment(&self, hash: &str, bytes: &[u8]) -> Result<(), AppError> {
        let path = attachment_path(hash)?;
        block_on(self.send(Method::PUT, &path, None, Some(bytes.to_vec()), false)).map(|_| ())
    }

    fn get_attachment(&self, hash: &str) -> Result<Option<Vec<u8>>, AppError> {
        block_on(self.get_bytes(&attachment_path(hash)?, None))
    }

    fn has_attachment(&self, hash: &str) -> Result<bool, AppError> {
        let path = attachment_path(hash)?;
        Ok(block_on(self.send(Method::HEAD, &path, None, None, true))?.is_some())
    }

    fn list_attachment_hashes(&self) -> Result<Vec<String>, AppError> {
        let b = block_on(self.get_bytes("/attachments", None))?.unwrap_or_default();
        serde_json::from_slice(&b).map_err(|e| AppError::Custom(format!("附件列表解析失败: {e}")))
    }

    fn list_root_files(&self) -> Result<Option<Vec<String>>, AppError> {
        let b = block_on(self.get_bytes("/root-files", None))?.unwrap_or_default();
        serde_json::from_slice(&b)
            .map(Some)
            .map_err(|e| AppError::Custom(format!("文件列表解析失败: {e}")))
    }
}
