//! 局域网同步的 mDNS 自动发现（电脑端广播，手机端查找；见 docs/tasks/lan-sync-tasks.md）。
//!
//! 为什么要：配对二维码里的地址是当时的 IP，电脑换了 Wi-Fi / DHCP 重新分配后就连不上了。
//! 电脑开着局域网同步时在 `_kb-lan._tcp` 下广播自己，TXT 里带证书指纹；
//! 手机连不上记下的地址时按配对时的指纹去找，拿到电脑当前的地址（同一局域网里多台电脑也不会认错）。
//!
//! 广播 / 查找失败都不影响同步本身（只是换 IP 后要重新扫码），调用方只记日志。

use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};

#[cfg(desktop)]
use mdns_sd::ServiceInfo;
use mdns_sd::{ServiceDaemon, ServiceEvent};

use crate::error::AppError;

pub const SERVICE_TYPE: &str = "_kb-lan._tcp.local.";

/// 指纹去掉冒号、转小写（64 位十六进制），放进 TXT 和比较都用这个形式
pub fn fp_compact(fingerprint: &str) -> String {
    fingerprint.replace(':', "").to_ascii_lowercase()
}

/// TXT 里的指纹是否就是配对时那台电脑
pub fn fp_matches(txt_fp: Option<&str>, expected_fingerprint: &str) -> bool {
    txt_fp.is_some_and(|t| t.eq_ignore_ascii_case(&fp_compact(expected_fingerprint)))
}

/// 实例名：设备名 + 指纹前 8 位（同名电脑也能区分）。DNS 标签上限 63 字节，中文设备名按字符截断
#[cfg(any(desktop, test))]
pub fn instance_name(device_name: &str, fingerprint: &str) -> String {
    let short = &fp_compact(fingerprint)[..8.min(fp_compact(fingerprint).len())];
    let mut name = String::new();
    for ch in device_name.chars().filter(|c| !c.is_control() && *c != '.') {
        if name.len() + ch.len_utf8() > 40 {
            break;
        }
        name.push(ch);
    }
    if name.trim().is_empty() {
        name = "知识库".into();
    }
    format!("{name} ({short})")
}

/// 正在广播的服务；Drop 时注销并关掉 mDNS 守护线程
#[cfg(desktop)]
pub struct Advertiser {
    daemon: ServiceDaemon,
    fullname: String,
}

#[cfg(desktop)]
impl Drop for Advertiser {
    fn drop(&mut self) {
        let _ = self.daemon.unregister(&self.fullname);
        let _ = self.daemon.shutdown();
    }
}

#[cfg(desktop)]
pub fn advertise(device_name: &str, fingerprint: &str, port: u16) -> Result<Advertiser, AppError> {
    let daemon = ServiceDaemon::new().map_err(|e| AppError::Custom(format!("mDNS 启动失败: {e}")))?;
    let fp = fp_compact(fingerprint);
    let host = format!("kb-{}.local.", &fp[..8.min(fp.len())]);
    let props = [("fp", fp.as_str()), ("v", "1")];
    let info = ServiceInfo::new(SERVICE_TYPE, &instance_name(device_name, fingerprint), &host, "", port, &props[..])
        .map_err(|e| AppError::Custom(format!("mDNS 服务信息无效: {e}")))?
        // 地址交给 mdns-sd 按网卡自动填：多网卡时每块网卡上都用它自己的地址回应
        .enable_addr_auto();
    let fullname = info.get_fullname().to_string();
    daemon.register(info).map_err(|e| AppError::Custom(format!("mDNS 广播失败: {e}")))?;
    log::info!("[lan-sync] mDNS 广播 {fullname}");
    Ok(Advertiser { daemon, fullname })
}

/// 在局域网里找指纹匹配的电脑，返回它当前的地址（只取 IPv4、已排序）。超时没找到返回空
pub fn discover(fingerprint: &str, timeout: Duration) -> Result<Vec<SocketAddr>, AppError> {
    // Android 的 Wi-Fi 默认丢弃组播包，不拿 MulticastLock 收不到电脑的回应；查找期间持有，返回时释放
    #[cfg(target_os = "android")]
    let _lock = multicast_lock::MulticastLock::acquire()?;
    let daemon = ServiceDaemon::new().map_err(|e| AppError::Custom(format!("mDNS 启动失败: {e}")))?;
    let rx = daemon.browse(SERVICE_TYPE).map_err(|e| AppError::Custom(format!("mDNS 查找失败: {e}")))?;
    let deadline = Instant::now() + timeout;
    let mut found = Vec::new();
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        let Ok(ev) = rx.recv_timeout(left) else { break };
        if let ServiceEvent::ServiceResolved(svc) = ev {
            if !fp_matches(svc.get_property_val_str("fp"), fingerprint) {
                continue;
            }
            let port = svc.get_port();
            let mut addrs: Vec<SocketAddr> =
                svc.get_addresses_v4().into_iter().map(|ip| SocketAddr::new(IpAddr::V4(ip), port)).collect();
            addrs.sort();
            found = addrs;
            break;
        }
    }
    let _ = daemon.stop_browse(SERVICE_TYPE);
    let _ = daemon.shutdown();
    Ok(found)
}

