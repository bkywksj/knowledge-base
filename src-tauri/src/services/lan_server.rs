//! 局域网同步服务端：把本机「局域网库目录」按同步接口暴露给别的设备（电脑常驻；手机当主机时临时开启）。
//!
//! 协议约定见 `sync_v1::lan_protocol`，客户端见 `sync_v1::backend_lan`。要点：
//! - HTTPS（自签证书，手机按配对时拿到的指纹固定校验）+ Bearer 令牌
//! - 只暴露同步接口的几个操作，所有路径 / hash 二次校验后才交给 LocalPathBackend
//! - 写操作必须持有库级租约（[`VaultLease`]）：手机同步和电脑自己往同一目录同步不会交错写 manifest
//!
//! axum::serve 不带 TLS，这里自己 accept → tokio-rustls 握手 → hyper 跑 axum Router。

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::Router;
use hyper_util::rt::TokioIo;
use hyper_util::service::TowerToHyperService;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio_rustls::TlsAcceptor;
use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::services::sync_v1::backend::SyncBackendImpl;
use crate::services::sync_v1::backend_local::LocalPathBackend;
use crate::services::sync_v1::lan_protocol::{
    token_eq, validate_hash, validate_rel_path, LeaseResponse, ServerInfo, API_PREFIX, LEASE_HEADER,
    LEASE_TTL_SECS, MAX_BODY_BYTES,
};

// ─── 库级租约 ─────────────────────────────────

/// 同一个局域网库目录同一时刻只允许一方写（手机经网络同步 / 电脑自己同步）。
///
/// 租约 `ttl` 内没有续期（带着租约的请求会自动续）就失效，持有方中途断网或被杀不会把库锁死。
/// 电脑端自己往这个目录同步时，也要在进程内先 [`try_acquire`](Self::try_acquire) 同一把租约。
#[derive(Clone)]
pub struct VaultLease {
    inner: Arc<Mutex<Option<LeaseSlot>>>,
    ttl: Duration,
}

struct LeaseSlot {
    id: String,
    holder: String,
    expires: Instant,
    /// 持有期间写过东西：归还时据此决定要不要让电脑端立即合并
    wrote: bool,
}

impl VaultLease {
    pub fn new(ttl: Duration) -> Self {
        Self { inner: Arc::new(Mutex::new(None)), ttl }
    }

