//! 局域网同步（电脑端编排，仅桌面）：开关 / 配对 / 本机中转同步源 / 租约。
//!
//! 整体方案见 docs/tasks/lan-sync-tasks.md。电脑端做两件事：
//! 1. 「本机中转」同步源：一个指向 `<数据目录>/lan-vault` 的普通「本地目录」同步源，
//!    电脑照常把笔记同步进去（同步列表里看得到，自动同步默认开）
//! 2. 局域网服务（lan_server）：把同一个目录按同步接口暴露给手机
//!
//! 两边写同一个目录，靠 [`LanSyncState::lease`] 互斥：手机写之前经网络申请，
//! 电脑同步这个中转源之前在进程内申请（见 [`acquire_host_lease`]）。
//!
//! 配置都存在 app_config：证书 / 令牌换了，已配对的手机就要重新扫码。

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use tokio::sync::Mutex;

use crate::database::Database;
use crate::error::AppError;
use crate::models::{SyncBackendInput, SyncBackendKind};
use crate::services::lan_server::{self, LanIdentity, RunningLanServer, VaultLease};
use crate::services::sync_v1::lan_protocol::{cert_fingerprint, LEASE_TTL_SECS};

pub const KEY_ENABLED: &str = "lan_sync.enabled";
pub const KEY_PORT: &str = "lan_sync.port";
pub const KEY_TOKEN: &str = "lan_sync.token";
pub const KEY_CERT: &str = "lan_sync.cert_der";
pub const KEY_KEY: &str = "lan_sync.key_der";
pub const KEY_BACKEND_ID: &str = "lan_sync.backend_id";

/// 默认端口：避开常见开发端口；被占用时用户可在设置里改
pub const DEFAULT_PORT: u16 = 47321;

/// 中转库目录名（在数据目录下）
const VAULT_DIR: &str = "lan-vault";

/// 电脑同步中转源时，手机正拿着租约的话最多等多久
const HOST_LEASE_WAIT: Duration = Duration::from_secs(30);

/// 局域网同步运行时状态（放在 AppState 里）
pub struct LanSyncState {
    server: Mutex<Option<RunningLanServer>>,
    /// mDNS 广播（和服务同生命周期；广播失败不影响服务，这里就是 None）
    advertiser: Mutex<Option<crate::services::lan_discovery::Advertiser>>,
    /// 中转库目录的写租约：服务端和电脑端同步共用这一把
    pub lease: VaultLease,
}

impl Default for LanSyncState {
    fn default() -> Self {
        Self {
            server: Mutex::new(None),
            advertiser: Mutex::new(None),
            lease: VaultLease::new(Duration::from_secs(LEASE_TTL_SECS)),
        }
    }
}

/// 给前端的状态
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanSyncStatus {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    /// 本机局域网地址（手机连这些）
    pub hosts: Vec<String>,
    pub device_name: String,
    /// 证书指纹，用户可与手机上显示的核对
    pub fingerprint: Option<String>,
    /// 「本机中转」同步源 id
    pub backend_id: Option<i64>,
}

fn get(db: &Database, key: &str) -> String {
    db.get_config(key).ok().flatten().unwrap_or_default()
}

pub fn vault_root(data_dir: &Path) -> PathBuf {
    data_dir.join(VAULT_DIR)
}

pub fn device_name() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "我的电脑".into())
}

pub fn port(db: &Database) -> u16 {
    get(db, KEY_PORT).parse().unwrap_or(DEFAULT_PORT)
}

