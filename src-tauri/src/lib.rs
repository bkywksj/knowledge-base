mod commands;
mod database;
mod error;
mod models;
mod services;
mod state;
#[cfg(desktop)]
mod tray;

use std::fs::File;
use std::path::{Path, PathBuf};

use state::AppState;
use tauri::{Emitter, Manager, WindowEvent};

/// 构建 macOS 风格的中文应用菜单（仅 macOS 实际挂载；Windows/Linux 默认不显示 menu bar）。
/// 抽成普通函数（不带 cfg）是为了让 Windows/Linux 也能编译验证语法。
#[allow(dead_code)]
fn build_chinese_app_menu(
    handle: &tauri::AppHandle,
) -> Result<tauri::menu::Menu<tauri::Wry>, tauri::Error> {
    use tauri::menu::{AboutMetadata, MenuBuilder, PredefinedMenuItem, SubmenuBuilder};

    let app_name = handle.package_info().name.clone();
    let about_meta = AboutMetadata {
        name: Some(app_name.clone()),
        version: Some(handle.package_info().version.to_string()),
        ..Default::default()
    };

    // 应用菜单（macOS 第一个 Submenu 标题被系统替换为 app 名）
    let app_submenu = SubmenuBuilder::new(handle, &app_name)
        .item(&PredefinedMenuItem::about(
            handle,
            Some(&format!("关于 {}", app_name)),
            Some(about_meta),
        )?)
        .separator()
        .item(&PredefinedMenuItem::services(handle, Some("服务"))?)
        .separator()
        .item(&PredefinedMenuItem::hide(
            handle,
            Some(&format!("隐藏 {}", app_name)),
        )?)
        .item(&PredefinedMenuItem::hide_others(handle, Some("隐藏其他"))?)
        .item(&PredefinedMenuItem::show_all(handle, Some("全部显示"))?)
        .separator()
        .item(&PredefinedMenuItem::quit(
            handle,
            Some(&format!("退出 {}", app_name)),
        )?)
        .build()?;

    let edit_submenu = SubmenuBuilder::new(handle, "编辑")
        .item(&PredefinedMenuItem::undo(handle, Some("撤销"))?)
        .item(&PredefinedMenuItem::redo(handle, Some("重做"))?)
        .separator()
        .item(&PredefinedMenuItem::cut(handle, Some("剪切"))?)
        .item(&PredefinedMenuItem::copy(handle, Some("复制"))?)
        .item(&PredefinedMenuItem::paste(handle, Some("粘贴"))?)
        .item(&PredefinedMenuItem::select_all(handle, Some("全选"))?)
        .build()?;

    let view_submenu = SubmenuBuilder::new(handle, "视图")
        .item(&PredefinedMenuItem::fullscreen(handle, Some("进入全屏"))?)
        .build()?;

    let window_submenu = SubmenuBuilder::new(handle, "窗口")
        .item(&PredefinedMenuItem::minimize(handle, Some("最小化"))?)
        .item(&PredefinedMenuItem::maximize(handle, Some("最大化"))?)
        .separator()
        .item(&PredefinedMenuItem::close_window(handle, Some("关闭窗口"))?)
        .build()?;

    MenuBuilder::new(handle)
        .item(&app_submenu)
        .item(&edit_submenu)
        .item(&view_submenu)
        .item(&window_submenu)
        .build()
}

/// 应用 identifier，必须与 tauri.conf.json 中的 identifier 一致
/// 用于在 Tauri Builder 启动前估算 app_data_dir（提前判断锁、投递 md 等）
const IDENTIFIER: &str = "com.agilefr.kb";
/// .md 文件投递文件名（单实例守护的轮询 watcher 监听此文件）
const DELIVER_FILE: &str = "deliver-md.txt";

// ───────── 单实例守护 ─────────

/// 从命令行参数中提取 .md / .markdown / .txt 文件路径（仅桌面端：移动端无 CLI 参数）
#[cfg(desktop)]
fn extract_md_paths_from_args<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .filter(|a| {
            let lo = a.to_lowercase();
            lo.ends_with(".md") || lo.ends_with(".markdown") || lo.ends_with(".txt")
        })
        .collect()
}

/// 在 Tauri 主进程内启动一份 in-memory MCP server (kb-core)，返回 client 端。
///
/// 架构：
/// ```text
///   主应用 setup
///       ├── tokio::io::duplex(64KB) → (server_io, client_io)
///       ├── tokio::spawn KbServer::serve(server_io)   [后台 task 永驻]
///       └── ().serve(client_io).await               [拿 client]
///                  ↓
///            存到 AppState.mcp_internal
/// ```
///
/// 主应用和 sidecar 各自独立打开 SQLite Connection，WAL + busy_timeout 保证并发安全。
/// `writable=true`：自家应用本身就有完整写权限，写工具默认开启。
fn setup_internal_mcp(
    db_path: &Path,
) -> Result<std::sync::Arc<state::InternalMcpClient>, Box<dyn std::error::Error + Send + Sync>> {
    use rmcp::ServiceExt;

    let db_path = db_path.to_path_buf();

    // setup 闭包不在 tokio runtime 上下文里，用 tauri::async_runtime::block_on 同步等待
    tauri::async_runtime::block_on(async move {
        let (server_io, client_io) = tokio::io::duplex(64 * 1024);

        let kb_db = kb_core::KbDb::open(&db_path, /* writable */ true)
            .map_err(|e| Box::<dyn std::error::Error + Send + Sync>::from(e.to_string()))?;
        let kb_server = kb_core::KbServer::new(kb_db, /* writable */ true);

        // 后台 task：跑 server，永远不退出（除非 client 断开）
        tauri::async_runtime::spawn(async move {
            match kb_server.serve(server_io).await {
                Ok(running) => {
                    if let Err(e) = running.waiting().await {
                        log::warn!("[mcp-internal] server waiting error: {e}");
                    }
                }
                Err(e) => log::error!("[mcp-internal] server start failed: {e}"),
            }
        });

        // client 端用 () handler（不响应 server-initiated 请求）
        let client = ()
            .serve(client_io)
            .await
            .map_err(|e| Box::<dyn std::error::Error + Send + Sync>::from(e.to_string()))?;

        Ok(std::sync::Arc::new(client))
    })
}