    /// 申请租约：空闲或上一份已过期 → 返回新租约 id；别人持有中 → None
    pub fn try_acquire(&self, holder: &str) -> Option<String> {
        let mut g = self.inner.lock().ok()?;
        let now = Instant::now();
        if let Some(s) = g.as_ref() {
            if s.expires > now {
                log::info!("[lan-sync] 租约被 {} 持有中，拒绝 {}", s.holder, holder);
                return None;
            }
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        *g = Some(LeaseSlot { id: id.clone(), holder: holder.to_string(), expires: now + self.ttl, wrote: false });
        Some(id)
    }

    /// 校验租约是否有效，有效则顺带续期
    pub fn check_and_touch(&self, id: &str) -> bool {
        self.touch(id, false)
    }

    /// 写操作用：校验 + 续期 + 记一笔「写过」
    pub fn check_and_touch_write(&self, id: &str) -> bool {
        self.touch(id, true)
    }

    fn touch(&self, id: &str, write: bool) -> bool {
        let Ok(mut g) = self.inner.lock() else { return false };
        let now = Instant::now();
        match g.as_mut() {
            Some(s) if s.id == id && s.expires > now => {
                s.expires = now + self.ttl;
                s.wrote |= write;
                true
            }
            _ => false,
        }
    }

    /// 释放租约（id 不匹配时不动，防止误放别人的）。返回持有期间是否写过
    pub fn release(&self, id: &str) -> bool {
        let Ok(mut g) = self.inner.lock() else { return false };
        if g.as_ref().is_some_and(|s| s.id == id) {
            return g.take().is_some_and(|s| s.wrote);
        }
        false
    }
}

// ─── 证书 ─────────────────────────────────────

/// 自签证书身份（DER）。首次开启局域网同步时生成、持久化，之后复用 —— 换证书 = 所有手机要重新配对
pub struct LanIdentity {
    pub cert_der: Vec<u8>,
    pub key_der: Vec<u8>,
}

pub fn generate_identity() -> Result<LanIdentity, AppError> {
    let ck = rcgen::generate_simple_self_signed(vec!["kb-lan.local".to_string()])
        .map_err(|e| AppError::Custom(format!("生成局域网证书失败: {e}")))?;
    Ok(LanIdentity { cert_der: ck.cert.der().to_vec(), key_der: ck.key_pair.serialize_der() })
}

// ─── 服务 ─────────────────────────────────────

pub struct StartParams {
    pub vault_root: PathBuf,
    pub bind: SocketAddr,
    pub token: String,
    pub device_name: String,
    pub identity: LanIdentity,
    pub lease: VaultLease,
    /// 手机写过数据并归还租约后调用：电脑端据此立即把中转库合并进自己的库
    pub on_client_wrote: Option<Arc<dyn Fn() + Send + Sync>>,
}

/// 运行中的服务；drop 不会停服，要显式 [`shutdown`](Self::shutdown)
pub struct RunningLanServer {
    pub addr: SocketAddr,
    cancel: CancellationToken,
    /// 监听循环任务：它退出时监听端口才真正释放
    task: tokio::task::JoinHandle<()>,
}

impl RunningLanServer {
    /// 只发停机信号就返回（测试夹具的 Drop 用）。要在同一端口马上重启请用 [`shutdown`](Self::shutdown)
    #[cfg(test)]
    pub fn stop(&self) {
        self.cancel.cancel();
    }

    /// 停机并等监听端口真正释放。重新生成配对码等「停了马上在同一端口重启」的场景必须用它：
    /// 只发信号的话旧监听还没放掉，新的 bind 报端口被占用（真机实测）
    pub async fn shutdown(self) {
        self.cancel.cancel();
        let _ = self.task.await;
    }
}

struct AppCtx {
    backend: LocalPathBackend,
    token: String,
    device_name: String,
    lease: VaultLease,
    on_client_wrote: Option<Arc<dyn Fn() + Send + Sync>>,
}

type Ctx = State<Arc<AppCtx>>;

pub async fn start(params: StartParams) -> Result<RunningLanServer, AppError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let tls = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| AppError::Custom(format!("TLS 初始化失败: {e}")))?
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(params.identity.cert_der)],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(params.identity.key_der)),
        )
        .map_err(|e| AppError::Custom(format!("局域网证书无效: {e}")))?;
    let acceptor = TlsAcceptor::from(Arc::new(tls));

    std::fs::create_dir_all(&params.vault_root)?;
    let root = params
        .vault_root
        .to_str()
        .ok_or_else(|| AppError::Custom("局域网库目录路径不是 UTF-8".into()))?;
    let ctx = Arc::new(AppCtx {
        backend: LocalPathBackend::new(root),
        token: params.token,
        device_name: params.device_name,
        lease: params.lease,
        on_client_wrote: params.on_client_wrote,
    });
    let app = router(ctx);

    let listener = tokio::net::TcpListener::bind(params.bind)
        .await
        .map_err(|e| AppError::Custom(format!("局域网同步端口 {} 监听失败（可能已被占用）: {e}", params.bind)))?;
    let addr = listener.local_addr().map_err(|e| AppError::Custom(e.to_string()))?;
    let cancel = CancellationToken::new();
    let cancel_task = cancel.clone();

    let task = tokio::spawn(async move {
        loop {
            let (tcp, peer) = tokio::select! {
                _ = cancel_task.cancelled() => break,
                r = listener.accept() => match r {
                    Ok(v) => v,
                    Err(e) => {
                        log::warn!("[lan-sync] accept 失败: {e}");
                        continue;
                    }
                },
            };
            let acceptor = acceptor.clone();
            let app = app.clone();
            let cancel_conn = cancel_task.clone();
            tokio::spawn(async move {
                // 握手失败多半是对方证书指纹对不上（不是配对过的手机）或者被扫端口，记一笔不报错
                let tls = match acceptor.accept(tcp).await {
                    Ok(s) => s,
                    Err(e) => {
                        log::info!("[lan-sync] {peer} TLS 握手失败: {e}");
                        return;
                    }
                };
                let conn = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(tls), TowerToHyperService::new(app));
                tokio::select! {
                    r = conn => if let Err(e) = r { log::debug!("[lan-sync] {peer} 连接结束: {e}") },
                    _ = cancel_conn.cancelled() => {}
                }
            });
        }
        log::info!("[lan-sync] 服务已停止");
    });

    log::info!("[lan-sync] 已启动 https://{addr}");
    Ok(RunningLanServer { addr, cancel, task })
}