/// 取证书身份，没有就生成并持久化（换证书 = 所有手机要重新配对，所以只在缺失时生成）
fn ensure_identity(db: &Database) -> Result<LanIdentity, AppError> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let (cert, key) = (get(db, KEY_CERT), get(db, KEY_KEY));
    if !cert.is_empty() && !key.is_empty() {
        if let (Ok(cert_der), Ok(key_der)) = (b64.decode(&cert), b64.decode(&key)) {
            return Ok(LanIdentity { cert_der, key_der });
        }
        log::warn!("[lan-sync] 存的证书解码失败，重新生成（已配对的手机需重新扫码）");
    }
    let id = lan_server::generate_identity()?;
    db.set_config(KEY_CERT, &b64.encode(&id.cert_der))?;
    db.set_config(KEY_KEY, &b64.encode(&id.key_der))?;
    Ok(id)
}

fn ensure_token(db: &Database) -> Result<String, AppError> {
    let t = get(db, KEY_TOKEN);
    if !t.trim().is_empty() {
        return Ok(t);
    }
    let t = crate::services::mcp_http::generate_token();
    db.set_config(KEY_TOKEN, &t)?;
    Ok(t)
}

/// 「本机中转」同步源 id（只读，不创建）。供同步流程判断要不要拿租约
pub fn host_backend_id(db: &Database) -> Option<i64> {
    get(db, KEY_BACKEND_ID).parse().ok()
}

/// 确保「本机中转」同步源存在：用户删了就重建，指向的目录不对就不动它（用户自己改的尊重用户）
fn ensure_host_backend(db: &Database, vault: &Path) -> Result<i64, AppError> {
    if let Some(id) = host_backend_id(db) {
        if db.get_sync_backend(id)?.is_some() {
            return Ok(id);
        }
    }
    let path = vault.to_str().ok_or_else(|| AppError::Custom("数据目录路径不是 UTF-8".into()))?;
    let id = db.create_sync_backend(&SyncBackendInput {
        kind: SyncBackendKind::Local,
        name: "局域网同步（本机中转）".into(),
        config_json: serde_json::json!({ "path": path }).to_string(),
        enabled: Some(true),
        // 默认自动同步：电脑上的改动定时进中转库，手机连上就能拉到
        auto_sync: Some(true),
        sync_interval_min: Some(5),
    })?;
    db.set_config(KEY_BACKEND_ID, &id.to_string())?;
    Ok(id)
}

impl LanSyncState {
    /// 按库里的配置起服务（已在跑就先停）。开关 / 自动启动 / 重置令牌后都走这里
    pub async fn start(&self, db: &Database, data_dir: &Path) -> Result<(), AppError> {
        self.stop().await;
        let vault = vault_root(data_dir);
        ensure_host_backend(db, &vault)?;
        let identity = ensure_identity(db)?;
        let fingerprint = cert_fingerprint(&identity.cert_der);
        let params = lan_server::StartParams {
            vault_root: vault,
            // 监听所有网卡：手机从局域网连进来。首次监听 Windows 会弹防火墙询问，需用户允许
            bind: ([0, 0, 0, 0], port(db)).into(),
            token: ensure_token(db)?,
            device_name: device_name(),
            identity,
            lease: self.lease.clone(),
        };
        let running = lan_server::start(params).await?;
        let bound_port = running.addr.port();
        *self.server.lock().await = Some(running);

        // 广播本机，手机换 IP 后按指纹找回来；失败只记日志（服务照常可用，换 IP 后重新扫码即可）
        match crate::services::lan_discovery::advertise(&device_name(), &fingerprint, bound_port) {
            Ok(a) => *self.advertiser.lock().await = Some(a),
            Err(e) => log::warn!("[lan-sync] mDNS 广播失败（不影响同步）: {e}"),
        }
        Ok(())
    }

    pub async fn stop(&self) {
        // 先停广播再停服务：别让手机找到一个已经关掉的地址
        self.advertiser.lock().await.take();
        if let Some(s) = self.server.lock().await.take() {
            s.stop();
        }
    }