/// 当前进程使用的 app_data 子目录名。
///
/// - prod: `com.agilefr.kb`（与 Tauri 默认一致）
/// - dev:  `com.agilefr.kb-dev`（整目录隔离，方便用户备份/清理 dev 数据；
///         比"同目录加 dev- 文件前缀"更直观）
///
/// 注意：Tauri 内置的 `app.path().app_data_dir()` 永远返回 prod 名（因为它读
/// `tauri.conf.json` 的 identifier）。setup 中需要在这个返回值上手动改写到
/// `app_data_dir_name()`，所有依赖 framework_app_data_dir 的下游都跟着走。
fn app_data_dir_name() -> String {
    if cfg!(debug_assertions) {
        format!("{}-dev", IDENTIFIER)
    } else {
        IDENTIFIER.to_string()
    }
}

/// 取当前进程实际使用的 framework_app_data_dir（dev 已隔离到 `-dev` 目录）。
///
/// Tauri 内置 `app.path().app_data_dir()` 永远返回 prod 名（基于 tauri.conf.json
/// 的 identifier），所有运行期 Command 拿 framework_app_data_dir 都要经过本函数，
/// 否则 dev 单实例锁 / multi_instance flag / 指针文件 等会落到 prod 目录里。
pub(crate) fn framework_app_data_dir(handle: &tauri::AppHandle) -> Result<PathBuf, tauri::Error> {
    let from_tauri = handle.path().app_data_dir()?;
    // 桌面端：dev 模式重写到 -dev 兄弟目录（应用对 OS 的 app_data_dir 父目录有写权限）
    // 移动端：Android 沙盒只允许应用写自己的 files/，不能在 parent 下建兄弟目录
    //         直接返回 tauri 给的（dev/prod 用同一个目录，反正每次卸载重装都重置）
    #[cfg(desktop)]
    if cfg!(debug_assertions) {
        return Ok(from_tauri
            .parent()
            .map(|parent| parent.join(app_data_dir_name()))
            .unwrap_or(from_tauri));
    }
    Ok(from_tauri)
}

/// 在 Tauri Builder 启动前估算 app data 目录（用于早期投递判断）
/// 必须与 setup 里的 framework_app_data_dir 保持一致：dev 走 `-dev` 隔离目录
/// 仅桌面端：移动端没有"启动前 estimate"概念
#[cfg(desktop)]
fn early_app_data_dir() -> PathBuf {
    let name = app_data_dir_name();
    #[cfg(windows)]
    {
        if let Ok(p) = std::env::var("APPDATA") {
            return PathBuf::from(p).join(&name);
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join("Library/Application Support")
                .join(&name);
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(p) = std::env::var("XDG_DATA_HOME") {
            return PathBuf::from(p).join(&name);
        }
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(".local/share").join(&name);
        }
    }
    std::env::temp_dir().join(name)
}

/// 尝试以独占方式打开锁文件
/// Windows: FILE_FLAG_DELETE_ON_CLOSE + share_mode(0)，进程退出时锁文件自动删除
/// Unix (macOS / Linux / *BSD): flock LOCK_EX | LOCK_NB —— 内核在 fd 关闭时自动释放，
///   进程崩溃 / 被 kill 也会释放，避免锁文件残留导致下次启动误判"已运行"
///
/// ⚠️ flock 在 NFS / SMB 等网络文件系统上语义不可靠（老内核根本不跨节点）。
///    本应用 data_dir 默认 `~/.local/share`，本地 ext4/btrfs 没问题；
///    如果用户把 data_dir 改到网络挂载，单实例语义可能退化。
#[cfg(desktop)]
fn try_exclusive_lock(path: &Path) -> Result<File, ()> {
    use std::fs::OpenOptions;

    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .custom_flags(0x04000000) // FILE_FLAG_DELETE_ON_CLOSE
            .share_mode(0) // 独占，第二个进程打开会失败
            .open(path)
            .map_err(|_| ())
    }

    // Unix 一律走 flock：文件存在与否不重要（create:true 兜底），关键是 advisory lock。
    // 历史教训：Linux 之前用 create_new(true)，进程退出后锁文件不会消失，导致用户每次
    // 启动都被误判成"默认实例已运行"，要么走 ping_default_to_focus 直接退出（看不到窗口），
    // 要么不停往后分配 instance-N（zombie 实例堆积）。
    #[cfg(unix)]
    {
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)
            .map_err(|_| ())?;
        use std::os::fd::AsRawFd;
        let ret = unsafe {
            extern "C" {
                fn flock(fd: i32, operation: i32) -> i32;
            }
            flock(file.as_raw_fd(), 2 /* LOCK_EX */ | 4 /* LOCK_NB */)
        };
        if ret == 0 {
            Ok(file)
        } else {
            Err(())
        }
    }

    #[cfg(not(any(windows, unix)))]
    {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|_| ())
    }
}

/// 获取单实例独占锁（默认锁）。
/// 正常情况下早期路径已保证第二个进程退出，这里能稳定拿到；拿不到也只返回 None
/// （锁是辅助约束，拿不到不阻断启动）。
/// 仅桌面端：移动端天然单实例。
#[cfg(desktop)]
fn acquire_default_lock(data_dir: &Path, prefix: &str) -> Option<File> {
    let default_lock = data_dir.join(format!("{}default.lock", prefix));
    try_exclusive_lock(&default_lock).ok()
}

/// 探测默认实例锁是否被占（不持有结果）
/// 试拿一次锁，立即 drop（在 Windows 上由于 FILE_FLAG_DELETE_ON_CLOSE，
/// 若拿到了锁文件会被自动删除，但此时本来就没有占用者，无副作用）
#[cfg(desktop)]
fn is_default_lock_busy(lock_path: &Path) -> bool {
    try_exclusive_lock(lock_path).is_err()
}

/// 把 .md 路径写入投递文件，给已运行的默认实例读取（仅桌面端）
#[cfg(desktop)]
fn deliver_md_to_default(app_data_dir: &Path, md_paths: &[String]) -> std::io::Result<()> {
    use std::io::Write;
    let path = app_data_dir.join(DELIVER_FILE);
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    for p in md_paths {
        writeln!(f, "{}", p)?;
    }
    Ok(())
}