fn router(ctx: Arc<AppCtx>) -> Router {
    let api = Router::new()
        .route("/ping", get(ping))
        .route("/info", get(info))
        .route("/lease", post(lease_acquire))
        .route("/lease/{id}", delete(lease_release))
        .route("/manifest", get(manifest_get).put(manifest_put))
        .route("/note", get(note_get).put(note_put).delete(note_delete))
        .route("/attachment/{hash}", get(attachment_get).head(attachment_head).put(attachment_put))
        .route("/attachments", get(attachments_list))
        .route("/root-files", get(root_files));
    Router::new()
        .nest(API_PREFIX, api)
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(ctx)
}

// ─── 处理函数 ─────────────────────────────────

type HResult = Result<Response, Response>;

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, msg.into()).into_response()
}

fn internal(e: AppError) -> Response {
    log::warn!("[lan-sync] 处理请求失败: {e}");
    err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

fn auth(ctx: &AppCtx, headers: &HeaderMap) -> Result<(), Response> {
    let ok = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|t| token_eq(t, &ctx.token));
    if !ok {
        return Err(err(StatusCode::UNAUTHORIZED, "unauthorized"));
    }
    // 带着租约的请求（含读）都续期：拉取大量附件时全是读，不续的话中途过期，后面的写就被拒了
    if let Some(id) = headers.get(LEASE_HEADER).and_then(|v| v.to_str().ok()) {
        ctx.lease.check_and_touch(id);
    }
    Ok(())
}

/// 写操作：鉴权 + 必须带有效租约
fn auth_write(ctx: &AppCtx, headers: &HeaderMap) -> Result<(), Response> {
    auth(ctx, headers)?;
    let ok = headers
        .get(LEASE_HEADER)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|id| ctx.lease.check_and_touch_write(id));
    if ok {
        Ok(())
    } else {
        Err(err(StatusCode::LOCKED, "lease required"))
    }
}

/// LocalPathBackend 是同步文件 IO，放到阻塞线程池里跑，别卡住 tokio worker
async fn blocking<T: Send + 'static>(
    ctx: &Arc<AppCtx>,
    f: impl FnOnce(&LocalPathBackend) -> Result<T, AppError> + Send + 'static,
) -> Result<T, Response> {
    let ctx = ctx.clone();
    tokio::task::spawn_blocking(move || f(&ctx.backend))
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(internal)
}

