//! 移动端"检查更新"（仅 Android/iOS 编译）。
//!
//! 桌面端用 `tauri-plugin-updater` 自动下载+原地替换，但该插件不支持移动端，
//! 且本项目已用 `#[cfg(desktop)]` 把 updater 隔离掉了。移动端没有"原地热替换"
//! 的能力（Android 必须走系统安装器、iOS 必须走 App Store），所以这里只做：
//!
//!   1. 拉移动端独立的 `update-mobile.json`（**不是**桌面那份 `update.json`——
//!      移动端有自己的版本线，从 0.1.0 起，跟桌面 1.x 解耦）
//!   2. 比对 `version` 字段与当前 App 版本（Android 的版本号来自
//!      `tauri.android.conf.json` 的 `version`，会被编译进 `package_info()`）
//!   3. 返回是否有新版本 + 更新说明 + APK 下载 URL
//!
//! 前端拿到结果后弹个对话框，用户点"去下载"就用 `tauri-plugin-opener` 打开
//! APK URL —— 浏览器接管下载，下载完用户点一下，系统安装器接手（首次会引导用户
//! 开"允许安装未知应用"，那是浏览器的权限不是本 App 的，所以 manifest 不用加
//! `REQUEST_INSTALL_PACKAGES`）。
//!
//! `update-mobile.json` schema（扁平结构，只服务 Android）：
//! ```json
//! {
//!   "version": "0.1.0",
//!   "notes": "更新说明",
//!   "pub_date": "2026-...",
//!   "url": "https://.../Knowledge.Base_0.1.0_android-arm64.apk"
//! }
//! ```
//! 兼容兜底：也认旧的 `platforms.android-arm64.url` 嵌套写法；都没有则回落到
//! release 仓库的发布页让用户自己挑。

use serde::Serialize;

/// 移动端独立更新源，按顺序尝试，第一个能拿到合法 JSON 的就用（R2 主 / GitHub / Gitee 兜底）。
/// 跟桌面 `tauri.conf.json` → `plugins.updater.endpoints`（那是 `update.json`）是两套。
const UPDATE_JSON_ENDPOINTS: &[&str] = &[
    "https://pub-9d9e6c0cb6934fb0a0c505e3c64f39b2.r2.dev/knowledge-base/update-mobile.json",
    "https://gitee.com/bkywksj/knowledge-base-release/raw/master/update-mobile.json",
    "https://github.com/bkywksj/knowledge-base-release/raw/main/update-mobile.json",
];

/// 当 `update-mobile.json` 里没有可用的 APK URL 时，回落到 release 仓库的发布页，
/// 让用户自己挑 APK。
const RELEASE_PAGE_FALLBACK: &str = "https://gitee.com/bkywksj/knowledge-base-release/releases";

#[derive(Debug, Serialize)]
pub struct MobileUpdateInfo {
    pub has_update: bool,
    pub current_version: String,
    pub latest_version: String,
    pub notes: String,
    /// APK 直链（优先）或 release 发布页（回落）
    pub download_url: String,
}

/// 简单版本号比较：把 "1.8.1" 拆成 [1,8,1] 逐段比，b > a 返回 true。
/// 非数字段当 0；段数不同短的补 0。够用了（本项目版本号一直是纯数字三段）。
fn is_newer(latest: &str, current: &str) -> bool {
    let parse = |s: &str| -> Vec<u32> {
        s.trim_start_matches('v')
            .split('.')
            .map(|p| p.trim().parse::<u32>().unwrap_or(0))
            .collect()
    };
    let (a, b) = (parse(current), parse(latest));
    let n = a.len().max(b.len());
    for i in 0..n {
        let ai = a.get(i).copied().unwrap_or(0);
        let bi = b.get(i).copied().unwrap_or(0);
        if bi != ai {
            return bi > ai;
        }
    }
    false
}

/// 拉一个 endpoint 的 update.json，解析失败 / 网络失败都返回 None（让上层试下一个）。
async fn fetch_update_json(url: &str) -> Option<serde_json::Value> {
    let resp = reqwest::Client::new()
        .get(url)
        .header("User-Agent", "knowledge-base-mobile")
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<serde_json::Value>().await.ok()
}