/// 仅写一个空行到投递文件，触发已运行实例的 watcher 唤起主窗。
/// 用于第二个进程启动时退出前把焦点让给已运行的实例（单实例守护）。
/// 仅桌面端
#[cfg(desktop)]
fn ping_default_to_focus(app_data_dir: &Path) -> std::io::Result<()> {
    use std::io::Write;
    let path = app_data_dir.join(DELIVER_FILE);
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    writeln!(f)?; // 空行 → mtime 变化 → watcher 唤起窗口
    Ok(())
}

/// 单实例投递监听线程：轮询 deliver 文件 mtime。
/// 检测到 mtime 变化即唤起主窗（前置 + 取消最小化），如果文件里有 .md 路径
/// 则同时 emit `open-md-file` 事件。
///
/// 第二个进程启动时会用 `ping_default_to_focus` 写空行触发这个唤起 ——
/// 所以即使没有 .md 内容也要把窗口前置。
/// 仅桌面端：移动端单实例 + 无 unminimize/show/set_focus 等 WebviewWindow 方法
#[cfg(desktop)]
fn start_md_deliver_watcher(handle: tauri::AppHandle, app_data_dir: PathBuf) {
    tauri::async_runtime::spawn(async move {
        let path = app_data_dir.join(DELIVER_FILE);
        // 启动时清空文件，避免上次残留被误处理；
        // baseline mtime 取清空后的值，防止首轮把"自己刚清空"误认成"有人投递"造成自唤起。
        let _ = std::fs::write(&path, "");
        let mut last_mtime = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(800)).await;
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            let Ok(mtime) = meta.modified() else { continue };
            if mtime <= last_mtime {
                continue;
            }
            last_mtime = mtime;
            let content = std::fs::read_to_string(&path).unwrap_or_default();
            // 处理 .md 路径（如有）——空行只用于"唤起窗口"，会被 trim 跳过
            for line in content.lines() {
                let p = line.trim();
                if p.is_empty() {
                    continue;
                }
                log::info!("[deliver] 收到 md: {}", p);
                let _ = handle.emit("open-md-file", p.to_string());
            }
            // 清空文件准备下一轮投递
            let _ = std::fs::write(&path, "");
            last_mtime = std::fs::metadata(&path)
                .and_then(|m| m.modified())
                .unwrap_or(last_mtime);
            // mtime 变化即视为"有人想唤起这个窗口"——把主窗前置
            if let Some(win) = handle.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
    });
}

