//! 笔记 / 思维导图的多窗口 pop-out
//!
//! 用途：用户想"两屏对照"或"边写边看导图"时，把一个笔记/导图视图弹到独立 OS 窗口，
//! 用户自己用 Win+方向键 Snap 到副屏 / 主屏的左半屏。
//!
//! 设计要点：
//! - **同 note_id 已存在窗口直接前置**，避免重复弹
//! - **label = `popout-note-{id}` / `popout-mindmap-{id}`**，对应 capabilities/default.json 的 windows glob
//! - **复用主 SPA**：和 emergency_window 保持一致，直接加载 `index.html#/...`；
//!   Tauri 会在 dev/prod 下分别映射到 devUrl / app URL
//! - **不使用 initialization_script 改 hash**：窗口创建阶段只负责加载稳定 URL，
//!   避免 document-start 脚本在 WebView2 初始化期间触发二次导航
//! - **精简模式判定**：前端读 `getCurrentWebviewWindow().label` 是否以 `popout-` 开头

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::AppError;

/// 定时推送弹窗最小尺寸（与前端 push-popup 页的 MIN_W/MIN_H 保持一致）
const MIN_W: f64 = 360.0;
const MIN_H: f64 = 200.0;

/// 给指定笔记打开 pop-out 窗口；同 id 已存在则前置
pub fn open_note(app: &AppHandle, note_id: i64) -> Result<(), AppError> {
    let label = format!("popout-note-{}", note_id);

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let url = format!("index.html#/notes/{}", note_id);

    log::info!(
        "[popout] 打开笔记新窗口: label={} note_id={}",
        label,
        note_id
    );

    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("笔记")
        // popout 默认窗口宽一点，编辑器 topbar 工具按钮多，900px 会挤
        .inner_size(1200.0, 780.0)
        .min_inner_size(720.0, 480.0)
        .center()
        .resizable(true)
        // 用 OS 原生标题栏：自带标题"笔记"、最小化/最大化/关闭按钮，不需要前端自绘。
        // 前端 AppLayout 用 isPopoutWindow 给 Content 加 paddingTop=32 让位即可
        .decorations(true)
        .focused(true)
        .visible(true);

    #[cfg(debug_assertions)]
    let builder = builder.devtools(true);

    builder
        .build()
        .map_err(|e| AppError::Custom(format!("pop-out 窗口创建失败: {}", e)))?;

    Ok(())
}

/// 给指定笔记打开"纯思维导图"独立窗口；同 id 已存在则前置
///
/// 与 `open_note` 区别：弹窗里只渲染 markmap 视图（不带编辑器/大纲/工具栏），
/// 适合双屏对照——一边写笔记一边看导图。窗口内通过 hash 路由 `/mindmap-popout/:noteId`
/// 进入独立页面，由该页面自己拉笔记内容并定时跟随主窗保存。
pub fn open_mindmap(app: &AppHandle, note_id: i64) -> Result<(), AppError> {
    let label = format!("popout-mindmap-{}", note_id);

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let url = format!("index.html#/mindmap-popout/{}", note_id);

    log::info!(
        "[popout] 打开思维导图新窗口: label={} note_id={}",
        label,
        note_id
    );

    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("思维导图")
        .inner_size(960.0, 720.0)
        .min_inner_size(480.0, 360.0)
        .center()
        .resizable(true)
        .decorations(true)
        .focused(true)
        .visible(true);

    #[cfg(debug_assertions)]
    let builder = builder.devtools(true);

    builder
        .build()
        .map_err(|e| AppError::Custom(format!("思维导图 pop-out 窗口创建失败: {}", e)))?;

    Ok(())
}

/// 「快速记一笔」独立悬浮窗（滴答清单式）。toggle 语义：
/// - 窗口不存在 → 创建（无边框 / 置顶 / 不进任务栏 / 居中小窗），加载 `#/quick-add`
/// - 已存在且可见 → 收起（hide，不销毁，下次秒开）
/// - 已存在但隐藏 → 前置并聚焦
///
/// 由全局快捷键（`global.quickAddWindow`）或托盘菜单调起；应用在后台也能唤起，
/// 不打断当前主窗工作。窗口内 Enter 追加到今日日记、Esc/失焦自动隐藏（前端处理）。
pub fn open_quick_add(app: &AppHandle) -> Result<(), AppError> {
    let label = "quick-add";

    if let Some(win) = app.get_webview_window(label) {
        // 复用已建窗口：可见则收起，隐藏则前置（配合前端失焦自动 hide）
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();
        }
        return Ok(());
    }

    log::info!("[quick-add] 创建快速记一笔悬浮窗");

    let builder = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App("index.html#/quick-add".into()),
    )
    .title("快速记一笔")
    .inner_size(560.0, 240.0)
    .center()
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    // 先隐藏建窗，规避新 WebView 加载期间的空白闪屏：
    // 前端 quick-add 页 React 首帧画好后再自己 show() + setFocus()，
    // 用户看到的直接就是渲染完整的小窗。后续复用走上面的 show 分支（已渲染，秒开不闪）。
    .focused(false)
    .visible(false);

    #[cfg(debug_assertions)]
    let builder = builder.devtools(true);

    builder
        .build()
        .map_err(|e| AppError::Custom(format!("快速记一笔窗口创建失败: {}", e)))?;

    Ok(())
}

/// 定时推送「居中弹窗」独立悬浮窗。
///
/// 设计（参考 quick-add + emergency_window，但更温和）：
/// - 独立窗口、屏幕居中、置顶、无边框、不抢主窗（绝不动主窗状态）
/// - 不全屏、无循环铃声（推送是"看一眼"，不是紧急接管）
/// - 进任务栏（skip_taskbar=false）：用户切走后还能从任务栏找回来
/// - label = `push-popup-{log_id}`，对应 capabilities/push-popup.json 的 `push-popup-*` glob
/// - URL `#/push-popup/{log_id}`，页面按 id 拉内容（payload 快照），自带 复制/写入日记/打开主窗/关闭
pub fn open_push_popup(app: &AppHandle, log_id: i64) -> Result<(), AppError> {
    let label = format!("push-popup-{}", log_id);

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_always_on_top(true);
        let _ = existing.set_focus();
        return Ok(());
    }

    let url = format!("index.html#/push-popup/{}", log_id);

    // 初始给个保守尺寸；前端内容加载后会按内容多少调用 setSize 智能调整（见 push-popup 页）。
    // resizable=true 让用户随后还能手动拉伸；min 防止被拉到不可用的小尺寸。
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("定时推送")
        .inner_size(440.0, 300.0)
        .min_inner_size(MIN_W, MIN_H)
        .center()
        .resizable(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(false)
        .focused(true)
        .shadow(true)
        .visible(true);

    #[cfg(debug_assertions)]
    let builder = builder.devtools(true);

    builder
        .build()
        .map_err(|e| AppError::Custom(format!("定时推送弹窗创建失败: {}", e)))?;

    Ok(())
}