/// Android Wi-Fi 组播锁，调 `com.agilefr.kb.MulticastHelper`（Kotlin 侧引用计数，并发查找各拿各放）
#[cfg(target_os = "android")]
mod multicast_lock {
    use crate::error::AppError;
    use crate::services::android_jni::{load_app_class, vm_and_context};
    use jni::objects::{JObject, JString, JValue};

    const CLASS: &str = "com.agilefr.kb.MulticastHelper";

    pub struct MulticastLock;

    impl MulticastLock {
        pub fn acquire() -> Result<Self, AppError> {
            let (vm, context_ptr) = vm_and_context().map_err(AppError::Custom)?;
            let mut env = vm.attach_current_thread().map_err(|e| AppError::Custom(format!("attach JNI 线程失败: {e}")))?;
            let context = unsafe { JObject::from_raw(context_ptr.cast()) };
            let class = load_app_class(&mut env, &context, CLASS).map_err(AppError::Custom)?;
            let ret = env
                .call_static_method(&class, "acquire", "(Landroid/content/Context;)Ljava/lang/String;", &[JValue::Object(&context)])
                .and_then(|v| v.l())
                .map_err(|e| AppError::Custom(format!("申请组播锁失败: {e}")))?;
            let err: String = env
                .get_string(&JString::from(ret))
                .map_err(|e| AppError::Custom(format!("读取组播锁结果失败: {e}")))?
                .into();
            if err.is_empty() {
                Ok(Self)
            } else {
                Err(AppError::Custom(format!("申请组播锁失败: {err}")))
            }
        }
    }

    impl Drop for MulticastLock {
        fn drop(&mut self) {
            let release = || -> Result<(), String> {
                let (vm, context_ptr) = vm_and_context()?;
                let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
                let context = unsafe { JObject::from_raw(context_ptr.cast()) };
                let class = load_app_class(&mut env, &context, CLASS)?;
                env.call_static_method(&class, "release", "()V", &[]).map_err(|e| e.to_string())?;
                Ok(())
            };
            if let Err(e) = release() {
                log::warn!("[lan-sync] 释放组播锁失败: {e}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FP: &str = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";

    #[test]
    fn fingerprint_matching_ignores_colons_and_case() {
        let compact = fp_compact(FP);
        assert_eq!(compact.len(), 64);
        assert!(fp_matches(Some(&compact), FP));
        assert!(fp_matches(Some(&compact.to_uppercase()), FP));
        assert!(!fp_matches(Some("deadbeef"), FP));
        assert!(!fp_matches(None, FP));
    }

    #[test]
    fn instance_name_is_short_and_distinct() {
        assert_eq!(instance_name("DESKTOP-01", FP), "DESKTOP-01 (abcdef01)");
        let long = instance_name(&"很长的电脑名".repeat(20), FP);
        assert!(long.len() <= 63, "{} 字节", long.len());
        assert!(long.ends_with("(abcdef01)"));
        assert_eq!(instance_name("..", FP), "知识库 (abcdef01)");
    }

    /// 真实组播收发：会在本机 UDP 5353 上监听，Windows 首次运行可能弹防火墙询问，
    /// 所以默认不跑。手动验证：cargo test --lib lan_discovery -- --ignored
    #[test]
    #[ignore]
    fn advertise_then_discover_on_this_machine() {
        let _ad = advertise("测试电脑", FP, 47999).unwrap();
        let addrs = discover(FP, Duration::from_secs(5)).unwrap();
        assert!(!addrs.is_empty(), "5 秒内没找到自己广播的服务");
        assert!(addrs.iter().all(|a| a.port() == 47999));
        // 指纹不对的找不到
        let other = FP.replace("AB", "00");
        assert!(discover(&other, Duration::from_secs(2)).unwrap().is_empty());
    }
}