/// T-013 完整版：检测到迁移 marker 时，开 splash 窗口跑迁移
///
/// 流程：
/// 1. 创建 `migration-splash` 独立窗口，URL = `index.html#/migration-splash`（同一个 React 包，HashRouter 路由）
/// 2. 主窗口此时还是 visible:false，splash 是用户唯一可见的窗口
/// 3. setup 阻塞跑 `run_migration`，进度通过 `data_dir:migrate_progress` emit 到 splash
/// 4. 迁移完毕 → close splash → setup 继续往下走 → 末尾 show 主窗
/// 仅桌面端：移动端无多窗口 + 无 WebviewWindowBuilder.title() 方法
#[cfg(desktop)]
fn run_data_dir_migration_with_splash(
    app: &tauri::App,
    framework_app_data_dir: &std::path::Path,
    marker: &services::data_dir::MigrationMarker,
) -> Result<(), crate::error::AppError> {
    use tauri::{Emitter, WebviewUrl, WebviewWindowBuilder};

    log::info!(
        "[migration] 检测到 marker: {} → {} (status={:?})",
        marker.from,
        marker.to,
        marker.status
    );

    // 创建 splash 窗口
    let splash = WebviewWindowBuilder::new(
        app,
        "migration-splash",
        WebviewUrl::App("index.html#/migration-splash".into()),
    )
    .title("正在迁移数据…")
    .inner_size(560.0, 360.0)
    .resizable(false)
    .center()
    .decorations(false)
    .always_on_top(true)
    .visible(true)
    .build()
    .map_err(|e| crate::error::AppError::Custom(format!("splash 窗口创建失败: {}", e)))?;

    // 让 splash 内 JS 有机会订阅事件（首屏 React 渲染 + listen 调用大约 100ms）
    std::thread::sleep(std::time::Duration::from_millis(300));

    let app_handle = app.handle().clone();
    let emit_progress = move |p: &services::data_dir::MigrationProgress| {
        let _ = app_handle.emit_to("migration-splash", "data_dir:migrate_progress", p);
    };

    let result = services::data_dir::DataDirResolver::run_migration(
        framework_app_data_dir,
        marker,
        &emit_progress,
    );

    match &result {
        Ok(_) => log::info!("[migration] 迁移完成"),
        Err(e) => log::error!("[migration] 迁移失败: {}", e),
    }

    // 让用户看到"完成"或"失败"画面 1 秒再关
    std::thread::sleep(std::time::Duration::from_millis(800));
    let _ = splash.close();

    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 桌面端早期路径：单实例守护 + .md 投递（移动端无此概念，整段跳过）
    #[cfg(desktop)]
    let lock_prefix = if cfg!(debug_assertions) { "dev-" } else { "" };

    // 早期路径：已有实例正在运行时（默认锁被占）的处理 —— 单实例守护。
    // - 有 .md 投递 → 转给已有实例打开 + 退出（双击 .md 的直觉行为，不开新窗）
    // - 否则       → 让已有实例把窗口前置 + 退出（避免误开第二个进程并发写坏 SQLite）
    #[cfg(desktop)]
    {
        let app_data_dir = early_app_data_dir();
        let _ = std::fs::create_dir_all(&app_data_dir);
        let default_lock = app_data_dir.join(format!("{}default.lock", lock_prefix));
        if is_default_lock_busy(&default_lock) {
            let md_paths = extract_md_paths_from_args(std::env::args().skip(1));
            if !md_paths.is_empty() {
                let _ = deliver_md_to_default(&app_data_dir, &md_paths);
            } else {
                let _ = ping_default_to_focus(&app_data_dir);
            }
            return;
        }
    }

    // ─── 跨平台共享插件 ────────────────────────
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init());

    // ─── 桌面专属插件（移动端不可用：autostart / updater / global-shortcut）────
    #[cfg(desktop)]
    {
        builder = builder
            // 开机启动：传 `--start-minimized` 给系统注册项，启动时由下方 setup 判断是否隐藏窗口
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec!["--start-minimized"]),
            ))
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_global_shortcut::Builder::new().build());
    }

    // ─── macOS 应用菜单中文化 ─────────────────────
    // 不引入 i18n 框架，直接硬编码中文。Windows/Linux 默认不显示 menu bar，不受影响。
    // 不设置 menu 时 Tauri 在 macOS 上走 muda 内置英文常量（About/Services/Hide/Quit 等）。
    #[cfg(target_os = "macos")]
    {
        builder = builder.menu(build_chinese_app_menu);
    }

    builder
        // ─── 应用初始化 ─────────────────────────────
        .setup(move |app| {
            // ⚠️ 第一步：立即显示主窗口，不依赖任何后续初始化成败。
            // 历史教训：tauri.conf.json 的 visible:false 启动隐藏窗口，靠 setup 末尾的
            // window.show() 显示。但 setup 闭包前面有 ~10 个 ? 错误传播点（fs/db/tray/...），
            // 任意一个失败都会让 setup 提前 Err return，window.show() 永远不调 → mac 白屏。
            // 改为 setup 第一行就 show，setup 中段失败也只是功能退化，不会黑屏。
            // 唯一例外：autostart --start-minimized 模式下面会重新 hide。
            // 仅桌面端：移动端 WebviewWindow 不提供 show/hide（系统管理可见性）
            #[cfg(desktop)]
            if let Some(window) = app.get_webview_window("main") {
                // 启动尺寸智能化：按主显示器逻辑分辨率重设窗口大小。
                // 规则：永不比 conf.json 默认 1388×830 更小（floor），按屏宽 75% 计算，
                //       同时不超出屏幕 95%、最高 1700×1050（cap）。
                //
                // 注意：floor 必须与 tauri.conf.json 的 width 保持一致 — 之前 floor=1330
                // 而 conf.json=1388 时，1080p (logical 1920) 走 1920*0.7=1344 被 1330 floor 兜
                // 但实际不到 1388 → 改 conf 不生效；现在统一抬到 1388（编辑器 toolbar 一行所需的最小宽度）。
                //
                // 验证：
                // - 1080p 100%      (logical 1920×1080): 1440×832  屏宽 75%（编辑器 toolbar 一行）
                // - 27" 2K 150% Win (logical 1707×960):  1388×830  floor 兜底
                // - 27" 2K 125% Win (logical 2048×1152): 1536×887  适度放大（屏宽 75%）
                // - 27" 2K 100%     (logical 2560×1440): 1700×1050 上限
                // - 旧本 1366×768  (logical 1366×768):  1297×729  屏幕 95%（屏幕本身比默认还小时退让）
                //
                // 取不到 monitor 时静默回落到 conf.json 默认尺寸。
                if let Ok(Some(monitor)) = window.primary_monitor() {
                    let phys = monitor.size();
                    let scale = monitor.scale_factor().max(0.1);
                    let logical_w = phys.width as f64 / scale;
                    let logical_h = phys.height as f64 / scale;
                    let target_w = (logical_w * 0.75)
                        .max(1388.0)
                        .min(logical_w * 0.95)
                        .min(1700.0);
                    let target_h = (logical_h * 0.77)
                        .max(830.0)
                        .min(logical_h * 0.95)
                        .min(1050.0);
                    let _ = window.set_size(tauri::LogicalSize::new(target_w, target_h));
                    let _ = window.center();
                }
                let _ = window.show();
            }

            // framework 默认 app_data_dir：单实例锁 + 指针文件 + 迁移 marker 永远在这里。
            // dev 模式重定向到 `-dev` 隔离目录（见 `framework_app_data_dir` helper 注释）。
            let framework_app_data_dir = framework_app_data_dir(&app.handle())?;
            std::fs::create_dir_all(&framework_app_data_dir)?;

            // T-013 完整版：检测迁移 marker → 弹 splash 窗口跑迁移 → close splash
            // 必须放在 db init 之前（迁移会动 db 文件）
            // 仅桌面端：移动端无多窗口（splash），按 T-M013 重做迁移流程
            #[cfg(desktop)]
            if let Ok(Some(marker)) =
                services::data_dir::DataDirResolver::read_migration_marker(&framework_app_data_dir)
            {
                run_data_dir_migration_with_splash(app, &framework_app_data_dir, &marker)
                    .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;
            }

            // T-013: 解析最终数据根目录（env > 指针文件 > 默认）
            // 注意 dev 模式旧数据迁移、单实例锁仍在 framework_app_data_dir 上做
            let resolved_data_dir =
                services::data_dir::DataDirResolver::resolve(&framework_app_data_dir)
                    .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;
            log::info!(
                "[data_dir] 当前数据根: {} (source={:?})",
                resolved_data_dir.current_dir,
                resolved_data_dir.source
            );
            let data_dir_root = std::path::PathBuf::from(&resolved_data_dir.current_dir);
            std::fs::create_dir_all(&data_dir_root)?;

            // 单实例守护锁：仅桌面端有此概念（移动端天然单实例，无锁）
            #[cfg(desktop)]
            let lock_file = {
                // dev 模式旧数据迁移到 dev- 前缀目录
                if cfg!(debug_assertions) {
                    migrate_to_dev_prefix(&data_dir_root);
                }
                // 拿默认锁（这次真持有，存活到进程结束）
                // ⚠️ 锁文件刻意放 framework_app_data_dir（不是 data_dir_root）：
                //    用户改数据目录不应该突破单例约束
                let lock_file = acquire_default_lock(&framework_app_data_dir, lock_prefix);
                log::info!("单实例模式");
                lock_file
            };
            #[cfg(mobile)]
            let lock_file: Option<std::fs::File> = None;

            std::fs::create_dir_all(&data_dir_root)?;

            let prefix = if cfg!(debug_assertions) { "dev-" } else { "" };
            let db_path = data_dir_root.join(format!("{}app.db", prefix));
            let db_path_str = db_path.to_string_lossy().to_string();

            let db = database::Database::init(&db_path_str)
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;
            log::info!("数据库初始化完成: {}", db_path_str);

            // 资产目录均基于 data_dir_root（service 内部仍叫 app_data_dir，语义是"数据根"）
            let images_dir = services::image::ImageService::ensure_dir(&data_dir_root)
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;
            log::info!("图片存储目录: {}", images_dir.display());

            let attachments_dir =
                services::attachment::AttachmentService::ensure_dir(&data_dir_root)
                    .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;
            log::info!("附件存储目录: {}", attachments_dir.display());

            let pdfs_dir = services::pdf::PdfService::ensure_dir(&data_dir_root)
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;
            log::info!("PDF 存储目录: {}", pdfs_dir.display());

            // 绑定 PDFium 动态库（资源目录与实例无关）。各平台用各自的动态库格式：
            //   Windows: pdfium.dll  / macOS: libpdfium.dylib  / Linux: libpdfium.so
            // 如果 resources/pdfium/ 下缺对应平台的库文件，仅 log warn —— pdf-extract
            // 主路径仍可工作，只是失去 PDFium fallback 这条防扫描件兜底。
            // 仅桌面端：移动端 NDK 加载动态库受沙盒限制，不引入 PDFium
            #[cfg(desktop)]
            {
                #[cfg(target_os = "windows")]
                const PDFIUM_LIB: &str = "resources/pdfium/pdfium.dll";
                #[cfg(target_os = "macos")]
                const PDFIUM_LIB: &str = "resources/pdfium/libpdfium.dylib";
                #[cfg(target_os = "linux")]
                const PDFIUM_LIB: &str = "resources/pdfium/libpdfium.so";

                match app
                    .path()
                    .resolve(PDFIUM_LIB, tauri::path::BaseDirectory::Resource)
                {
                    Ok(lib_path) => match services::pdf::init_pdfium(&lib_path) {
                        Ok(()) => log::info!("PDFium 绑定成功: {}", lib_path.display()),
                        Err(e) => log::warn!(
                            "PDFium 绑定失败（fallback 不可用，仅 pdf-extract 路径可用）: {}",
                            e
                        ),
                    },
                    Err(e) => log::warn!("PDFium 资源路径解析失败: {}", e),
                }
            }

            let sources_dir = services::source_file::SourceFileService::ensure_dir(&data_dir_root)
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;
            log::info!("源文件存储目录: {}", sources_dir.display());

            // 把当前数据目录加进 asset protocol scope（递归）。
            // 静态 tauri.conf.json 里的 `$APPDATA/**` 只覆盖 OS 默认 app_data_dir，
            // 用户改自定义数据目录 / KB_DATA_DIR 后 kb_assets/pdfs/sources
            // 都会落到这条静态 scope 之外，导致 `convertFileSrc()` 出来的 asset URL 被 WebView 拒绝
            // → 图片/视频/PDF/附件全部加载失败。
            // 失败仅 log warn：素材渲染降级，不阻断启动。
            if let Err(e) = app
                .asset_protocol_scope()
                .allow_directory(&data_dir_root, true)
            {
                log::warn!(
                    "[asset_scope] 注册数据目录到 asset 协议失败（图片/PDF 可能无法显示）: {} ({})",
                    data_dir_root.display(),
                    e
                );
            } else {
                log::info!(
                    "[asset_scope] 已允许 asset 协议读取: {}",
                    data_dir_root.display()
                );
            }

            // ─── 启动 in-memory MCP server（kb-core）─────────────
            // tokio::io::duplex 当 transport，KbServer 跑在后台 task，
            // client 端存到 AppState 供 commands::mcp::* 用。
            // 失败不阻断启动 —— 用 Option 包装，commands 拿不到时报"未就绪"
            let mcp_internal = setup_internal_mcp(&db_path).map_or_else(
                |e| {
                    log::warn!(
                        "[mcp-internal] 初始化失败，自家 AI 对话页将无法用 MCP 内置工具: {e}"
                    );
                    None
                },
                |c| {
                    log::info!("[mcp-internal] in-memory MCP server 就绪（kb-core 12 工具）");
                    Some(c)
                },
            );

            // 注册全局状态
            let state = AppState::new(db, data_dir_root.clone(), mcp_internal, lock_file);

            // 若由"双击 md 文件"启动，暂存路径到 state，
            // 等前端 mount 完成后通过 take_pending_open_md_path 取走并打开
            // 仅桌面端：移动端无双击文件启动概念
            #[cfg(desktop)]
            if let Some(md_path) = extract_md_paths_from_args(std::env::args().skip(1))
                .into_iter()
                .next()
            {
                log::info!("[launch] 启动参数带入 md: {}", md_path);
                if let Ok(mut guard) = state.pending_open_md_path.lock() {
                    *guard = Some(md_path);
                }
            }

            app.manage(state);

            // 启动期清理 .sync-tmp-* 孤儿（上次崩溃 / kill 可能残留 VACUUM 副本 / push-zip / pull-zip）
            // 顶层扫，严格前缀匹配，不递归子目录 → 不会误删任何业务资产
            let cleaned = services::sync::SyncService::cleanup_orphan_temp_files(&data_dir_root);
            if cleaned > 0 {
                log::info!("[startup] 清理 {} 个同步临时孤儿文件", cleaned);
            }

            // 窗口标题：dev build 追加 [DEV]，prod 保留 conf.json 默认标题
            // 仅桌面端：移动端无窗口标题概念（标题栏由系统/状态栏管理）
            #[cfg(desktop)]
            if cfg!(debug_assertions) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title("知识库 [DEV]");
                }
            }

            // 启动 .md 投递监听，接管双击 .md 文件转来的打开请求
            // ⚠️ 投递文件刻意走 framework_app_data_dir（不是 data_dir_root）：
            //    其他进程不知道当前用户配的自定义路径，必须用 OS 给的固定位置约定
            // 仅桌面端：移动端没有"双击 .md 启动"路径
            #[cfg(desktop)]
            {
                start_md_deliver_watcher(app.handle().clone(), framework_app_data_dir.clone());

                // 全局快捷键注册。单条注册失败只 log warn，不阻断启动；用户可在设置页改键/禁用
                services::shortcut::ShortcutService::register_all(
                    app.handle(),
                    &app.state::<AppState>().db,
                );
            }

            // 系统托盘（仅桌面端；移动端无托盘概念）
            // 用 if let Err 兜底而非 ?：tray 是辅助功能，失败不该让整个应用启动崩。
            // 历史教训：tray::setup_tray 在 mac 上失败（如 default_window_icon 返回 None）
            // 会让 setup 闭包提前 Err return，主窗永远 visible:false 导致白屏。
            #[cfg(desktop)]
            {
                if let Err(e) = tray::setup_tray(app) {
                    log::error!("[tray] 初始化失败（不影响主窗运行）: {}", e);
                } else {
                    log::info!("系统托盘初始化完成");
                }
            }

            // 开机启动时若带 --start-minimized 参数 且 用户在设置里开启了"启动最小化到托盘"，
            // 则隐藏主窗口到托盘
            // 仅桌面端：移动端无 --start-minimized + 无托盘 + 无 window.hide
            #[cfg(desktop)]
            if std::env::args().any(|a| a == "--start-minimized") {
                let start_minimized = app
                    .state::<AppState>()
                    .db
                    .get_config("start_minimized")
                    .ok()
                    .flatten()
                    .as_deref()
                    == Some("1");
                if start_minimized {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                        log::info!("[autostart] 启动最小化已启用，主窗口已隐藏到托盘");
                    }
                }
            }

            // 自动同步调度器
            // 仅桌面端：移动端按 T-M014 改"手动同步按钮"，且 sync_v1_scheduler 依赖 rust-s3
            #[cfg(desktop)]
            {
                let app_handle_sched = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    services::sync_scheduler::run_scheduler(app_handle_sched).await;
                });
                // V1 多端同步调度器：每分钟扫到期 backend 跑双向（pull → push）
                let app_handle_v1 = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    services::sync_v1_scheduler::run_v1_scheduler(app_handle_v1).await;
                });
            }

            // 待办定时提醒
            let app_handle_reminder = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                services::task_reminder::run_reminder_loop(app_handle_reminder).await;
            });

            // 定时推送调度器（独立于待办提醒，骨架同源）
            let app_handle_push = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                services::push::scheduler::run_push_loop(app_handle_push).await;
            });

            // setup 末尾再 show + set_focus 抢焦点：
            // - 主窗已在 setup 第一步 show 过，这里 show 是幂等的
            // - 真正作用是 set_focus：迁移 splash 关闭后 / 多窗口创建后把焦点拉回主窗
            // - autostart --start-minimized 模式下用户已选择隐藏到托盘，跳过此步
            // 仅桌面端：移动端 WebviewWindow 不提供 show/set_focus 方法
            #[cfg(desktop)]
            {
                let did_start_minimized = std::env::args().any(|a| a == "--start-minimized")
                    && app
                        .state::<AppState>()
                        .db
                        .get_config("start_minimized")
                        .ok()
                        .flatten()
                        .as_deref()
                        == Some("1");
                if !did_start_minimized {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }

            Ok(())
        })
        // ─── Command 注册 ───────────────────────────
        .invoke_handler(tauri::generate_handler![
            // MCP 内置 server（kb-core 12 工具）
            commands::mcp::mcp_internal_list_tools,
            commands::mcp::mcp_internal_call_tool,
            commands::mcp::mcp_runtime_info,
            commands::mcp::mcp_get_claude_md_template,
            commands::mcp::mcp_list_servers,
            commands::mcp::mcp_create_server,
            commands::mcp::mcp_update_server,
            commands::mcp::mcp_delete_server,
            commands::mcp::mcp_set_server_enabled,
            // 外部 MCP server 子进程仅桌面端
            #[cfg(desktop)]
            commands::mcp::mcp_external_list_tools,
            #[cfg(desktop)]
            commands::mcp::mcp_external_call_tool,
            commands::mcp::mcp_install_to_client,
            commands::mcp::mcp_uninstall_from_client,
            commands::mcp::mcp_check_install_status,
            commands::mcp::mcp_get_setup_doc,
            commands::mcp::mcp_get_ai_writable,
            commands::mcp::mcp_set_ai_writable,
            // 系统模块
            commands::system::greet,
            commands::system::get_system_info,
            commands::system::get_dashboard_stats,
            commands::system::get_writing_trend,
            commands::system::write_text_file,
            commands::system::write_binary_file,
            commands::system::resolve_asset_absolute_path,
            commands::system::copy_theme_bg,
            commands::system::clear_theme_bg,
            commands::system::path_exists,
            // 配置模块
            commands::config::get_all_config,
            commands::config::get_config,
            commands::config::set_config,
            commands::config::delete_config,
            // 笔记模块
            commands::notes::create_note,
            commands::notes::update_note,
            commands::notes::delete_note,
            commands::notes::get_note,
            commands::notes::get_notes_images,
            commands::notes::list_notes,
            commands::notes::toggle_pin,
            commands::notes::move_note_to_folder,
            commands::notes::reorder_notes,
            commands::notes::list_note_ids_for_reorder,
            commands::notes::move_notes_batch,
            commands::notes::trash_notes_batch,
            commands::notes::add_tags_to_notes_batch,
            commands::notes::set_note_hidden,
            commands::notes::list_hidden_notes,
            commands::notes::list_hidden_folder_ids,
            // 隐藏笔记 PIN（UX 门禁，非真加密）
            commands::hidden_pin::is_hidden_pin_set,
            commands::hidden_pin::set_hidden_pin,
            commands::hidden_pin::verify_hidden_pin,
            commands::hidden_pin::clear_hidden_pin,
            commands::hidden_pin::get_hidden_pin_hint,
            // T-014 网页剪藏
            commands::notes::clip_url_to_note,
            // 多窗口 pop-out（笔记对照 / 双显示器分屏）
            #[cfg(desktop)]
            commands::notes::open_note_in_new_window,
            #[cfg(desktop)]
            commands::notes::open_mindmap_in_new_window,
            // T-007 笔记加密 / Vault
            commands::vault::vault_status,
            commands::vault::vault_setup,
            commands::vault::vault_unlock,
            commands::vault::vault_lock,
            commands::vault::encrypt_note,
            commands::vault::decrypt_note,
            commands::vault::disable_note_encrypt,
            // T-013 自定义数据目录
            commands::data_dir::get_data_dir_info,
            commands::data_dir::set_pending_data_dir,
            commands::data_dir::clear_pending_data_dir,
            commands::data_dir::set_pending_data_dir_with_migration,
            commands::data_dir::cancel_pending_migration,
            commands::data_dir::get_migration_marker,
            // T-024 同步 V1（多端真同步 + 多 backend）
            commands::sync_v1::sync_v1_list_backends,
            commands::sync_v1::sync_v1_get_backend,
            commands::sync_v1::sync_v1_create_backend,
            commands::sync_v1::sync_v1_update_backend,
            commands::sync_v1::sync_v1_delete_backend,
            commands::sync_v1::sync_v1_test_connection,
            commands::sync_v1::sync_v1_read_remote_manifest,
            commands::sync_v1::sync_v1_push,
            commands::sync_v1::sync_v1_pull,
            commands::sync_v1::sync_v1_trigger_background_sync,
            commands::sync_v1::sync_v1_get_local_manifest,
            commands::sync_v1::sync_v1_rebuild_attachment_index,
            commands::sync_v1::sync_v1_gc_attachments,
            commands::sync_v1::sync_v1_list_conflicts,
            commands::sync_v1::sync_v1_resolve_conflict,
            // 文件夹模块
            commands::folders::create_folder,
            commands::folders::rename_folder,
            commands::folders::delete_folder,
            commands::folders::folder_subtree_stats,
            commands::folders::delete_folder_cascade,
            commands::folders::list_folders,
            commands::folders::move_folder,
            commands::folders::reorder_folders,
            commands::folders::ensure_folder_path,
            commands::folders::set_folder_color,
            // 搜索模块
            commands::search::search_notes,
            // 回收站模块
            commands::trash::soft_delete_note,
            commands::trash::restore_note,
            commands::trash::permanent_delete_note,
            commands::trash::list_trash,
            commands::trash::empty_trash,
            commands::trash::restore_notes_batch,
            commands::trash::permanent_delete_notes_batch,
            // 每日笔记模块
            commands::daily::get_daily,
            commands::daily::get_or_create_daily,
            commands::daily::list_daily_dates,
            commands::daily::get_daily_neighbors,
            commands::daily::list_all_dailies,
            commands::daily::append_quick_capture,
            // 标签模块
            commands::tags::create_tag,
            commands::tags::list_tags,
            commands::tags::rename_tag,
            commands::tags::set_tag_color,
            commands::tags::set_tag_parent,
            commands::tags::reorder_tags,
            commands::tags::delete_tag,
            commands::tags::add_tag_to_note,
            commands::tags::remove_tag_from_note,
            commands::tags::get_note_tags,
            commands::tags::list_notes_by_tag,
            // 链接模块
            commands::links::sync_note_links,
            commands::links::get_backlinks,
            commands::links::search_link_targets,
            commands::links::find_note_id_by_title_loose,
            commands::links::get_graph_data,
            // AI 模块
            commands::ai::list_ai_models,
            commands::ai::create_ai_model,
            commands::ai::update_ai_model,
            commands::ai::delete_ai_model,
            commands::ai::set_default_ai_model,
            commands::ai::test_ai_model,
            commands::ai::list_ai_conversations,
            commands::ai::create_ai_conversation,
            commands::ai::delete_ai_conversation,
            commands::ai::delete_ai_conversations_before,
            commands::ai::rename_ai_conversation,
            commands::ai::update_ai_conversation_model,
            commands::ai::list_ai_messages,
            commands::ai::send_ai_message,
            commands::ai::cancel_ai_generation,
            commands::ai::ai_write_assist,
            commands::ai::ai_suggest_prompt,
            commands::ai::cancel_ai_write_assist,
            commands::ai::ai_plan_today,
            commands::ai::ai_extract_task_from_text,
            commands::ai::ai_plan_from_goal,
            // Excel 解析仅桌面端（calamine 移动端编译失败，T-M013 后再决策）
            #[cfg(desktop)]
            commands::ai::ai_plan_from_excel,
            #[cfg(desktop)]
            commands::ai::ai_parse_excel,
            commands::ai::ai_parse_attachment,
            commands::ai::undo_task_batch,
            commands::ai::ai_draft_note,
            commands::ai::set_ai_conversation_attached_notes,
            commands::ai::set_ai_conversation_scope_folder,
            commands::ai::archive_ai_conversation_to_note,
            commands::ai::get_or_create_companion_conversation,
            // 提示词库模块
            commands::prompt::list_prompts,
            commands::prompt::get_prompt,
            commands::prompt::create_prompt,
            commands::prompt::update_prompt,
            commands::prompt::delete_prompt,
            commands::prompt::set_prompt_enabled,
            // 定时推送
            commands::push::list_push_jobs,
            commands::push::get_push_job,
            commands::push::create_push_job,
            commands::push::update_push_job,
            commands::push::delete_push_job,
            commands::push::set_push_job_enabled,
            commands::push::run_push_job_now,
            commands::push::list_push_run_logs,
            commands::push::get_push_popup_data,
            // 导入模块
            commands::import::scan_markdown_folder,
            commands::import::import_selected_files,
            commands::import::open_markdown_file,
            commands::import::take_pending_open_md_path,
            // 导出模块
            commands::export::export_notes,
            commands::export::export_single_note,
            // T-020 导出 Word / HTML
            // Word 导出仅桌面端（docx_rs 移动端编译失败）
            #[cfg(desktop)]
            commands::export::export_single_note_to_word,
            commands::export::export_single_note_to_html,
            // R-005 PDF 导出：渲染 HTML 字符串供前端 iframe 打印
            commands::export::render_note_html_for_pdf,
            // 通用：前端生成的 PNG 落盘到用户选定路径（如表格导出图片）
            commands::export::export_png_to_file,
            // 笔记批量操作
            commands::notes::trash_all_notes,
            // 图片模块
            commands::image::save_note_image,
            commands::image::save_note_image_from_path,
            commands::image::download_image_to_assets,
            commands::image::delete_note_images,
            commands::image::get_images_dir,
            commands::image::get_image_blob,
            // 孤儿素材统一清理（替代旧的 scan_orphan_images / clean_orphan_images）
            commands::orphan::scan_orphan_assets,
            commands::orphan::clean_orphan_assets,
            // 视频模块
            commands::videos::save_video,
            commands::videos::save_video_from_path,
            commands::videos::delete_note_videos,
            commands::videos::get_videos_dir,
            // 附件模块（PDF/Office/ZIP/音视频等通用文件）
            commands::attachment::save_note_attachment,
            commands::attachment::save_note_attachment_from_path,
            commands::attachment::delete_note_attachments,
            commands::attachment::get_attachments_dir,
            commands::attachment::preview_excel_attachment,
            commands::attachment::preview_text_attachment,
            // 模板模块
            commands::template::list_templates,
            commands::template::get_template,
            commands::template::create_template,
            commands::template::update_template,
            commands::template::delete_template,
            commands::template::create_note_from_template,
            commands::template::render_template_content,
            // PDF 模块
            commands::pdf::import_pdfs,
            commands::pdf::get_pdf_absolute_path,
            // 通用源文件 / Word 模块
            commands::source_file::get_converter_status,
            commands::source_file::diagnose_doc_converter,
            commands::source_file::convert_doc_to_docx_base64,
            commands::source_file::attach_source_file,
            commands::source_file::get_source_file_absolute_path,
            commands::source_file::read_file_as_base64,
            // 外部 .md 写回（保存即同步原文件）
            commands::source_writeback::write_back_source_md,
            commands::source_writeback::clear_source_md_link,
            // 同步模块（V1/V2：本地 ZIP + WebDAV 全量快照）
            commands::sync::sync_export_to_file,
            commands::sync::sync_import_from_file,
            commands::sync::sync_webdav_test,
            commands::sync::sync_webdav_push,
            commands::sync::sync_webdav_pull,
            commands::sync::sync_webdav_preview,
            commands::sync::sync_webdav_list_snapshots,
            commands::sync::sync_save_webdav_password,
            commands::sync::sync_has_webdav_password,
            commands::sync::sync_get_webdav_password,
            commands::sync::sync_delete_webdav_password,
            commands::sync::sync_save_backup_password,
            commands::sync::sync_has_backup_password,
            commands::sync::sync_get_backup_password,
            commands::sync::sync_delete_backup_password,
            commands::sync::sync_list_history,
            commands::sync::sync_scheduler_reload,
            // 闪卡 + FSRS 复习
            commands::cards::create_card,
            commands::cards::list_cards,
            commands::cards::get_card,
            commands::cards::list_due_cards,
            commands::cards::update_card_content,
            commands::cards::delete_card,
            commands::cards::review_card,
            commands::cards::get_card_stats,
            commands::cards::list_card_review_logs,
            // 待办模块
            commands::tasks::list_tasks,
            commands::tasks::get_task,
            commands::tasks::list_subtasks,
            commands::tasks::create_task,
            commands::tasks::update_task,
            commands::tasks::toggle_task_status,
            commands::tasks::set_task_kanban_stage,
            commands::tasks::delete_task,
            commands::tasks::delete_tasks_batch,
            commands::tasks::complete_tasks_batch,
            commands::tasks::add_task_link,
            commands::tasks::remove_task_link,
            commands::tasks::get_task_stats,
            commands::tasks::snooze_task_reminder,
            commands::tasks::complete_task_occurrence,
            commands::tasks::search_tasks,
            // 全局快捷键（仅桌面端；移动端无此概念）
            #[cfg(desktop)]
            commands::shortcut::list_shortcut_bindings,
            #[cfg(desktop)]
            commands::shortcut::set_shortcut_binding,
            #[cfg(desktop)]
            commands::shortcut::reset_shortcut_binding,
            #[cfg(desktop)]
            commands::shortcut::disable_shortcut_binding,
            // 待办分类
            commands::tasks::list_task_categories,
            commands::tasks::create_task_category,
            commands::tasks::update_task_category,
            commands::tasks::delete_task_category,
            // 项目（v41，配合甘特图）
            commands::projects::list_projects,
            commands::projects::get_project,
            commands::projects::create_project,
            commands::projects::update_project,
            commands::projects::delete_project,
            // Dataview 块（v1.12 最简，5 个固定模板查询）
            commands::dataview::dataview_recent_notes,
            commands::dataview::dataview_notes_by_tag,
            commands::dataview::dataview_notes_by_folder,
            commands::dataview::dataview_pending_tasks,
            commands::dataview::dataview_tasks_by_project,
            // 语音识别（ASR）
            commands::asr::asr_get_config,
            commands::asr::asr_save_config,
            commands::asr::asr_test_connection,
            commands::asr::asr_transcribe_audio,
            // 移动端"检查更新"（桌面端走 tauri-plugin-updater，无此命令）
            #[cfg(mobile)]
            commands::mobile_update::check_mobile_update,
        ])
        // ─── 窗口事件处理 ─────────────────────────
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 关闭决策只对主窗口生效（要读 app_config 里的 window.close_action）。
                // 子窗口（emergency-*、migration-splash 等）的 close 应该自然完成，
                // 否则 emit 出的 app:close-requested 会被主窗 CloseRequestedListener 接到
                // 误弹"关闭/最小化"询问框。
                if window.label() != "main" {
                    return;
                }
                api.prevent_close();
                let _ = window.emit("app:close-requested", ());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// dev 模式首次启动时，把旧的无前缀数据自动迁移到 dev- 前缀
