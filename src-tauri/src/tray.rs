use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Listener, Manager,
};
use tauri_plugin_autostart::ManagerExt;

use crate::services::sync_scheduler;

/// 初始化系统托盘
pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // 快捷操作
    let new_note = MenuItem::with_id(app, "new-note", "新建笔记", true, Some("Ctrl+N"))?;
    let quick_add = MenuItem::with_id(
        app,
        "quick-add",
        "快速记一笔",
        true,
        Some("Ctrl+Alt+Space"),
    )?;
    let open_daily = MenuItem::with_id(app, "open-daily", "打开今日日记", true, None::<&str>)?;
    let open_search = MenuItem::with_id(app, "open-search", "全局搜索", true, Some("Ctrl+K"))?;
    let sep1 = PredefinedMenuItem::separator(app)?;

    // 同步
    let sync_now = MenuItem::with_id(app, "sync-now", "立即同步到云端", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    // 偏好 / 更新
    // 窗口置顶：初始默认关闭（Tauri 没有"读取当前 always-on-top"的 API，以托盘状态为准）
    let always_on_top =
        CheckMenuItem::with_id(app, "always-on-top", "窗口置顶", true, false, None::<&str>)?;
    // 开机自启：从 autolaunch 插件读真实状态作为初值，保证与系统一致
    let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机自启",
        true,
        autostart_enabled,
        None::<&str>,
    )?;
    let check_update = MenuItem::with_id(app, "check-update", "检查更新…", true, None::<&str>)?;
    let sep3 = PredefinedMenuItem::separator(app)?;

    // 窗口 & 退出
    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &new_note,
            &quick_add,
            &open_daily,
            &open_search,
            &sep1,
            &sync_now,
            &sep2,
            &always_on_top,
            &autostart,
            &check_update,
            &sep3,
            &show,
            &quit,
        ],
    )?;

    // clone 给事件闭包使用（内部是 Arc，开销极小）
    let always_on_top_ref = always_on_top.clone();
    let autostart_ref = autostart.clone();

    // 监听前端发来的置顶状态变化，同步 CheckMenuItem 勾选
    // （右上角按钮点击 → Zustand → emit 此事件）
    // ⚠️ macOS：NSStatusItem 的写操作必须在 main thread；listen 回调跑在 IPC worker
    // 线程，直接调 set_checked 在 mac 上有崩溃风险。用 run_on_main_thread 投递到主线程。
    let always_on_top_for_sync = always_on_top.clone();
    let app_for_sync = app.handle().clone();
    app.listen("ui:always-on-top-changed", move |event| {
        if let Ok(enabled) = serde_json::from_str::<bool>(event.payload()) {
            let item = always_on_top_for_sync.clone();
            let _ = app_for_sync.run_on_main_thread(move || {
                let _ = item.set_checked(enabled);
            });
        }
    });

    // 开发环境：给托盘图标右下角叠加一个橙色小圆点角标，方便和正式安装版的实例区分
    let base_icon = app.default_window_icon().ok_or("应用图标未配置")?;
    let icon: tauri::image::Image<'static> = if cfg!(debug_assertions) {
        add_dev_badge(base_icon)
    } else {
        tauri::image::Image::new_owned(
            base_icon.rgba().to_vec(),
            base_icon.width(),
            base_icon.height(),
        )
    };

    let tooltip: &str = if cfg!(debug_assertions) {
        "知识库 [DEV]"
    } else {
        "知识库"
    };

    TrayIconBuilder::new()
        .icon(icon)
        .tooltip(tooltip)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "new-note" => {
                bring_main_to_front(app);
                let _ = app.emit("tray:new-note", ());
            }
            "quick-add" => {
                // 快速记一笔悬浮窗：不前置主窗，直接弹独立小窗（应用在后台也能记）
                let _ = crate::services::popout_window::open_quick_add(app);
            }
            "open-daily" => {
                bring_main_to_front(app);
                let _ = app.emit("tray:open-daily", ());
            }
            "open-search" => {
                bring_main_to_front(app);
                let _ = app.emit("tray:open-search", ());
            }
            "sync-now" => {
                // 不需要主窗口在前台也能同步；结果通过 sync:manual-push-result 广播
                let app_handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    sync_scheduler::push_once(&app_handle, "tray").await;
                });
            }
            "always-on-top" => {
                // CheckMenuItem 点击后 Tauri 会先自动翻转 checked 状态，这里读到的是新状态
                let checked = always_on_top_ref.is_checked().unwrap_or(false);
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(e) = window.set_always_on_top(checked) {
                        log::error!("[tray] 设置窗口置顶失败: {}", e);
                        // 状态回滚
                        let _ = always_on_top_ref.set_checked(!checked);
                        return;
                    }
                }
                // 通知前端同步 Zustand + 右上角按钮 UI
                let _ = app.emit("rust:always-on-top-changed", checked);
            }
            "autostart" => {
                let checked = autostart_ref.is_checked().unwrap_or(false);
                let result = if checked {
                    app.autolaunch().enable()
                } else {
                    app.autolaunch().disable()
                };
                if let Err(e) = result {
                    log::error!("[tray] 切换开机自启失败: {}", e);
                    // 失败回滚 UI
                    let _ = autostart_ref.set_checked(!checked);
                }
            }
            "check-update" => {
                bring_main_to_front(app);
                let _ = app.emit("tray:check-update", ());
            }
            "show" => {
                bring_main_to_front(app);
            }
            "quit" => {
                // 走前端确认流程：让 React 检查未保存草稿，弹 Modal 给用户三选一
                // 前端确认后通过 tauri-plugin-process 的 exit() 真正退出
                bring_main_to_front(app);
                let _ = app.emit("tray:request-exit", ());
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键点击：切换主窗口可见性（可见且未最小化 → 隐藏回托盘；否则 → 显示并聚焦）
            //
            // ⚠️ 不要再用 is_focused 作为「隐藏」的判定条件：Windows 上点击托盘图标会把焦点
            // 从主窗口夺走（转给 shell/任务栏），等 MouseButton::Up 事件到达时主窗口
            // is_focused() 已经是 false → 永远走不到 hide 分支，表现为「再单击不隐藏，反而重新
            // 聚焦」。改为纯按可见性切换，保证「单击显示、再单击隐藏」的预期行为。
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let is_visible = window.is_visible().unwrap_or(false);
                    let is_minimized = window.is_minimized().unwrap_or(false);

                    if is_visible && !is_minimized {
                        let _ = window.hide();
                    } else {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}

/// 给托盘图标右下角叠一个橙色小圆点角标（仅开发环境用，便于区分 dev 实例 / 正式安装版）。
///
/// 直接在图标 RGBA 像素上画一个小实心圆 + 一圈深橙描边（保证任何底色都看得清），
/// 不做半透明混合。半径取短边的 0.18，圆心落在右下角内缩 1px 处。
fn add_dev_badge(icon: &tauri::image::Image<'_>) -> tauri::image::Image<'static> {
    let w = icon.width();
    let h = icon.height();
    let mut rgba = icon.rgba().to_vec();
    if w == 0 || h == 0 || rgba.len() < (w * h * 4) as usize {
        // 数据异常就原样返回，别越界乱画
        return tauri::image::Image::new_owned(rgba, w, h);
    }

    // 角标半径取短边的 0.18（小角标即可，够眼睛分辨就行），圆心落在右下角内缩 1px
    let r = (w.min(h) as f32) * 0.18;
    let cx = w as f32 - r - 1.0;
    let cy = h as f32 - r - 1.0;
    let edge = r * 0.25; // 外圈深橙描边宽度

    for y in 0..h {
        for x in 0..w {
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            let dist = (dx * dx + dy * dy).sqrt();
            if dist > r {
                continue;
            }
            let idx = ((y * w + x) * 4) as usize;
            // 外缘一圈深橙描边、内部亮橙实心
            let (cr, cg, cb) = if dist >= r - edge {
                (198u8, 80, 0)
            } else {
                (255u8, 149, 0)
            };
            rgba[idx] = cr;
            rgba[idx + 1] = cg;
            rgba[idx + 2] = cb;
            rgba[idx + 3] = 255;
        }
    }

    tauri::image::Image::new_owned(rgba, w, h)
}

/// 把主窗口从最小化/隐藏中恢复并聚焦
fn bring_main_to_front(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