#[tauri::command]
pub async fn check_mobile_update(app: tauri::AppHandle) -> Result<MobileUpdateInfo, String> {
    let current_version = app.package_info().version.to_string();

    // 依次尝试 3 个 endpoint
    let mut json: Option<serde_json::Value> = None;
    for ep in UPDATE_JSON_ENDPOINTS {
        if let Some(v) = fetch_update_json(ep).await {
            json = Some(v);
            break;
        }
    }
    let json = json.ok_or_else(|| "无法连接更新服务器（3 个源都失败），请检查网络".to_string())?;

    let latest_version = json
        .get("version")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "update-mobile.json 缺少 version 字段".to_string())?
        .to_string();
    let notes = json
        .get("notes")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // APK 直链：优先顶层 `url`（新版扁平结构）；兼容旧的 `platforms.android-arm64.url`
    // 嵌套写法；都没有则回落到 release 发布页让用户自己挑。
    let download_url = json
        .get("url")
        .and_then(|u| u.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            json.get("platforms")
                .and_then(|p| {
                    p.get("android-arm64")
                        .or_else(|| p.get("android-aarch64"))
                        .or_else(|| p.get("android"))
                })
                .and_then(|entry| entry.get("url"))
                .and_then(|u| u.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| RELEASE_PAGE_FALLBACK.to_string());

    Ok(MobileUpdateInfo {
        has_update: is_newer(&latest_version, &current_version),
        current_version,
        latest_version,
        notes,
        download_url,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// App 内下载 + 安装（Android）
// ─────────────────────────────────────────────────────────────────────────────

/// 下载进度事件名（前端 listen 这个）
pub const EVENT_DOWNLOAD_PROGRESS: &str = "mobile-update://download-progress";

/// 进度快照，每 ~300ms 或每 512KB 推一次（不是每个 chunk 都推，否则 IPC 被刷爆）
#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    /// 已下载字节
    pub downloaded: u64,
    /// 总字节（服务端没给 Content-Length 时为 0，前端据此显示不确定进度）
    pub total: u64,
    /// 0-100，total 为 0 时恒为 0
    pub percent: u8,
}

/// 下载 APK 到应用 cache 目录，返回落盘的绝对路径。
///
/// 与桌面 `tauri-plugin-updater` 的差别：不做 minisign 验签 —— Android 的包管理器
/// 会用 APK 自身的 v2/v3 签名校验，且必须与已安装版本同一个 keystore 才让装，
/// 这层保护比 minisign 更强（minisign 只能证明"文件没被篡改"，APK 签名还能证明
/// "确实出自同一开发者"）。
///
/// 🔴 落盘位置必须在 FileProvider 的 `file_paths.xml` 声明范围内，否则
/// `FileProvider.getUriForFile` 会抛 IllegalArgumentException。当前 file_paths.xml
/// 有 `<cache-path name="my_cache_images" path="." />`，即整个 cacheDir 都可用。
#[tauri::command]
pub async fn download_mobile_update(
    app: tauri::AppHandle,
    url: String,
    version: String,
) -> Result<String, String> {
    use futures::StreamExt;
    use tauri::{Emitter, Manager};
    use tokio::io::AsyncWriteExt;

    // 只收 http(s)，挡掉 file:// 之类的本地路径注入
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(format!("非法的下载地址: {url}"));
    }

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("取 cache 目录失败: {e}"))?;
    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("建 cache 目录失败: {e}"))?;

    let file_name = format!("Knowledge.Base_{version}_android-arm64.apk");
    let dest = cache_dir.join(&file_name);
    let part = cache_dir.join(format!("{file_name}.part"));

    // 清掉同目录下别的版本残留（换版本时旧 .part / 旧 apk 白占空间）
    if let Ok(entries) = std::fs::read_dir(&cache_dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p == dest || p == part {
                continue;
            }
            let name = e.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("Knowledge.Base_") && (name.ends_with(".apk") || name.ends_with(".part")) {
                let _ = std::fs::remove_file(&p);
            }
        }
    }

    // 已经下好过同一版就直接复用（用户点了"更新"但上次装到一半退出的场景）
    if dest.exists() {
        if let Ok(meta) = std::fs::metadata(&dest) {
            if meta.len() > 0 {
                return Ok(dest.to_string_lossy().into_owned());
            }
        }
        let _ = std::fs::remove_file(&dest);
    }

    // 断点续传：.part 已有多少字节就从那儿接着要
    let resume_from = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(1800))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let mut req = client.get(&url).header("User-Agent", "knowledge-base-mobile");
    if resume_from > 0 {
        req = req.header("Range", format!("bytes={resume_from}-"));
    }
    let resp = req.send().await.map_err(|e| format!("下载请求失败: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("下载失败，服务端返回 {status}"));
    }
    // 服务端认不认 Range 决定了是续传还是重头来（206 = 认，200 = 不认）
    let resumed = status.as_u16() == 206 && resume_from > 0;
    let total = resp
        .content_length()
        .map(|len| if resumed { len + resume_from } else { len })
        .unwrap_or(0);

    let mut file = if resumed {
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(&part)
            .await
            .map_err(|e| format!("打开续传文件失败: {e}"))?
    } else {
        tokio::fs::File::create(&part)
            .await
            .map_err(|e| format!("创建下载文件失败: {e}"))?
    };

    let mut downloaded = if resumed { resume_from } else { 0 };
    let mut stream = resp.bytes_stream();
    // 节流：满 300ms 或攒够 512KB 才推一次进度，避免 IPC 被 chunk 刷爆
    let mut last_emit = std::time::Instant::now();
    let mut last_emit_bytes = downloaded;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入失败: {e}"))?;
        downloaded += chunk.len() as u64;

        if last_emit.elapsed() >= std::time::Duration::from_millis(300)
            || downloaded - last_emit_bytes >= 512 * 1024
        {
            let percent = if total > 0 {
                ((downloaded as f64 / total as f64) * 100.0).min(100.0) as u8
            } else {
                0
            };
            let _ = app.emit(
                EVENT_DOWNLOAD_PROGRESS,
                DownloadProgress {
                    downloaded,
                    total,
                    percent,
                },
            );
            last_emit = std::time::Instant::now();
            last_emit_bytes = downloaded;
        }
    }

    file.flush().await.map_err(|e| format!("刷盘失败: {e}"))?;
    drop(file);

    // 服务端给了长度就校验完整性——截断的 APK 装上去只会在安装器里报"解析失败"，
    // 不如在这里就告诉用户重试
    if total > 0 && downloaded != total {
        let _ = std::fs::remove_file(&part);
        return Err(format!("下载不完整（{downloaded}/{total} 字节），请重试"));
    }

    std::fs::rename(&part, &dest).map_err(|e| format!("重命名失败: {e}"))?;

    // 收尾补一帧 100%，免得最后一个 chunk 没触发节流导致进度条停在 99%
    let _ = app.emit(
        EVENT_DOWNLOAD_PROGRESS,
        DownloadProgress {
            downloaded,
            total: if total > 0 { total } else { downloaded },
            percent: 100,
        },
    );

    Ok(dest.to_string_lossy().into_owned())
}