    pub async fn status(&self, db: &Database) -> LanSyncStatus {
        // 在跑就报实际监听的端口（改了配置还没重启时，以正在用的为准）
        let running_port = self.server.lock().await.as_ref().map(|s| s.addr.port());
        let running = running_port.is_some();
        let fingerprint = base64::engine::general_purpose::STANDARD
            .decode(get(db, KEY_CERT))
            .ok()
            .filter(|d| !d.is_empty())
            .map(|d| cert_fingerprint(&d));
        LanSyncStatus {
            enabled: get(db, KEY_ENABLED) == "1",
            running,
            port: running_port.unwrap_or_else(|| port(db)),
            hosts: lan_ipv4_hosts(),
            device_name: device_name(),
            fingerprint,
            backend_id: host_backend_id(db),
        }
    }
}

/// 配对二维码内容（手机扫码后保存）。含令牌 —— 只在界面上显示给用户扫，不写日志
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct PairingPayload {
    /// 固定 "kb-lan"，手机端据此认出是配对码
    pub t: String,
    pub v: u32,
    pub name: String,
    pub hosts: Vec<String>,
    pub port: u16,
    pub fp: String,
    pub token: String,
}

pub fn pairing_payload(db: &Database) -> Result<String, AppError> {
    let id = ensure_identity(db)?;
    let p = PairingPayload {
        t: "kb-lan".into(),
        v: 1,
        name: device_name(),
        hosts: lan_ipv4_hosts(),
        port: port(db),
        fp: cert_fingerprint(&id.cert_der),
        token: ensure_token(db)?,
    };
    serde_json::to_string(&p).map_err(|e| AppError::Custom(e.to_string()))
}

/// 换令牌：所有已配对设备立即失效（服务在跑的话调用方要重启服务才生效）
pub fn reset_token(db: &Database) -> Result<(), AppError> {
    db.set_config(KEY_TOKEN, &crate::services::mcp_http::generate_token())?;
    Ok(())
}

