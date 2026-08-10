//! 主窗口尺寸相关 Command（仅桌面端 —— 移动端窗口由系统管理）。

/// 窗口状态跟踪的 flags，插件注册处（`lib.rs`）与所有手动调用必须用同一份。
///
/// 刻意不含 VISIBLE：本应用支持「关闭时最小化到托盘」和 autostart `--start-minimized`，
/// 窗口隐藏着退出是正常路径，跟踪 VISIBLE 会导致下次启动直接无窗口。
#[cfg(desktop)]
pub(crate) const TRACKED_STATE_FLAGS: tauri_plugin_window_state::StateFlags =
    tauri_plugin_window_state::StateFlags::SIZE
        .union(tauri_plugin_window_state::StateFlags::POSITION)
        .union(tauri_plugin_window_state::StateFlags::MAXIMIZED);

/// 把窗口塞进它当前所在那块屏的**工作区**（扣掉任务栏），返回是否真的动过窗口。
///
/// 🔴 存在的理由：`tauri-plugin-window-state` 存/还原的都是**物理**像素，且完全不 clamp
/// （详见 `services::window_size::fit_into_work_area` 的注释）。显示器拓扑一变
/// —— 拔掉外接屏、改分辨率、改缩放 —— 还原出来的几何就可能比屏幕还大、或整个跑到屏幕外。
/// 每次还原 / 改尺寸之后都过一遍本函数，保证窗口一定是完整可见、可拖动的。
///
/// `center = true` 时忽略当前位置、直接在工作区内居中（首次启动 / 「恢复默认大小」）。
///
/// 🔴 下发顺序固定为 `set_position` → `set_size`：跨 DPI 屏移动时 Windows 会在
/// `set_position` 内部同步抛 `WM_DPICHANGED` 并按新 DPI 重算窗口 rect，反过来的话
/// 刚设好的尺寸会被再乘一次两屏缩放比（tauri-cc 项目在混合 DPI 双屏上实测过这个坑）。
#[cfg(desktop)]
pub(crate) fn fit_into_work_area(window: &tauri::WebviewWindow, center: bool) -> bool {
    use crate::services::window_size::Rect;

    // 最大化 / 全屏的几何由系统管理，插手只会打架
    if window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        return false;
    }

    // current_monitor 才是「窗口实际在哪块屏」；取不到（窗口还没落位）才退主屏
    let Some(monitor) = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
    else {
        return false;
    };

    // 工作区被报成 0 的显示器（虚拟屏 / 远程桌面）退回整屏几何
    let wa = monitor.work_area();
    let work = if wa.size.width > 0 && wa.size.height > 0 {
        Rect { x: wa.position.x, y: wa.position.y, width: wa.size.width, height: wa.size.height }
    } else {
        Rect {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
        }
    };

    let (Ok(outer), Ok(inner), Ok(pos)) = (
        window.outer_size(),
        window.inner_size(),
        window.outer_position(),
    ) else {
        return false;
    };

    // 「占多大地方」算的是外框，但 set_size 设的是内容区。本应用 decorations:false
    // 时两者相等，但别把这个前提焊死 —— 留出边框差，将来开边框也不会算错。
    let border_w = outer.width.saturating_sub(inner.width);
    let border_h = outer.height.saturating_sub(inner.height);

    let want_pos = if center { None } else { Some((pos.x, pos.y)) };
    let fitted = crate::services::window_size::fit_into_work_area(
        work,
        want_pos,
        outer.width,
        outer.height,
    );

    let mut changed = false;
    if (fitted.x, fitted.y) != (pos.x, pos.y) {
        let _ = window.set_position(tauri::PhysicalPosition::new(fitted.x, fitted.y));
        changed = true;
    }
    if (fitted.width, fitted.height) != (outer.width, outer.height) {
        let _ = window.set_size(tauri::PhysicalSize::new(
            fitted.width.saturating_sub(border_w).max(1),
            fitted.height.saturating_sub(border_h).max(1),
        ));
        changed = true;
    }

    if changed {
        log::info!(
            "[window] 几何已按工作区校正: {}x{}@({},{}) → {}x{}@({},{})，屏 {}",
            outer.width,
            outer.height,
            pos.x,
            pos.y,
            fitted.width,
            fitted.height,
            fitted.x,
            fitted.y,
            monitor.name().map(String::as_str).unwrap_or("<未命名>"),
        );
    }
    changed
}

/// 把主窗口恢复成"默认大小并居中"。
///
/// 为什么需要它：接了 tauri-plugin-window-state 之后，窗口的大小 / 位置 /
/// 最大化状态会被记住并在下次启动还原。好处是用户调过一次就一直保持，代价是
/// 一旦把窗口拖成很别扭的尺寸（或从多屏环境挪到单屏、外接屏拔掉），就再没有
/// 一键回到合理尺寸的路 —— 这个 Command 就是那条路。
///
/// 做三件事，缺一不可：
///   1. 先退出最大化 —— 最大化状态下 set_size 不生效（或还原后才生效，观感是"点了没反应"）
///   2. 按**窗口当前所在**那块屏重算默认尺寸，再按该屏工作区居中
///   3. **立刻落盘**，否则用户点完不重启直接关窗口，插件会把"关闭那一刻的尺寸"
///      写回去，看起来像恢复失败
///
/// 🔴 第 2 步认的是 `current_monitor` 而非 `primary_monitor`：双屏下用户很可能是在副屏
/// 点的这个按钮，按主屏分辨率算出来的尺寸放到副屏上并不合适（4K 副屏上会偏小、
/// 小副屏上会装不下）。居中也不再用 `center()` —— 它按整屏居中、不管任务栏，
/// 改走 [`fit_into_work_area`] 按工作区居中并兜底。
#[tauri::command]
pub fn reset_window_size(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        use tauri_plugin_window_state::AppHandleExt;

        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "找不到主窗口".to_string())?;

        // 1. 退出最大化（本来就不是最大化时这是空操作）
        if window.is_maximized().unwrap_or(false) {
            window.unmaximize().map_err(|e| e.to_string())?;
        }

        // 2. 按窗口所在屏重算 —— 用户可能换了屏、挪了窗口或改了缩放，不能用启动时的值
        let monitor = window
            .current_monitor()
            .ok()
            .flatten()
            .or_else(|| window.primary_monitor().ok().flatten())
            .ok_or_else(|| "取不到显示器信息".to_string())?;
        let scale = monitor.scale_factor().max(0.1);
        let phys = monitor.size();
        let (w, h) = crate::services::window_size::default_window_size(
            phys.width as f64 / scale,
            phys.height as f64 / scale,
        );
        window
            .set_size(tauri::LogicalSize::new(w, h))
            .map_err(|e| e.to_string())?;
        // 按工作区居中 + clamp：默认尺寸不一定装得进这块屏（小笔记本 / 投影仪 1280×720）
        fit_into_work_area(&window, true);

        // 3. 立刻落盘。flags 与插件注册处同源，避免两处漂移 ——
        //    传 all() 会顺带把 VISIBLE 写进去，而我们刻意不跟踪它（见 TRACKED_STATE_FLAGS）。
        app.save_window_state(TRACKED_STATE_FLAGS)
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("移动端窗口由系统管理，不支持调整".to_string())
    }
}
