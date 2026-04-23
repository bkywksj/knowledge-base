use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Listener, Manager,
};
use tauri_plugin_autostart::ManagerExt;

use crate::services::sync_scheduler;

pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // 快捷操作
    let new_note = MenuItem::with_id(app, "new-note", "新建笔记", true, Some("Ctrl+N"))?;
    let open_daily = MenuItem::with_id(app, "open-daily", "打开今日每日笔记", true, None::<&str>)?;
    let open_search = MenuItem::with_id(app, "open-search", "全局搜索", true, Some("Ctrl+K"))?;
    let sep1 = PredefinedMenuItem::separator(app)?;

    // 同步
    let sync_now = MenuItem::with_id(app, "sync-now", "立即同步到云端", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    // 偏好 / 更新
    // 窗口置顶：初始默认关闭（Tauri 没有"读取当前 always-on-top"的 API，以托盘状态为准）
    let always_on_top = CheckMenuItem::with_id(
        app,
        "always-on-top",
        "窗口置顶",
        true,
        false,
        None::<&str>,
    )?;
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
    let always_on_top_for_sync = always_on_top.clone();
    app.listen("ui:always-on-top-changed", move |event| {
        if let Ok(enabled) = serde_json::from_str::<bool>(event.payload()) {
            let _ = always_on_top_for_sync.set_checked(enabled);
        }
    });

    let icon = app.default_window_icon().ok_or("应用图标未配置")?.clone();

    let tooltip = if cfg!(debug_assertions) {
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
            // 左键点击：切换主窗口可见性（可见且聚焦 → 隐藏回托盘；否则 → 显示并聚焦）
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
                    let is_focused = window.is_focused().unwrap_or(false);

                    if is_visible && !is_minimized && is_focused {
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

/// 把主窗口从最小化/隐藏中恢复并聚焦
fn bring_main_to_front(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