fn json<T: serde::Serialize>(v: &T) -> Response {
    match serde_json::to_vec(v) {
        Ok(b) => ([(header::CONTENT_TYPE, "application/json")], b).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
struct PathQuery {
    path: String,
}

async fn ping(State(ctx): Ctx, headers: HeaderMap) -> HResult {
    auth(&ctx, &headers)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn info(State(ctx): Ctx, headers: HeaderMap) -> HResult {
    auth(&ctx, &headers)?;
    Ok(json(&ServerInfo { device_name: ctx.device_name.clone(), protocol: 1 }))
}

async fn lease_acquire(State(ctx): Ctx, headers: HeaderMap) -> HResult {
    auth(&ctx, &headers)?;
    match ctx.lease.try_acquire("lan-client") {
        Some(lease_id) => Ok(json(&LeaseResponse { lease_id, ttl_secs: LEASE_TTL_SECS })),
        None => Err(err(StatusCode::CONFLICT, "vault busy")),
    }
}

async fn lease_release(State(ctx): Ctx, headers: HeaderMap, Path(id): Path<String>) -> HResult {
    auth(&ctx, &headers)?;
    if ctx.lease.release(&id) {
        if let Some(cb) = &ctx.on_client_wrote {
            cb();
        }
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn manifest_get(State(ctx): Ctx, headers: HeaderMap) -> HResult {
    auth(&ctx, &headers)?;
    match blocking(&ctx, |b| b.read_manifest()).await? {
        Some(m) => Ok(json(&m)),
        None => Err(err(StatusCode::NOT_FOUND, "no manifest")),
    }
}

async fn manifest_put(State(ctx): Ctx, headers: HeaderMap, body: Bytes) -> HResult {
    auth_write(&ctx, &headers)?;
    let m: crate::models::SyncManifestV1 =
        serde_json::from_slice(&body).map_err(|e| err(StatusCode::BAD_REQUEST, format!("manifest 解析失败: {e}")))?;
    blocking(&ctx, move |b| b.write_manifest(&m)).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn note_get(State(ctx): Ctx, headers: HeaderMap, Query(q): Query<PathQuery>) -> HResult {
    auth(&ctx, &headers)?;
    validate_rel_path(&q.path).map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
    match blocking(&ctx, move |b| b.get_note(&q.path)).await? {
        Some(text) => Ok(([(header::CONTENT_TYPE, "text/markdown; charset=utf-8")], text).into_response()),
        None => Err(err(StatusCode::NOT_FOUND, "not found")),
    }
}

async fn note_put(State(ctx): Ctx, headers: HeaderMap, Query(q): Query<PathQuery>, body: Bytes) -> HResult {
    auth_write(&ctx, &headers)?;
    validate_rel_path(&q.path).map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
    let text = String::from_utf8(body.to_vec()).map_err(|_| err(StatusCode::BAD_REQUEST, "笔记不是 UTF-8"))?;
    blocking(&ctx, move |b| b.put_note(&q.path, &text)).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn note_delete(State(ctx): Ctx, headers: HeaderMap, Query(q): Query<PathQuery>) -> HResult {
    auth_write(&ctx, &headers)?;
    validate_rel_path(&q.path).map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
    blocking(&ctx, move |b| b.delete_note(&q.path)).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn attachment_get(State(ctx): Ctx, headers: HeaderMap, Path(hash): Path<String>) -> HResult {
    auth(&ctx, &headers)?;
    validate_hash(&hash).map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
    match blocking(&ctx, move |b| b.get_attachment(&hash)).await? {
        Some(bytes) => Ok(([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response()),
        None => Err(err(StatusCode::NOT_FOUND, "not found")),
    }
}

async fn attachment_head(State(ctx): Ctx, headers: HeaderMap, Path(hash): Path<String>) -> HResult {
    auth(&ctx, &headers)?;
    validate_hash(&hash).map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
    if blocking(&ctx, move |b| b.has_attachment(&hash)).await? {
        Ok(StatusCode::OK.into_response())
    } else {
        Err(StatusCode::NOT_FOUND.into_response())
    }
}

async fn attachment_put(State(ctx): Ctx, headers: HeaderMap, Path(hash): Path<String>, body: Bytes) -> HResult {
    auth_write(&ctx, &headers)?;
    validate_hash(&hash).map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
    blocking(&ctx, move |b| b.put_attachment(&hash, &body)).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn attachments_list(State(ctx): Ctx, headers: HeaderMap) -> HResult {
    auth(&ctx, &headers)?;
    Ok(json(&blocking(&ctx, |b| b.list_attachment_hashes()).await?))
}

async fn root_files(State(ctx): Ctx, headers: HeaderMap) -> HResult {
    auth(&ctx, &headers)?;
    Ok(json(&blocking(&ctx, |b| b.list_root_files()).await?.unwrap_or_default()))
}

#[cfg(test)]
mod tests {
    //! 端到端：本机起服务，用手机端同一个 LanBackend 客户端连。
    //! 客户端内部用同步专用运行时 block_on，所以测试本身不能是 #[tokio::test]（嵌套运行时会 panic），
    //! 服务端跑在单独建的 tokio 运行时上。
    use super::*;
    use crate::models::SyncManifestV1;
    use crate::services::sync_v1::backend_lan::LanBackend;
    use crate::services::sync_v1::lan_protocol::cert_fingerprint;

    struct Fixture {
        _rt: tokio::runtime::Runtime,
        server: RunningLanServer,
        root: PathBuf,
        token: String,
        fingerprint: String,
        lease: VaultLease,
        wrote_calls: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.server.stop();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn fixture() -> Fixture {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let root = std::env::temp_dir().join(format!("kb-lan-test-{}", uuid::Uuid::new_v4().simple()));
        let identity = generate_identity().unwrap();
        let fingerprint = cert_fingerprint(&identity.cert_der);
        let token = crate::services::sync_v1::lan_protocol::random_token();
        let lease = VaultLease::new(Duration::from_secs(LEASE_TTL_SECS));
        let wrote_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let server = rt
            .block_on(start(StartParams {
                vault_root: root.join("vault"),
                bind: "127.0.0.1:0".parse().unwrap(),
                token: token.clone(),
                device_name: "测试电脑".into(),
                identity,
                lease: lease.clone(),
                on_client_wrote: Some(Arc::new({
                    let n = wrote_calls.clone();
                    move || {
                        n.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    }
                })),
            }))
            .unwrap();
        Fixture { _rt: rt, server, root, token, fingerprint, lease, wrote_calls }
    }

    /// 不等待的客户端：租约被占时立即报错，测互斥用
    fn client(f: &Fixture) -> LanBackend {
        let mut c = LanBackend::new(&format!("https://{}", f.server.addr), &f.token, &f.fingerprint).unwrap();
        c.set_busy_wait(Duration::ZERO);
        c.set_discover_timeout(Duration::ZERO);
        c
    }

    fn manifest() -> SyncManifestV1 {
        SyncManifestV1 {
            manifest_version: SyncManifestV1::VERSION,
            app_version: "test".into(),
            device: "phone".into(),
            generated_at: "2026-11-14 23:00:00".into(),
            entries: vec![],
            hash_algo: Some(SyncManifestV1::HASH_ALGO_V2.into()),
            vault: None,
            attachments: vec![],
            projects: vec![],
            tasks: vec![],
            task_categories: vec![],
            cards: vec![],
            card_review_logs: vec![],
            prompts: vec![],
            note_templates: vec![],
            folders: vec![],
        }
    }

    #[test]
    fn roundtrip_through_lan() {
        let f = fixture();
        let c = client(&f);
        c.test_connection().unwrap();
        assert_eq!(c.server_info().unwrap().device_name, "测试电脑");
        assert!(c.read_manifest().unwrap().is_none());

        c.begin_session().unwrap();
        c.write_manifest(&manifest()).unwrap();
        assert_eq!(c.read_manifest().unwrap().unwrap().device, "phone");

        c.put_note("notes/a.md", "# 标题\n\n正文").unwrap();
        assert_eq!(c.get_note("notes/a.md").unwrap().as_deref(), Some("# 标题\n\n正文"));
        assert!(c.get_note("notes/none.md").unwrap().is_none());
        c.delete_note("notes/a.md").unwrap();
        assert!(c.get_note("notes/a.md").unwrap().is_none());

        let hash = "ab".repeat(32);
        assert!(!c.has_attachment(&hash).unwrap());
        c.put_attachment(&hash, &[1, 2, 3]).unwrap();
        assert!(c.has_attachment(&hash).unwrap());
        assert_eq!(c.get_attachment(&hash).unwrap().unwrap(), vec![1, 2, 3]);
        assert_eq!(c.list_attachment_hashes().unwrap(), vec![hash.clone()]);
        assert!(c.list_root_files().unwrap().unwrap().contains(&"manifest.json".to_string()));
        c.end_session();

        // 落盘位置就是库目录（电脑端自己同步会读这里）
        assert!(f.root.join("vault").join("manifest.json").exists());
    }

    #[test]
    fn lease_is_automatic_and_exclusive() {
        let f = fixture();
        let a = client(&f);
        // 第一次写自动申请租约
        a.put_note("notes/a.md", "x").unwrap();
        // 另一台设备这时写不进来
        let b = client(&f);
        let e = b.put_note("notes/b.md", "y").unwrap_err().to_string();
        assert!(e.contains("电脑端正在同步"), "{e}");
        // 读不需要租约
        assert_eq!(b.get_note("notes/a.md").unwrap().as_deref(), Some("x"));
        assert_eq!(f.wrote_calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        // a 用完释放（Drop 归还）：写过 → 通知电脑合并一次；之后 b 能写
        drop(a);
        assert_eq!(f.wrote_calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        b.put_note("notes/b.md", "y").unwrap();
    }

    #[test]
    fn read_only_session_does_not_trigger_merge() {
        let f = fixture();
        let c = client(&f);
        assert!(c.read_manifest().unwrap().is_none()); // 读 manifest 也拿租约（push 先读后写）
        assert!(f.lease.try_acquire("desktop").is_none());
        drop(c);
        assert_eq!(f.wrote_calls.load(std::sync::atomic::Ordering::SeqCst), 0, "只读不触发合并");
        assert!(f.lease.try_acquire("desktop").is_some());
    }

    #[test]
    fn picks_reachable_host_from_candidates() {
        let f = fixture();
        let port = f.server.addr.port();
        // 第一个地址连不上（保留地址，不会有人应答），应退到第二个
        let c = LanBackend::with_hosts(
            &["192.0.2.1".into(), "127.0.0.1".into()],
            port,
            &f.token,
            &f.fingerprint,
        )
        .unwrap();
        c.test_connection().unwrap();
        assert!(LanBackend::with_hosts(&[], port, &f.token, &f.fingerprint).is_err());
    }

    /// 记下的地址失效（电脑换了 IP）：按指纹经 mDNS 找到电脑，连上并交出新地址供写回配置。
    /// 会在本机 UDP 5353 收发真实组播，Windows 首次运行可能弹防火墙询问，默认不跑。
    /// 手动验证：cargo test --lib lan_server::tests::rediscovers_moved_desktop -- --ignored
    #[test]
    #[ignore]
    fn rediscovers_moved_desktop() {
        let f = fixture();
        let port = f.server.addr.port();
        let _ad = crate::services::lan_discovery::advertise("测试电脑", &f.fingerprint, port).unwrap();
        let mut c = LanBackend::with_hosts(&["192.0.2.1".into()], port, &f.token, &f.fingerprint).unwrap();
        c.set_discover_timeout(Duration::from_secs(5));
        c.test_connection().unwrap();
        let hosts = c.take_discovered_hosts().expect("应交出新地址");
        assert!(hosts.iter().all(|h| h.ends_with(&format!(":{port}"))), "{hosts:?}");
        assert!(c.take_discovered_hosts().is_none(), "取走后清空");
    }

    #[test]
    fn lease_conflicts_with_desktop_sync() {
        let f = fixture();
        let c = client(&f);
        // 电脑端自己正在往库目录同步（进程内拿着同一把租约）
        let desktop = f.lease.try_acquire("desktop").unwrap();
        let e = c.begin_session().unwrap_err().to_string();
        assert!(e.contains("电脑端正在同步"), "{e}");
        f.lease.release(&desktop);
        c.begin_session().unwrap();
        // 手机持有期间，电脑端也拿不到
        assert!(f.lease.try_acquire("desktop").is_none());
        c.end_session();
        assert!(f.lease.try_acquire("desktop").is_some());
    }

    /// 真机复现：手机一键同步推完后电脑立刻拿租约合并，紧接着的拉取撞上 409。
    /// 默认客户端应等电脑合并完再继续，而不是直接报「电脑端正在同步」
    #[test]
    fn begin_session_waits_for_desktop_merge() {
        let f = fixture();
        let mut c = client(&f);
        c.set_busy_wait(Duration::from_secs(10));
        let desktop = f.lease.try_acquire("desktop").unwrap();
        let lease = f.lease.clone();
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1500));
            lease.release(&desktop);
        });
        let t = std::time::Instant::now();
        c.begin_session().unwrap();
        assert!(t.elapsed() >= Duration::from_millis(1000), "应等电脑释放后才拿到");
        releaser.join().unwrap();
        assert!(f.lease.try_acquire("desktop").is_none(), "手机已持有租约");
        c.end_session();
    }

    #[test]
    fn wrong_token_and_wrong_fingerprint_rejected() {
        let f = fixture();
        let bad_token = LanBackend::new(&format!("https://{}", f.server.addr), "nope", &f.fingerprint).unwrap();
        let e = bad_token.test_connection().unwrap_err().to_string();
        assert!(e.contains("配对已失效"), "{e}");

        // 冒充的电脑：证书指纹对不上，TLS 握手就失败，根本发不出带令牌的请求
        let other = cert_fingerprint(&generate_identity().unwrap().cert_der);
        let mut bad_fp = LanBackend::new(&format!("https://{}", f.server.addr), &f.token, &other).unwrap();
        // 连不上时本来会去 mDNS 找电脑；测试里不碰真实组播
        bad_fp.set_discover_timeout(Duration::ZERO);
        let e = bad_fp.test_connection().unwrap_err().to_string();
        assert!(e.contains("连不上电脑端"), "{e}");
    }

    #[test]
    fn path_escape_rejected() {
        let f = fixture();
        let c = client(&f);
        c.begin_session().unwrap();
        for bad in ["../escape.md", "notes/../../escape.md", "C:/escape.md"] {
            let e = c.put_note(bad, "x").unwrap_err().to_string();
            assert!(e.contains("400"), "{bad}: {e}");
        }
        assert!(c.get_attachment("../../etc").is_err());
        assert!(!f.root.join("escape.md").exists());
        c.end_session();
    }

    #[test]
    fn restart_on_same_port_after_shutdown() {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let root = std::env::temp_dir().join(format!("kb-lan-restart-{}", uuid::Uuid::new_v4().simple()));
        let params = |bind: SocketAddr| StartParams {
            vault_root: root.clone(),
            bind,
            token: "t".into(),
            device_name: "x".into(),
            identity: generate_identity().unwrap(),
            lease: VaultLease::new(Duration::from_secs(5)),
            on_client_wrote: None,
        };
        let first = rt.block_on(start(params("127.0.0.1:0".parse().unwrap()))).unwrap();
        let addr = first.addr;
        rt.block_on(first.shutdown());
        // 停完立刻在同一端口再起：重新生成配对码就是这么做的
        let second = rt.block_on(start(params(addr))).expect("同一端口应能马上重启");
        rt.block_on(second.shutdown());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn lease_expires_without_renewal() {
        let lease = VaultLease::new(Duration::from_millis(50));
        let a = lease.try_acquire("phone").unwrap();
        assert!(lease.try_acquire("desktop").is_none());
        assert!(lease.check_and_touch(&a));
        std::thread::sleep(Duration::from_millis(80));
        assert!(!lease.check_and_touch(&a), "过期后不能再续");
        assert!(lease.try_acquire("desktop").is_some(), "过期后别人能拿到");
        assert!(!lease.release(&a), "旧 id 释放不动新租约");
        assert!(lease.try_acquire("x").is_none());
    }
}