/// 本机所有可用于局域网的 IPv4（配对二维码里带上，手机挨个试）。
/// 多网卡 / VPN 时不止一个：默认路由那块网卡排第一（最可能和手机同网），其余私网地址随后
pub fn lan_ipv4_hosts() -> Vec<String> {
    let all: Vec<std::net::Ipv4Addr> = if_addrs::get_if_addrs()
        .map(|ifs| {
            ifs.into_iter()
                .filter_map(|i| match i.ip() {
                    std::net::IpAddr::V4(v4) => Some(v4),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    order_hosts(default_route_ipv4(), all)
}

/// 出口网卡地址：UDP connect 到公网地址只选路、不真的发包，断网时只要有默认路由也能拿到
fn default_route_ipv4() -> Option<std::net::Ipv4Addr> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("223.5.5.5:53").ok()?;
    match sock.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(v4) => Some(v4),
        _ => None,
    }
}

/// 过滤并排序：只留私网地址（10/8、172.16/12、192.168/16），去掉回环 / 169.254 自动地址；
/// 默认路由地址排第一，其余按地址排序去重
fn order_hosts(default: Option<std::net::Ipv4Addr>, all: Vec<std::net::Ipv4Addr>) -> Vec<String> {
    let mut v: Vec<std::net::Ipv4Addr> = all.into_iter().filter(|ip| ip.is_private()).collect();
    v.sort();
    v.dedup();
    if let Some(d) = default.filter(|d| d.is_private()) {
        v.retain(|ip| *ip != d);
        v.insert(0, d);
    }
    v.into_iter().map(|ip| ip.to_string()).collect()
}

/// 电脑同步「本机中转」源时持有的租约；Drop 自动释放
pub struct HostLeaseGuard {
    lease: VaultLease,
    id: String,
}

impl Drop for HostLeaseGuard {
    fn drop(&mut self) {
        self.lease.release(&self.id);
    }
}

/// 同步某个同步源前调用：是「本机中转」源就拿租约（手机正在同步则最多等 30 秒），否则返回 None。
/// 在阻塞线程里调用（同步流程本身就跑在 spawn_blocking 里）
pub fn acquire_host_lease(
    state: &LanSyncState,
    db: &Database,
    backend_id: i64,
) -> Result<Option<HostLeaseGuard>, String> {
    if host_backend_id(db) != Some(backend_id) {
        return Ok(None);
    }
    let deadline = std::time::Instant::now() + HOST_LEASE_WAIT;
    loop {
        if let Some(id) = state.lease.try_acquire("desktop") {
            return Ok(Some(HostLeaseGuard { lease: state.lease.clone(), id }));
        }
        if std::time::Instant::now() >= deadline {
            return Err("手机正在通过局域网同步，稍后会自动重试".into());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Database {
        Database::init(":memory:").unwrap()
    }

    #[test]
    fn hosts_keep_private_lan_only_with_default_route_first() {
        let ip = |s: &str| s.parse::<std::net::Ipv4Addr>().unwrap();
        let all = vec![
            ip("127.0.0.1"),
            ip("169.254.3.4"),
            ip("192.168.1.23"),
            ip("10.8.0.2"),
            ip("8.8.8.8"),
            ip("172.20.1.5"),
            ip("192.168.1.23"),
        ];
        assert_eq!(
            order_hosts(Some(ip("192.168.1.23")), all.clone()),
            vec!["192.168.1.23", "10.8.0.2", "172.20.1.5"]
        );
        // 默认路由不是私网地址（比如直接拨号拿到公网 IP）就不放进来
        assert_eq!(order_hosts(Some(ip("8.8.8.8")), all), vec!["10.8.0.2", "172.20.1.5", "192.168.1.23"]);
        assert!(order_hosts(None, vec![ip("127.0.0.1")]).is_empty());
    }

    #[test]
    fn identity_and_token_are_stable_until_reset() {
        let db = db();
        let a = ensure_identity(&db).unwrap();
        let b = ensure_identity(&db).unwrap();
        assert_eq!(a.cert_der, b.cert_der, "已有证书不能每次重新生成，否则手机要反复配对");
        let t1 = ensure_token(&db).unwrap();
        assert_eq!(t1, ensure_token(&db).unwrap());
        reset_token(&db).unwrap();
        assert_ne!(t1, ensure_token(&db).unwrap());
    }

    #[test]
    fn host_backend_created_once_and_recreated_if_deleted() {
        let db = db();
        let vault = std::env::temp_dir().join("kb-lan-vault-test");
        let id = ensure_host_backend(&db, &vault).unwrap();
        assert_eq!(ensure_host_backend(&db, &vault).unwrap(), id);
        let b = db.get_sync_backend(id).unwrap().unwrap();
        assert!(b.auto_sync);
        db.delete_sync_backend(id).unwrap();
        let id2 = ensure_host_backend(&db, &vault).unwrap();
        assert_ne!(id, id2);
    }

    #[test]
    fn pairing_payload_has_everything_phone_needs() {
        let db = db();
        let p: PairingPayload = serde_json::from_str(&pairing_payload(&db).unwrap()).unwrap();
        assert_eq!(p.t, "kb-lan");
        assert_eq!(p.port, DEFAULT_PORT);
        assert_eq!(p.fp.split(':').count(), 32);
        assert_eq!(p.token, ensure_token(&db).unwrap());
    }

    #[test]
    fn host_lease_only_for_host_backend_and_waits_out_phone() {
        let db = db();
        let state = LanSyncState::default();
        let id = ensure_host_backend(&db, &std::env::temp_dir().join("kb-lan-vault-test2")).unwrap();
        assert!(acquire_host_lease(&state, &db, id + 100).unwrap().is_none(), "别的同步源不拿租约");
        {
            let g = acquire_host_lease(&state, &db, id).unwrap();
            assert!(g.is_some());
            assert!(state.lease.try_acquire("phone").is_none(), "电脑同步期间手机拿不到");
        }
        assert!(state.lease.try_acquire("phone").is_some(), "守卫释放后可用");
    }
}
