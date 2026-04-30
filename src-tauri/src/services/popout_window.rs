//! 笔记 / 思维导图的多窗口 pop-out
//!
//! 用途：用户想"两屏对照"或"边写边看导图"时，把一个笔记/导图视图弹到独立 OS 窗口，
//! 用户自己用 Win+方向键 Snap 到副屏 / 主屏的左半屏。
//!
//! 设计要点：
//! - **同 note_id 已存在窗口直接前置**，避免重复弹
//! - **label = `popout-note-{id}`**，对应 capabilities/default.json 的 windows glob
//! - **复用主 SPA**：URL 走 HashRouter `#/notes/{id}`，新窗口和主窗口跑同一份 React 应用
//!   - 优点：零改造、所有功能（保存、AI、导图）都能用
//!   - 缺点：会带上侧边栏 Tabs；后续可加 `?popout=1` 路由参数让前端隐藏侧栏

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::AppError;

/// 给指定笔记打开 pop-out 窗口；同 id 已存在则前置
pub fn open_note(app: &AppHandle, note_id: i64) -> Result<(), AppError> {
    let label = format!("popout-note-{}", note_id);

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    // popout=1 让前端 AppLayout 切到精简模式（隐藏侧边栏 / Tabs，只保留编辑器）
    let url = format!("index.html?popout=1#/notes/{}", note_id);

    WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("笔记")
        .inner_size(900.0, 720.0)
        .min_inner_size(560.0, 400.0)
        .center()
        .resizable(true)
        .decorations(true)
        .focused(true)
        .visible(true)
        .build()
        .map_err(|e| AppError::Custom(format!("pop-out 窗口创建失败: {}", e)))?;

    Ok(())
}