/// Android JNI 桥：调 `com.agilefr.kb.ApkInstaller` 的静态方法。
///
/// 🔴 核心坑：`attach_current_thread` 出来的线程用的是**系统 ClassLoader**，
/// `find_class("com/agilefr/kb/ApkInstaller")` 必然 ClassNotFoundException
/// （系统 ClassLoader 看不到应用自己的 dex）。必须借 Context 的 ClassLoader
/// 反射 `loadClass` 才能拿到应用类 —— 这是 Rust 调 Android 自有类的标准做法。
#[cfg(target_os = "android")]
mod android_jni {
    use jni::objects::{JClass, JObject, JString, JValue};
    use jni::JavaVM;

    /// 拿到 (JavaVM, Context)。Context 由 ndk_context 提供，tao 在启动时塞进去。
    fn vm_and_context() -> Result<(JavaVM, *mut std::ffi::c_void), String> {
        let ctx = ndk_context::android_context();
        let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
            .map_err(|e| format!("取 JavaVM 失败: {e}"))?;
        Ok((vm, ctx.context()))
    }

    /// 借 Context 的 ClassLoader 加载应用自有类（绕开系统 ClassLoader 看不见 dex 的问题）
    fn load_app_class<'a>(
        env: &mut jni::JNIEnv<'a>,
        context: &JObject<'a>,
        class_name: &str,
    ) -> Result<JClass<'a>, String> {
        let loader = env
            .call_method(context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
            .map_err(|e| format!("取 ClassLoader 失败: {e}"))?
            .l()
            .map_err(|e| format!("ClassLoader 返回值异常: {e}"))?;
        let name = env
            .new_string(class_name)
            .map_err(|e| format!("构造类名字符串失败: {e}"))?;
        let class_obj = env
            .call_method(
                &loader,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[JValue::Object(&name)],
            )
            .map_err(|e| format!("loadClass({class_name}) 失败: {e}"))?
            .l()
            .map_err(|e| format!("loadClass 返回值异常: {e}"))?;
        Ok(JClass::from(class_obj))
    }

    /// 调 `(Context) -> String` 或 `(Context, String) -> String` 的静态方法，
    /// 返回 Kotlin 侧给的错误串（空串 = 成功）
    fn call_returning_string(method: &str, arg: Option<&str>) -> Result<String, String> {
        let (vm, context_ptr) = vm_and_context()?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("attach JNI 线程失败: {e}"))?;
        let context = unsafe { JObject::from_raw(context_ptr.cast()) };
        let class = load_app_class(&mut env, &context, "com.agilefr.kb.ApkInstaller")?;

        let result = match arg {
            Some(a) => {
                let jarg = env
                    .new_string(a)
                    .map_err(|e| format!("构造参数字符串失败: {e}"))?;
                env.call_static_method(
                    &class,
                    method,
                    "(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;",
                    &[JValue::Object(&context), JValue::Object(&jarg)],
                )
            }
            None => env.call_static_method(
                &class,
                method,
                "(Landroid/content/Context;)Ljava/lang/String;",
                &[JValue::Object(&context)],
            ),
        }
        .map_err(|e| format!("调用 {method} 失败: {e}"))?
        .l()
        .map_err(|e| format!("{method} 返回值异常: {e}"))?;

        let s: String = env
            .get_string(&JString::from(result))
            .map_err(|e| format!("读取 {method} 返回值失败: {e}"))?
            .into();
        Ok(s)
    }

    /// 拉起系统安装器；Ok(()) = 已拉起
    pub fn install_apk(apk_path: &str) -> Result<(), String> {
        let err = call_returning_string("install", Some(apk_path))?;
        if err.is_empty() {
            Ok(())
        } else {
            Err(err)
        }
    }

    /// 查询是否已获「允许安装未知应用」授权
    pub fn can_request_install() -> Result<bool, String> {
        let (vm, context_ptr) = vm_and_context()?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("attach JNI 线程失败: {e}"))?;
        let context = unsafe { JObject::from_raw(context_ptr.cast()) };
        let class = load_app_class(&mut env, &context, "com.agilefr.kb.ApkInstaller")?;
        let allowed = env
            .call_static_method(
                &class,
                "canRequestInstall",
                "(Landroid/content/Context;)Z",
                &[JValue::Object(&context)],
            )
            .map_err(|e| format!("调用 canRequestInstall 失败: {e}"))?
            .z()
            .map_err(|e| format!("canRequestInstall 返回值异常: {e}"))?;
        Ok(allowed)
    }

    /// 跳到「允许安装未知应用」设置页
    pub fn open_install_permission_settings() -> Result<(), String> {
        let err = call_returning_string("openInstallPermissionSettings", None)?;
        if err.is_empty() {
            Ok(())
        } else {
            Err(err)
        }
    }
}