/// （只在 cfg!(debug_assertions) 下调用；迁移失败仅记日志，不阻断启动）
#[cfg(debug_assertions)]
fn migrate_to_dev_prefix(data_dir: &std::path::Path) {
    let pairs: &[(&str, &str)] = &[
        ("app.db", "dev-app.db"),
        ("app.db-shm", "dev-app.db-shm"),
        ("app.db-wal", "dev-app.db-wal"),
        ("kb_assets", "dev-kb_assets"),
        ("settings.json", "dev-settings.json"),
    ];
    for (old, new) in pairs {
        let old_p = data_dir.join(old);
        let new_p = data_dir.join(new);
        if old_p.exists() && !new_p.exists() {
            match std::fs::rename(&old_p, &new_p) {
                Ok(_) => log::info!("[dev 迁移] {} → {}", old_p.display(), new_p.display()),
                Err(e) => log::warn!(
                    "[dev 迁移失败] {} → {}: {}",
                    old_p.display(),
                    new_p.display(),
                    e
                ),
            }
        }
    }
}

#[cfg(not(debug_assertions))]
#[allow(dead_code)]
fn migrate_to_dev_prefix(_data_dir: &std::path::Path) {}

// 全局快捷键的注册 / 派发 / 缓存逻辑全部在 services::shortcut 中