/// 拉起系统安装器安装已下载的 APK。
///
/// iOS 没有侧载安装的可能（必须走 App Store），所以非 Android 一律返回错误，
/// 前端拿到后回退到"用浏览器打开下载页"的老路径。
#[tauri::command]
pub fn install_mobile_update(apk_path: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        android_jni::install_apk(&apk_path)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = apk_path;
        Err("当前平台不支持直接安装 APK".to_string())
    }
}

/// 查询是否已获「允许安装未知应用」授权（Android 8.0+ 才有这个开关）。
/// 非 Android 返回 false，前端据此走浏览器下载的老路径。
#[tauri::command]
pub fn can_install_mobile_update() -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        android_jni::can_request_install()
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(false)
    }
}

/// 跳到本应用的「允许安装未知应用」设置页（系统不允许应用自己授予，只能引导）。
#[tauri::command]
pub fn open_install_permission_settings() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        android_jni::open_install_permission_settings()
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("当前平台不需要此权限".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn version_compare() {
        assert!(is_newer("1.8.2", "1.8.1"));
        assert!(is_newer("1.9.0", "1.8.9"));
        assert!(is_newer("2.0.0", "1.99.99"));
        assert!(!is_newer("1.8.1", "1.8.1"));
        assert!(!is_newer("1.8.0", "1.8.1"));
        assert!(is_newer("v1.8.2", "1.8.1")); // 容忍 v 前缀
        assert!(!is_newer("1.8", "1.8.0")); // 段数不同补 0
    }
}
